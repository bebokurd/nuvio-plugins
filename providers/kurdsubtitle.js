// Kurdsubtitle Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js

"use strict";

const PROVIDER_NAME = "Kurdsubtitle";
const BASE_URL = "https://kurdsubtitle.net";
const API_BASE = "https://api.kurdsubtitle.net/api/v1";
const TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
const ENCRYPTION_SECRET = "ff7847b696daa59590236f7850e348612a48d3dcf121bf1539a101c4fb140c7e";
const TIMEOUT_MS = 12000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": UA,
  "Origin": BASE_URL,
  "Referer": BASE_URL + "/",
  "Accept": "application/json, text/plain, */*"
};

const PLAYABLE_EXT = /\.(mp4|mkv|webm|avi|m3u8|mpd)(\?|$)/i;
const EMBED_HOST = /(dhtpre\.com\/(embed|e|download)|bysejikuar\.com\/e\/|\/embed\/|player\.php)/i;
const VSTREAMER_RE = /(?:^|\.)vstreamer\.store\/(?:stream\/)?(\d+)/i;

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

function isDirectFile(url) {
  return typeof url === "string" && PLAYABLE_EXT.test(url);
}

function isEmbedPage(url) {
  return typeof url === "string" && EMBED_HOST.test(url);
}

function unescapeJsString(str) {
  return String(str || "").replace(/\\\//g, "/");
}

function latinServerName(server, url, idx) {
  var raw = (server && (server.name || server.label)) || "";
  if (/vstreamer/i.test(raw) || /vstreamer/i.test(url || "")) return "Vstreamer";
  if (/download/i.test(raw)) return "Download";
  var latin = raw.replace(/[^\x00-\x7F]+/g, " ").replace(/\s+/g, " ").trim();
  if (latin) return latin;
  var hostMatch = String(url || "").match(/^https?:\/\/([^/:]+)/i);
  if (hostMatch) return hostMatch[1].replace(/^www\./, "");
  return "Server " + (idx + 1);
}

function buildStreamHeaders(url) {
  var headers = { "User-Agent": UA };
  if (/vstreamer\.store/i.test(url || "")) {
    headers.Referer = "https://streamer.vstreamer.store/";
    headers.Origin = "https://streamer.vstreamer.store";
  } else {
    headers.Referer = BASE_URL + "/";
  }
  return headers;
}

// ─── Base64 helpers ──────────────────────────────────────────────────────────

function base64ToUint8Array(b64) {
  try {
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(b64, "base64"));
    }
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (e) {
    return new Uint8Array(0);
  }
}

// ─── AES-GCM Decryption ──────────────────────────────────────────────────────

function getSubtle() {
  if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle)
    return globalThis.crypto.subtle;
  if (typeof global !== "undefined" && global.crypto && global.crypto.subtle)
    return global.crypto.subtle;
  if (typeof self !== "undefined" && self.crypto && self.crypto.subtle)
    return self.crypto.subtle;
  if (typeof crypto !== "undefined" && crypto.subtle)
    return crypto.subtle;
  return null;
}

function coerceServerList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.watchServers)) return parsed.watchServers;
  if (parsed && Array.isArray(parsed.servers)) return parsed.servers;
  return [];
}

