// ChiChi Cinema Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js
// Kurdish (Sorani) subtitled movies & TV shows from web.chichicinema.vip
//
// The site is a Next.js (App Router) front end. Search is served by a JSON
// API that demands a browser-style `Referer` header (otherwise it answers
// 403 "Security violation: Invalid request signature"). Title pages are
// server-rendered and embed the whole player payload (a `servers` array and,
// for series, a `seasons` array) inside the React Server Components flight
// stream (`self.__next_f.push([1,"..."])`). We parse that payload directly.
//
// Direct playback lives on video.hama.krd and is an .m3u8 master playlist.
// IMPORTANT: video.hama.krd responds 403 when a Referer header is present,
// so stream headers carry only a User-Agent.

"use strict";

var PROVIDER_NAME = "ChiChi Cinema";
var BASE_URL = "https://web.chichicinema.vip";
var API_BASE = "https://api.chichicinema.vip";
var LANG = "sorani";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 15000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

var PAGE_HEADERS = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" };
var API_HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json",
  "Referer": BASE_URL + "/"
};
var STREAM_HEADERS = { "User-Agent": UA };

var DIRECT_MEDIA = /\.(m3u8|mp4|mkv|webm)([?#]|$)/i;

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
  var ms = timeoutMs || TIMEOUT_MS;
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

function fetchText(url, headers) {
  var key = "t:" + url + ":" + JSON.stringify(headers || {});
  var cached = cacheGet(key);
  if (cached !== null) return Promise.resolve(cached);
  return fetchWithTimeout(url, { headers: headers || PAGE_HEADERS }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  }).then(function (text) {
    return cacheSet(key, text);
  });
}

function fetchJson(url, headers) {
  var key = "j:" + url;
  var cached = cacheGet(key);
  if (cached !== null) return Promise.resolve(cached);
  return fetchWithTimeout(url, { headers: headers || API_HEADERS }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then(function (json) {
    return cacheSet(key, json);
  });
}

function cleanTitle(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function yearOf(v) {
  var s = String(v || "").split("-")[0];
  return /^\d{4}$/.test(s) ? s : "";
}

function pad2(n) {
  n = Number(n) || 0;
  return n < 10 ? "0" + n : String(n);
}

function isDirectMedia(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) && DIRECT_MEDIA.test(url);
}

// ─── Flight-stream payload parsing ───────────────────────────────────────────

// Concatenate the (JSON-escaped) strings pushed into the RSC flight stream.
function extractFlight(html) {
  var out = "";
  var re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  var m;
  while ((m = re.exec(html))) {
    try {
      out += JSON.parse('"' + m[1] + '"');
    } catch (e) {
      out += m[1];
    }
  }
  return out;
}

// Find `"key":[` and return the parsed array, scanning with string awareness.
function findArray(text, key, fromIndex) {
  var needle = '"' + key + '":[';
  var i = typeof fromIndex === "number" ? text.indexOf(needle, fromIndex) : text.indexOf(needle);
  if (i === -1) return null;
  var start = i + needle.length - 1;
  var depth = 0;
  var inStr = false;
  var esc = false;
  for (var j = start; j < text.length; j++) {
    var c = text.charAt(j);
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          try {
            return { value: JSON.parse(text.slice(start, j + 1)), end: j };
          } catch (e) {
            return null;
          }
        }
      }
    }
  }
  return null;
}

// First `servers` array that actually holds a usable media embed.
function findPlayerServers(flight) {
  var idx = 0;
  for (var guard = 0; guard < 6; guard++) {
    var found = findArray(flight, "servers", idx);
    if (!found) break;
    var arr = found.value || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && isDirectMedia(String(arr[i].embed || "").trim())) return arr;
    }
    idx = found.end;
  }
  return null;
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
    console.log("[" + PROVIDER_NAME + "] TMDB error: " + err.message);
    return { title: "", titles: [], year: "" };
  }
}

// ─── Search & match ──────────────────────────────────────────────────────────

var STOP_WORDS = [
  "the", "a", "an", "of", "and", "on", "at", "for", "to", "in", "with",
  "by", "is", "or", "as", "it", "vs", "v", "x", "s"
];

function buildQueries(titles) {
  var list = uniqueNonEmpty(titles);
  var queries = [];
  for (var ti = 0; ti < list.length; ti++) {
    var title = list[ti];
    queries.push(title);
    if (title.indexOf(":") !== -1) queries.push(title.split(":")[0].trim());

    var words = title.split(/\s+/);
    var kept = [];
    for (var wi = 0; wi < words.length; wi++) {
      if (!words[wi]) continue;
      if (STOP_WORDS.indexOf(words[wi].toLowerCase()) !== -1) continue;
      kept.push(words[wi]);
    }
    if (kept.length && kept.join(" ") !== title) queries.push(kept.join(" "));
  }
  var out = uniqueNonEmpty(queries);
  out.sort(function (a, b) { return b.length - a.length; });
  return out.slice(0, 6);
}

async function searchChiChi(query) {
  var url = API_BASE + "/api/native/?action=search&q=" + encodeURIComponent(query);
  try {
    var json = await fetchJson(url, API_HEADERS);
    if (!json || !json.success || !json.data) return [];
    var data = json.data;
    if (Array.isArray(data.ranked) && data.ranked.length) return data.ranked;
    return [].concat(data.movies || [], data.series || [], data.cartoons || []);
  } catch (e) {
    console.log("[" + PROVIDER_NAME + "] search failed: " + e.message);
    return [];
  }
}

function matchesType(item, mediaType) {
  var want = mediaType === "movie" ? "movie" : "serie";
  var got = String(item.type || "").toLowerCase();
  if (want === "movie") return got === "movie";
  return got === "serie" || got === "series" || got === "tv";
}

function scoreItem(item, titles, year) {
  if (!item) return 0;
  var n = cleanTitle(item.title || item.name);
  if (!n) return 0;
  var itemYear = yearOf(item.create_year);
  var yearOk = !year || !itemYear || Math.abs(Number(itemYear) - Number(year)) <= 1;
  var best = 0;
  for (var i = 0; i < titles.length; i++) {
    var t = cleanTitle(titles[i]);
    if (!t) continue;
    if (n === t) {
      best = Math.max(best, yearOk ? 100 : 78);
    } else if (n.indexOf(t) !== -1 || t.indexOf(n) !== -1) {
      best = Math.max(best, yearOk ? 62 : 40);
    }
  }
  return best;
}

async function findOnChiChi(titles, mediaType, year) {
  var queries = buildQueries(titles);
  var best = null;
  var bestScore = 0;
  for (var qi = 0; qi < queries.length; qi++) {
    var docs = await searchChiChi(queries[qi]);
    for (var di = 0; di < docs.length; di++) {
      var doc = docs[di];
      if (!matchesType(doc, mediaType)) continue;
      var sc = scoreItem(doc, titles, year);
      if (sc > bestScore) {
        bestScore = sc;
        best = doc;
      }
    }
    if (bestScore >= 100) break;
  }
  if (!best || bestScore < 78) {
    console.log("[" + PROVIDER_NAME + "] content not found (best score " + bestScore + ")");
    return null;
  }
  console.log("[" + PROVIDER_NAME + "] match: " + (best.title || best.id) + " (" + best.create_year + ") score=" + bestScore);
  return best;
}

// Episode pages expose the active episode's direct source via a `videoUrl`
// field (the `servers` array is `$undefined` and only carries season 1 data).
function directSourcesFromEpisode(flight) {
  var urls = [];
  var vm = flight.match(/"videoUrl":"(https?:[^"]+)"/);
  if (vm && isDirectMedia(vm[1])) urls.push(vm[1]);
  var em = flight.match(/"embedUrl":"(https?:[^"]+)"/);
  if (em && isDirectMedia(em[1]) && urls.indexOf(em[1]) === -1) urls.push(em[1]);
  var out = [];
  for (var i = 0; i < urls.length; i++) out.push({ embed: urls[i] });
  return out;
}

