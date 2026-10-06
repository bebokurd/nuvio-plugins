// Beenar Scraper for Nuvio Local Scrapers
// Kurdish (Sorani) subtitled movies & TV series from beenar.net
// Compatible with React Native / Hermes and Node.js

"use strict";

var PROVIDER_NAME = "Beenar";
var BASE_URL = "https://beenar.net";
var API_URL = BASE_URL + "/api/client";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 12000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
var CACHE_TTL_MS = 20 * 60 * 1000;

// Domains that only appear as decoys or test media
var DECOY_RE = /test-videos\.co\.uk|bigbuckbunny|sample-videos\.com|w3\.org|schema\.org/i;

// Playable media extensions
var PLAYABLE_EXT = /\.(m3u8|mp4|mkv)(\?|$)/i;

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
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ckb,en-US;q=0.9"
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

function apiHeaders(extra) {
  return Object.assign({
    "Accept": "application/json, text/plain, */*",
    "Referer": BASE_URL + "/",
    "Origin": BASE_URL
  }, extra || {});
}

function apiPost(path, payload, timeoutMs) {
  return fetchWithTimeout(API_URL + path, {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload)
  }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  });
}

function apiGet(path, timeoutMs) {
  return fetchJson(API_URL + path, apiHeaders(), timeoutMs);
}

// ─── String and URL Helpers ───────────────────────────────────────────────────

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
  if (u.charAt(0) === "/") return (originOf(base) || BASE_URL) + u;
  return u;
}

