// Awenafilm Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js
// Kurdish (Sorani) subtitled movies & TV shows
// awenafilm.com is a Next.js app; all content is served through
// Next.js Server Actions (POST + Next-Action header).

"use strict";

var PROVIDER_NAME = "Awenafilm";
var BASE_URL = "https://awenafilm.com";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 15000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// Next.js Server Action ids (Next 14.2.3 build QhvTZRwvhDDmGDuLnaGuT)
var SEARCH_ACTION = "d12083f07e70aa0d728c5a5b31a9a5679424c72a";
var DETAIL_ACTION = "6f881928e7892e79c083b09da5072d0c7585b0b1";

// Router state tree required by Next.js for Server Action requests.
var ROUTER_TREE = JSON.stringify(["", { "children": ["search", { "children": ["__PAGE__", {}] }] }, null, null, true]);

var STREAM_BASE = "https://cdn.video.krd/video/";
var PLAYABLE_EXT = /\/content\.m3u8$/i;

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
  if (!opts.headers) opts.headers = {};
  if (!opts.headers["User-Agent"]) opts.headers["User-Agent"] = UA;
  if (controller) opts.signal = controller.signal;
  return fetch(url, opts).then(function (res) {
    if (timer) clearTimeout(timer);
    return res;
  }).catch(function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
}

