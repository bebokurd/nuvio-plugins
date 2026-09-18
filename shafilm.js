// ShaFilm Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js
// Kurdish (Sorani) subtitled movies & TV shows

"use strict";

var PROVIDER_NAME = "ShaFilm";
var BASE_URL = "https://shafilm.vip";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 15000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

var HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json, text/html, */*",
  "Referer": BASE_URL + "/",
  "Origin": BASE_URL,
  "X-Requested-With": "XMLHttpRequest"
};

var PLAYABLE_EXT = /\.(mp4|mkv|webm|m3u8)(\?|$)/i;
var HLS_MARKER = /\/hls\//i;
var DEAD_HOST = /shafilmbot\.herokuapp\.com/i;

// Server buttons look like:
//   <button class="btn-service dropdown-source" data-embed="63089"><span class="name">SHA NVME</span></button>
var SERVER_RE = /data-embed="(\d+)"[^>]*>\s*<span class="name">\s*([^<]*?)\s*<\/span>/gi;

// Embed responses either contain a direct player:
//   const videoUrl = "https://...";
// or an iframe / source element:
//   <iframe class="embed-responsive-item" src="https://..." ...>
var VIDEO_URL_RE = /videoUrl\s*=\s*["']([^"']+)["']/i;
var SOURCE_RE = /<source[^>]*src="([^"]+)"/i;
var VIDEO_SRC_RE = /<video[^>]*src="([^"]+)"/i;
var IFRAME_RE = /<iframe[^>]*src="([^"]+)"/i;

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
  opts.headers = Object.assign({}, HEADERS, opts.headers || {});
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

function inferQuality(str) {
  var m = String(str || "").match(/(2160|1440|1080|720|480|360)\s*p/i);
  return m ? m[1] + "p" : "";
}

function unescapeUrl(str) {
  var out = String(str || "");
  out = out.replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) {
    return String.fromCharCode(parseInt(h, 16));
  });
  out = out
    .replace(/&#0*39;|&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return out;
}

function isDirectUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.indexOf("http") !== 0) return false;
  if (DEAD_HOST.test(url)) return false;
  if (PLAYABLE_EXT.test(url)) return true;
  if (HLS_MARKER.test(url)) return true;
  return false;
}

function pad2(n) {
  n = Number(n) || 0;
  return n < 10 ? "0" + n : String(n);
}

function latinServerName(name, url, idx) {
  var raw = String(name || "");
  if (raw) return raw;
  var hostMatch = String(url || "").match(/^https?:\/\/([^/:]+)/i);
  if (hostMatch) return hostMatch[1].replace(/^www\./, "");
  return "Server " + (idx + 1);
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
    console.log("[ShaFilm] TMDB error: " + err.message);
    return { title: "", titles: [], year: "" };
  }
}

// ─── Search & Match ──────────────────────────────────────────────────────────

async function searchShafilm(query) {
  var url = BASE_URL + "/ajax/posts?q=" + encodeURIComponent(query);
  console.log("[ShaFilm] Searching: " + url);
  var res = await fetchWithTimeout(url);
  if (!res.ok) return [];
  var data = await res.json();
  if (!data || !Array.isArray(data.data)) return [];
  return data.data;
}

function scoreItem(item, titles, year) {
  var n = cleanTitle(item.name);
  if (!n) return 0;
  var yearOk = !year || !item.year || String(item.year) === String(year);
  var best = 0;
  for (var i = 0; i < titles.length; i++) {
    var t = cleanTitle(titles[i]);
    if (!t) continue;
    if (n === t && yearOk) return 100;
    if (n === t) {
      best = Math.max(best, 70);
    } else if (yearOk && (n.indexOf(t) !== -1 || t.indexOf(n) !== -1)) {
      best = Math.max(best, 55);
    }
  }
  return best;
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
  return out;
}

async function findOnShafilm(titles, mediaType, year) {
  var titleList = uniqueNonEmpty(titles);
  var queries = buildQueries(titles);

  var targetType = mediaType === "movie" ? "movie" : "serie";
  var best = null;
  var bestScore = 0;

  for (var qi = 0; qi < queries.length; qi++) {
    try {
      var docs = await searchShafilm(queries[qi]);
      for (var di = 0; di < docs.length; di++) {
        var doc = docs[di];
        if (String(doc.content_type) !== targetType) continue;
        var sc = scoreItem(doc, titleList, year);
        if (sc > bestScore) {
          bestScore = sc;
          best = doc;
        }
      }
      if (bestScore >= 100) break;
    } catch (e) {
      console.log("[ShaFilm] Search attempt failed: " + e.message);
    }
  }

  if (!best || bestScore < 55) {
    console.log("[ShaFilm] Content not found on ShaFilm");
    return null;
  }

  console.log("[ShaFilm] Match: " + (best.name || best.url) + " (score " + bestScore + ")");
  return best;
}

// ─── Page parsing ─────────────────────────────────────────────────────────────

async function fetchText(url) {
  var res = await fetchWithTimeout(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,*/*",
      "Referer": BASE_URL + "/"
    }
  });
  if (!res.ok) throw new Error("Page HTTP " + res.status);
  return await res.text();
}