async function decryptServers(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "string") return [];

  var trimmed = payload.trim();
  if (trimmed.charAt(0) === "[" || trimmed.charAt(0) === "{") {
    try {
      return coerceServerList(JSON.parse(trimmed));
    } catch (e) {}
  }

  try {
    var rawBytes = base64ToUint8Array(payload);
    if (rawBytes.length < 28) {
      console.log("[Kurdsubtitle] Payload too short to be encrypted");
      return [];
    }

    var iv = rawBytes.slice(0, 12);
    var ciphertextWithTag = rawBytes.slice(12);

    var subtle = getSubtle();
    if (subtle) {
      try {
        var secretBytes = new TextEncoder().encode(ENCRYPTION_SECRET);
        var keyHash = await subtle.digest("SHA-256", secretBytes);
        var cryptoKey = await subtle.importKey("raw", keyHash, { name: "AES-GCM" }, false, ["decrypt"]);
        var decrypted = await subtle.decrypt({ name: "AES-GCM", iv: iv, tagLength: 128 }, cryptoKey, ciphertextWithTag);
        var text = new TextDecoder().decode(decrypted);
        return coerceServerList(JSON.parse(text));
      } catch (e) {
        console.log("[Kurdsubtitle] WebCrypto decrypt failed: " + e.message);
      }
    }

    try {
      var nodeCrypto = require("crypto");
      if (nodeCrypto && typeof nodeCrypto.createDecipheriv === "function") {
        var key = nodeCrypto.createHash("sha256").update(ENCRYPTION_SECRET).digest();
        var tagStart = rawBytes.length - 16;
        var tag = rawBytes.slice(tagStart);
        var cipher = rawBytes.slice(12, tagStart);
        var decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        var dec = Buffer.concat([decipher.update(Buffer.from(cipher)), decipher.final()]);
        return coerceServerList(JSON.parse(dec.toString("utf8")));
      }
    } catch (nodeErr) {}

    console.log("[Kurdsubtitle] No crypto API available for decryption");
    return [];
  } catch (err) {
    console.log("[Kurdsubtitle] Decryption error: " + err.message);
    return [];
  }
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
    console.log("[Kurdsubtitle] TMDB error: " + err.message);
    return { title: "", titles: [], year: "" };
  }
}

function scoreDoc(doc, titles, year) {
  var dt = cleanTitle(doc.title);
  if (!dt) return 0;
  var yearOk = !year || !doc.year || String(doc.year) === String(year);
  var best = 0;
  for (var i = 0; i < titles.length; i++) {
    var nt = cleanTitle(titles[i]);
    if (!nt) continue;
    if (dt === nt && yearOk) return 100;
    if (dt === nt) best = Math.max(best, 70);
    else if (yearOk && (dt.indexOf(nt) !== -1 || nt.indexOf(dt) !== -1)) best = Math.max(best, 55);
  }
  return best;
}

// ─── Search & Match ──────────────────────────────────────────────────────────

async function searchDocs(query, targetType) {
  var url = API_BASE + "/search?query=" + encodeURIComponent(query);
  console.log("[Kurdsubtitle] Searching: " + url);
  var res = await fetchWithTimeout(url);
  if (!res.ok) return [];
  var categories = await res.json();
  if (!Array.isArray(categories)) return [];
  for (var ci = 0; ci < categories.length; ci++) {
    var c = categories[ci];
    if (c.type === targetType && c.data && Array.isArray(c.data.docs)) return c.data.docs;
  }
  return [];
}

async function findOnKurdsubtitle(titles, mediaType, year) {
  var titleList = uniqueNonEmpty(titles);
  var queries = [];
  for (var ti = 0; ti < titleList.length; ti++) {
    var title = titleList[ti];
    queries.push(title);
    if (title.indexOf(":") !== -1) queries.push(title.split(":")[0].trim());
  }
  queries = uniqueNonEmpty(queries);

  var targetType = mediaType === "movie" ? "movie" : "tvshow";
  var best = null;
  var bestScore = 0;

  for (var qi = 0; qi < queries.length; qi++) {
    try {
      var docs = await searchDocs(queries[qi], targetType);
      for (var di = 0; di < docs.length; di++) {
        var sc = scoreDoc(docs[di], titleList, year);
        if (sc > bestScore) {
          bestScore = sc;
          best = docs[di];
        }
      }
      if (bestScore >= 100) break;
    } catch (e) {
      console.log("[Kurdsubtitle] Search attempt failed: " + e.message);
    }
  }

  if (!best || bestScore < 55) {
    console.log("[Kurdsubtitle] Content not found on Kurdsubtitle");
    return null;
  }

  console.log("[Kurdsubtitle] Match: " + best.slug + " (score " + bestScore + ")");
  return best;
}

function tmdbMatches(item, tmdbId) {
  var id = String(item.tmdbID || item.tmdbId || "");
  return !id || id === String(tmdbId);
}

// ─── Stream resolve ──────────────────────────────────────────────────────────

