// KurdCinema Scraper for Nuvio Local Scrapers
// Kurdish-subtitled movies & TV shows (Sorani) via kurdcinama.com
// Compatible with React Native / Hermes and Node.js

"use strict";

var PROVIDER_NAME = "KurdCinema";
var BASE_URL = "https://kurdcinama.com";
var CACHE_API = BASE_URL + "/api/TMDBCache.aspx";
var TIMEOUT_MS = 15000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
var CACHE_TTL_MS = 15 * 60 * 1000;

// Player front-ends that share the same packed config (`links = { hls4, hls2, hls3 }`).
// hgcloud.to and friends just redirect to one of these.
var PLAYER_HOSTS = [
  "hanerix.com",
  "playerwish.com",
  "obeywish.com",
  "audinifer.com",
  "swdyu.com",
  "swishsrv.com"
];

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

function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

function uniqueNonEmpty(arr) {
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var v = (arr[i] || "").trim();
    if (!v || seen[v]) continue;
    seen[v] = true;
    out.push(v);
  }
  return out;
}

function hostOf(url) {
  var m = String(url || "").match(/^https?:\/\/([^\/:]+)/i);
  return m ? m[1].toLowerCase() : "";
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
  try {
    var text = await fetchText(url, headers);
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

function playerIdFromUrl(url) {
  var m = String(url || "").match(/\/e\/([^\/?#]+)/);
  if (m) return m[1];
  var parts = String(url || "").split("?")[0].split("/");
  return parts[parts.length - 1] || "";
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

async function resolvePlayer(iframeUrl) {
  var id = playerIdFromUrl(iframeUrl);
  if (!id) return null;

  var candidates = uniqueNonEmpty([hostOf(iframeUrl)].concat(PLAYER_HOSTS));
  for (var i = 0; i < candidates.length; i++) {
    var host = candidates[i];
    var origin = "https://" + host;
    var pageUrl = origin + "/e/" + id;
    try {
      var html = await fetchText(pageUrl, { Referer: origin + "/" });
      if (html.length < 800) continue;
      var links = extractPlayerLinks(html);
      if (!links) continue;
      var streamUrl = pickPlayerUrl(links, origin);
      if (!streamUrl) continue;
      console.log("[" + PROVIDER_NAME + "] Resolved player " + host + " -> " + streamUrl.slice(0, 80) + "...");
      return { url: streamUrl, host: host, origin: origin };
    } catch (e) {
      console.log("[" + PROVIDER_NAME + "] Player " + host + " failed: " + e.message);
    }
  }
  return null;
}

function makeStream(resolved, streamTitle, quality, extraName) {
  var label = resolved.host.replace(/\.(com|to|net|space|cyou|xyz)$/i, "");
  return {
    name: PROVIDER_NAME + " [" + label + (extraName ? " · " + extraName : "") + "]",
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

    var iframeUrl = "";
    if (isMovie) {
      var movieUrl = BASE_URL + "/online.aspx?movieid=" + encodeURIComponent(entry.db_id);
      console.log("[" + PROVIDER_NAME + "] Movie page: " + movieUrl);
      var movieHtml = await fetchText(movieUrl);
      iframeUrl = extractIframeSrc(movieHtml);
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
      var epUrl = BASE_URL + "/Episodes2.aspx?type=" + encodeURIComponent(entry.db_id) +
        "&Stype=" + encodeURIComponent(target.stype) + "&name=" + pad2(e);
      console.log("[" + PROVIDER_NAME + "] Episode page: " + epUrl);
      var epHtml = await fetchText(epUrl);
      iframeUrl = extractIframeSrc(epHtml);
    }

    if (!iframeUrl) {
      console.log("[" + PROVIDER_NAME + "] No player found on page");
      return [];
    }
    console.log("[" + PROVIDER_NAME + "] Player iframe: " + iframeUrl);

    var resolved = await resolvePlayer(iframeUrl);
    if (!resolved) {
      console.log("[" + PROVIDER_NAME + "] Could not resolve player");
      return [];
    }

    var quality = await inferQuality(resolved.url, {
      "User-Agent": UA,
      "Referer": resolved.origin + "/"
    });

    var streams = [makeStream(resolved, streamTitle, quality, "KU Sub")];
    console.log("[" + PROVIDER_NAME + "] Done: " + streams.length + " stream(s)");
    return streams;

  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
