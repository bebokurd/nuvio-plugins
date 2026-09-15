// Kurdsubtitle Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js
"use strict";

const PROVIDER_NAME = "Kurdsubtitle";
const BASE_URL = "https://kurdsubtitle.net";
const API_BASE = "https://api.kurdsubtitle.net/api/v1";
const TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
const ENCRYPTION_SECRET = "ff7847b696daa59590236f7850e348612a48d3dcf121bf1539a101c4fb140c7e";
const TIMEOUT_MS = 12000;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Origin": BASE_URL,
  "Referer": `${BASE_URL}/`,
  "Accept": "application/json, text/plain, */*"
};

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

async function decryptServers(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "string") return [];

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
        var parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
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
        var parsedNode = JSON.parse(dec.toString("utf8"));
        return Array.isArray(parsedNode) ? parsedNode : [];
      }
    } catch (nodeErr) {
      // Node crypto not available or failed
    }

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
    return {
      title: data.name || data.title || "",
      year: (data.first_air_date || data.release_date || "").split("-")[0]
    };
  } catch (err) {
    console.log("[Kurdsubtitle] TMDB error: " + err.message);
    return { title: "", year: "" };
  }
}

// ─── Search & Match ──────────────────────────────────────────────────────────

async function findOnKurdsubtitle(title, mediaType, year) {
  var queries = [title];
  if (title.includes(":")) queries.push(title.split(":")[0].trim());
  if (title.split(" ").length > 1) queries.push(title.split(" ")[0]);

  var targetType = mediaType === "movie" ? "movie" : "tvshow";

  for (var qi = 0; qi < queries.length; qi++) {
    var q = queries[qi];
    try {
      var url = API_BASE + "/search?query=" + encodeURIComponent(q);
      console.log("[Kurdsubtitle] Searching: " + url);
      var res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      var categories = await res.json();
      if (!Array.isArray(categories)) continue;

      var cat = null;
      for (var ci = 0; ci < categories.length; ci++) {
        var c = categories[ci];
        if (c.type === targetType) { cat = c; break; }
      }
      if (!cat || !cat.data || !Array.isArray(cat.data.docs) || !cat.data.docs.length) continue;

      var docs = cat.data.docs;
      var normalizedTarget = cleanTitle(title);

      for (var di = 0; di < docs.length; di++) {
        var d = docs[di];
        if (cleanTitle(d.title) === normalizedTarget && (!year || !d.year || String(d.year) === String(year))) {
          console.log("[Kurdsubtitle] Exact match: " + d.slug);
          return d;
        }
      }

      for (var di2 = 0; di2 < docs.length; di2++) {
        var d2 = docs[di2];
        var mt = cleanTitle(d2.title);
        var sameYear = !year || !d2.year || String(d2.year) === String(year);
        if (sameYear && (mt.includes(normalizedTarget) || normalizedTarget.includes(mt))) {
          console.log("[Kurdsubtitle] Partial match: " + d2.slug);
          return d2;
        }
      }

      for (var di3 = 0; di3 < docs.length; di3++) {
        var d3 = docs[di3];
        var mt3 = cleanTitle(d3.title);
        if (mt3 === normalizedTarget || mt3.includes(normalizedTarget) || normalizedTarget.includes(mt3)) {
          console.log("[Kurdsubtitle] Title-only match: " + d3.slug);
          return d3;
        }
      }

      if (qi === 0 && docs.length > 0) {
        console.log("[Kurdsubtitle] Fallback to first result: " + docs[0].slug);
        return docs[0];
      }
    } catch (e) {
      console.log("[Kurdsubtitle] Search attempt failed: " + e.message);
    }
  }

  console.log("[Kurdsubtitle] Content not found on Kurdsubtitle");
  return null;
}

// ─── Stream builders ─────────────────────────────────────────────────────────

function buildStreamHeaders() {
  return {
    "User-Agent": HEADERS["User-Agent"],
    "Referer": BASE_URL + "/"
  };
}

function serverToStream(server, idx, streamTitle, subtitles) {
  var url = server.url || server.value || null;
  if (!url || typeof url !== "string" || !url.startsWith("http")) return null;
  var name = server.name || ("Server " + (idx + 1));
  var quality = server.quality || "Auto";
  return {
    name: PROVIDER_NAME + " [" + name + "]",
    title: streamTitle + " · " + quality,
    url: url,
    quality: quality,
    headers: buildStreamHeaders(),
    subtitles: subtitles || []
  };
}

function downloadToStream(dl, streamTitle) {
  var url = dl.url || dl.value || null;
  if (!url || typeof url !== "string" || !url.startsWith("http")) return null;
  var quality = dl.quality || "1080p";
  return {
    name: PROVIDER_NAME + " [Download · " + quality + "]",
    title: streamTitle + " · " + quality,
    url: url,
    quality: quality,
    headers: buildStreamHeaders(),
    subtitles: []
  };
}

function extractSubtitles(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.reduce(function (acc, sub) {
    var url = sub.url || sub.value || (typeof sub === "string" ? sub : "");
    if (url) acc.push({ url: url, lang: sub.lang || sub.language || "Kurdish" });
    return acc;
  }, []);
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
    var searchTitle = tmdbInfo.title || String(tmdbId);
    var searchYear = tmdbInfo.year || "";

    var matchDoc = await findOnKurdsubtitle(searchTitle, mediaType, searchYear);
    if (!matchDoc || !matchDoc.slug) {
      console.log("[Kurdsubtitle] Not found, returning []");
      return [];
    }

    var streamTitle = (tmdbInfo.title || matchDoc.title || ("TMDB " + tmdbId)) +
      (isMovie ? "" : (" S" + String(s).padStart(2, "0") + "E" + String(e).padStart(2, "0"))) +
      (tmdbInfo.year || matchDoc.year ? " (" + (tmdbInfo.year || matchDoc.year) + ")" : "");

    var streams = [];

    if (isMovie) {
      var movieUrl = API_BASE + "/movies/" + matchDoc.slug;
      console.log("[Kurdsubtitle] Fetching movie: " + movieUrl);
      var mRes = await fetchWithTimeout(movieUrl);
      if (!mRes.ok) throw new Error("Movie HTTP " + mRes.status);
      var mData = await mRes.json();
      var movie = mData.movie || mData;

      var subs = extractSubtitles(movie.subtitles);
      var watchServers = Array.isArray(movie.watchServers) ? movie.watchServers : [];
      var dlServers = Array.isArray(movie.downloadServers) ? movie.downloadServers : [];

      watchServers.forEach(function (srv, idx) {
        var st = serverToStream(srv, idx, streamTitle, subs);
        if (st) streams.push(st);
      });
      dlServers.forEach(function (dl) {
        var st = downloadToStream(dl, streamTitle);
        if (st) streams.push(st);
      });

    } else {
      var tvUrl = API_BASE + "/tvshows/" + matchDoc.slug;
      console.log("[Kurdsubtitle] Fetching tvshow: " + tvUrl);
      var tvRes = await fetchWithTimeout(tvUrl);
      if (!tvRes.ok) throw new Error("TVShow HTTP " + tvRes.status);
      var tvData = await tvRes.json();
      var tvshow = tvData.movie || tvData;

      var detailTmdbId = String(tvshow.tmdbID || tvshow.tmdbId || "");
      if (detailTmdbId && detailTmdbId !== String(tmdbId)) {
        console.log("[Kurdsubtitle] TMDB ID mismatch (" + detailTmdbId + " vs " + tmdbId + "), trying again");
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
        targetEp = episodes[e - 1] || episodes[0];
        console.log("[Kurdsubtitle] Ep " + e + " not found by number, using index fallback");
      }

      console.log("[Kurdsubtitle] Resolving servers for S" + s + "E" + targetEp.number);

      var watchServersRaw = await decryptServers(targetEp.watchServers);
      var dlServersRaw = await decryptServers(targetEp.downloadServers);
      var epSubs = extractSubtitles(targetEp.subtitles);

      watchServersRaw.forEach(function (srv, idx) {
        var st = serverToStream(srv, idx, streamTitle, epSubs);
        if (st) streams.push(st);
      });
      dlServersRaw.forEach(function (dl) {
        var st = downloadToStream(dl, streamTitle);
        if (st) streams.push(st);
      });
    }

    console.log("[Kurdsubtitle] Done: " + streams.length + " stream(s)");
    return streams;

  } catch (err) {
    console.error("[Kurdsubtitle] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