function extractServers(html) {
  var servers = [];
  var seen = {};
  var m;
  SERVER_RE.lastIndex = 0;
  while ((m = SERVER_RE.exec(html)) !== null) {
    var id = m[1];
    var name = (m[2] || "").trim();
    if (!id || seen[id]) continue;
    seen[id] = true;
    servers.push({ id: id, name: name });
  }
  return servers;
}

// ─── Embed resolve ────────────────────────────────────────────────────────────

async function resolveEmbed(id, pageUrl) {
  var url = BASE_URL + "/ajax/embed";
  try {
    var res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": pageUrl || BASE_URL + "/",
        "Origin": BASE_URL,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "text/html, */*"
      },
      body: "id=" + encodeURIComponent(id)
    });
    if (!res.ok) return null;
    var html = await res.text();

    var m = html.match(VIDEO_URL_RE);
    if (m && m[1]) {
      var cu = unescapeUrl(m[1]);
      if (isDirectUrl(cu)) {
        return { url: cu, quality: inferQuality(cu) };
      }
    }

    var src = null;
    var sm = html.match(SOURCE_RE);
    if (sm && sm[1]) src = sm[1];
    if (!src) {
      var vm = html.match(VIDEO_SRC_RE);
      if (vm && vm[1]) src = vm[1];
    }
    if (src) {
      var cs = unescapeUrl(src);
      if (isDirectUrl(cs)) {
        return { url: cs, quality: inferQuality(cs) };
      }
    }

    var im = html.match(IFRAME_RE);
    if (im && im[1]) {
      var ci = unescapeUrl(im[1]);
      if (isDirectUrl(ci)) {
        return { url: ci, quality: inferQuality(ci) };
      }
    }

    return null;
  } catch (err) {
    console.log("[ShaFilm] Embed resolve failed (" + id + "): " + err.message);
    return null;
  }
}

// ─── Stream building ──────────────────────────────────────────────────────────

function buildStreamHeaders(url, pageUrl) {
  var headers = { "User-Agent": UA };
  headers.Referer = pageUrl || BASE_URL + "/";
  headers.Origin = BASE_URL;
  headers.Accept = "*/*";
  return headers;
}

function makeStream(url, serverName, quality, streamTitle, pageUrl) {
  var q = quality || inferQuality(url) || "Auto";
  var name = PROVIDER_NAME + (serverName ? " [" + serverName + "]" : "");
  return {
    name: name,
    title: streamTitle + " · " + q,
    url: url,
    quality: q,
    headers: buildStreamHeaders(url, pageUrl),
    subtitles: []
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  console.log("[ShaFilm] Request: tmdbId=" + tmdbId + " type=" + mediaType + (isMovie ? "" : " S" + s + "E" + e));

  try {
    var tmdbInfo = await getTMDBDetails(tmdbId, mediaType);
    var searchTitles = tmdbInfo.titles && tmdbInfo.titles.length ? tmdbInfo.titles : [String(tmdbId)];
    var searchYear = tmdbInfo.year || "";

    var match = await findOnShafilm(searchTitles, mediaType, searchYear);
    if (!match || !match.url) {
      console.log("[ShaFilm] Not found, returning []");
      return [];
    }

    var pageUrl;
    if (isMovie) {
      pageUrl = match.url;
    } else {
      pageUrl = match.url + "-" + s + "-season-" + e + "-episode";
    }
    console.log("[ShaFilm] Fetching page: " + pageUrl);

    var html = await fetchText(pageUrl);
    var servers = extractServers(html);
    if (!servers.length) {
      console.log("[ShaFilm] No servers found on page");
      return [];
    }

    var streamTitle = (tmdbInfo.title || match.name || ("TMDB " + tmdbId)) +
      (isMovie ? "" : (" S" + pad2(s) + "E" + pad2(e))) +
      (tmdbInfo.year || match.year ? " (" + (tmdbInfo.year || match.year) + ")" : "");

    var streams = [];
    var seen = {};
    for (var i = 0; i < servers.length; i++) {
      var server = servers[i];
      var resolved = await resolveEmbed(server.id, pageUrl);
      if (!resolved || !resolved.url || seen[resolved.url]) continue;
      seen[resolved.url] = true;
      var sName = latinServerName(server.name, resolved.url, i);
      streams.push(makeStream(resolved.url, sName, resolved.quality, streamTitle, pageUrl));
    }

    console.log("[ShaFilm] Done: " + streams.length + " stream(s)");
    return streams;

  } catch (err) {
    console.error("[ShaFilm] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };