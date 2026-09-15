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

// Safe fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller ? controller.signal : undefined,
      headers: { ...HEADERS, ...(options.headers || {}) }
    });
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Helper to convert base64 to Uint8Array
function base64ToUint8Array(b64) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Decrypt AES-GCM payload used by Kurdsubtitle for episode servers
async function decryptServers(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "string") return [];

  try {
    const rawBytes = base64ToUint8Array(payload);
    if (rawBytes.length < 28) {
      console.log("[Kurdsubtitle] Encrypted payload is too short");
      return [];
    }

    const iv = rawBytes.slice(0, 12);
    const ciphertextWithTag = rawBytes.slice(12);

    // 1. Try WebCrypto (Hermes / modern browser / global crypto)
    const subtle = typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle
      ? globalThis.crypto.subtle
      : (typeof crypto !== "undefined" && crypto.subtle ? crypto.subtle : null);

    if (subtle) {
      const secretBytes = new TextEncoder().encode(ENCRYPTION_SECRET);
      const keyHash = await subtle.digest("SHA-256", secretBytes);
      const cryptoKey = await subtle.importKey("raw", keyHash, { name: "AES-GCM" }, false, ["decrypt"]);
      const decrypted = await subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, cryptoKey, ciphertextWithTag);
      const decodedText = new TextDecoder().decode(decrypted);
      const parsed = JSON.parse(decodedText);
      return Array.isArray(parsed) ? parsed : [];
    }

    // 2. Fallback to Node.js crypto module if available
    try {
      const nodeCrypto = require("crypto");
      if (nodeCrypto && typeof nodeCrypto.createDecipheriv === "function") {
        const key = nodeCrypto.createHash("sha256").update(ENCRYPTION_SECRET).digest();
        const tag = rawBytes.slice(rawBytes.length - 16);
        const cipherContent = rawBytes.slice(12, rawBytes.length - 16);
        const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(cipherContent), decipher.final()]);
        const parsed = JSON.parse(decrypted.toString("utf8"));
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      // Node crypto not available
    }

    console.log("[Kurdsubtitle] No compatible crypto API available for decryption");
    return [];
  } catch (err) {
    console.log(`[Kurdsubtitle] Decryption failed: ${err.message}`);
    return [];
  }
}