async function resolveVstreamer(videoId) {
  var fallback = "https://main.vstreamer.store/" + videoId + ".mp4";
  try {
    var res = await fetchWithTimeout("https://server.vstreamer.store/api/videos/" + videoId, {
      headers: {
        Origin: "https://streamer.vstreamer.store",
        Referer: "https://streamer.vstreamer.store/stream/" + videoId,
        Accept: "application/json"
      }
    });
    if (res.ok) {
      var body = await res.json();
      var data = body && body.data ? body.data : body;
      var link = data && (data.link || data.secondaryLink || data.url);
      if (typeof link === "string" && link.indexOf("http") === 0) {
        return {
          url: link,
          quality: inferQuality(data.name) || "1080p",
          sourceName: "Vstreamer"
        };
      }
    }
  } catch (e) {
    console.log("[Kurdsubtitle] Vstreamer API failed: " + e.message);
  }

  try {
    var page = await fetchWithTimeout("https://streamer.vstreamer.store/stream/" + videoId);
    if (page.ok) {
      var html = await page.text();
      var fileMatch = html.match(/file:\s*"([^"]+)"/);
      if (fileMatch && fileMatch[1]) {
        var fileUrl = unescapeJsString(fileMatch[1]);
        if (fileUrl.indexOf("http") === 0) {
          return { url: fileUrl, quality: "1080p", sourceName: "Vstreamer" };
        }
      }
    }
  } catch (e) {
    console.log("[Kurdsubtitle] Vstreamer page failed: " + e.message);
  }

  return { url: fallback, quality: "1080p", sourceName: "Vstreamer" };
}

async function resolveServerUrl(url) {
  if (!url || typeof url !== "string") return null;
  url = url.trim();
  if (url.indexOf("http") !== 0) return null;
  if (isEmbedPage(url)) return null;

  var vs = url.match(VSTREAMER_RE);
  if (vs) return resolveVstreamer(vs[1]);

  if (isDirectFile(url)) return { url: url, quality: inferQuality(url) || "Auto", sourceName: "" };
  return null;
}

function makeStream(url, name, quality, streamTitle, subtitles, language) {
  var lang = language ? " · " + language : "";
  return {
    name: PROVIDER_NAME + " [" + name + lang + "]",
    title: streamTitle + " · " + quality,
    url: url,
    quality: quality,
    headers: buildStreamHeaders(url),
    subtitles: subtitles || []
  };
}

async function serversToStreams(servers, streamTitle, subtitles, language) {
  var list = Array.isArray(servers) ? servers : [];
  var resolved = await Promise.all(list.map(function (srv) {
    return resolveServerUrl(srv && (srv.url || srv.value || srv.link));
  }));

  var streams = [];
  var seen = {};
  for (var i = 0; i < resolved.length; i++) {
    var r = resolved[i];
    if (!r || !r.url || seen[r.url]) continue;
    seen[r.url] = true;
    var name = r.sourceName || latinServerName(list[i], r.url, i);
    var quality = inferQuality(list[i] && list[i].quality) || r.quality || "Auto";
    streams.push(makeStream(r.url, name, quality, streamTitle, subtitles, language));
  }
  return streams;
}

function downloadsToStreams(downloads, streamTitle, language) {
  var list = Array.isArray(downloads) ? downloads : [];
  var streams = [];
  var seen = {};
  for (var i = 0; i < list.length; i++) {
    var url = list[i] && (list[i].url || list[i].value || list[i].link);
    if (!url || typeof url !== "string" || url.indexOf("http") !== 0) continue;
    if (isEmbedPage(url) || !isDirectFile(url)) continue;
    if (seen[url]) continue;
    seen[url] = true;
    var quality = list[i].quality || inferQuality(url) || "1080p";
    streams.push(makeStream(url, "Download", quality, streamTitle, [], language));
  }
  return streams;
}

function extractSubtitles(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.reduce(function (acc, sub) {
    var url = sub.url || sub.value || (typeof sub === "string" ? sub : "");
    if (url) acc.push({ url: url, lang: sub.lang || sub.language || "Kurdish" });
    return acc;
  }, []);
}

function itemLanguage(item) {
  if (!item) return "";
  if (Array.isArray(item.language) && item.language.length) return item.language[0];
  if (typeof item.language === "string") return item.language;
  return "";
}