function cleanTitle(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function base64Decode(str) {
  try {
    if (typeof atob !== "undefined") return atob(str);
    if (typeof Buffer !== "undefined") return Buffer.from(str, "base64").toString("utf8");
  } catch (e) {}
  return "";
}

function randomStr(length) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var out = "";
  for (var i = 0; i < length; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function extractIframeSrc(html) {
  var m = html.match(/<iframe[^>]*\bsrc=["']([^"']+)["']/i);
  return m ? m[1].trim() : "";
}

// ─── Dean Edwards Packer Unpacker ────────────────────────────────────────────

function unpackJs(code) {
  try {
    var m = code.match(/eval\(function\(p,a,c,k,e,[rd]\)\{.*?\}\s*\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
    if (!m) return null;
    var p = m[1];
    var a = parseInt(m[2], 10);
    var k = m[4].split("|");
    var ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

    p = p.replace(/\b\w+\b/g, function (token) {
      var val = 0;
      for (var i = 0; i < token.length; i++) {
        var idx = ALPHABET.indexOf(token[i]);
        if (idx === -1 || idx >= a) { val = -1; break; }
        val = val * a + idx;
      }
      if (val !== -1 && val < k.length && k[val]) return k[val];
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

// ─── Beenar Catalog Search ───────────────────────────────────────────────────

// POST /client/movie { filter_name, part, ... } — part 1 = movies, part 2 = series
async function searchBeenar(term, part) {
  var key = "search:" + part + ":" + term.toLowerCase();
  var cached = cacheGet(key);
  if (cached) return cached;

  var payload = {
    filter_genres: [],
    filter_years: [],
    filter_name: term,
    filter_country: null,
    filter_sort: "newest",
    filter_runtime: null,
    filter_status: null,
    filter_4k: false,
    page: 1,
    part: part,
    type: null,
    lang: null
  };

  try {
    var data = await apiPost("/movie", payload, 9000);
    var items = (data && data.data && data.data.data) || [];
    cacheSet(key, items);
    return items;
  } catch (e) {
    return [];
  }
}

function scoreMatch(item, expectedTitles, expectedYear) {
  var it = cleanTitle(item.name);
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
      best = Math.max(best, yearOk ? 85 : 55);
      continue;
    }
    // loose token containment (handles punctuation / article differences)
    var etTokens = et.split(" ").filter(function (t) { return t.length > 2; });
    if (!etTokens.length) continue;
    var hits = etTokens.filter(function (t) { return it.indexOf(t) !== -1; }).length;
    if (hits === etTokens.length) best = Math.max(best, yearOk ? 80 : 50);
    else if (hits >= etTokens.length - 1 && hits > 0) best = Math.max(best, yearOk ? 65 : 40);
  }
  return best;
}

async function findBeenarEntry(tmdbInfo, isMovie) {
  var expectedTitles = tmdbInfo.titles.length ? tmdbInfo.titles : [tmdbInfo.title];
  var expectedYear = tmdbInfo.year || "";

  var terms = [];
  for (var i = 0; i < expectedTitles.length; i++) {
    var t = expectedTitles[i];
    if (!t) continue;
    if (terms.indexOf(t) === -1) terms.push(t);
    var clean = cleanTitle(t);
    if (clean && clean !== t && terms.indexOf(clean) === -1) terms.push(clean);
  }
  if (!terms.length) return null;

  var part = isMovie ? 1 : 2;

  for (var j = 0; j < terms.length; j++) {
    var results = await searchBeenar(terms[j], part);
    if (!results.length) continue;

    // Keep only entries that match the requested media type
    var candidates = results.filter(function (item) {
      return isMovie ? !Number(item.is_series) : !!Number(item.is_series);
    });
    if (!candidates.length) candidates = results;

    var scored = candidates.map(function (item) {
      return { item: item, score: scoreMatch(item, expectedTitles, expectedYear) };
    }).sort(function (a, b) { return b.score - a.score; });

    if (scored.length && scored[0].score >= 65) {
      return scored[0].item;
    }
  }

  return null;
}

// ─── Title Detail (movies & series) ──────────────────────────────────────────

function normalizeVideo(video) {
  var url = normalizeUrl(video.url, BASE_URL);
  if (!url || url.indexOf("http") !== 0) return null;
  if (/youtu\.?be|youtube\.com/i.test(url)) return null;

  var category = String(video.category || "").toLowerCase();
  if (category !== "full") return null;

  return {
    url: url,
    quality: video.quality || "",
    server: (video.server && video.server.name) || ""
  };
}

async function getMovieVideos(titleId) {
  var data = await apiGet("/title-show/" + encodeURIComponent(titleId), 9000);
  var videos = (data && data.data && data.data.videos) || [];
  return videos.map(normalizeVideo).filter(Boolean);
}

async function getSeriesVideos(titleId, season, episode) {
  var series = await apiGet("/series-show/" + encodeURIComponent(titleId) + "?part=2", 11000);
  var seasons = (series && series.data && series.data.seasons) || [];
  if (!seasons.length) return [];

  var target = null;
  for (var i = 0; i < seasons.length; i++) {
    if (Number(seasons[i].number) === Number(season)) { target = seasons[i]; break; }
  }
  if (!target) return [];

  // The series payload only inlines the first season's episodes
  var episodes = target.episodes || [];
  if (!episodes.length) {
    var seasonKey = "season:" + target.id + ":" + season + ":" + episode;
    episodes = cacheGet(seasonKey) || [];
    if (!episodes.length) {
      try {
        var seasonData = await apiGet("/series-season/" + encodeURIComponent(target.id), 11000);
        // This endpoint answers with a bare { season, episodes } payload (no "data" wrapper)
        episodes = (seasonData && seasonData.episodes) ||
                   (seasonData && seasonData.data && seasonData.data.episodes) ||
                   [];
      } catch (e) {
        episodes = [];
      }
    }
    cacheSet(seasonKey, episodes);
  }

  var picked = null;
  for (var j = 0; j < episodes.length; j++) {
    if (Number(episodes[j].episode_number) === Number(episode)) { picked = episodes[j]; break; }
  }
  if (!picked && episodes.length === 1) picked = episodes[0];
  if (!picked) return [];

  var videos = picked.videos || [];
  return videos.map(normalizeVideo).filter(Boolean);
}

// ─── Individual Embed Resolvers ──────────────────────────────────────────────

function isUsableStream(url) {
  if (!url || typeof url !== "string") return false;
  if (DECOY_RE.test(url)) return false;
  if (/drive\.google\.com\/uc\?export=download/i.test(url)) return true;
  return PLAYABLE_EXT.test(url) || /\/master\.|\/hls\d?\//i.test(url) || url.indexOf(".m3u8") !== -1;
}

function extractStreamFromCode(code, baseOrigin) {
  if (!code) return null;
  var patterns = [
    /"hls4"\s*:\s*"([^"]+)"/,
    /"hls2"\s*:\s*"([^"]+)"/,
    /"hls"\s*:\s*"([^"]+)"/,
    /file\s*:\s*["']([^"']+\.(?:m3u8|mp4|mkv)[^"']*)["']/i,
    /sources\s*:\s*\[[^\]]*?["'](https?:\/\/[^"']+\.(?:m3u8|mp4|mkv)[^"']*)["']/i,
    /["'](https?:\/\/[^"'\s\\]+\.(?:m3u8|mp4|mkv)[^"'\s\\]*)["']/i,
    /["'](\/\/[^"'\s\\]+\.(?:m3u8|mp4|mkv)[^"'\s\\]*)["']/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = code.match(patterns[i]);
    if (m && m[1]) {
      var u = m[1].replace(/\\\//g, "/");
      if (u.indexOf("//") === 0) u = "https:" + u;
      else if (u.charAt(0) === "/") u = (baseOrigin || "") + u;
      if (isUsableStream(u)) return u;
    }
  }
  return null;
}

// Pull a playable URL out of an embed page (raw markup first, then unpacked JS)
function extractFromHtml(html, origin) {
  var raw = extractStreamFromCode(html, origin);
  if (raw) return raw;
  var unpacked = unpackJs(html);
  if (unpacked) {
    var fromPacked = extractStreamFromCode(unpacked, origin);
    if (fromPacked) return fromPacked;
  }
  return null;
}

// 1. StreamWish family (StreamSB, StreamWish, ObeyWish, HgCloud, PlayerWish, ...)
var STREAMWISH_HOSTS = /streamwish|obeywish|playerwish|jodwish|strwish|sfastwish|hlswish|swishsrv|audinifer|wishembed|hgcloud|hglink|iplayerhls|hanerix|swdyu|swishhub|filesb|buzzfile|1oxa|streamhie/i;

async function resolveStreamWish(iframeUrl) {
  var codeMatch = iframeUrl.match(/\/(?:e|f)\/([a-zA-Z0-9_-]+)/);
  if (!codeMatch) return null;
  var fileCode = codeMatch[1];
  var ownHost = hostOf(iframeUrl);
  var ownOrigin = originOf(iframeUrl);

  var mirrors = [
    "https://obeywish.com",
    ownOrigin,
    "https://swdyu.com",
    "https://playerwish.com",
    "https://strwish.com",
    "https://hlswish.com",
    "https://streamwish.to"
  ];

  var tried = {};
  for (var i = 0; i < mirrors.length; i++) {
    var origin = mirrors[i];
    if (!origin || tried[origin]) continue;
    tried[origin] = true;

    var targetUrl = origin + "/e/" + fileCode;
    try {
      var html = await fetchText(targetUrl, {
        "Referer": origin + "/",
        "Origin": origin
      }, 7000);

      var streamUrl = extractFromHtml(html, origin);
      if (streamUrl) return { url: streamUrl, origin: origin };
    } catch (e) {}
  }

  // Some mirrors expose the download route only
  if (ownHost) {
    try {
      var html2 = await fetchText(ownOrigin + "/f/" + fileCode, { "Referer": ownOrigin + "/" }, 7000);
      var s2 = extractFromHtml(html2, ownOrigin);
      if (s2) return { url: s2, origin: ownOrigin };
    } catch (e) {}
  }

  return null;
}

// 2. Vidmoly (host + unpacked JS on the same page)
async function resolveVidmoly(iframeUrl) {
  var origin = originOf(iframeUrl) || "https://vidmoly.net";
  try {
    var html = await fetchText(iframeUrl, {
      "Referer": origin + "/",
      "Origin": origin
    }, 8000);

    var streamUrl = extractFromHtml(html, origin);
    if (streamUrl) return { url: streamUrl, origin: origin };

    // Some builds bounce to the player host before rendering
    var redir = html.match(/window\.location\.(?:replace|href)\s*(?:=|\()\s*['"]([^'"]+)['"]/i);
    if (redir && redir[1]) {
      var nextUrl = normalizeUrl(redir[1], origin);
      if (nextUrl && nextUrl !== iframeUrl) {
        var html2 = await fetchText(nextUrl, { "Referer": origin + "/" }, 8000);
        var s2 = extractFromHtml(html2, originOf(nextUrl) || origin);
        if (s2) return { url: s2, origin: originOf(nextUrl) || origin };
      }
    }
  } catch (e) {}

  return null;
}

// 3. VidHide / FileLions family
async function resolveVidHide(iframeUrl) {
  var origin = originOf(iframeUrl) || "https://filelions.to";
  try {
    var html = await fetchText(iframeUrl, {
      "Referer": origin + "/",
      "Origin": origin
    }, 8000);
    var streamUrl = extractFromHtml(html, origin);
    if (streamUrl) return { url: streamUrl, origin: origin };
  } catch (e) {}
  return null;
}

// 4. VOE decoder
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
      rot = rot.replace(/[^A-Za-z0-9+/=]/g, "");
    }
    var b64 = base64Decode(rot);
    if (!b64) return null;

    var shifted = "";
    for (var k = 0; k < b64.length; k++) {
      shifted += String.fromCharCode((b64.charCodeAt(k) - 3 + 256) % 256);
    }
    var jsonStr = base64Decode(shifted.split("").reverse().join(""));
    return jsonStr ? JSON.parse(jsonStr) : null;
  } catch (e) {
    return null;
  }
}

