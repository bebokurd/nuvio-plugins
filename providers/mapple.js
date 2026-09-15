// Mapple Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js

"use strict";

const PROVIDER_NAME = "Mapple";
const BASE_URL = "https://mapple.rip";
const MIRROR_URL = "https://mappl.tv";
const TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
const TIMEOUT_MS = 10000;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Origin": BASE_URL,
  "Referer": `${BASE_URL}/`,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
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

// Fetch TMDB metadata for stream title formatting
async function getTMDBDetails(tmdbId, mediaType) {
  const type = mediaType === "movie" ? "movie" : "tv";
  try {
    const res = await fetchWithTimeout(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}`);
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
    const data = await res.json();
    return {
      title: data.name || data.title || "",
      year: (data.first_air_date || data.release_date || "").split("-")[0]
    };
  } catch (err) {
    console.log(`[Mapple] TMDB lookup error: ${err.message}`);
    return { title: "", year: "" };
  }
}

// Main stream extraction
async function getStreams(tmdbId, mediaType = "movie", season = 1, episode = 1) {
  const isMovie = mediaType === "movie";
  const s = Number(season) || 1;
  const e = Number(episode) || 1;

  console.log(`[Mapple] Request: tmdbId=${tmdbId} type=${mediaType}${isMovie ? "" : ` S${s}E${e}`}`);

  try {
    const tmdbInfo = await getTMDBDetails(tmdbId, mediaType);
    const streamTitle = `${tmdbInfo.title || `TMDB ${tmdbId}`}` +
      (isMovie ? "" : ` S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`) +
      (tmdbInfo.year ? ` (${tmdbInfo.year})` : "");

    const streams = [];

    // Path segments for movie vs tv
    const movieSlug = `${tmdbId}`;
    const tvSlug = `${tmdbId}-${s}-${e}`;
    const pathSlug = isMovie ? `movie/${movieSlug}` : `tv/${tvSlug}`;

    // Server 1: Mapple Embed Server
    const embedUrl = `${BASE_URL}/embed/${pathSlug}`;
    streams.push({
      name: `${PROVIDER_NAME} [Server 1 - Primary]`,
      title: streamTitle,
      url: embedUrl,
      quality: "Auto",
      headers: {
        "User-Agent": HEADERS["User-Agent"],
        "Referer": `${BASE_URL}/`,
        "Origin": BASE_URL
      },
      subtitles: []
    });

    // Server 2: Mapple Direct Watch
    const watchUrl = `${BASE_URL}/watch/${pathSlug}`;
    streams.push({
      name: `${PROVIDER_NAME} [Server 2 - Fast]`,
      title: streamTitle,
      url: watchUrl,
      quality: "1080p",
      headers: {
        "User-Agent": HEADERS["User-Agent"],
        "Referer": `${BASE_URL}/`,
        "Origin": BASE_URL
      },
      subtitles: []
    });

    // Server 3: Mapple Mirror Server
    const mirrorEmbedUrl = `${MIRROR_URL}/embed/${pathSlug}`;
    streams.push({
      name: `${PROVIDER_NAME} [Server 3 - Mirror]`,
      title: streamTitle,
      url: mirrorEmbedUrl,
      quality: "Auto",
      headers: {
        "User-Agent": HEADERS["User-Agent"],
        "Referer": `${MIRROR_URL}/`,
        "Origin": MIRROR_URL
      },
      subtitles: []
    });

    // Check if direct API playback endpoint responds without captcha/PoW
    try {
      const playbackRes = await fetchWithTimeout(`${BASE_URL}/api/playback-init`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": HEADERS["User-Agent"],
          "Referer": `${BASE_URL}/watch/${pathSlug}`
        },
        body: JSON.stringify({
          mediaId: Number(tmdbId),
          mediaType: isMovie ? "movie" : "tv",
          tv_slug: isMovie ? "" : tvSlug
        })
      }, 4000);

      if (playbackRes.ok) {
        const playbackData = await playbackRes.json();
        if (playbackData && playbackData.sources && Array.isArray(playbackData.sources)) {
          playbackData.sources.forEach((source, idx) => {
            if (source.url && source.url.startsWith("http")) {
              streams.unshift({
                name: `${PROVIDER_NAME} [Direct Stream ${idx + 1}]`,
                title: streamTitle,
                url: source.url,
                quality: source.quality || "Auto",
                headers: {
                  "User-Agent": HEADERS["User-Agent"],
                  "Referer": `${BASE_URL}/`
                },
                subtitles: Array.isArray(playbackData.subtitles) ? playbackData.subtitles : []
              });
            }
          });
        }
      }
    } catch {
      // Playback init is optional, fallback to embed servers
    }

    console.log(`[Mapple] Returning ${streams.length} stream(s)`);
    return streams;

  } catch (err) {
    console.error(`[Mapple] Error: ${err.message}`);
    return [];
  }
}

module.exports = { getStreams };