async function collectFromItem(item, streamTitle) {
  var subs = extractSubtitles(item.subtitles);
  var language = itemLanguage(item);
  var watchServers = await decryptServers(item.watchServers);
  var dlServers = await decryptServers(item.downloadServers);
  var streams = await serversToStreams(watchServers, streamTitle, subs, language);
  return streams.concat(downloadsToStreams(dlServers, streamTitle, language));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  console.log("[Kurdsubtitle] Request: tmdbId=" + tmdbId + " type=" + mediaType + (isMovie ? "" : " S" + s + "E" + e));

  try {
    var tmdbInfo = await getTMDBDetails(tmdbId, mediaType);
    var searchTitles = tmdbInfo.titles && tmdbInfo.titles.length ? tmdbInfo.titles : [String(tmdbId)];
    var searchYear = tmdbInfo.year || "";

    var matchDoc = await findOnKurdsubtitle(searchTitles, mediaType, searchYear);
    if (!matchDoc || !matchDoc.slug) {
      console.log("[Kurdsubtitle] Not found, returning []");
      return [];
    }

    var streamTitle = (tmdbInfo.title || matchDoc.title || ("TMDB " + tmdbId)) +
      (isMovie ? "" : (" S" + String(s).padStart(2, "0") + "E" + String(e).padStart(2, "0"))) +
      (tmdbInfo.year || matchDoc.year ? " (" + (tmdbInfo.year || matchDoc.year) + ")" : "");

    if (isMovie) {
      var movieUrl = API_BASE + "/movies/" + matchDoc.slug;
      console.log("[Kurdsubtitle] Fetching movie: " + movieUrl);
      var mRes = await fetchWithTimeout(movieUrl);
      if (!mRes.ok) throw new Error("Movie HTTP " + mRes.status);
      var movie = (await mRes.json()).movie || {};
      if (!tmdbMatches(movie, tmdbId)) {
        console.log("[Kurdsubtitle] TMDB mismatch on movie detail, skipping");
        return [];
      }
      var movieStreams = await collectFromItem(movie, streamTitle);
      console.log("[Kurdsubtitle] Done: " + movieStreams.length + " stream(s)");
      return movieStreams;
    }

    var tvUrl = API_BASE + "/tvshows/" + matchDoc.slug;
    console.log("[Kurdsubtitle] Fetching tvshow: " + tvUrl);
    var tvRes = await fetchWithTimeout(tvUrl);
    if (!tvRes.ok) throw new Error("TVShow HTTP " + tvRes.status);
    var tvshow = (await tvRes.json()).movie || {};
    if (!tmdbMatches(tvshow, tmdbId)) {
      console.log("[Kurdsubtitle] TMDB mismatch on tv detail, skipping");
      return [];
    }

    var tvshowId = tvshow._id || matchDoc._id || matchDoc.id;
    if (!tvshowId) throw new Error("No tvshow _id found");

    var epUrl = API_BASE + "/tvshows/" + tvshowId + "/seasons/" + s + "/episodes";
    console.log("[Kurdsubtitle] Fetching episodes: " + epUrl);
    var epRes = await fetchWithTimeout(epUrl);
    if (!epRes.ok) throw new Error("Episodes HTTP " + epRes.status);
    var episodes = await epRes.json();

    if (!Array.isArray(episodes) || !episodes.length) {
      console.log("[Kurdsubtitle] No episodes for season " + s);
      return [];
    }

    var targetEp = null;
    for (var ei = 0; ei < episodes.length; ei++) {
      if (Number(episodes[ei].number) === e) { targetEp = episodes[ei]; break; }
    }
    if (!targetEp) {
      console.log("[Kurdsubtitle] Episode " + e + " not found");
      return [];
    }

    console.log("[Kurdsubtitle] Resolving servers for S" + s + "E" + targetEp.number);
    var tvStreams = await collectFromItem(targetEp, streamTitle);
    console.log("[Kurdsubtitle] Done: " + tvStreams.length + " stream(s)");
    return tvStreams;

  } catch (err) {
    console.error("[Kurdsubtitle] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
