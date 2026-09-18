// KurdCinema Scraper for Nuvio Local Scrapers
// Kurdish-subtitled movies & TV shows (Sorani) via kurdcinama.com
// Collects every server from the page dropdown and returns each resolvable
// direct link (Stream wish family, VidHide/File lions, Sendvid, YourUpload).
// Compatible with React Native / Hermes and Node.js

"use strict";

var PROVIDER_NAME = "KurdCinema";
var BASE_URL = "https://kurdcinama.com";
var CACHE_API = BASE_URL + "/api/TMDBCache.aspx";
var TIMEOUT_MS = 15000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
var CACHE_TTL_MS = 15 * 60 * 1000;

// Player iframes are hosted on rotating front-ends. All of the "stream wish"
// family (swdyu/playerwish/obeywish/hanerix/swishsrv/audinifer) and the
// VidHide family (vidhide*/callistanise/dintezuvio/minochinos) share a packed
// `hls4/hls2/hls3` config; youupload/sendvid expose a direct MP4.

// Domains that only ever appear as decoys / test media, never a real stream.
var DECOY_RE = /test-videos\.co\.uk|bigbuckbunny|sample-videos\.com|w3\.org|schema\.org/i;

// ─── Cache ───────────────────────────────────────────────────────────────────

var _cache = {};

function cacheGet(key) {
  var hit = _cache[key];
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) {
    delete _cache[key];
    return null;
  }
  return hit.v;
}

function cacheSet(key, value) {
  _cache[key] = { t: Date.now(), v: value };
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function fetchWithTimeout(url, options, timeoutMs) {
  var ms = timeoutMs || TIMEOUT_MS;
  var controller = null;
  var timer = null;
  try {
    controller = new AbortController();
    timer = setTimeout(function () { controller.abort(); }, ms);
  } catch (e) {
    controller = null;
  }
  var opts = options || {};
  opts.headers = Object.assign({ "User-Agent": UA }, opts.headers || {});
  if (controller) opts.signal = controller.signal;
  return fetch(url, opts).then(function (res) {
    if (timer) clearTimeout(timer);
    return res;
  }).catch(function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
}

function fetchText(url, headers) {
  return fetchWithTimeout(url, { headers: headers || {} }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  });
}

function fetchTextPost(url, body, headers, timeoutMs) {
  return fetchWithTimeout(url, { method: "POST", headers: headers || {}, body: body }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  });
}

function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

function hostOf(url) {
  var m = String(url || "").match(/^https?:\/\/([^\/:]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function originOf(url) {
  var m = String(url || "").match(/^(https?:\/\/[^\/]+)/i);
  return m ? m[1] : "";
}

// Turn protocol-relative (`//host/x`) or root-relative (`/x`) iframe srcs into
// absolute URLs.
function normalizeUrl(url, base) {
  var u = String(url || "").trim();
  if (!u) return "";
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.charAt(0) === "/") return originOf(base) + u;
  return u;
}

function decodeEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2B;/gi, "+");
}

function encodeForm(obj) {
  var parts = [];
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(obj[k] == null ? "" : obj[k]));
  }
  return parts.join("&");
}

// ─── Dean Edwards packer unpacker (player configs) ───────────────────────────

function unpackJs(source) {
  var start = source.indexOf("eval(function");
  if (start < 0) return null;
  var body = source.slice(start);
  var m = body.match(/^eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  var a = parseInt(m[2], 10);
  var c = parseInt(m[3], 10);
  var k = m[4].split("|");

  function toBase(cc) {
    return (cc < a ? "" : toBase(parseInt(cc / a, 10))) +
      ((cc = cc % a) > 35 ? String.fromCharCode(cc + 29) : cc.toString(36));
  }

  while (c--) {
    if (k[c]) p = p.replace(new RegExp("\\b" + toBase(c) + "\\b", "g"), k[c]);
  }
  return p;
}

// Extract `links = { hls4: "...", hls2: "...", hls3: "..." }` from a player page.
function extractPlayerLinks(html) {
  var code = html;
  var unpacked = unpackJs(html);
  if (unpacked) code = unpacked;

  var m = code.match(/links\s*=\s*(\{[^{}]*\})\s*;?/);
  if (m) {
    try {
      var parsed = JSON.parse(m[1]);
      if (parsed && (parsed.hls4 || parsed.hls2 || parsed.hls3)) return parsed;
    } catch (e) {}
  }

  // Fallback: jwplayer-style single source.
  var f = code.match(/file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
  if (f) return { hls2: f[1] };
  return null;
}

function pickPlayerUrl(links, origin) {
  var order = ["hls4", "hls2", "hls3"];
  for (var i = 0; i < order.length; i++) {
    var u = links[order[i]];
    if (!u || typeof u !== "string") continue;
    if (u.charAt(0) === "/") u = origin + u;
    if (u.indexOf("http") === 0) return u;
  }
  return null;
}

function bucketQuality(height) {
  if (height >= 1800) return "2160p";
  if (height >= 1300) return "1440p";
  if (height >= 900) return "1080p";
  if (height >= 600) return "720p";
  if (height >= 400) return "480p";
  if (height >= 300) return "360p";
  return "Auto";
}

async function inferQuality(url, headers) {
  // Only master playlists are cheap to inspect; never fetch a whole MP4.
  if (!/\.m3u8(\?|$)/i.test(url)) return "Auto";
  try {
    var text = await fetchWithTimeout(url, { headers: headers }, 4000).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    });
    var best = 0;
    var re = /RESOLUTION=\d+x(\d+)/gi;
    var m;
    while ((m = re.exec(text))) {
      var h = parseInt(m[1], 10);
      if (h > best) best = h;
    }
    if (best) return bucketQuality(best);
  } catch (e) {}
  return "Auto";
}