// ─── Quality probing ─────────────────────────────────────────────────────────

function qualityFromResolution(w, h) {
  if (h >= 1700 || w >= 3300) return "2160p";
  if (h >= 1000 || w >= 1800) return "1080p";
  if (h >= 700 || w >= 1200) return "720p";
  if (h >= 500 || w >= 800) return "480p";
  return h > 0 ? h + "p" : "";
}

function probeQuality(url) {
  var key = "q:" + url;
  var cached = cacheGet(key);
  if (cached !== null) return Promise.resolve(cached);
  return fetchWithTimeout(url, { headers: STREAM_HEADERS }, 8000).then(function (res) {
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

// ─── Stream building ─────────────────────────────────────────────────────────

function makeStream(url, quality, streamTitle) {
  var q = quality || "HD";
  return {
    name: PROVIDER_NAME,
    title: streamTitle + " · " + q,
    url: url,
    quality: q,
    headers: { "User-Agent": UA },
    subtitles: []
  };
}

async function buildStreams(servers, streamTitle) {
  var urls = [];
  var seen = {};
  for (var i = 0; i < (servers || []).length; i++) {
    var s = servers[i];
    if (!s) continue;
    var embed = String(s.embed || "").trim();
    if (!isDirectMedia(embed) || seen[embed]) continue;
    seen[embed] = true;
    urls.push(embed);
  }
  if (!urls.length) return [];

  var streams = [];
  for (var u = 0; u < urls.length; u++) {
    var quality = await probeQuality(urls[u]);
    streams.push(makeStream(urls[u], quality, streamTitle));
  }
  return streams;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  console.log("[" + PROVIDER_NAME + "] Request: tmdbId=" + tmdbId + " type=" + mediaType +
    (isMovie ? "" : " S" + s + "E" + e));

  try {
    var tmdbInfo = await getTMDBDetails(tmdbId, mediaType);
    var searchTitles = tmdbInfo.titles && tmdbInfo.titles.length ? tmdbInfo.titles : [String(tmdbId)];

    var match = await findOnChiChi(searchTitles, mediaType, tmdbInfo.year);
    if (!match || !match.id) {
      console.log("[" + PROVIDER_NAME + "] no match, returning []");
      return [];
    }

    var baseTitle = tmdbInfo.title || match.title || ("TMDB " + tmdbId);
    var year = tmdbInfo.year || yearOf(match.create_year);
    var streamTitle = baseTitle + (isMovie ? "" : (" S" + pad2(s) + "E" + pad2(e))) +
      (year ? " (" + year + ")" : "");

    var servers = null;

    if (isMovie) {
      var html = await fetchText(BASE_URL + "/" + LANG + "/movie/" + match.id, PAGE_HEADERS);
      var flight = extractFlight(html);
      servers = findPlayerServers(flight);
      if (!servers) {
        var m = flight.match(/"embedUrl":"(https?:[^"]+)"/);
        if (m && isDirectMedia(m[1])) servers = [{ embed: m[1] }];
      }
    } else {
      var epUrl = BASE_URL + "/" + LANG + "/series/" + match.id + "/episode/s" + s + "e" + e;
      var epHtml = null;
      try {
        epHtml = await fetchText(epUrl, PAGE_HEADERS);
      } catch (epErr) {
        console.log("[" + PROVIDER_NAME + "] episode S" + s + "E" + e + " not available (" + epErr.message + ")");
        return [];
      }
      servers = directSourcesFromEpisode(extractFlight(epHtml));
    }

    var streams = await buildStreams(servers, streamTitle);
    console.log("[" + PROVIDER_NAME + "] Done: " + streams.length + " stream(s)");
    return streams;

  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
