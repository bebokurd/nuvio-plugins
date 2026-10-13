// CHYA TV Scraper for Nuvio Local Scrapers
// Kurdish dubbed & subtitled movies, animations and TV series from CHYA TV 
// Source endpoint: https://bebokurd.github.io/lala.json
// Compatible with React Native / Hermes and Node.js

"use strict";

var PROVIDER_NAME = "CHYA TV";
var DATA_URL = "https://bebokurd.github.io/lala.json";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 15000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
var CACHE_TTL_MS = 15 * 60 * 1000;

var DEFAULT_HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json, text/plain, */*"
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

function fetchJson(url, headers, timeoutMs) {
  return fetchWithTimeout(url, { headers: headers }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  });
}

// ─── String and Normalization Utilities ──────────────────────────────────────

function pad2(n) {
  var num = Number(n) || 0;
  return num < 10 ? "0" + num : String(num);
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

function normalizeKurdish(str) {
  return String(str || "")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ە")
    .replace(/[\s\-_]+/g, " ")
    .trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) === 0 || b.indexOf(a) === 0) return 0.9;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.8;

  var at = a.split(" ").filter(Boolean);
  var bt = b.split(" ").filter(Boolean);
  if (!at.length || !bt.length) return 0;
  var hit = 0;
  for (var i = 0; i < at.length; i++) {
    if (bt.indexOf(at[i]) !== -1) hit++;
  }
  return (2 * hit) / (at.length + bt.length);
}

function uniqueNonEmpty(arr) {
  var seen = {};
  var out = [];
  for (var i = 0; i < (arr || []).length; i++) {
    var v = (arr[i] || "").trim();
    if (!v || seen[v]) continue;
    seen[v] = true;
    out.push(v);
  }
  return out;
}

function inferQuality(url) {
  var s = String(url || "").toLowerCase();
  if (/2160p|4k/i.test(s)) return "4K";
  if (/1080p|bluray|blu-ray/i.test(s)) return "1080p";
  if (/720p|hd/i.test(s)) return "720p";
  if (/480p/i.test(s)) return "480p";
  return "1080p";
}

function inferServerName(item, url) {
  if (item && item.sourceName) return String(item.sourceName).trim();
  var u = String(url || "").toLowerCase();
  if (u.indexOf("archive.org") !== -1) return "Archive";
  if (u.indexOf("jwplayer.com") !== -1) return "JWPlayer";
  return "Direct";
}

// ─── Remote Catalog Loader ───────────────────────────────────────────────────

async function getCatalog() {
  var cacheKey = "lala:catalog";
  var cached = cacheGet(cacheKey);
  if (cached && Array.isArray(cached) && cached.length) return cached;

  try {
    var data = await fetchJson(DATA_URL, {}, TIMEOUT_MS);
    if (Array.isArray(data) && data.length) {
      cacheSet(cacheKey, data);
      return data;
    }
  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Failed to fetch catalog: " + err.message);
  }
  return cached || [];
}

// ─── TMDB Metadata Lookup ────────────────────────────────────────────────────

async function getTMDBInfo(tmdbId, mediaType) {
  var isMovie = mediaType === "movie";
  var cacheKey = "tmdb:" + (isMovie ? "movie:" : "tv:") + tmdbId;
  var cached = cacheGet(cacheKey);
  if (cached) return cached;

  var idStr = String(tmdbId || "").trim();
  var isImdb = /^tt\d+/i.test(idStr);

  try {
    var url = "";
    if (isImdb) {
      url = "https://api.themoviedb.org/3/find/" + idStr + "?api_key=" + TMDB_API_KEY + "&external_source=imdb_id";
      var findData = await fetchJson(url);
      var result = isMovie
        ? ((findData.movie_results && findData.movie_results[0]) || (findData.tv_results && findData.tv_results[0]))
        : ((findData.tv_results && findData.tv_results[0]) || (findData.movie_results && findData.movie_results[0]));
      if (result) {
        var info = {
          imdbId: idStr,
          title: result.title || result.name || "",
          originalTitle: result.original_title || result.original_name || "",
          year: ((result.release_date || result.first_air_date || "").split("-")[0]) || "",
          titles: uniqueNonEmpty([result.title, result.name, result.original_title, result.original_name])
        };
        cacheSet(cacheKey, info);
        return info;
      }
      return { imdbId: idStr, title: "", originalTitle: "", year: "", titles: [] };
    }

    if (isMovie) {
      url = "https://api.themoviedb.org/3/movie/" + idStr + "?api_key=" + TMDB_API_KEY;
    } else {
      url = "https://api.themoviedb.org/3/tv/" + idStr + "?api_key=" + TMDB_API_KEY + "&append_to_response=external_ids";
    }

    var data = await fetchJson(url);
    var imdbId = data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || "";
    var titles = uniqueNonEmpty([
      data.title,
      data.name,
      data.original_title,
      data.original_name
    ]);

    var infoObj = {
      imdbId: imdbId,
      title: data.title || data.name || "",
      originalTitle: data.original_title || data.original_name || "",
      year: ((data.release_date || data.first_air_date || "").split("-")[0]) || "",
      titles: titles
    };
    cacheSet(cacheKey, infoObj);
    return infoObj;
  } catch (err) {
    console.log("[" + PROVIDER_NAME + "] TMDB lookup error: " + err.message);
    return {
      imdbId: isImdb ? idStr : "",
      title: "",
      originalTitle: "",
      year: "",
      titles: []
    };
  }
}

// ─── Entry Matcher ───────────────────────────────────────────────────────────

function findMatchingEntry(catalog, tmdbInfo, isMovie) {
  if (!catalog || !catalog.length) return null;

  var targetImdb = (tmdbInfo.imdbId || "").trim().toLowerCase();
  var targetYear = Number(tmdbInfo.year) || 0;

  // 1. Direct IMDb ID match (100% authoritative)
  if (targetImdb) {
    for (var i = 0; i < catalog.length; i++) {
      var item = catalog[i];
      if (item.imdbId && item.imdbId.trim().toLowerCase() === targetImdb) {
        return item;
      }
    }
  }

  // 2. Fuzzy Title & Year match
  var candidateTitles = [];
  if (tmdbInfo.title) candidateTitles.push(tmdbInfo.title);
  if (tmdbInfo.originalTitle) candidateTitles.push(tmdbInfo.originalTitle);
  if (tmdbInfo.titles && tmdbInfo.titles.length) {
    for (var t = 0; t < tmdbInfo.titles.length; t++) {
      candidateTitles.push(tmdbInfo.titles[t]);
    }
  }
  candidateTitles = uniqueNonEmpty(candidateTitles);

  var bestItem = null;
  var bestScore = 0;

  for (var j = 0; j < catalog.length; j++) {
    var entry = catalog[j];
    var isEntrySeries = entry.type === "series" || (Array.isArray(entry.episodes) && entry.episodes.length > 0);

    // Filter by media type
    if (isMovie && isEntrySeries) continue;
    if (!isMovie && !isEntrySeries) continue;

    var entryTitleNorm = normalizeTitle(entry.name);
    var entryKurdishNorm = normalizeKurdish(entry.nameKurdish);
    var entryYear = Number(entry.year) || 0;

    for (var k = 0; k < candidateTitles.length; k++) {
      var candNorm = normalizeTitle(candidateTitles[k]);
      var candKurdishNorm = normalizeKurdish(candidateTitles[k]);

      var score = similarity(entryTitleNorm, candNorm);
      if (entryKurdishNorm && candKurdishNorm && entryKurdishNorm === candKurdishNorm) {
        score = Math.max(score, 0.95);
      }

      if (score >= 0.7) {
        if (targetYear && entryYear) {
          var diff = Math.abs(targetYear - entryYear);
          if (diff === 0) score += 0.2;
          else if (diff <= 1) score += 0.1;
          else score -= 0.2;
        }

        if (score > bestScore) {
          bestScore = score;
          bestItem = entry;
        }
      }
    }
  }

  if (bestScore >= 0.75) return bestItem;
  return null;
}

// ─── Stream Formatting ───────────────────────────────────────────────────────

function makeStream(item, streamUrl, streamTitle) {
  var isHls = /\.m3u8([?#]|$)/i.test(streamUrl);
  var quality = inferQuality(streamUrl);
  var serverName = inferServerName(item, streamUrl);
  var formatLabel = isHls ? "HLS" : "MP4";

  return {
    name: PROVIDER_NAME + " [" + serverName + " · " + formatLabel + "]",
    title: streamTitle + " · " + quality,
    url: streamUrl,
    quality: quality,
    headers: {
      "User-Agent": UA
    },
    subtitles: []
  };
}

// ─── Main Plugin Entry Point ─────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  console.log("[" + PROVIDER_NAME + "] Request: tmdbId=" + tmdbId + " type=" + mediaType +
    (isMovie ? "" : " S" + s + "E" + e));

  try {
    var catalog = await getCatalog();
    if (!catalog || !catalog.length) {
      console.log("[" + PROVIDER_NAME + "] Catalog empty or unreachable");
      return [];
    }

    var tmdbInfo = await getTMDBInfo(tmdbId, mediaType);
    var match = findMatchingEntry(catalog, tmdbInfo, isMovie);

    if (!match) {
      console.log("[" + PROVIDER_NAME + "] No match found for tmdbId=" + tmdbId + " (" + (tmdbInfo.title || "unknown") + ")");
      return [];
    }

    console.log("[" + PROVIDER_NAME + "] Matched: \"" + match.name + "\" (" + (match.nameKurdish || "") + ") -> ID=" + match.id);

    var targetUrl = "";
    if (isMovie) {
      targetUrl = match.streamUrl || "";
    } else {
      var eps = match.episodes || [];
      for (var i = 0; i < eps.length; i++) {
        var ep = eps[i];
        if (Number(ep.season) === s && Number(ep.number) === e) {
          targetUrl = ep.streamUrl || "";
          break;
        }
      }
      if (!targetUrl && s === 1 && e === 1 && match.streamUrl) {
        targetUrl = match.streamUrl;
      }
    }

    if (!targetUrl) {
      console.log("[" + PROVIDER_NAME + "] No stream URL for " + (isMovie ? "movie" : "S" + s + "E" + e));
      return [];
    }

    var displayTitle = (match.nameKurdish ? match.nameKurdish + " (" + match.name + ")" : match.name) +
      (isMovie ? "" : " S" + pad2(s) + "E" + pad2(e)) +
      (match.year ? " (" + match.year + ")" : "");

    var stream = makeStream(match, targetUrl, displayTitle);
    console.log("[" + PROVIDER_NAME + "] Done: 1 stream -> " + targetUrl.slice(0, 80) + "...");
    return [stream];

  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
