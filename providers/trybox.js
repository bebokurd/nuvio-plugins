// TryBox Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js
//
// TryBox (https://trybox.app) is a Braflix-style meta source: it does not host
// any media itself. It resolves metadata from TMDB and hands playback to a
// rotating list of third-party embed players (vidsrc, vidlink, vidfast,
// videasy, 2embed, ...). This provider mirrors that behaviour and returns the
// embed player URLs so the Nuvio webview player can play them.

"use strict";

var PROVIDER_NAME = "TryBox";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 12000;
var CACHE_TTL_MS = 20 * 60 * 1000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// Curated subset of TryBox's embed providers (each verified reachable at build
// time). Most players follow the   /movie/{tmdb}   and   /tv/{tmdb}/{s}/{e}
// layout; a couple use a special layout which is captured by `layout`:
//   - "bare"  ->  /{tmdb}            and  /{tmdb}/{s}/{e}      (cinemaos "Prime")
//   - "query" ->  default path plus a fixed query suffix
var SOURCES = [
  { name: "Vidsrc", url: "https://vidsrc.party" },
  { name: "Vidlink", url: "https://vidlink.pro" },
  { name: "VidFast", url: "https://vidfast.pro" },
  { name: "Videasy", url: "https://player.videasy.net" },
  { name: "2Embed", url: "https://www.2embed.stream/embed" },
  { name: "Vidsrc SU", url: "https://vidsrc.su/embed" },
  { name: "Vidbolt", url: "https://vidbolt.xyz" },
  { name: "XPass", url: "https://play.xpass.top/e" },
  { name: "Vidnest", url: "https://vidnest.fun" },
  { name: "Vidzee", url: "https://player.vidzee.wtf/embed" },
  { name: "VsEmbed", url: "https://vsembed.ru/embed" },
  { name: "Vidrock", url: "https://vidrock.to" },
  { name: "Mapple 4K", url: "https://mapple.rip/watch", layout: "query", query: "?autoPlay=true" },
  { name: "Prime", url: "https://cinemaos.tech/player", layout: "bare" }
];

// ─── Utilities ───────────────────────────────────────────────────────────────

var _cache = {};

function cacheGet(key) {
  var entry = _cache[key];
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    delete _cache[key];
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  _cache[key] = { value: value, exp: Date.now() + CACHE_TTL_MS };
  return value;
}

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
  if (controller) opts.signal = controller.signal;
  return fetch(url, opts).then(function (res) {
    if (timer) clearTimeout(timer);
    return res;
  }).catch(function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
}

function uniqueNonEmpty(arr) {
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var v = arr[i];
    if (v === null || v === undefined) continue;
    v = String(v).trim();
    if (!v || seen[v]) continue;
    seen[v] = true;
    out.push(v);
  }
  return out;
}

function pad2(n) {
  n = Number(n) || 0;
  return n < 10 ? "0" + n : String(n);
}

// ─── TMDB (display metadata only) ─────────────────────────────────────────────

async function getTMDBDetails(tmdbId, mediaType) {
  var key = "tmdb:" + mediaType + ":" + tmdbId;
  var cached = cacheGet(key);
  if (cached) return cached;

  var type = mediaType === "movie" ? "movie" : "tv";
  try {
    var res = await fetchWithTimeout(
      "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY,
      { headers: { "User-Agent": UA, "Accept": "application/json" } },
      8000
    );
    if (!res.ok) throw new Error("TMDB HTTP " + res.status);
    var data = await res.json();
    var titles = uniqueNonEmpty([data.title, data.name, data.original_title, data.original_name]);
    var info = {
      title: titles[0] || ("TMDB " + tmdbId),
      year: String(data.first_air_date || data.release_date || "").split("-")[0]
    };
    return cacheSet(key, info);
  } catch (err) {
    console.log("[" + PROVIDER_NAME + "] TMDB error: " + err.message);
    return { title: "TMDB " + tmdbId, year: "" };
  }
}

// ─── Embed URL building ───────────────────────────────────────────────────────

function buildEmbed(source, tmdbId, isMovie, season, episode) {
  var path;
  if (source.layout === "bare") {
    path = isMovie ? ("/" + tmdbId) : ("/" + tmdbId + "/" + season + "/" + episode);
  } else {
    path = isMovie ? ("/movie/" + tmdbId) : ("/tv/" + tmdbId + "/" + season + "/" + episode);
    if (source.layout === "query") path += source.query || "";
  }
  return source.url + path;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  console.log("[" + PROVIDER_NAME + "] Request: tmdbId=" + tmdbId + " type=" + mediaType + (isMovie ? "" : " S" + s + "E" + e));

  if (!tmdbId) {
    console.log("[" + PROVIDER_NAME + "] Missing tmdbId, returning []");
    return [];
  }

  try {
    var tmdbInfo = await getTMDBDetails(tmdbId, mediaType);
    var streamTitle = tmdbInfo.title +
      (isMovie ? "" : (" S" + pad2(s) + "E" + pad2(e))) +
      (tmdbInfo.year ? " (" + tmdbInfo.year + ")" : "");

    var streams = [];
    for (var i = 0; i < SOURCES.length; i++) {
      var source = SOURCES[i];
      var url = buildEmbed(source, tmdbId, isMovie, s, e);
      streams.push({
        name: PROVIDER_NAME + " · " + source.name,
        title: streamTitle,
        url: url,
        quality: "Auto",
        headers: { "User-Agent": UA },
        subtitles: []
      });
    }

    console.log("[" + PROVIDER_NAME + "] Done: " + streams.length + " stream(s)");
    return streams;
  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