// ─── Content lookup (TMDB id -> site db_id) ──────────────────────────────────

function loadContent(type) {
  var cacheKey = "content:" + type;
  var cached = cacheGet(cacheKey);
  if (cached) return Promise.resolve(cached);

  var url = CACHE_API + "?action=mycontent&type=" + encodeURIComponent(type) + "&limit=100000";
  console.log("[" + PROVIDER_NAME + "] Loading content list: " + type);
  return fetchText(url).then(function (text) {
    var data = JSON.parse(text);
    var list = (data && data.results) || [];
    cacheSet(cacheKey, list);
    return list;
  });
}

function findEntry(list, tmdbId) {
  var target = String(tmdbId);
  for (var i = 0; i < list.length; i++) {
    if (list[i] && String(list[i].id) === target && list[i].db_id) return list[i];
  }
  return null;
}

// ─── TMDB (label only) ───────────────────────────────────────────────────────

function getTMDBInfo(tmdbId, mediaType) {
  var type = mediaType === "movie" ? "movie" : "tv";
  var key = "tmdb:" + type + ":" + tmdbId;
  var cached = cacheGet(key);
  if (cached) return Promise.resolve(cached);

  var url = "https://api.themoviedb.org/3/" + type + "/" + tmdbId +
    "?api_key=1c29a5198ee1854bd5eb45dbe8d17d92";
  return fetchWithTimeout(url).then(function (res) {
    return res.ok ? res.json() : {};
  }).then(function (data) {
    var info = {
      title: data.title || data.name || "",
      year: ((data.release_date || data.first_air_date || "").split("-")[0]) || ""
    };
    cacheSet(key, info);
    return info;
  }).catch(function () {
    return { title: "", year: "" };
  });
}

// ─── Page parsing ────────────────────────────────────────────────────────────

function extractIframeSrc(html) {
  var m = html.match(/<iframe[^>]*\bsrc=["']([^"']+)["']/i);
  return m ? m[1].trim() : "";
}

// Collect every hidden input (ASP.NET viewstate etc.) needed to replay a
// postback.
function parseHiddenInputs(html) {
  var out = {};
  var re = /<input[^>]*type=["']hidden["'][^>]*>/gi;
  var m;
  while ((m = re.exec(html))) {
    var tag = m[0];
    var name = (tag.match(/\bname=["']([^"']+)["']/i) || [])[1];
    var value = (tag.match(/\bvalue=["']([^"]*)["']/i) || [])[1];
    if (name) out[name] = decodeEntities(value || "");
  }
  return out;
}

// Parse the `<select>` that switches servers (DropDownList1 on movie pages,
// DDLplayer on episode pages).
function parseServerSelect(html) {
  var sel = html.match(/<select[^>]*\bname=["']([^"']*(?:DropDownList1|DDLplayer)[^"']*)["'][^>]*>([\s\S]*?)<\/select>/i);
  if (!sel) return null;
  var options = [];
  var re = /<option[^>]*\bvalue=["']([^"]*)["'][^>]*>([\s\S]*?)<\/option>/gi;
  var m;
  while ((m = re.exec(sel[2]))) {
    var text = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (!m[1] && !text) continue;
    options.push({ value: m[1], text: text, selected: /\bselected\b/i.test(m[0]) });
  }
  return { name: sel[1], options: options };
}

function cleanServerName(text) {
  return String(text || "").replace(/^\s*\d+\s*[-.)]\s*/, "").trim();
}

// Return [{ name, iframe }] for every server in the page's dropdown by
// replaying the ASP.NET postback for each option.
async function collectServerIframes(pageUrl, html) {
  var initial = extractIframeSrc(html);
  var select = parseServerSelect(html);
  if (!select || !select.options.length) {
    return initial ? [{ name: "Default", iframe: initial }] : [];
  }

  var hidden = parseHiddenInputs(html);
  var servers = [];
  var jobs = [];

  select.options.forEach(function (opt) {
    if (!opt.value) return;
    var name = cleanServerName(opt.text) || opt.value;
    if (opt.selected && initial) {
      servers.push({ name: name, iframe: initial });
      return;
    }
    var body = Object.assign({}, hidden, {
      __EVENTTARGET: select.name,
      __EVENTARGUMENT: ""
    });
    body[select.name] = opt.value;
    jobs.push(
      fetchTextPost(pageUrl, encodeForm(body), {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: pageUrl
      }, 8000).then(function (resHtml) {
        var src = extractIframeSrc(resHtml);
        if (src) servers.push({ name: name, iframe: normalizeUrl(src, pageUrl) });
      }).catch(function () {})
    );
  });

  await Promise.all(jobs);
  return servers;
}

// Split the series page into season blocks and return [{ season, stype }].
function parseSeasons(html) {
  var seasons = [];
  var blocks = html.split(/class="season-block"/).slice(1);
  if (blocks.length) {
    for (var i = 0; i < blocks.length; i++) {
      var m = blocks[i].match(/Stype=(\d+)/);
      if (m) seasons.push({ season: i + 1, stype: m[1] });
    }
    return seasons;
  }

  var seen = [];
  var re = /Stype=(\d+)/g;
  var mm;
  while ((mm = re.exec(html))) {
    if (seen.indexOf(mm[1]) === -1) seen.push(mm[1]);
  }
  for (var j = 0; j < seen.length; j++) seasons.push({ season: j + 1, stype: seen[j] });
  return seasons;
}

// ─── Player resolution ───────────────────────────────────────────────────────

function isUsableStream(url) {
  if (!url || typeof url !== "string") return false;
  if (DECOY_RE.test(url)) return false;
  return /\.(m3u8|mp4|txt)(\?|$)|\/master\.|\/hls\d?\//i.test(url) || url.indexOf(".m3u8") !== -1;
}

// Pull every plausible direct-stream URL out of a (possibly unpacked) page,
// preferring HLS playlists.
function extractStreamUrl(code, base) {
  var found = [];
  var patterns = [
    /"hls4"\s*:\s*"([^"]+)"/, /'hls4'\s*:\s*'([^']+)'/,
    /"hls2"\s*:\s*"([^"]+)"/, /'hls2'\s*:\s*'([^']+)'/,
    /"hls3"\s*:\s*"([^"]+)"/, /'hls3'\s*:\s*'([^']+)'/,
    /"hls"\s*:\s*"([^"]+)"/, /'hls'\s*:\s*'([^']+)'/,
    /file\s*:\s*["']([^"']+)["']/i,
    /sources\s*:\s*\[\s*["']([^"']+)["']/i,
    /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /(https?:\/\/[^"'\s\\]+\.(?:m3u8|mp4)[^"'\s\\]*)/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = code.match(patterns[i]);
    if (!m) continue;
    var u = m[1];
    if (!u) continue;
    if (u.indexOf("//") === 0) u = "https:" + u;
    else if (u.charAt(0) === "/") u = base + u;
    if (isUsableStream(u)) found.push(u);
  }
  // Also catch the `links = { hls4: ... }` shape (unquoted keys) if JSON failed.
  var links = extractPlayerLinks(code);
  if (links) {
    var picked = pickPlayerUrl(links, base);
    if (picked && isUsableStream(picked)) found.push(picked);
  }
  for (var j = 0; j < found.length; j++) if (/\.m3u8/i.test(found[j])) return found[j];
  for (var k = 0; k < found.length; k++) if (/\.mp4/i.test(found[k])) return found[k];
  return found[0] || null;
}

async function resolveEmbed(iframeUrl) {
  var url = normalizeUrl(iframeUrl, BASE_URL);
  if (!url || url.indexOf("http") !== 0) return null;
  var host = hostOf(url);
  var origin = originOf(url);
  var code;
  var finalUrl = url;
  try {
    var res = await fetchWithTimeout(url, {
      headers: { Referer: origin + "/", Origin: origin, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow"
    }, 8000);
    code = await res.text();
    finalUrl = res.url || url;
  } catch (e) {
    return null;
  }
  var origin2 = originOf(finalUrl) || origin;

  // VOE hides the real source behind a redirect + anti-bot; the decoy
  // test-videos URL is rejected by isUsableStream so this safely yields null.
  var redir = code.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/);
  if (redir && redir[1] !== url) {
    try {
      var res2 = await fetchWithTimeout(redir[1], {
        headers: { Referer: origin2 + "/" },
        redirect: "follow"
      }, 8000);
      code = await res2.text();
      origin2 = originOf(res2.url) || origin2;
    } catch (e) {}
  }

  if (code.indexOf("eval(function") !== -1) {
    var unpacked = unpackJs(code);
    if (unpacked) code = unpacked;
  }

  var streamUrl = extractStreamUrl(code, origin2);
  if (!streamUrl) return null;
  return { url: streamUrl, host: host, origin: origin2 };
}

function makeStream(resolved, streamTitle, quality, serverName) {
  var label = serverName || resolved.host.replace(/\.(com|to|net|space|cyou|xyz|biz)$/i, "");
  return {
    name: PROVIDER_NAME + " [" + label + " · KU Sub]",
    title: streamTitle + " · " + quality,
    url: resolved.url,
    quality: quality,
    headers: {
      "User-Agent": UA,
      "Referer": resolved.origin + "/",
      "Origin": resolved.origin
    },
    subtitles: []
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  console.log("[" + PROVIDER_NAME + "] Request: tmdbId=" + tmdbId + " type=" + mediaType +
    (isMovie ? "" : " S" + s + "E" + e));

  try {
    var list = await loadContent(isMovie ? "movie" : "tv");
    var entry = findEntry(list, tmdbId);
    if (!entry) {
      console.log("[" + PROVIDER_NAME + "] Content not found on site");
      return [];
    }

    var tmdbInfo = await getTMDBInfo(tmdbId, mediaType);
    var baseTitle = tmdbInfo.title || entry.title || ("TMDB " + tmdbId);
    var year = tmdbInfo.year || (String(entry.title || "").match(/\((\d{4})\)/) || [])[1] || "";

    var streamTitle = baseTitle +
      (isMovie ? "" : " S" + pad2(s) + "E" + pad2(e)) +
      (year ? " (" + year + ")" : "");

    var pageUrl;
    var pageHtml;
    if (isMovie) {
      pageUrl = BASE_URL + "/online.aspx?movieid=" + encodeURIComponent(entry.db_id);
      console.log("[" + PROVIDER_NAME + "] Movie page: " + pageUrl);
      pageHtml = await fetchText(pageUrl);
    } else {
      var seriesUrl = BASE_URL + "/Episodes.aspx?type=" + encodeURIComponent(entry.db_id);
      console.log("[" + PROVIDER_NAME + "] Series page: " + seriesUrl);
      var seriesHtml = await fetchText(seriesUrl);
      var seasons = parseSeasons(seriesHtml);
      var target = null;
      for (var i = 0; i < seasons.length; i++) {
        if (seasons[i].season === s) { target = seasons[i]; break; }
      }
      if (!target) {
        console.log("[" + PROVIDER_NAME + "] Season " + s + " not found");
        return [];
      }
      pageUrl = BASE_URL + "/Episodes2.aspx?type=" + encodeURIComponent(entry.db_id) +
        "&Stype=" + encodeURIComponent(target.stype) + "&name=" + pad2(e);
      console.log("[" + PROVIDER_NAME + "] Episode page: " + pageUrl);
      pageHtml = await fetchText(pageUrl);
    }

    var serverIframes = await collectServerIframes(pageUrl, pageHtml);
    if (!serverIframes.length) {
      console.log("[" + PROVIDER_NAME + "] No player found on page");
      return [];
    }
    console.log("[" + PROVIDER_NAME + "] Servers: " +
      serverIframes.map(function (x) { return x.name; }).join(", "));

    var resolvedList = await Promise.all(serverIframes.map(function (srv) {
      return resolveEmbed(srv.iframe).then(function (r) {
        return r ? { resolved: r, name: srv.name } : null;
      });
    }));
    var pending = resolvedList.filter(Boolean);

    var seen = {};
    var streams = [];
    await Promise.all(pending.map(async function (item) {
      if (seen[item.resolved.url]) return;
      seen[item.resolved.url] = true;
      var quality = await inferQuality(item.resolved.url, {
        "User-Agent": UA,
        "Referer": item.resolved.origin + "/"
      });
      streams.push(makeStream(item.resolved, streamTitle, quality, item.name));
      console.log("[" + PROVIDER_NAME + "] " + item.name + " -> " +
        item.resolved.url.slice(0, 80) + "...");
    }));

    console.log("[" + PROVIDER_NAME + "] Done: " + streams.length + " stream(s)");
    return streams;

  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