function cleanTitle(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function yearFromDate(d) {
  if (!d) return "";
  var s = String(d).split("-")[0];
  return /^\d{4}$/.test(s) ? s : "";
}

function pad2(n) {
  n = Number(n) || 0;
  return n < 10 ? "0" + n : String(n);
}

// ─── Next.js Server Action caller ────────────────────────────────────────────

// Server Action responses are flight streams; the payload lives in a
// "\n1:{...}" chunk and dates/undefined are encoded with $D / $undefined
// markers. Parse just enough to get the plain JSON.
function parseActionPayload(text) {
  var lines = String(text || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var idx = line.indexOf(":");
    if (idx <= 0) continue;
    if (line.slice(0, idx) !== "1") continue;
    var payload = line.slice(idx + 1);
    if (payload.charAt(0) !== "{") continue;
    payload = payload.replace(/"\$undefined"/g, "null");
    payload = payload.replace(/"\$D([0-9TZ.:+-]+)"/g, '"$1"');
    try {
      return JSON.parse(payload);
    } catch (e) {
      return null;
    }
  }
  return null;
}

function callAction(actionId, args, route) {
  var url = BASE_URL + (route || "/search");
  var body = JSON.stringify(args);
  var headers = {
    "Accept": "text/x-component",
    "Next-Action": actionId,
    "Next-Router-State-Tree": encodeURIComponent(ROUTER_TREE),
    "Next-Url": encodeURIComponent(route || "/search")
  };
  return fetchWithTimeout(url, {
    method: "POST",
    headers: headers,
    body: body
  }).then(function (res) {
    if (!res.ok) throw new Error("Action HTTP " + res.status);
    return res.text();
  }).then(parseActionPayload);
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────

async function getTMDBDetails(tmdbId, mediaType) {
  var type = mediaType === "movie" ? "movie" : "tv";
  try {
    var res = await fetchWithTimeout(
      "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY
    );
    if (!res.ok) throw new Error("TMDB HTTP " + res.status);
    var data = await res.json();
    var titles = uniqueNonEmpty([
      data.title,
      data.name,
      data.original_title,
      data.original_name
    ]);
    return {
      title: titles[0] || "",
      titles: titles,
      year: (data.first_air_date || data.release_date || "").split("-")[0]
    };
  } catch (err) {
    console.log("[Awenafilm] TMDB error: " + err.message);
    return { title: "", titles: [], year: "" };
  }
}

// ─── Search & Match ──────────────────────────────────────────────────────────

async function searchAwenafilm(query) {
  var data = await callAction(SEARCH_ACTION, [query, "all", 1]);
  if (!data || !Array.isArray(data.results)) return [];
  return data.results;
}

var STOP_WORDS = [
  "the", "a", "an", "of", "and", "on", "at", "for", "to", "in", "with",
  "by", "is", "or", "as", "it", "vs", "v", "x", "s"
];

function buildQueries(titles) {
  var titleList = uniqueNonEmpty(titles);
  var queries = [];
  for (var ti = 0; ti < titleList.length; ti++) {
    var title = titleList[ti];
    queries.push(title);
    if (title.indexOf(":") !== -1) queries.push(title.split(":")[0].trim());

    var words = title.split(/\s+/);
    var kept = [];
    for (var wi = 0; wi < words.length; wi++) {
      var w = words[wi].toLowerCase();
      if (!w || STOP_WORDS.indexOf(w) !== -1) continue;
      kept.push(words[wi]);
    }
    if (kept.length && kept.join(" ") !== title) queries.push(kept.join(" "));

    for (var ki = 0; ki < kept.length; ki++) {
      if (kept[ki].length >= 3) queries.push(kept[ki]);
    }
  }
  var out = uniqueNonEmpty(queries);
  out.sort(function (a, b) {
    return b.length - a.length;
  });
  return out.slice(0, 8);
}

function scoreItem(item, titles, year) {
  var n = cleanTitle(item.title || item.name);
  if (!n) return 0;
  var itemYear = yearFromDate(item.releaseDate || item.release_date);
  var yearOk = !year || !itemYear || String(itemYear) === String(year);
  var best = 0;
  for (var i = 0; i < titles.length; i++) {
    var t = cleanTitle(titles[i]);
    if (!t) continue;
    if (n === t && yearOk) return 100;
    if (n === t) {
      best = Math.max(best, 80);
    } else if (yearOk && (n.indexOf(t) !== -1 || t.indexOf(n) !== -1)) {
      best = Math.max(best, 55);
    }
  }
  return best;
}

async function findOnAwenafilm(titles, mediaType, year) {
  var titleList = uniqueNonEmpty(titles);
  var queries = buildQueries(titles);

  var targetType = mediaType === "movie" ? "movie" : "series";
  var best = null;
  var bestScore = 0;

  for (var qi = 0; qi < queries.length; qi++) {
    try {
      var docs = await searchAwenafilm(queries[qi]);
      for (var di = 0; di < docs.length; di++) {
        var doc = docs[di];
        if (String(doc.type) !== targetType) continue;
        var sc = scoreItem(doc, titleList, year);
        if (sc > bestScore || (sc === bestScore && best && (doc.similarityScore || 0) > (best.similarityScore || 0))) {
          bestScore = sc;
          best = doc;
        }
      }
      if (bestScore >= 100) break;
    } catch (e) {
      console.log("[Awenafilm] Search attempt failed: " + e.message);
    }
  }

  if (!best || bestScore < 55) {
    console.log("[Awenafilm] Content not found on Awenafilm");
    return null;
  }

  console.log("[Awenafilm] Match: " + (best.title || best.id) + " (score " + bestScore + ")");
  return best;
}

// ─── Details & Streams ───────────────────────────────────────────────────────

async function fetchMovieRecord(id) {
  try {
    return await callAction(DETAIL_ACTION, ["movie", id], "/movie/" + id);
  } catch (e) {
    console.log("[Awenafilm] Movie detail failed: " + e.message);
    return null;
  }
}

async function fetchSeriesRecord(id) {
  try {
    return await callAction(DETAIL_ACTION, ["series", id], "/tv-shows/" + id);
  } catch (e) {
    console.log("[Awenafilm] Series detail failed: " + e.message);
    return null;
  }
}

function pickEpisode(record, season, episode) {
  var eps = (record && Array.isArray(record.episodes)) ? record.episodes : [];
  for (var i = 0; i < eps.length; i++) {
    var ep = eps[i];
    if (Number(ep.seasonNum) === Number(season) && Number(ep.episodeNum) === Number(episode)) {
      return ep;
    }
  }
  return null;
}

function inferQualityFromTitle(title) {
  var m = String(title || "").match(/(2160|1440|1080|720|480|360)\s*p/i);
  return m ? m[1] + "p" : "";
}

function makeStream(watchId, serverName, quality, streamTitle) {
  var url = STREAM_BASE + watchId + "/content.m3u8";
  var q = quality || "Auto";
  var name = PROVIDER_NAME + (serverName ? " [" + serverName + "]" : "");
  return {
    name: name,
    title: streamTitle + " · " + q,
    url: url,
    quality: q,
    headers: {
      "User-Agent": UA,
      "Referer": BASE_URL + "/"
    },
    subtitles: []
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  console.log("[Awenafilm] Request: tmdbId=" + tmdbId + " type=" + mediaType + (isMovie ? "" : " S" + s + "E" + e));

  try {
    var tmdbInfo = await getTMDBDetails(tmdbId, mediaType);
    var searchTitles = tmdbInfo.titles && tmdbInfo.titles.length ? tmdbInfo.titles : [String(tmdbId)];
    var searchYear = tmdbInfo.year || "";

    var match = await findOnAwenafilm(searchTitles, mediaType, searchYear);
    if (!match || !match.id) {
      console.log("[Awenafilm] Not found, returning []");
      return [];
    }

    var baseTitle = tmdbInfo.title || match.title || ("TMDB " + tmdbId);
    var year = tmdbInfo.year || yearFromDate(match.releaseDate || match.release_date);
    var streamTitle = baseTitle + (isMovie ? "" : (" S" + pad2(s) + "E" + pad2(e))) +
      (year ? " (" + year + ")" : "");

    var streams = [];

    if (isMovie) {
      var movie = await fetchMovieRecord(match.id);
      if (movie && movie.watchId) {
        streams.push(makeStream(movie.watchId, "", inferQualityFromTitle(movie.title), streamTitle));
      }
    } else {
      var series = await fetchSeriesRecord(match.id);
      var ep = pickEpisode(series, s, e);
      if (ep && ep.watchId) {
        var q = inferQualityFromTitle(ep.title) || "";
        streams.push(makeStream(ep.watchId, "", q, streamTitle));
      }
    }

    console.log("[Awenafilm] Done: " + streams.length + " stream(s)");
    return streams;

  } catch (err) {
    console.error("[Awenafilm] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };