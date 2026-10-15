// YapGrid Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js
//
// YapGrid (yapgrid.com) is an embed player that resolves a public streaming
// network behind a simple per-title URL:
//   movie -> https://yapgrid.com/embed/movie/{tmdbId}
//   tv    -> https://yapgrid.com/embed/tv/{tmdbId}/{season}/{episode}
//
// It hosts nothing itself. Its player bundle (chunk 414) reveals a small public
// JSON API that does the heavy lifting:
//   POST /player/api/extract            -> { url, source, ... } resolves the
//                                          embed into a playable HLS master
//   POST /player/api/subtitles/catalog  -> { context, lang } returns subtitle
//                                          tracks (proxy .vtt URLs)
//
// Right now the only working upstream is the "embedwave" source, which returns
// a master m3u8 proxied through yapgrid.com (no extra headers required). We use
// that API to hand Nuvio a real direct HLS stream (plus the available subtitle
// tracks) and fall back to the public embed URL for the webview player when the
// extraction is unavailable for a given title.

var PROVIDER_NAME = "YapGrid";
var BASE_URL = "https://yapgrid.com";
var EMBED_BASE = "https://embedwave.cc/embed";
var SOURCE = "embedwave";
var EXTRACT_URL = BASE_URL + "/player/api/extract";
var CATALOG_URL = BASE_URL + "/player/api/subtitles/catalog";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

var EXTRACT_TIMEOUT_MS = 30000;
var SUB_TIMEOUT_MS = 10000;
var PROBE_TIMEOUT_MS = 8000;
var TMDB_TIMEOUT_MS = 8000;
var CACHE_TTL_MS = 20 * 60 * 1000;
var CACHE_MAX = 40;

var cache = {};

// ─── Utilities ───────────────────────────────────────────────────────────────

function nowMs() {
  return new Date().getTime();
}

