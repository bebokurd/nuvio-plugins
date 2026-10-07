// KRD Watch Scraper for Nuvio Local Scrapers
// Kurdish subtitled movies, series, anime & K-dramas from krd.watch
//   search -> player.php -> proxied MP4 source + subtitle tracks
// Compatible with React Native / Hermes and Node.js

"use strict";

var PROVIDER_NAME = "KRD Watch";
var BASE_URL = "https://krd.watch";
var API_URL = BASE_URL + "/api/";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 15000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
var CACHE_TTL_MS = 20 * 60 * 1000;

var DEFAULT_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/json,*/*;q=0.8",
  "Referer": BASE_URL + "/"
};

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
  return value;
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
  opts.headers = Object.assign({}, DEFAULT_HEADERS, opts.headers || {});
  if (controller) opts.signal = controller.signal;
  return fetch(url, opts).then(function (res) {
    if (timer) clearTimeout(timer);
    return res;
  }, function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
}

function fetchText(url, headers, timeoutMs) {
  return fetchWithTimeout(url, { headers: headers }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  });
}

function fetchJson(url, headers, timeoutMs) {
  return fetchWithTimeout(url, { headers: headers }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  });
}

// ─── String Utilities ─────────────────────────────────────────────────────────

function pad2(n) {
  var num = Number(n) || 0;
  return num < 10 ? "0" + num : String(num);
}

function queryEscape(value) {
  return encodeURIComponent(String(value || ""));
}

function normalizeTitle(str) {
  return String(str || "")
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/&/g, " and ")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase()
    .replace(/\bthe\s+/g, " ")
    .replace(/\bseason\s*\d+\b/g, " ")
    .replace(/\bpart\s*\d+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) === 0 || b.indexOf(a) === 0) return 0.9;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.8;

  var at = a.split(" ");
  var bt = b.split(" ");
  if (!at.length || !bt.length) return 0;
  var hit = 0;
  for (var i = 0; i < at.length; i++) {
    if (bt.indexOf(at[i]) !== -1) hit++;
  }
  return (2 * hit) / (at.length + bt.length);
}

function yearOf(value) {
  var m = String(value || "").match(/(19\d\d|20\d\d)/);
  return m ? m[1] : "";
}

function unescapeJs(str) {
  return String(str || "")
    .replace(/\r/g, "")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function absUrl(path) {
  var p = String(path || "").trim();
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p;
  if (p.charAt(0) !== "/") p = "/" + p;
  return BASE_URL + p;
}

// ─── TMDB Details Lookup ─────────────────────────────────────────────────────

async function getTMDBInfo(tmdbId, mediaType) {
  var type = mediaType === "movie" ? "movie" : "tv";
  var key = "tmdb:" + type + ":" + tmdbId;
  var cached = cacheGet(key);
  if (cached) return cached;

  var base = "https://api.themoviedb.org/3/" + type + "/" + tmdbId;
  try {
    var data = await fetchJson(base + "?api_key=" + TMDB_API_KEY);
    var titles = [];
    if (data.title) titles.push(data.title);
    if (data.name) titles.push(data.name);
    if (data.original_title) titles.push(data.original_title);
    if (data.original_name) titles.push(data.original_name);

    var year = ((data.release_date || data.first_air_date || "").split("-")[0]) || "";

    var imdb = "";
    try {
      var ext = await fetchJson(base + "/external_ids?api_key=" + TMDB_API_KEY);
      imdb = String((ext && ext.imdb_id) || "");
    } catch (eImdb) {}

    var info = {
      title: data.title || data.name || "",
      titles: titles,
      year: year,
      imdb: imdb
    };
    cacheSet(key, info);
    return info;
  } catch (e) {
    return { title: "", titles: [], year: "", imdb: "" };
  }
}

// ─── krd.watch Catalog Search ────────────────────────────────────────────────

// GET /api/?route=search&q=<term> -> { movies:[{id, imdb_id, title, year}], shows:[...] }
async function searchSite(term) {
  var key = "search:" + String(term || "").toLowerCase();
  var cached = cacheGet(key);
  if (cached) return cached;

  var url = API_URL + "?route=search&q=" + queryEscape(term);
  try {
    var data = await fetchJson(url, null, 10000);
    var out = {
      movies: (data && data.movies) || [],
      shows: (data && data.shows) || []
    };
    cacheSet(key, out);
    return out;
  } catch (e) {
    return { movies: [], shows: [] };
  }
}

function scoreMatch(item, tmdbInfo) {
  if (!item) return 0;

  var siteTitle = normalizeTitle(item.title);
  var nativeTitle = siteTitle;
  if (!siteTitle) return 0;

  var best = 0;
  var pool = (tmdbInfo.titles || []).concat(tmdbInfo.title ? [tmdbInfo.title] : []);
  for (var i = 0; i < pool.length; i++) {
    var s = similarity(normalizeTitle(pool[i]), siteTitle);
    if (s > best) best = s;
  }
  if (best < 0.5) return 0;
  var score = Math.round(best * 100);

  var siteYear = yearOf(item.year);
  if (tmdbInfo.year && siteYear) {
    var diff = Math.abs(Number(siteYear) - Number(tmdbInfo.year));
    if (diff === 0) score += 15;
    else if (diff === 1) score += 5;
    else if (diff >= 3) score -= 15;
  }

  var siteImdb = String(item.imdb_id || "");
  if (siteImdb && tmdbInfo.imdb) {
    if (siteImdb === tmdbInfo.imdb) score += 40;
    else score -= 15;
  }

  return score;
}

async function findSiteEntry(tmdbInfo, isMovie) {
  var pool = (tmdbInfo.titles || []).concat(tmdbInfo.title ? [tmdbInfo.title] : []);
  var seen = {};
  var names = [];
  for (var i = 0; i < pool.length; i++) {
    var n = normalizeTitle(pool[i]);
    if (n && !seen[n]) {
      seen[n] = true;
      names.push(pool[i]);
    }
  }
  if (!names.length) return null;

  var bestEntry = null;
  var bestScore = 0;

  for (var j = 0; j < names.length; j++) {
    var res = await searchSite(names[j]);
    var list = isMovie ? res.movies : res.shows;
    if (!list || !list.length) continue;

    for (var k = 0; k < list.length; k++) {
      var score = scoreMatch(list[k], tmdbInfo);
      if (score > bestScore) {
        bestScore = score;
        bestEntry = list[k];
      }
    }
    if (bestScore >= 130) break;
  }

  if (!bestEntry || bestScore < 90) return null;
  return bestEntry;
}

// ─── krd.watch Player ────────────────────────────────────────────────────────

// Player page injects PRIMARY_SRC / FALLBACK_SRC / WK_SUBS / season+episode
async function fetchPlayerPage(entry, isMovie, season, episode) {
  var url = BASE_URL + "/player.php?id=" + queryEscape(entry.id) +
    "&type=" + (isMovie ? "movie" : "show") +
    (isMovie ? "" : "&s=" + queryEscape(season) + "&e=" + queryEscape(episode));
  return fetchText(url, null, TIMEOUT_MS);
}

function matchConst(html, name) {
  var re = new RegExp("const\\s+" + name + "\\s*=\\s*([^;]*);");
  var m = html.match(re);
  return m ? m[1].trim() : "";
}

function stringConst(html, name) {
  var raw = matchConst(html, name);
  var inner = raw.match(/^"([\s\S]*)"$/);
  return unescapeJs(inner ? inner[1] : raw);
}

function numberConst(html, name) {
  var raw = matchConst(html, name);
  var n = parseInt(raw, 10);
  return isNaN(n) ? -1 : n;
}

// The player clamps out-of-range seasons/episodes to the first one, so the
// echoed values must match the request or we would serve the wrong episode.
function validatePlayer(html, isMovie, season, episode) {
  var itemType = stringConst(html, "WK_ITEM_TYPE");
  if (isMovie && itemType !== "movie") return false;
  if (!isMovie) {
    if (itemType !== "show") return false;
    if (numberConst(html, "WK_SEASON") !== Number(season)) return false;
    if (numberConst(html, "WK_EPISODE") !== Number(episode)) return false;
  }
  return true;
}

function parseSubtitles(html) {
  var out = [];
  var m = html.match(/window\.WK_SUBS\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return out;

  var list;
  try {
    list = JSON.parse(m[1]);
  } catch (e) {
    return out;
  }
  if (!Array.isArray(list)) return out;

  var seen = {};
  for (var i = 0; i < list.length && out.length < 16; i++) {
    var sub = list[i];
    if (!sub || typeof sub.url !== "string" || !sub.url) continue;
    var url = absUrl(sub.url);
    if (!url || seen[url]) continue;
    seen[url] = true;
    if (url.indexOf("format=") === -1) url += (url.indexOf("?") !== -1 ? "&" : "?") + "format=vtt";

    var lang = String(sub.language || "").toLowerCase();
    out.push({
      url: url,
      name: String(sub.label || sub.language || "Subtitle").slice(0, 60),
      language: lang || "und"
    });
  }
  return out;
}

// ─── Stream Formatting ───────────────────────────────────────────────────────

function makeStream(source, streamTitle, quality) {
  return {
    name: PROVIDER_NAME + " [MP4 · " + quality + "]",
    title: streamTitle + " · " + quality,
    url: source,
    quality: quality,
    headers: {
      "User-Agent": UA,
      "Referer": BASE_URL + "/"
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

    var entry = await findSiteEntry(tmdbInfo, isMovie);
    if (!entry) {
      console.log("[" + PROVIDER_NAME + "] No krd.watch match for \"" + tmdbInfo.title + "\"");
      return [];
    }

    console.log("[" + PROVIDER_NAME + "] Matched: " + (entry.title || tmdbInfo.title) +
      " -> id=" + entry.id + (entry.year ? " (" + entry.year + ")" : ""));

    var html = await fetchPlayerPage(entry, isMovie, s, e);
    if (!html || html.indexOf("PRIMARY_SRC") === -1) {
      console.log("[" + PROVIDER_NAME + "] Player page unavailable for this episode");
      return [];
    }

    if (!validatePlayer(html, isMovie, s, e)) {
      console.log("[" + PROVIDER_NAME + "] Site clamped to a different episode — no stream");
      return [];
    }

    var source = stringConst(html, "PRIMARY_SRC");
    if (!source) source = stringConst(html, "FALLBACK_SRC");
    if (!source) {
      console.log("[" + PROVIDER_NAME + "] Player page has no source");
      return [];
    }
    source = absUrl(source);

    var streamTitle = (entry.title || tmdbInfo.title) +
      (isMovie ? "" : " S" + pad2(s) + "E" + pad2(e)) +
      (tmdbInfo.year ? " (" + tmdbInfo.year + ")" : "");

    var stream = makeStream(source, streamTitle, "1080p");
    stream.subtitles = parseSubtitles(html);

    console.log("[" + PROVIDER_NAME + "] Source: " + source.slice(0, 90) + "...");
    console.log("[" + PROVIDER_NAME + "] Subtitles: " + stream.subtitles.length +
      " (" + stream.subtitles.map(function (x) { return x.language; }).join(", ") + ")");

    var finalStreams = [];
    var seen = {};
    var list = [stream];
    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      if (!st.url || seen[st.url]) continue;
      seen[st.url] = true;
      finalStreams.push(st);
    }

    console.log("[" + PROVIDER_NAME + "] Done: " + finalStreams.length + " stream(s)");
    return finalStreams;

  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
