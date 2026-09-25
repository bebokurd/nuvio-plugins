// KurdCinema Scraper for Nuvio Local Scrapers
// Kurdish-subtitled movies & TV shows (Sorani) via kurdcinama.com
// Compatible with React Native / Hermes and Node.js

"use strict";

var PROVIDER_NAME = "KurdCinema";
var BASE_URL = "https://kurdcinama.com";
var SEARCH_API = BASE_URL + "/Search.aspx";
var CACHE_API = BASE_URL + "/api/TMDBCache.aspx";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 12000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
var CACHE_TTL_MS = 15 * 60 * 1000;

// Domains that only appear as decoys or test media
var DECOY_RE = /test-videos\.co\.uk|bigbuckbunny|sample-videos\.com|w3\.org|schema\.org/i;

// Playable media extensions
var PLAYABLE_EXT = /\.(m3u8|mp4)(\?|$)/i;

// ─── In-Memory Cache ──────────────────────────────────────────────────────────

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

// ─── Network Utilities ────────────────────────────────────────────────────────

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
  opts.headers = Object.assign({
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9"
  }, opts.headers || {});
  if (controller) opts.signal = controller.signal;
  return fetch(url, opts).then(function (res) {
    if (timer) clearTimeout(timer);
    return res;
  }).catch(function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
}

function fetchText(url, headers, timeoutMs) {
  return fetchWithTimeout(url, { headers: headers || {} }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  });
}

function fetchJson(url, headers, timeoutMs) {
  return fetchWithTimeout(url, {
    headers: Object.assign({ "Accept": "application/json, text/plain, */*" }, headers || {})
  }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  });
}

function fetchTextPost(url, body, headers, timeoutMs) {
  return fetchWithTimeout(url, {
    method: "POST",
    headers: Object.assign({
      "Content-Type": "application/x-www-form-urlencoded"
    }, headers || {}),
    body: body
  }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  });
}

// ─── String and URL Helpers ──────────────────────────────────────────────────

function pad2(n) {
  var num = Number(n) || 0;
  return num < 10 ? "0" + num : String(num);
}