// Fetch TMDB metadata
async function getTMDBDetails(tmdbId, mediaType) {
  const type = mediaType === "movie" ? "movie" : "tv";
  try {
    const res = await fetchWithTimeout(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}`);
    if (!res.ok) throw new Error(`TMDB error ${res.status}`);
    const data = await res.json();
    return {
      title: data.name || data.title || "",
      year: (data.first_air_date || data.release_date || "").split("-")[0]
    };
  } catch (err) {
    console.log(`[Kurdsubtitle] TMDB lookup error: ${err.message}`);
    return { title: "", year: "" };
  }
}

// Clean title for search matching
function cleanTitle(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Search Kurdsubtitle API
async function searchKurdsubtitle(title, mediaType, tmdbId, year) {
  try {
    const searchUrl = `${API_BASE}/search?query=${encodeURIComponent(title)}`;
    console.log(`[Kurdsubtitle] Searching: ${searchUrl}`);
    const res = await fetchWithTimeout(searchUrl);
    if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
    const categories = await res.json();
    if (!Array.isArray(categories)) return null;

    const targetType = mediaType === "movie" ? "movie" : "tvshow";
    const targetName = mediaType === "movie" ? "فیلم" : "زنجیرە";

    const cat = categories.find(c => c.type === targetType || c.name === targetName || (mediaType === "tv" && c.type === "series"));
    if (!cat || !cat.data || !Array.isArray(cat.data.docs) || cat.data.docs.length === 0) {
      console.log("[Kurdsubtitle] No matching category or docs found in search");
      return null;
    }

    const docs = cat.data.docs;

    // 1. Try exact TMDB ID match
    const tmdbMatch = docs.find(d => String(d.tmdbID || d.tmdbId || "") === String(tmdbId));
    if (tmdbMatch) {
      console.log(`[Kurdsubtitle] Found match by TMDB ID: ${tmdbMatch.slug}`);
      return tmdbMatch;
    }

    // 2. Try title + year match
    const normalizedTarget = cleanTitle(title);
    const titleMatch = docs.find(d => {
      const matchTitle = cleanTitle(d.title);
      const isTitleEqual = matchTitle === normalizedTarget || matchTitle.includes(normalizedTarget) || normalizedTarget.includes(matchTitle);
      const isYearEqual = !year || !d.year || String(d.year) === String(year);
      return isTitleEqual && isYearEqual;
    });

    if (titleMatch) {
      console.log(`[Kurdsubtitle] Found match by title/year: ${titleMatch.slug}`);
      return titleMatch;
    }

    // 3. Fallback to first result
    console.log(`[Kurdsubtitle] Falling back to first doc: ${docs[0].slug}`);
    return docs[0];
  } catch (err) {
    console.log(`[Kurdsubtitle] Search failed: ${err.message}`);
    return null;
  }
}

// Main stream extraction
async function getStreams(tmdbId, mediaType = "movie", season = 1, episode = 1) {
  const isMovie = mediaType === "movie";
  const s = Number(season) || 1;
  const e = Number(episode) || 1;

  console.log(`[Kurdsubtitle] Request: tmdbId=${tmdbId} type=${mediaType}${isMovie ? "" : ` S${s}E${e}`}`);

  try {
    const tmdbInfo = await getTMDBDetails(tmdbId, mediaType);
    const searchQuery = tmdbInfo.title || String(tmdbId);

    const matchDoc = await searchKurdsubtitle(searchQuery, mediaType, tmdbId, tmdbInfo.year);
    if (!matchDoc || !matchDoc.slug) {
      console.log("[Kurdsubtitle] Item not found on Kurdsubtitle");
      return [];
    }

    const streamTitle = `${tmdbInfo.title || matchDoc.title || `TMDB ${tmdbId}`}` +
      (isMovie ? "" : ` S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`) +
      (tmdbInfo.year || matchDoc.year ? ` (${tmdbInfo.year || matchDoc.year})` : "");

    const streams = [];

    if (isMovie) {
      // Movie stream extraction
      const movieUrl = `${API_BASE}/movies/${matchDoc.slug}`;
      console.log(`[Kurdsubtitle] Fetching movie details: ${movieUrl}`);
      const res = await fetchWithTimeout(movieUrl);
      if (!res.ok) throw new Error(`Movie details HTTP ${res.status}`);
      const data = await res.json();

      const movie = data.movie || data;
      const watchServers = Array.isArray(movie.watchServers) ? movie.watchServers : [];
      const downloadServers = Array.isArray(movie.downloadServers) ? movie.downloadServers : [];

      // Extract subtitles if present
      const subtitles = [];
      if (Array.isArray(movie.subtitles)) {
        movie.subtitles.forEach(sub => {
          const url = sub.url || sub.value || (typeof sub === "string" ? sub : "");
          if (url) {
            subtitles.push({
              url,
              lang: sub.lang || sub.language || "Kurdish"
            });
          }
        });
      }

      // Add streaming servers
      watchServers.forEach((server, idx) => {
        if (server.value && typeof server.value === "string" && server.value.startsWith("http")) {
          const sName = server.name || `Server ${idx + 1}`;
          streams.push({
            name: `${PROVIDER_NAME} [${sName}] - Auto`,
            title: streamTitle,
            url: server.value,
            quality: "Auto",
            headers: {
              "User-Agent": HEADERS["User-Agent"],
              "Referer": `${BASE_URL}/`
            },
            subtitles
          });
        }
      });

      // Add download/direct servers
      downloadServers.forEach((dl, idx) => {
        if (dl.value && typeof dl.value === "string" && dl.value.startsWith("http")) {
          const quality = dl.quality || "1080p";
          streams.push({
            name: `${PROVIDER_NAME} [Direct ${quality}]`,
            title: streamTitle,
            url: dl.value,
            quality: quality,
            headers: {
              "User-Agent": HEADERS["User-Agent"],
              "Referer": `${BASE_URL}/`
            },
            subtitles
          });
        }
      });

    } else {
      // TV show stream extraction
      const tvUrl = `${API_BASE}/tvshows/${matchDoc.slug}`;
      console.log(`[Kurdsubtitle] Fetching TV show details: ${tvUrl}`);
      const res = await fetchWithTimeout(tvUrl);
      if (!res.ok) throw new Error(`TV show details HTTP ${res.status}`);
      const data = await res.json();

      const tvshow = data.movie || data;
      const tvshowId = tvshow._id || matchDoc._id || matchDoc.id;
      if (!tvshowId) throw new Error("Could not find TV show ID");

      // Fetch episodes for requested season
      const episodesUrl = `${API_BASE}/tvshows/${tvshowId}/seasons/${s}/episodes`;
      console.log(`[Kurdsubtitle] Fetching season episodes: ${episodesUrl}`);
      const epRes = await fetchWithTimeout(episodesUrl);
      if (!epRes.ok) throw new Error(`Episodes HTTP ${epRes.status}`);
      const episodes = await epRes.json();

      if (!Array.isArray(episodes) || episodes.length === 0) {
        console.log(`[Kurdsubtitle] No episodes found for Season ${s}`);
        return [];
      }

      // Find episode by number
      const targetEp = episodes.find(ep => Number(ep.number) === e) || episodes[e - 1] || episodes[0];
      if (!targetEp) {
        console.log(`[Kurdsubtitle] Episode ${e} not found`);
        return [];
      }

      console.log(`[Kurdsubtitle] Resolving servers for Episode ${targetEp.number}`);

      // Decrypt watch servers
      const watchServers = await decryptServers(targetEp.watchServers);
      const downloadServers = await decryptServers(targetEp.downloadServers);

      const subtitles = [];
      if (Array.isArray(targetEp.subtitles)) {
        targetEp.subtitles.forEach(sub => {
          const url = sub.url || sub.value || (typeof sub === "string" ? sub : "");
          if (url) {
            subtitles.push({
              url,
              lang: sub.lang || sub.language || "Kurdish"
            });
          }
        });
      }

      // Add watch servers
      watchServers.forEach((server, idx) => {
        if (server.value && typeof server.value === "string" && server.value.startsWith("http")) {
          const sName = server.name || `Server ${idx + 1}`;
          streams.push({
            name: `${PROVIDER_NAME} [${sName}] - Auto`,
            title: streamTitle,
            url: server.value,
            quality: "Auto",
            headers: {
              "User-Agent": HEADERS["User-Agent"],
              "Referer": `${BASE_URL}/`
            },
            subtitles
          });
        }
      });

      // Add direct download servers
      downloadServers.forEach((dl, idx) => {
        if (dl.value && typeof dl.value === "string" && dl.value.startsWith("http")) {
          const quality = dl.quality || "1080p";
          streams.push({
            name: `${PROVIDER_NAME} [Direct ${quality}]`,
            title: streamTitle,
            url: dl.value,
            quality: quality,
            headers: {
              "User-Agent": HEADERS["User-Agent"],
              "Referer": `${BASE_URL}/`
            },
            subtitles
          });
        }
      });
    }

    console.log(`[Kurdsubtitle] Found ${streams.length} stream(s)`);
    return streams;

  } catch (err) {
    console.error(`[Kurdsubtitle] Error: ${err.message}`);
    return [];
  }
}

module.exports = { getStreams };