function cacheGet(key) {
  var hit = cache[key];
  if (!hit) return null;
  if (nowMs() - hit.at > CACHE_TTL_MS) {
    delete cache[key];
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache[key] = { at: nowMs(), value: value };
  var keys = [];
  for (var k in cache) {
    if (cache.hasOwnProperty(k)) keys.push(k);
  }
  if (keys.length > CACHE_MAX) {
    keys.sort(function (a, b) { return cache[a].at - cache[b].at; });
    for (var i = 0; i < keys.length - CACHE_MAX; i++) delete cache[keys[i]];
  }
  return value;
}

function fetchWithTimeout(url, options, timeoutMs) {
  var ms = timeoutMs || EXTRACT_TIMEOUT_MS;
  var opts = options || {};
  if (!opts.headers) opts.headers = {};
  if (!opts.headers["User-Agent"]) opts.headers["User-Agent"] = UA;
  var controller = null;
  var timer = null;
  try {
    controller = new AbortController();
    timer = setTimeout(function () { controller.abort(); }, ms);
  } catch (e) {
    controller = null;
  }
  if (controller) opts.signal = controller.signal;
  return fetch(url, opts).then(function (res) {
    if (timer) clearTimeout(timer);
    return res;
  }).catch(function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
}

function absoluteUrl(url) {
  var u = String(url || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.charAt(0) === "/") return BASE_URL + u;
  return BASE_URL + "/" + u;
}

function uniqueNonEmpty(arr) {
  var seen = {};
  var out = [];
  for (var i = 0; i < (arr || []).length; i++) {
    var v = (arr[i] || "").toString().trim();
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

function qualityFromResolution(w, h) {
  if (h >= 1700 || w >= 3300) return "2160p";
  if (h >= 1000 || w >= 1800) return "1080p";
  if (h >= 700 || w >= 1200) return "720p";
  if (h >= 500 || w >= 800) return "480p";
  return h > 0 ? h + "p" : "";
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
      TMDB_TIMEOUT_MS
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

// ─── Extraction (embed -> direct HLS master) ─────────────────────────────────

function extractOnce(tmdbId, isMovie, season, episode) {
  var embedUrl = isMovie
    ? (EMBED_BASE + "/movie/" + tmdbId)
    : (EMBED_BASE + "/tv/" + tmdbId + "/" + season + "/" + episode);

  var body = JSON.stringify({
    url: embedUrl,
    source: SOURCE,
    strictSource: true,
    waitMs: 5000,
    nativeHls: true
  });

  return fetchWithTimeout(EXTRACT_URL, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json" },
    body: body
  }, EXTRACT_TIMEOUT_MS).then(function (res) {
    if (!res.ok) throw new Error("extract HTTP " + res.status);
    return res.json();
  }).then(function (json) {
    if (!json || !json.success) throw new Error("extract unsuccessful");
    var found = json.found || [];
    var pick = null;
    for (var i = 0; i < found.length; i++) {
      if (found[i] && found[i].url && found[i].type !== "subtitle") { pick = found[i]; break; }
    }
    if (!pick) {
      for (var j = 0; j < found.length; j++) {
        if (found[j] && found[j].url) { pick = found[j]; break; }
      }
    }
    if (!pick || !pick.url) throw new Error("no stream found");
    return { url: absoluteUrl(pick.url), catalog: pick.subtitleCatalog || "" };
  });
}

// The embedwave source is occasionally slow to warm up; YapGrid's own player
// retries it once, so we mirror that behaviour.
function extractMaster(tmdbId, isMovie, season, episode) {
  return extractOnce(tmdbId, isMovie, season, episode).catch(function () {
    return extractOnce(tmdbId, isMovie, season, episode);
  });
}

function probeQuality(url) {
  var key = "q:" + url;
  var cached = cacheGet(key);
  if (cached !== null) return Promise.resolve(cached);
  return fetchWithTimeout(url, { headers: { "User-Agent": UA } }, PROBE_TIMEOUT_MS).then(function (res) {
    if (!res.ok) return "";
    return res.text();
  }).then(function (text) {
    var w = 0;
    var h = 0;
    var re = /RESOLUTION=(\d+)x(\d+)/g;
    var m;
    while ((m = re.exec(text))) {
      var hh = parseInt(m[2], 10);
      if (hh > h) { h = hh; w = parseInt(m[1], 10); }
    }
    return cacheSet(key, qualityFromResolution(w, h));
  }).catch(function () {
    return "";
  });
}

// ─── Subtitles ────────────────────────────────────────────────────────────────

function getSubtitles(context) {
  if (!context) return Promise.resolve([]);
  var key = "subs:" + context;
  var cached = cacheGet(key);
  if (cached) return Promise.resolve(cached);

  var body = JSON.stringify({ context: context, lang: "en", retry: false });
  return fetchWithTimeout(CATALOG_URL, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json" },
    body: body
  }, SUB_TIMEOUT_MS).then(function (res) {
    if (!res.ok) return null;
    return res.json();
  }).then(function (json) {
    if (!json || !json.found) return cacheSet(key, []);
    var seen = {};
    var out = [];
    for (var i = 0; i < json.found.length; i++) {
      var t = json.found[i];
      if (!t || !t.url) continue;
      var u = absoluteUrl(t.url);
      if (seen[u]) continue;
      seen[u] = true;
      out.push({
        url: u,
        name: t.label || t.lang || t.code || ("Subtitle " + (out.length + 1)),
        language: t.lang || t.code || ""
      });
    }
    return cacheSet(key, out);
  }).catch(function () {
    return [];
  });
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

  var info = await getTMDBDetails(tmdbId, mediaType);
  var streamTitle = info.title +
    (isMovie ? "" : (" S" + pad2(s) + "E" + pad2(e))) +
    (info.year ? " (" + info.year + ")" : "");

  try {
    var master = await extractMaster(tmdbId, isMovie, s, e);
    var quality = await probeQuality(master.url);
    var subs = await getSubtitles(master.catalog);
    console.log("[" + PROVIDER_NAME + "] Direct HLS resolved" + (quality ? " (" + quality + ")" : "") + ", " + subs.length + " subtitle(s)");
    return [{
      name: PROVIDER_NAME,
      title: streamTitle + (quality ? " · " + quality : ""),
      url: master.url,
      quality: quality || "Auto",
      headers: { "User-Agent": UA },
      subtitles: subs
    }];
  } catch (err) {
    console.log("[" + PROVIDER_NAME + "] extraction failed (" + err.message + "), falling back to embed URL");
  }

  // Fallback: hand Nuvio's webview the public YapGrid embed player.
  var embedUrl = isMovie
    ? (BASE_URL + "/embed/movie/" + tmdbId)
    : (BASE_URL + "/embed/tv/" + tmdbId + "/" + s + "/" + e);

  return [{
    name: PROVIDER_NAME,
    title: streamTitle,
    url: embedUrl,
    quality: "Auto",
    headers: { "User-Agent": UA },
    subtitles: []
  }];
}

module.exports = { getStreams };