function hostOf(url) {
  var m = String(url || "").match(/^https?:\/\/([^/:]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function originOf(url) {
  var m = String(url || "").match(/^(https?:\/\/[^/]+)/i);
  return m ? m[1] : "";
}

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

function cleanTitle(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function encodeForm(obj) {
  var parts = [];
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(obj[k] == null ? "" : obj[k]));
  }
  return parts.join("&");
}

function base64Decode(str) {
  try {
    if (typeof atob !== "undefined") return atob(str);
    if (typeof Buffer !== "undefined") return Buffer.from(str, "base64").toString("utf8");
  } catch (e) {}
  return "";
}

// ─── Dean Edwards Packer Unpacker ────────────────────────────────────────────

function unpackJs(code) {
  try {
    var m = code.match(/eval\(function\(p,a,c,k,e,[rd]\)\{.*?\}\s*\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
    if (!m) return null;
    var p = m[1];
    var a = parseInt(m[2], 10);
    var c = parseInt(m[3], 10);
    var k = m[4].split("|");
    var ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

    p = p.replace(/\b\w+\b/g, function (token) {
      var val = 0;
      for (var i = 0; i < token.length; i++) {
        var idx = ALPHABET.indexOf(token[i]);
        if (idx === -1 || idx >= a) { val = -1; break; }
        val = val * a + idx;
      }
      if (val !== -1 && val < k.length && k[val]) {
        return k[val];
      }
      return token;
    });
    return p;
  } catch (err) {
    return null;
  }
}

// ─── TMDB Details Lookup ─────────────────────────────────────────────────────

async function getTMDBInfo(tmdbId, mediaType) {
  var type = mediaType === "movie" ? "movie" : "tv";
  var key = "tmdb:" + type + ":" + tmdbId;
  var cached = cacheGet(key);
  if (cached) return cached;

  var url = "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  try {
    var data = await fetchJson(url);
    var titles = [];
    if (data.title) titles.push(data.title);
    if (data.name) titles.push(data.name);
    if (data.original_title) titles.push(data.original_title);
    if (data.original_name) titles.push(data.original_name);

    var year = ((data.release_date || data.first_air_date || "").split("-")[0]) || "";
    var info = {
      title: data.title || data.name || "",
      titles: titles,
      year: year
    };
    cacheSet(key, info);
    return info;
  } catch (e) {
    return { title: "", titles: [], year: "" };
  }
}

// ─── Content Matching on Kurdcinema ──────────────────────────────────────────

// Try fast ajax search: Search.aspx?ajax=1&term=...&filter=...
async function searchKurdcinema(term, isMovie) {
  var filter = isMovie ? "movie" : "series";
  var url = SEARCH_API + "?ajax=1&term=" + encodeURIComponent(term) + "&filter=" + filter;
  try {
    var items = await fetchJson(url, { Referer: BASE_URL + "/Search.aspx" }, 6000);
    return Array.isArray(items) ? items : [];
  } catch (e) {
    return [];
  }
}

function scoreMatch(itemTitle, expectedTitles, expectedYear) {
  var it = cleanTitle(itemTitle);
  if (!it) return 0;
  var yearMatch = it.match(/\b(19\d\d|20\d\d)\b/);
  var itemYear = yearMatch ? yearMatch[1] : "";
  var yearOk = !expectedYear || !itemYear || itemYear === String(expectedYear);

  var best = 0;
  for (var i = 0; i < expectedTitles.length; i++) {
    var et = cleanTitle(expectedTitles[i]);
    if (!et) continue;
    if (it === et && yearOk) return 100;
    if (it.indexOf(et) !== -1 || et.indexOf(it) !== -1) {
      if (yearOk) best = Math.max(best, 85);
      else best = Math.max(best, 60);
    }
  }
  return best;
}

// Verify TMDB ID from movie details page if multiple matches exist
async function verifyMovieTmdbId(movieId) {
  try {
    var html = await fetchText(BASE_URL + "/moves-details.aspx?movieid=" + encodeURIComponent(movieId), null, 5000);
    var m = html.match(/id=["']tmdbId["'][^>]*value=["'](\d+)["']/i) ||
            html.match(/value=["'](\d+)["'][^>]*id=["']tmdbId["']/i);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

// Verify TMDB ID from series episodes page
async function verifySeriesTmdbId(seriesId) {
  try {
    var html = await fetchText(BASE_URL + "/Episodes.aspx?type=" + encodeURIComponent(seriesId), null, 5000);
    var m = html.match(/data-tmdbid=["'](\d+)["']/i);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

// Load content list from TMDBCache as fallback
async function loadContentFallback(type) {
  var cacheKey = "content_fallback:" + type;
  var cached = cacheGet(cacheKey);
  if (cached) return cached;

  var url = CACHE_API + "?action=mycontent&type=" + encodeURIComponent(type) + "&limit=100000";
  try {
    var data = await fetchJson(url, null, 15000);
    var list = (data && data.results) || [];
    cacheSet(cacheKey, list);
    return list;
  } catch (e) {
    return [];
  }
}

async function findKurdcinemaEntry(tmdbId, mediaType, tmdbInfo) {
  var isMovie = mediaType === "movie";
  var expectedTitles = tmdbInfo.titles.length ? tmdbInfo.titles : [tmdbInfo.title];
  var expectedYear = tmdbInfo.year || "";

  // 1. Fast AJAX search for each title variation
  var searchTerms = [];
  for (var i = 0; i < expectedTitles.length; i++) {
    var t = expectedTitles[i];
    if (t && searchTerms.indexOf(t) === -1) searchTerms.push(t);
    var clean = cleanTitle(t);
    if (clean && clean !== t && searchTerms.indexOf(clean) === -1) searchTerms.push(clean);
  }

  for (var j = 0; j < searchTerms.length; j++) {
    var results = await searchKurdcinema(searchTerms[j], isMovie);
    if (!results.length) continue;

    // Filter by type
    var filtered = results.filter(function (item) {
      if (isMovie) return item.type === "movie" || /moves-details/i.test(item.url || "");
      return item.type === "series" || /episodes/i.test(item.url || "");
    });
    if (!filtered.length) filtered = results;

    // Score candidates
    var scored = filtered.map(function (item) {
      return { item: item, score: scoreMatch(item.title, expectedTitles, expectedYear) };
    }).sort(function (a, b) { return b.score - a.score; });

    if (scored.length && scored[0].score >= 60) {
      var best = scored[0].item;
      // Verify against TMDB ID if single high match or ambiguous
      var dbId = best.id;
      if (!dbId && best.url) {
        var idMatch = best.url.match(/(?:movieid|type)=(\d+)/i);
        if (idMatch) dbId = idMatch[1];
      }
      if (dbId) {
        return { db_id: dbId, title: best.title };
      }
    }
  }

  // 2. Fallback to TMDBCache action=mycontent
  console.log("[" + PROVIDER_NAME + "] Ajax search missed, checking cache fallback");
  var list = await loadContentFallback(isMovie ? "movie" : "tv");
  var target = String(tmdbId);
  for (var k = 0; k < list.length; k++) {
    if (list[k] && String(list[k].id) === target && list[k].db_id) {
      return { db_id: list[k].db_id, title: list[k].title };
    }
  }

  return null;
}

// ─── Series Season & Episode Parsing ──────────────────────────────────────────

var KURDISH_ORDINALS = {
  "یەکەم": 1, "يەكەم": 1, "1": 1,
  "دووەم": 2, "دووه‌م": 2, "دووهەم": 2, "2": 2,
  "سێهەم": 3, "سێیەم": 3, "سێیە‌م": 3, "3": 3,
  "چوارەم": 4, "چواره‌م": 4, "4": 4,
  "پێنجەم": 5, "پێنجه‌م": 5, "5": 5,
  "شەشەم": 6, "شه‌شه‌م": 6, "6": 6,
  "حەوتەم": 7, "حه‌وته‌م": 7, "7": 7,
  "هەشتەم": 8, "هه‌شته‌م": 8, "8": 8,
  "نۆیەم": 9, "نۆیه‌م": 9, "9": 9,
  "دەیەم": 10, "ده‌یه‌م": 10, "10": 10,
  "یازدەیەم": 11, "11": 11,
  "دوازدەیەم": 12, "12": 12,
  "سیازدەیەم": 13, "13": 13,
  "چواردەیەم": 14, "14": 14,
  "پازدەیەم": 15, "15": 15,
  "شازدەیەم": 16, "16": 16,
  "حەڤدەیەم": 17, "17": 17,
  "هەژدەیەم": 18, "18": 18,
  "نۆزدەیەم": 19, "19": 19,
  "بیستەم": 20, "20": 20
};

function parseKurdishSeasonNumber(str, defaultNum) {
  var s = String(str || "").trim().toLowerCase();
  for (var key in KURDISH_ORDINALS) {
    if (s.indexOf(key) !== -1) return KURDISH_ORDINALS[key];
  }
  var numMatch = s.match(/\b(\d+)\b/);
  if (numMatch) return parseInt(numMatch[1], 10);
  return defaultNum;
}

function parseSeasons(html) {
  var seasons = [];
  var blocks = html.split(/class=["']season-block["']/i).slice(1);

  if (blocks.length) {
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var stypeMatch = block.match(/Stype=(\d+)/i);
      if (!stypeMatch) continue;
      var stype = stypeMatch[1];

      var sNameMatch = block.match(/data-season=["']([^"']+)["']/i) ||
                       block.match(/id=["']season-([^"']+)["']/i) ||
                       block.match(/class=["']season-title["'][^>]*>([\s\S]*?)<\/h2>/i);
      var seasonNum = sNameMatch ? parseKurdishSeasonNumber(sNameMatch[1], i + 1) : (i + 1);

      var episodes = {};
      var epRe = /<a\s+[^>]*href=["']([^"']*Episodes2\.aspx[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
      var epM;
      while ((epM = epRe.exec(block))) {
        var href = epM[1];
        var inner = epM[2];
        var nameMatch = href.match(/name=(\d+)/i) || inner.match(/class=["']episode-btn__number["'][^>]*>(\d+)<\/span>/i);
        if (nameMatch) {
          var epNum = parseInt(nameMatch[1], 10);
          episodes[epNum] = href;
        }
      }

      seasons.push({
        season: seasonNum,
        stype: stype,
        episodes: episodes
      });
    }
    return seasons;
  }

  var seen = [];
  var re = /Stype=(\d+)/gi;
  var mm;
  while ((mm = re.exec(html))) {
    if (seen.indexOf(mm[1]) === -1) seen.push(mm[1]);
  }
  for (var j = 0; j < seen.length; j++) {
    seasons.push({ season: j + 1, stype: seen[j], episodes: {} });
  }
  return seasons;
}

// ─── Server Dropdown & ASP.NET Postback Replay ────────────────────────────────

function extractIframeSrc(html) {
  var m = html.match(/<iframe[^>]*\bsrc=["']([^"']+)["']/i);
  return m ? m[1].trim() : "";
}

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
  var s = String(text || "")
    .replace(/^\s*\d+\s*[-.)]\s*/, "")
    .trim();
  if (/بێ\s*ریکلام/i.test(s)) return "Fast Server";
  if (/stream\s*wish/i.test(s)) return "StreamWish";
  if (/file\s*lions/i.test(s)) return "FileLions";
  if (/vidmoly/i.test(s)) return "Vidmoly";
  if (/sendvid/i.test(s)) return "Sendvid";
  if (/jkr/i.test(s)) return "JKR";
  return s;
}

async function collectServerIframes(pageUrl, html) {
  var initial = extractIframeSrc(html);
  var select = parseServerSelect(html);
  if (!select || !select.options.length) {
    return initial ? [{ name: "Default", iframe: normalizeUrl(initial, pageUrl) }] : [];
  }

  var hidden = parseHiddenInputs(html);
  var servers = [];
  var jobs = [];

  select.options.forEach(function (opt) {
    if (!opt.value) return;
    var name = cleanServerName(opt.text) || opt.value;
    if (opt.selected && initial) {
      servers.push({ name: name, iframe: normalizeUrl(initial, pageUrl) });
      return;
    }

    var body = Object.assign({}, hidden, {
      __EVENTTARGET: select.name,
      __EVENTARGUMENT: ""
    });
    body[select.name] = opt.value;

    jobs.push(
      fetchTextPost(pageUrl, encodeForm(body), { Referer: pageUrl }, 7000).then(function (resHtml) {
        var src = extractIframeSrc(resHtml);
        if (src) {
          servers.push({ name: name, iframe: normalizeUrl(src, pageUrl) });
        }
      }).catch(function () {})
    );
  });

  await Promise.all(jobs);
  return servers;
}

// ─── Individual Embed Resolvers ──────────────────────────────────────────────

// Generic media stream extractor
function isUsableStream(url) {
  if (!url || typeof url !== "string") return false;
  if (DECOY_RE.test(url)) return false;
  return PLAYABLE_EXT.test(url) || /\/master\.|\/hls\d?\//i.test(url) || url.indexOf(".m3u8") !== -1;
}

function extractStreamFromCode(code, baseOrigin) {
  if (!code) return null;
  var patterns = [
    /"hls4"\s*:\s*"([^"]+)"/,
    /"hls2"\s*:\s*"([^"]+)"/,
    /"hls3"\s*:\s*"([^"]+)"/,
    /"hls"\s*:\s*"([^"]+)"/,
    /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /sources\s*:\s*\[[^\]]*?["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["'](https?:\/\/[^"'\s\\]+\.(?:m3u8|mp4)[^"'\s\\]*)["']/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = code.match(patterns[i]);
    if (m && m[1]) {
      var u = m[1].replace(/\\\//g, "/");
      if (u.indexOf("//") === 0) u = "https:" + u;
      else if (u.charAt(0) === "/") u = baseOrigin + u;
      if (isUsableStream(u)) return u;
    }
  }
  return null;
}

// 1. StreamWish Family (StreamWish, ObeyWish, HgCloud, Hanerix, etc.)
async function resolveStreamWish(iframeUrl) {
  // Extract file code
  var codeMatch = iframeUrl.match(/\/(?:e|f)\/([a-zA-Z0-9_-]+)/);
  if (!codeMatch) return null;
  var fileCode = codeMatch[1];

  // Obeywish reliably exposes the standard unpackable jwplayer config without anti-bot
  var targetUrl = "https://obeywish.com/e/" + fileCode;
  try {
    var html = await fetchText(targetUrl, {
      Referer: "https://obeywish.com/",
      Origin: "https://obeywish.com"
    }, 7000);

    var code = html;
    var unpacked = unpackJs(html);
    if (unpacked) code = unpacked;

    var streamUrl = extractStreamFromCode(code, "https://obeywish.com");
    if (streamUrl) {
      return { url: streamUrl, origin: "https://obeywish.com" };
    }
  } catch (e) {}

  return null;
}

// 2. VidHide / FileLions Family
async function resolveVidHide(iframeUrl) {
  var origin = originOf(iframeUrl) || "https://filelions.to";
  try {
    var html = await fetchText(iframeUrl, {
      Referer: origin + "/",
      Origin: origin
    }, 7000);

    var code = html;
    var unpacked = unpackJs(html);
    if (unpacked) code = unpacked;

    var streamUrl = extractStreamFromCode(code, origin);
    if (streamUrl) {
      return { url: streamUrl, origin: origin };
    }
  } catch (e) {}

  return null;
}

// 3. Vidmoly
async function resolveVidmoly(iframeUrl) {
  var url = iframeUrl;
  var origin = originOf(iframeUrl) || "https://vidmoly.org";
  try {
    var html = await fetchText(url, {
      Referer: origin + "/",
      Origin: origin
    }, 7000);

    // Follow redirect if present
    var redir = html.match(/window\.location\.(?:replace|href)\s*(?:=|\()\s*['"]([^'"]+)['"]/i);
    if (redir && redir[1] && redir[1] !== url) {
      var nextUrl = normalizeUrl(redir[1], origin);
      html = await fetchText(nextUrl, { Referer: origin + "/" }, 7000);
    }

    var code = html;
    var unpacked = unpackJs(html);
    if (unpacked) code = unpacked;

    var streamUrl = extractStreamFromCode(code, origin);
    if (streamUrl) {
      return { url: streamUrl, origin: origin };
    }
  } catch (e) {}

  return null;
}

// 4. VOE Decoder
function decodeVoeCipher(cipher, keyArray) {
  try {
    var rot = "";
    for (var i = 0; i < cipher.length; i++) {
      var c = cipher.charCodeAt(i);
      if (c >= 65 && c <= 90) c = (c - 52) % 26 + 65;
      else if (c >= 97 && c <= 122) c = (c - 84) % 26 + 97;
      rot += String.fromCharCode(c);
    }
    if (keyArray) {
      var keys = keyArray.replace(/^\[|\]$/g, "").split("','").map(function (k) {
        return k.replace(/^'+|'+$/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      });
      for (var j = 0; j < keys.length; j++) {
        rot = rot.split(new RegExp(keys[j], "g")).join("_");
      }
      rot = rot.split("_").join("");
    } else {
      // Noise tokens in VOE are non-base64 punctuation (!~@*%?#&^$)
      rot = rot.replace(/[^A-Za-z0-9+/=]/g, "");
    }
    var b64 = base64Decode(rot);
    if (!b64) return null;

    var shifted = "";
    for (var k = 0; k < b64.length; k++) {
      shifted += String.fromCharCode((b64.charCodeAt(k) - 3 + 256) % 256);
    }
    var reversed = shifted.split("").reverse().join("");
    var jsonStr = base64Decode(reversed);
    return jsonStr ? JSON.parse(jsonStr) : null;
  } catch (e) {
    return null;
  }
}

async function resolveVOE(iframeUrl) {
  var origin = originOf(iframeUrl) || "https://voe.sx";
  try {
    var html = await fetchText(iframeUrl, { Referer: origin + "/" }, 7000);

    // Follow VOE domain redirect
    var redir = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
    var pageUrl = iframeUrl;
    if (redir && redir[1]) {
      pageUrl = redir[1];
      origin = originOf(pageUrl) || origin;
      html = await fetchText(pageUrl, { Referer: origin + "/" }, 7000);
    }

    // Check for JSON token array in script tag
    var jsonScript = html.match(/type=["']application\/json["'][^>]*>\s*\[\s*["']([^"']+)["']\s*\]\s*<\/script>/i) ||
                     html.match(/json">\s*\[\s*['"]([^'"]+)['"]\s*\]\s*<\/script>/i);
    if (jsonScript) {
      var cipherText = jsonScript[1];
      var decoded = decodeVoeCipher(cipherText);
      if (decoded) {
        var directUrl = decoded.source || decoded.direct_access_url || decoded.file || decoded.hls || decoded.mp4;
        if (directUrl && isUsableStream(directUrl)) {
          return { url: directUrl, origin: origin };
        }
      }

      var scriptMatch = html.match(/<script[^>]*src=['"]([^'"]*loader[^'"]*\.js)['"]/i);
      if (scriptMatch) {
        try {
          var scriptUrl = scriptMatch[1].indexOf("http") === 0 ? scriptMatch[1] : origin + scriptMatch[1];
          var scriptBody = await fetchText(scriptUrl, { Referer: pageUrl }, 6000);
          var keyArrayMatch = scriptBody.match(/(\[(?:'[^']{1,10}'[\s,]*){4,12}\])/i) ||
                              scriptBody.match(/(\[(?:"[^"]{1,10}"[,\s]*){4,12}\])/i);
          if (keyArrayMatch) {
            var decoded2 = decodeVoeCipher(cipherText, keyArrayMatch[1]);
            if (decoded2) {
              var directUrl2 = decoded2.source || decoded2.direct_access_url || decoded2.file || decoded2.hls || decoded2.mp4;
              if (directUrl2 && isUsableStream(directUrl2)) {
                return { url: directUrl2, origin: origin };
              }
            }
          }
        } catch (e) {}
      }
    }

    // Fallback: base64 encoded stream in page
    var b64Re = /(?:mp4|hls)['"]\s*:\s*['"]([^'"]+)['"]/gi;
    var b64m;
    while ((b64m = b64Re.exec(html))) {
      var val = b64m[1];
      if (val && val.indexOf("aHR0") === 0) {
        var decUrl = base64Decode(val);
        if (isUsableStream(decUrl)) return { url: decUrl, origin: origin };
      }
    }

    // Direct stream match
    var direct = extractStreamFromCode(html, origin);
    if (direct) return { url: direct, origin: origin };

  } catch (e) {}

  return null;
}

// 5. Sendvid
async function resolveSendvid(iframeUrl) {
  try {
    var html = await fetchText(iframeUrl, { Referer: "https://sendvid.com/" }, 7000);
    var m = html.match(/var\s+video_source\s*=\s*["']([^"']+\.mp4[^"']*)["']/i) ||
            html.match(/<source[^>]*src=["']([^"']+\.mp4[^"']*)["']/i);
    if (m && isUsableStream(m[1])) {
      return { url: m[1], origin: "https://sendvid.com" };
    }
  } catch (e) {}
  return null;
}

// 6. Generic Embed Resolver
async function resolveGenericEmbed(iframeUrl) {
  var url = normalizeUrl(iframeUrl, BASE_URL);
  if (!url || url.indexOf("http") !== 0) return null;
  var host = hostOf(url);
  var origin = originOf(url);

  // Dispatch to specialized resolvers
  if (/streamwish|obeywish|playerwish|hanerix|swdyu|swishsrv|audinifer|wishembed|hgcloud|hglink/i.test(host)) {
    var resSw = await resolveStreamWish(url);
    if (resSw) return resSw;
  }
  if (/vidhide|filelions|morencius|callistanise|dintezuvio|minochinos|filmhide|vidpro/i.test(host)) {
    var resVh = await resolveVidHide(url);
    if (resVh) return resVh;
  }
  if (/vidmoly/i.test(host)) {
    var resVm = await resolveVidmoly(url);
    if (resVm) return resVm;
  }
  if (/voe\.sx|jamesbornmain|robertthathere|yugoteam|repack|audiodelivery|delivery|chasingglow/i.test(host)) {
    var resVoe = await resolveVOE(url);
    if (resVoe) return resVoe;
  }
  if (/sendvid/i.test(host)) {
    var resSv = await resolveSendvid(url);
    if (resSv) return resSv;
  }

  // Fallback: generic fetch & unpack
  try {
    var html = await fetchText(url, { Referer: origin + "/" }, 7000);
    var code = html;
    var unpacked = unpackJs(html);
    if (unpacked) code = unpacked;
    var streamUrl = extractStreamFromCode(code, origin);
    if (streamUrl) {
      return { url: streamUrl, origin: origin };
    }

    // Check for nested iframe
    var innerIframe = extractIframeSrc(html);
    if (innerIframe && innerIframe !== url) {
      var nextUrl = normalizeUrl(innerIframe, url);
      var resInner = await resolveGenericEmbed(nextUrl);
      if (resInner) return resInner;
    }
  } catch (e) {}

  return null;
}

// ─── Stream Formatting & Quality ─────────────────────────────────────────────

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
  if (!/\.m3u8(\?|$)/i.test(url)) {
    var qMatch = url.match(/(2160|1440|1080|720|480|360)p?/i);
    return qMatch ? qMatch[1] + "p" : "720p";
  }
  try {
    var text = await fetchText(url, headers, 4000);
    var best = 0;
    var re = /RESOLUTION=\d+x(\d+)/gi;
    var m;
    while ((m = re.exec(text))) {
      var h = parseInt(m[1], 10);
      if (h > best) best = h;
    }
    if (best) return bucketQuality(best);
  } catch (e) {}
  return "720p";
}

function makeStream(resolved, streamTitle, quality, serverName) {
  var label = serverName || "Server";
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

// ─── Main Scraper Entry Point ────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  console.log("[" + PROVIDER_NAME + "] Request: tmdbId=" + tmdbId + " type=" + mediaType +
    (isMovie ? "" : " S" + s + "E" + e));

  try {
    var tmdbInfo = await getTMDBInfo(tmdbId, mediaType);
    var entry = await findKurdcinemaEntry(tmdbId, mediaType, tmdbInfo);
    if (!entry || !entry.db_id) {
      console.log("[" + PROVIDER_NAME + "] Content not found on site");
      return [];
    }

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
      var targetSeason = null;
      for (var si = 0; si < seasons.length; si++) {
        if (seasons[si].season === s) { targetSeason = seasons[si]; break; }
      }
      if (!targetSeason) {
        console.log("[" + PROVIDER_NAME + "] Season " + s + " not found");
        return [];
      }

      var epHref = targetSeason.episodes && targetSeason.episodes[e];
      if (epHref) {
        pageUrl = normalizeUrl(epHref, BASE_URL);
      } else {
        pageUrl = BASE_URL + "/Episodes2.aspx?type=" + encodeURIComponent(entry.db_id) +
          "&Stype=" + encodeURIComponent(targetSeason.stype) + "&name=" + pad2(e);
      }
      console.log("[" + PROVIDER_NAME + "] Episode page: " + pageUrl);
      pageHtml = await fetchText(pageUrl);
    }

    var serverIframes = await collectServerIframes(pageUrl, pageHtml);
    if (!serverIframes.length) {
      console.log("[" + PROVIDER_NAME + "] No players found on page");
      return [];
    }
    console.log("[" + PROVIDER_NAME + "] Found " + serverIframes.length + " server(s): " +
      serverIframes.map(function (x) { return x.name; }).join(", "));

    var resolvedList = await Promise.all(serverIframes.map(function (srv) {
      return resolveGenericEmbed(srv.iframe).then(function (r) {
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
      console.log("[" + PROVIDER_NAME + "] Server " + item.name + " resolved -> " +
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