async function resolveVOE(iframeUrl) {
  var origin = originOf(iframeUrl) || "https://voe.sx";
  var pageUrl = iframeUrl;
  try {
    var html = await fetchText(iframeUrl, { "Referer": origin + "/" }, 8000);

    var redir = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
    if (redir && redir[1]) {
      pageUrl = normalizeUrl(redir[1], origin);
      origin = originOf(pageUrl) || origin;
      html = await fetchText(pageUrl, { "Referer": origin + "/" }, 8000);
    }

    var jsonScript = html.match(/type=["']application\/json["'][^>]*>\s*\[\s*["']([^"']+)["']\s*\]\s*<\/script>/i) ||
                     html.match(/json">\s*\[\s*['"]([^'"]+)['"]\s*\]<\/script>/i);
    if (jsonScript) {
      var decoded = decodeVoeCipher(jsonScript[1]);
      if (decoded) {
        var directUrl = decoded.source || decoded.direct_access_url || decoded.file || decoded.hls || decoded.mp4;
        if (directUrl && isUsableStream(directUrl)) return { url: directUrl, origin: origin };
      }
    }

    var direct = extractFromHtml(html, origin);
    if (direct) return { url: direct, origin: origin };
  } catch (e) {}

  return null;
}

// 5. Sendvid (direct mp4)
async function resolveSendvid(iframeUrl) {
  var origin = originOf(iframeUrl) || "https://sendvid.com";
  try {
    var html = await fetchText(iframeUrl, { "Referer": origin + "/" }, 7000);
    var m = html.match(/var\s+video_source\s*=\s*["']([^"']+\.mp4[^"']*)["']/i) ||
            html.match(/<source[^>]*src=["']([^"']+\.mp4[^"']*)["']/i);
    if (m && isUsableStream(m[1])) return { url: m[1], origin: origin };
  } catch (e) {}
  return null;
}

// 6. DoodStream
async function resolveDood(iframeUrl) {
  var origin = originOf(iframeUrl);
  if (!origin) return null;
  try {
    var html = await fetchText(iframeUrl, { "Referer": iframeUrl }, 8000);
    var md5Match = html.match(/\$\.get\(\s*['"]\/pass_md5\/([^'"]+)['"]/) ||
                   html.match(/['"]\/pass_md5\/([^'"]+)['"]/);
    if (!md5Match) return null;
    var md5Path = md5Match[1];
    var token = md5Path.substring(md5Path.lastIndexOf("/") + 1);
    var passRes = await fetchText(origin + "/pass_md5/" + md5Path, { "Referer": iframeUrl }, 8000);
    var base = (passRes || "").trim();
    if (!base) return null;
    return {
      url: base + randomStr(10) + "?token=" + token + "&expiry=" + Date.now(),
      origin: origin + "/"
    };
  } catch (e) {}
  return null;
}

// 7. MixDrop (direct mp4)
async function resolveMixdrop(iframeUrl) {
  var origin = originOf(iframeUrl) || "https://mixdrop.to";
  try {
    var html = await fetchText(iframeUrl, { "Referer": origin + "/" }, 7000);
    var m = html.match(/<video[^>]*src=["']([^"']+)["']/i) ||
            html.match(/<source[^>]*src=["']([^"']+)["']/i) ||
            html.match(/property=["']og:video[^"']*["'][^>]*content=["']([^"']+)["']/i);
    if (m && m[1]) {
      var u = normalizeUrl(m[1], origin);
      if (isUsableStream(u)) return { url: u, origin: origin };
    }
  } catch (e) {}
  return null;
}

// 8. Google Drive preview links
async function resolveGoogleDrive(url) {
  var m = url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
  if (!m) return null;

  var fileId = m[1];
  var direct = "https://drive.google.com/uc?export=download&id=" + fileId;

  // Beenar keeps dead Drive links around, so drop the ones Drive no longer serves
  try {
    var probe = await fetchWithTimeout(direct, {
      method: "GET",
      headers: { "User-Agent": UA }
    }, 8000);
    var ct = (probe.headers.get("content-type") || "").toLowerCase();
    var isHtml = ct.indexOf("text/html") === 0;
    var probeText = (!probe.ok || isHtml) ? (await probe.text()).slice(0, 600).toLowerCase() : "";

    if (!probe.ok || /error 404|not found|forbidden|sorry, unable/.test(probeText)) {
      return { dead: true };
    }

    // Google serves a virus-scan interstitial for larger files
    if (isHtml && /name=["']confirm["']/.test(probeText)) {
      return {
        url: "https://drive.google.com/uc?export=download&confirm=t&id=" + fileId,
        origin: "https://drive.google.com"
      };
    }
  } catch (e) {}

  return { url: direct, origin: "https://drive.google.com" };
}

// Detect the client-side redirect targets some players use (ronemo, europixhd, ...)
function extractRedirectTarget(html, currentUrl) {
  var patterns = [
    /window\.location\.href\s*=\s*['"]([^'"]+)['"]/i,
    /window\.location\.replace\(\s*['"]([^'"]+)['"]\s*\)/i,
    /window\.location\.assign\(\s*['"]([^'"]+)['"]\s*\)/i,
    /location\.href\s*=\s*['"]([^'"]+)['"]/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>\s]+)/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = html.match(patterns[i]);
    if (m && m[1]) {
      var target = normalizeUrl(m[1].replace(/&amp;/g, "&"), currentUrl);
      if (target && target !== currentUrl) return target;
    }
  }
  return null;
}

// 9. Generic embed resolver (follows JS / meta redirects and nested iframes)
async function resolveGenericEmbed(iframeUrl, depth) {
  var level = depth || 0;
  var url = normalizeUrl(iframeUrl, BASE_URL);
  if (!url || url.indexOf("http") !== 0) return null;
  var origin = originOf(url);

  try {
    var html = await fetchText(url, { "Referer": BASE_URL + "/", "Origin": origin }, 8000);
    var streamUrl = extractFromHtml(html, origin);
    if (streamUrl) return { url: streamUrl, origin: origin };

    if (level < 3) {
      var inner = extractIframeSrc(html) || extractRedirectTarget(html, url);
      if (inner) {
        var nextUrl = normalizeUrl(inner, url);
        if (nextUrl && nextUrl !== url) {
          var resInner = await resolveGenericEmbed(nextUrl, level + 1);
          if (resInner) return resInner;
        }
      }
    }

    // json based players that expose the manifest through a separate endpoint
    var apiMatch = html.match(/["'](https?:\/\/[^"']*(?:sources?|playlist|master)[^"']*\.(?:m3u8|mp4)[^"']*)["']/i);
    if (apiMatch) {
      var apiUrl = apiMatch[1].replace(/\\\//g, "/");
      if (isUsableStream(apiUrl)) return { url: apiUrl, origin: originOf(apiUrl) || origin };
    }
  } catch (e) {}

  return null;
}

// Master dispatch
async function resolveEmbed(url) {
  var host = hostOf(url);

  if (/drive\.google\.com/i.test(host)) return resolveGoogleDrive(url);

  if (STREAMWISH_HOSTS.test(host)) {
    var sw = await resolveStreamWish(url);
    if (sw) return sw;
  }
  if (/vidmoly/i.test(host)) {
    var vm = await resolveVidmoly(url);
    if (vm) return vm;
  }
  if (/vidhide|filelions|morencius|callistanise|dintezuvio|minochinos|guccihide|fviplions|megacloud/i.test(host)) {
    var vh = await resolveVidHide(url);
    if (vh) return vh;
  }
  if (/voe\.sx|jamesbornmain|robertthathere|yugoteam|repack|audiodelivery|chasingglow/i.test(host)) {
    var voe = await resolveVOE(url);
    if (voe) return voe;
  }
  if (/sendvid/i.test(host)) {
    var sv = await resolveSendvid(url);
    if (sv) return sv;
  }
  if (/dood|ds2play|bigwar5/i.test(host)) {
    var dd = await resolveDood(url);
    if (dd) return dd;
  }
  if (/mixdrop/i.test(host)) {
    var mx = await resolveMixdrop(url);
    if (mx) return mx;
  }

  return resolveGenericEmbed(url, 0);
}

// ─── Stream Formatting & Quality ─────────────────────────────────────────────

function bucketQuality(height) {
  if (height >= 2000) return "4K";
  if (height >= 1300) return "1440p";
  if (height >= 900) return "1080p";
  if (height >= 600) return "720p";
  if (height >= 400) return "480p";
  if (height >= 300) return "360p";
  return "Auto";
}

function normalizeQualityLabel(value) {
  var q = String(value || "").toLowerCase();
  if (!q) return "Auto";
  if (/2160|4k|uhd/.test(q)) return "4K";
  if (/1440|2k/.test(q)) return "1440p";
  if (/1080|fhd/.test(q)) return "1080p";
  if (/720|hd/.test(q)) return "720p";
  if (/480|sd/.test(q)) return "480p";
  if (/360/.test(q)) return "360p";
  var m = q.match(/(\d{3,4})/);
  if (m) return bucketQuality(parseInt(m[1], 10));
  return "Auto";
}

var QUALITY_ORDER = {
  "4K": 5,
  "1440p": 4,
  "1080p": 3,
  "720p": 2,
  "480p": 1,
  "360p": 0,
  "Auto": -1
};

async function inferQuality(url, headers, fallback) {
  var known = normalizeQualityLabel(fallback);
  if (!/\.m3u8(\?|$)/i.test(url)) {
    if (known !== "Auto") return known;
    var qMatch = url.match(/(2160|1440|1080|720|480|360)p?/i);
    return qMatch ? qMatch[1] + "p" : "720p";
  }

  // Some CDNs only serve the manifest for their own origin, others need the embed origin
  var referers = [originOf(url) + "/"];
  if (headers && headers.Referer && headers.Referer !== referers[0]) referers.push(headers.Referer);

  for (var i = 0; i < referers.length; i++) {
    try {
      var text = await fetchText(url, {
        "User-Agent": UA,
        "Referer": referers[i]
      }, 4500);
      var best = 0;
      var re = /RESOLUTION=\d+x(\d+)/gi;
      var m;
      while ((m = re.exec(text))) {
        var h = parseInt(m[1], 10);
        if (h > best) best = h;
      }
      if (best) return bucketQuality(best);
    } catch (e) {}
  }
  return known !== "Auto" ? known : "720p";
}

function serverLabel(video) {
  var name = String(video.server || "").trim();
  if (!name) {
    var host = hostOf(video.url).replace(/^www\./, "");
    name = host.split(".")[0];
  }
  // Kurdish server labels on the site (Beenar, Vidmoly, StreamSB, ...)
  return name;
}

function makeStream(resolved, streamTitle, quality, label, direct) {
  var referer = resolved.origin ? resolved.origin + "/" : BASE_URL + "/";
  return {
    name: PROVIDER_NAME + " [" + label + (direct ? "" : " · KU Sub") + "]",
    title: streamTitle + " · " + quality,
    url: resolved.url,
    quality: quality,
    isDirect: !!direct,
    headers: {
      "User-Agent": UA,
      "Referer": referer,
      "Origin": resolved.origin || BASE_URL
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
    if (!tmdbInfo.title && !tmdbInfo.titles.length) {
      console.log("[" + PROVIDER_NAME + "] TMDB metadata unavailable");
      return [];
    }

    var entry = await findBeenarEntry(tmdbInfo, isMovie);
    if (!entry) {
      console.log("[" + PROVIDER_NAME + "] Content not found on Beenar");
      return [];
    }
    console.log("[" + PROVIDER_NAME + "] Matched: " + entry.name + " (id " + entry.id + ")");

    var videos = isMovie
      ? await getMovieVideos(entry.id)
      : await getSeriesVideos(entry.id, s, e);

    if (!videos.length) {
      console.log("[" + PROVIDER_NAME + "] No playable videos for this request");
      return [];
    }

    var streamTitle = (tmdbInfo.title || entry.name) +
      (isMovie ? "" : " S" + pad2(s) + "E" + pad2(e)) +
      (tmdbInfo.year ? " (" + tmdbInfo.year + ")" : "");

    console.log("[" + PROVIDER_NAME + "] Servers: " +
      videos.map(function (v) { return serverLabel(v); }).join(", "));

    var resolvedList = await Promise.all(videos.map(async function (video) {
      try {
        var resolved = await resolveEmbed(video.url);
        if (resolved) return { resolved: resolved, video: video };
      } catch (err) {
        console.log("[" + PROVIDER_NAME + "] " + serverLabel(video) + " resolver error: " + err.message);
      }
      return null;
    }));

    var streams = [];
    var seenUrls = {};
    var solvedVideos = {};
    var deadVideos = {};
    var pending = [];

    for (var i = 0; i < resolvedList.length; i++) {
      var item = resolvedList[i];
      if (!item) continue;

      var resolved = item.resolved;
      if (resolved.dead) {
        deadVideos[item.video.url] = true;
        solvedVideos[item.video.url] = true;
        console.log("[" + PROVIDER_NAME + "] " + serverLabel(item.video) + " -> dead link, skipped");
        continue;
      }

      if (seenUrls[resolved.url]) continue;
      seenUrls[resolved.url] = true;
      solvedVideos[item.video.url] = true;

      pending.push({
        resolved: resolved,
        video: item.video,
        isDirect: !!isUsableStream(resolved.url)
      });
    }

    // Measuring real resolutions hits the network, so do it in parallel
    streams = await Promise.all(pending.map(async function (p) {
      var quality = await inferQuality(p.resolved.url, {
        "User-Agent": UA,
        "Referer": (p.resolved.origin || BASE_URL) + "/"
      }, p.video.quality);

      console.log("[" + PROVIDER_NAME + "] " + serverLabel(p.video) + " (" + quality + ") -> " +
        p.resolved.url.slice(0, 90) + "...");

      return makeStream(p.resolved, streamTitle, quality, serverLabel(p.video), p.isDirect);
    }));

    // Unresolved embeds are still offered so the in-app player can try them
    for (var j = 0; j < videos.length; j++) {
      var v = videos[j];
      if (deadVideos[v.url] || solvedVideos[v.url] || seenUrls[v.url]) continue;
      seenUrls[v.url] = true;
      streams.push({
        name: PROVIDER_NAME + " [" + serverLabel(v) + " · Embed]",
        title: streamTitle + " · " + normalizeQualityLabel(v.quality),
        url: v.url,
        quality: normalizeQualityLabel(v.quality),
        isDirect: false,
        headers: {
          "User-Agent": UA,
          "Referer": BASE_URL + "/",
          "Origin": originOf(v.url) || BASE_URL
        },
        subtitles: []
      });
    }

    streams.sort(function (a, b) {
      if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
      return (QUALITY_ORDER[b.quality] || -1) - (QUALITY_ORDER[a.quality] || -1);
    });
    streams.forEach(function (st) { delete st.isDirect; });

    console.log("[" + PROVIDER_NAME + "] Done: " + streams.length + " stream(s)");
    return streams;

  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };