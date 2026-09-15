// Kurdsubtitle Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js

"use strict";

const PROVIDER_NAME = "Kurdsubtitle";
const BASE_URL = "https://kurdsubtitle.net";
const API_BASE = "https://api.kurdsubtitle.net/api/v1";
const TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
const ENCRYPTION_SECRET = "ff7847b696daa59590236f7850e348612a48d3dcf121bf1539a101c4fb140c7e";
const TIMEOUT_MS = 10000;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Origin": BASE_URL,
  "Referer": `${BASE_URL}/`,
  "Accept": "application/json, text/plain, */*"
};

const HTML_HEADERS = Object.assign({}, HEADERS, { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" });

// Hosts that Nuvio cannot play directly – skip them
const SKIP_HOSTS = [
  "terabox", "gdrive", "drive.google", "youtube", "youtu.be",
  "fembed", "uns.bio", "uns.bio"
];

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

function normalizeUrl(url) {
  if (!url || typeof url !== "string") return null;
  url = url.trim();
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http://")) return "https://" + url.slice(7);
  if (url.startsWith("http")) return url;
  return null;
}

function isSkippableHost(url) {
  if (!url) return true;
  var lower = url.toLowerCase();
  for (var i = 0; i < SKIP_HOSTS.length; i++) {
    if (lower.includes(SKIP_HOSTS[i])) return true;
  }
  return false;
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

function hexToUint8Array(hex) {
  if (!hex || typeof hex !== "string") return new Uint8Array(0);
  hex = hex.replace(/^0x/, "");
  if (hex.length % 2 !== 0) return new Uint8Array(0);
  var bytes = new Uint8Array(hex.length / 2);
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
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

async function tryDecryptWebCrypto(rawBytes, keyBytes) {
  var subtle = getSubtle();
  if (!subtle) return null;
  try {
    var iv = rawBytes.slice(0, 12);
    var ciphertextWithTag = rawBytes.slice(12);
    var cryptoKey = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    var decrypted = await subtle.decrypt(
      { name: "AES-GCM", iv: iv, tagLength: 128 },
      cryptoKey,
      ciphertextWithTag
    );
    var text = new TextDecoder().decode(decrypted);
    var parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

async function tryDecryptNode(rawBytes, keyBytes) {
  try {
    var nodeCrypto = require("crypto");
    if (!nodeCrypto || typeof nodeCrypto.createDecipheriv !== "function") return null;
    var iv = rawBytes.slice(0, 12);
    var tagStart = rawBytes.length - 16;
    var tag = rawBytes.slice(tagStart);
    var cipher = rawBytes.slice(12, tagStart);
    var decipher = nodeCrypto.createDecipheriv("aes-256-gcm", Buffer.from(keyBytes), Buffer.from(iv));
    decipher.setAuthTag(Buffer.from(tag));
    var dec = Buffer.concat([decipher.update(Buffer.from(cipher)), decipher.final()]);
    var parsed = JSON.parse(dec.toString("utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

async function decryptPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "string") return [];

  try {
    var rawBytes = base64ToUint8Array(payload);
    if (rawBytes.length < 28) return [];

    // Build candidate keys: SHA-256 of secret, and raw hex-decoded secret
    var subtle = getSubtle();
    var shaKey = null;
    if (subtle) {
      try {
        var secretBytes = new TextEncoder().encode(ENCRYPTION_SECRET);
        var hash = await subtle.digest("SHA-256", secretBytes);
        shaKey = new Uint8Array(hash);
      } catch (e) { /* ignore */ }
    }
    var hexKey = hexToUint8Array(ENCRYPTION_SECRET);

    var candidates = [];
    if (shaKey) candidates.push(shaKey);
    if (hexKey.length === 32) candidates.push(hexKey);

    // Try WebCrypto first, then Node
    for (var i = 0; i < candidates.length; i++) {
      var res = await tryDecryptWebCrypto(rawBytes, candidates[i]);
      if (res) return res;
    }
    for (var j = 0; j < candidates.length; j++) {
      var res2 = await tryDecryptNode(rawBytes, candidates[j]);
      if (res2) return res2;
    }

    return [];
  } catch (err) {
    console.log("[Kurdsubtitle] Decryption error: " + err.message);
    return [];
  }
}

// ─── Packed JS unpacker (Dean Edwards) ───────────────────────────────────────

function unpackPacked(html) {
  // Match: eval(function(p,a,c,k,e,d){...}('...',N,N,'...'.split('|'),0,{}))
  var match = html.match(
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\s*\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\s*\.split\('\|'\)/
  );
  if (!match) return html;

  var payload = match[1];
  var radix = parseInt(match[2], 10);
  var count = parseInt(match[3], 10);
  var keywords = match[4].split("|");

  function baseN(num, r) {
    var chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    var result = "";
    var n = num;
    while (n > 0) {
      result = chars.charAt(n % r) + result;
      n = Math.floor(n / r);
    }
    return result || "0";
  }

  // Replace \b\w+\b tokens with keyword table entries
  var unpacked = payload.replace(/\b\w+\b/g, function (word) {
    var idx = parseInt(word, radix);
    if (!isNaN(idx) && idx < keywords.length && keywords[idx]) {
      return keywords[idx];
    }
    return word;
  });

  // Decode \x escapes
  unpacked = unpacked.replace(/\\x([0-9A-Fa-f]{2})/g, function (_, hex) {
    return String.fromCharCode(parseInt(hex, 16));
  });
  unpacked = unpacked.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");

  return unpacked;
}

// ─── Media extraction ────────────────────────────────────────────────────────

function extractMediaFromHtml(html) {
  if (!html || typeof html !== "string") return null;

  var unpacked = html;
  if (html.includes("p,a,c,k,e,d") || html.includes("eval(function(p,a,c,k,e,d)")) {
    try { unpacked = unpackPacked(html); } catch (e) { /* use original */ }
  }

  // Try common patterns
  var patterns = [
    /["']file["']\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["']source["']\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["']src["']\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i,
    /(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/i
  ];

  for (var i = 0; i < patterns.length; i++) {
    var m = unpacked.match(patterns[i]);
    if (m && m[1]) {
      var url = m[1].replace(/\\\//g, "/").replace(/\\u002F/g, "/");
      return normalizeUrl(url);
    }
  }

  // Check for vstreamer rewrite
  var vsMatch = unpacked.match(/(https?:\/\/[^\s"'<>]*vstreamer[^\s"'<>]*)/i);
  if (vsMatch) {
    return rewriteVstreamer(vsMatch[1]);
  }

  return null;
}

function rewriteVstreamer(url) {
  if (!url) return null;
  // Rewrite to main.vstreamer.store with correct referer
  var rewritten = url.replace(/\/\/[^/]*vstreamer[^/]*\//i, "//main.vstreamer.store/");
  return normalizeUrl(rewritten);
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
        if (categories[ci].type === targetType) { cat = categories[ci]; break; }
      }
      if (!cat || !cat.data || !Array.isArray(cat.data.docs) || !cat.data.docs.length) continue;

      var docs = cat.data.docs;
      var normalizedTarget = cleanTitle(title);

      for (var di = 0; di < docs.length; di++) {
        var d = docs[di];
        if (cleanTitle(d.title) === normalizedTarget && (!year || !d.year || String(d.year) === String(year))) {
          return d;
        }
      }

      for (var di2 = 0; di2 < docs.length; di2++) {
        var d2 = docs[di2];
        var mt = cleanTitle(d2.title);
        var sameYear = !year || !d2.year || String(d2.year) === String(year);
        if (sameYear && (mt.includes(normalizedTarget) || normalizedTarget.includes(mt))) {
          return d2;
        }
      }

      for (var di3 = 0; di3 < docs.length; di3++) {
        var d3 = docs[di3];
        var mt3 = cleanTitle(d3.title);
        if (mt3 === normalizedTarget || mt3.includes(normalizedTarget) || normalizedTarget.includes(mt3)) {
          return d3;
        }
      }

      if (qi === 0 && docs.length > 0) return docs[0];
    } catch (e) {
      console.log("[Kurdsubtitle] Search attempt failed: " + e.message);
    }
  }

  return null;
}

// ─── Stream builders ─────────────────────────────────────────────────────────

function buildStreamHeaders(referer) {
  return {
    "User-Agent": HEADERS["User-Agent"],
    "Referer": referer || (BASE_URL + "/")
  };
}

function extractSubtitles(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.reduce(function (acc, sub) {
    var url = sub.url || sub.value || (typeof sub === "string" ? sub : "");
    url = normalizeUrl(url);
    if (url) acc.push({ url: url, lang: sub.lang || sub.language || "Kurdish" });
    return acc;
  }, []);
}

// Extract a direct URL from a server object (movie servers use `value`)
function extractServerUrl(server) {
  if (!server) return null;
  var raw = server.url || server.value || server.link || server.src || null;
  return normalizeUrl(raw);
}

// Resolve an embed page to a direct media URL
async function resolveEmbed(url) {
  if (!url) return null;
  if (isSkippableHost(url)) return null;
  try {
    var res = await fetchWithTimeout(url, { headers: HTML_HEADERS });
    if (!res.ok) return null;
    var html = await res.text();
    var media = extractMediaFromHtml(html);
    if (media) return media;
  } catch (e) {
    // ignore
  }
  return null;
}

// Resolve the "our" server (no direct URL) via the site's stream API
async function resolveOurServer(slug, mediaType, season, episode) {
  // Try common endpoint patterns
  var endpoints = [];
  if (mediaType === "movie") {
    endpoints.push(API_BASE + "/movies/" + slug + "/stream");
    endpoints.push(API_BASE + "/movies/" + slug + "/watch");
  } else {
    endpoints.push(API_BASE + "/tvshows/" + slug + "/seasons/" + season + "/episodes/" + episode + "/stream");
    endpoints.push(API_BASE + "/tvshows/" + slug + "/seasons/" + season + "/episodes/" + episode + "/watch");
  }
  for (var i = 0; i < endpoints.length; i++) {
    try {
      var res = await fetchWithTimeout(endpoints[i]);
      if (!res.ok) continue;
      var data = await res.json();
      // Look for a URL in the response
      var candidate = data.url || data.value || data.stream || data.link || null;
      candidate = normalizeUrl(candidate);
      if (candidate) return candidate;
      // If the response itself is an encrypted payload
      if (typeof data === "string") {
        var dec = await decryptPayload(data);
        if (dec && dec.length) {
          var u = extractServerUrl(dec[0]);
          if (u) return u;
        }
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

// Build a stream object from a resolved URL
function makeStream(url, name, streamTitle, quality, subtitles, referer) {
  if (!url) return null;
  return {
    name: PROVIDER_NAME + " [" + name + "]",
    title: streamTitle + (quality ? " · " + quality : ""),
    url: url,
    quality: quality || "Auto",
    provider: "kurdsubtitle",
    headers: buildStreamHeaders(referer),
    subtitles: subtitles || []
  };
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
    var resolveTasks = [];

    // ── Movie ─────────────────────────────────────────────────────────────────
    if (isMovie) {
      var movieUrl = API_BASE + "/movies/" + matchDoc.slug;
      console.log("[Kurdsubtitle] Fetching movie: " + movieUrl);
      var mRes = await fetchWithTimeout(movieUrl);
      if (!mRes.ok) throw new Error("Movie HTTP " + mRes.status);
      var mData = await mRes.json();
      var movie = mData.movie || mData;

      // Movie servers may be encrypted (string) or plain array
      var watchServers = await decryptPayload(movie.watchServers);
      if (!watchServers.length && Array.isArray(movie.watchServers)) {
        watchServers = movie.watchServers;
      }
      var dlServers = Array.isArray(movie.downloadServers) ? movie.downloadServers : [];

      var subs = extractSubtitles(movie.subtitles);

      watchServers.forEach(function (srv, idx) {
        var url = extractServerUrl(srv);
        if (url && !isSkippableHost(url)) {
          // Direct URL – check if it's an embed page or a direct stream
          if (url.includes(".m3u8") || url.includes(".mp4")) {
            var st = makeStream(url, srv.name || ("Server " + (idx + 1)), streamTitle, srv.quality, subs);
            if (st) streams.push(st);
          } else {
            // Embed page – resolve it
            resolveTasks.push(
              resolveEmbed(url).then(function (resolved) {
                if (resolved) {
                  var st = makeStream(resolved, srv.name || ("Server " + (idx + 1)), streamTitle, srv.quality, subs, url);
                  if (st) streams.push(st);
                }
              })
            );
          }
        } else if (!url && (srv.name || "").toLowerCase().includes("our")) {
          // "our" server – resolve via API
          resolveTasks.push(
            resolveOurServer(matchDoc.slug, "movie", s, e).then(function (resolved) {
              if (resolved) {
                var st = makeStream(resolved, "Our", streamTitle, srv.quality || "Auto", subs, BASE_URL + "/");
                if (st) streams.push(st);
              }
            })
          );
        }
      });

      dlServers.forEach(function (dl) {
        var url = extractServerUrl(dl);
        if (url && (url.includes(".mp4") || url.includes(".m3u8")) && !isSkippableHost(url)) {
          var st = makeStream(url, "Download · " + (dl.quality || "1080p"), streamTitle, dl.quality || "1080p", []);
          if (st) streams.push(st);
        }
      });

    // ── TV Show ───────────────────────────────────────────────────────────────
    } else {
      var tvUrl = API_BASE + "/tvshows/" + matchDoc.slug;
      console.log("[Kurdsubtitle] Fetching tvshow: " + tvUrl);
      var tvRes = await fetchWithTimeout(tvUrl);
      if (!tvRes.ok) throw new Error("TVShow HTTP " + tvRes.status);
      var tvData = await tvRes.json();
      var tvshow = tvData.movie || tvData;

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

      // TV servers are always encrypted
      var watchServersRaw = await decryptPayload(targetEp.watchServers);
      var dlServersRaw = await decryptPayload(targetEp.downloadServers);
      var epSubs = extractSubtitles(targetEp.subtitles);

      watchServersRaw.forEach(function (srv, idx) {
        var url = extractServerUrl(srv);
        if (url && !isSkippableHost(url)) {
          if (url.includes(".m3u8") || url.includes(".mp4")) {
            var st = makeStream(url, srv.name || ("Server " + (idx + 1)), streamTitle, srv.quality, epSubs);
            if (st) streams.push(st);
          } else {
            resolveTasks.push(
              resolveEmbed(url).then(function (resolved) {
                if (resolved) {
                  var st = makeStream(resolved, srv.name || ("Server " + (idx + 1)), streamTitle, srv.quality, epSubs, url);
                  if (st) streams.push(st);
                }
              })
            );
          }
        } else if (!url && (srv.name || "").toLowerCase().includes("our")) {
          resolveTasks.push(
            resolveOurServer(matchDoc.slug, "tvshow", s, targetEp.number).then(function (resolved) {
              if (resolved) {
                var st = makeStream(resolved, "Our", streamTitle, srv.quality || "Auto", epSubs, BASE_URL + "/");
                if (st) streams.push(st);
              }
            })
          );
        }
      });

      dlServersRaw.forEach(function (dl) {
        var url = extractServerUrl(dl);
        if (url && (url.includes(".mp4") || url.includes(".m3u8")) && !isSkippableHost(url)) {
          var st = makeStream(url, "Download · " + (dl.quality || "1080p"), streamTitle, dl.quality || "1080p", []);
          if (st) streams.push(st);
        }
      });
    }

    // Wait for all embed resolutions (with a cap so we don't hang)
    if (resolveTasks.length) {
      await Promise.race([
        Promise.all(resolveTasks),
        new Promise(function (r) { setTimeout(r, TIMEOUT_MS + 2000); })
      ]);
    }

    console.log("[Kurdsubtitle] Done: " + streams.length + " stream(s)");
    return streams;

  } catch (err) {
    console.error("[Kurdsubtitle] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
