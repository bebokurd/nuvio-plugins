// KurdFilm Scraper for Nuvio Local Scrapers
// Kurdish-subtitled movies & TV shows (Sorani & Badini) via kurdfilm.krd
// Multi-server extraction: Cornclick (adaptive HLS + Kurdish VTT subtitles),
// StreamWish family, Uqload, YourUpload, and VidHide.
// Compatible with React Native / Hermes and Node.js

"use strict";

var PROVIDER_NAME = "KurdFilm";
var BASE_URL = "https://kurdfilm.krd";
var API_BASE = "https://app.kurdfilm.krd/api";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 15000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
var CACHE_TTL_MS = 15 * 60 * 1000;

// ─── Cache ───────────────────────────────────────────────────────────────────

var _cache = {};

function cacheGet(key) {
  var hit = _cache[key];
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) {
    delete _cache[key];
    return null;
  }
  return hit.v;
}

function cacheSet(key, val) {
  _cache[key] = { t: Date.now(), v: val };
}

// ─── HTTP Utilities ──────────────────────────────────────────────────────────

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
  opts.headers = Object.assign({ "User-Agent": UA }, opts.headers || {});
  if (controller) opts.signal = controller.signal;
  return fetch(url, opts).then(function (res) {
    if (timer) clearTimeout(timer);
    return res;
  }).catch(function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
}

function fetchText(url, headers, timeoutMs) {
  return fetchWithTimeout(url, { headers: headers || {} }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  });
}

function fetchJson(url, headers, timeoutMs) {
  return fetchWithTimeout(url, {
    headers: Object.assign({ Accept: "application/json" }, headers || {})
  }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  });
}

function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

function cleanTitle(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapServerUrl(rawUrl) {
  if (!rawUrl) return "";
  var m = String(rawUrl).match(/[?&]url=([^&]+)/i);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  }
  return rawUrl;
}

function latinServerName(rawName, fallback) {
  var s = (rawName || "").trim();
  if (!s || s === "کوردفیلم") return "KurdFilm";
  var cleaned = s.replace(/[^a-zA-Z0-9_\-\s]/g, "").trim();
  if (cleaned) {
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return fallback || "Server";
}

// ─── Dean Edwards JS Packer Unpacker ─────────────────────────────────────────

function unpackJs(source) {
  var start = source.indexOf("eval(function");
  if (start < 0) return null;
  var body = source.slice(start);
  var m = body.match(/^eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return null;
  var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  var a = parseInt(m[2], 10);
  var c = parseInt(m[3], 10);
  var k = m[4].split("|");

  function toBase(cc) {
    return (cc < a ? "" : toBase(parseInt(cc / a, 10))) +
      ((cc = cc % a) > 35 ? String.fromCharCode(cc + 29) : cc.toString(36));
  }

  while (c--) {
    if (k[c]) p = p.replace(new RegExp("\\b" + toBase(c) + "\\b", "g"), k[c]);
  }
  return p;
}

// ─── TMDB Metadata ──────────────────────────────────────────────────────────

async function getTMDBInfo(tmdbId, mediaType) {
  var type = mediaType === "movie" ? "movie" : "tv";
  var cacheKey = "tmdb:" + type + ":" + tmdbId;
  var cached = cacheGet(cacheKey);
  if (cached) return cached;

  var url = "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  try {
    var data = await fetchJson(url);
    var info = {
      title: data.title || data.name || "",
      originalTitle: data.original_title || data.original_name || "",
      year: ((data.release_date || data.first_air_date || "").split("-")[0]) || ""
    };
    cacheSet(cacheKey, info);
    return info;
  } catch (e) {
    return { title: "", originalTitle: "", year: "" };
  }
}

// ─── KurdFilm API Search ─────────────────────────────────────────────────────

async function searchKurdFilm(query) {
  var q = (query || "").trim();
  if (!q) return [];
  var cacheKey = "kf:search:" + q.toLowerCase();
  var cached = cacheGet(cacheKey);
  if (cached) return cached;

  var url = API_BASE + "/search?q=" + encodeURIComponent(q) + "&per_page=30";
  try {
    var json = await fetchJson(url, { Referer: BASE_URL + "/" }, 10000);
    var items = (json && json.data) || [];
    cacheSet(cacheKey, items);
    return items;
  } catch (e) {
    return [];
  }
}

// ─── Embed Resolvers ─────────────────────────────────────────────────────────

async function resolveCornclick(embedUrl, tmdbId, mediaType, season, episode, subtitleDialects) {
  try {
    var u = new URL(embedUrl);
    var vtt = u.searchParams.get("vtt");
    var vttlabel = u.searchParams.get("vttlabel") || "Kurdish";
    var source = u.searchParams.get("source") || "self";
    var worker = u.searchParams.get("worker");

    var playerPath = mediaType === "tv"
      ? "/player/tv/" + tmdbId + "/" + season + "/" + episode
      : "/player/movie/" + tmdbId;

    var s = new URLSearchParams();
    if (vtt) s.set("vtt", vtt);
    if (vttlabel) s.set("vttlabel", vttlabel);
    if (source && source !== "vaplayer") s.set("source", source);
    if (worker) s.set("worker", worker);

    var playerUrl = "https://cornclick.com" + playerPath + (s.toString() ? "?" + s.toString() : "");
    var data = await fetchJson(playerUrl, { Referer: embedUrl }, 10000);

    var subs = [];
    if (vtt) {
      var dialectLabel = subtitleDialects && subtitleDialects.length ? " (" + subtitleDialects.join(", ") + ")" : "";
      subs.push({
        url: vtt,
        name: vttlabel + dialectLabel,
        language: "ku"
      });
    }

    if (data && data.subtitles) {
      for (var sub of data.subtitles) {
        if (!sub || !sub.url) continue;
        if (!subs.some(function(x) { return x.url === sub.url; })) {
          subs.push({
            url: sub.url,
            name: sub.label || "Kurdish",
            language: (sub.label || "").toLowerCase().includes("kurd") ? "ku" : (sub.lang || "und")
          });
        }
      }
    }

    var out = [];
    if (data && data.sources) {
      for (var src of data.sources) {
        if (!src || !src.url) continue;
        var pName = (src.provider && src.provider.name) || "HD";
        out.push({
          url: src.url,
          quality: src.quality === "adaptive" ? "1080p" : (src.quality || "Auto"),
          serverName: "KurdFilm (" + pName + ")",
          subtitles: subs,
          headers: {
            "User-Agent": UA,
            "Referer": "https://cornclick.com/"
          }
        });
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function resolveEmbed(rawUrl, serverLabel, fallbackSubs) {
  var url = unwrapServerUrl(rawUrl);
  if (!url || url.indexOf("http") !== 0) return null;

  try {
    // 1. YourUpload
    if (url.indexOf("yourupload.com") !== -1) {
      var htmlYu = await fetchText(url, { Referer: BASE_URL + "/" }, 8000);
      var mYu = htmlYu.match(/file:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i) ||
                htmlYu.match(/og:video(?::secure_url)?[^"']+content=["']([^"']+)["']/i);
      if (mYu) {
        return {
          url: mYu[1] || mYu[0],
          quality: "720p",
          serverName: "YourUpload",
          subtitles: fallbackSubs || [],
          headers: { "User-Agent": UA, "Referer": url }
        };
      }
    }

    // 2. Uqload
    if (/uqload\.(io|com|vc)/i.test(url)) {
      var htmlUq = await fetchText(url, { Referer: BASE_URL + "/" }, 8000);
      var unpackedUq = unpackJs(htmlUq) || htmlUq;
      var urlsUq = unpackedUq.match(/https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*/gi);
      if (urlsUq && urlsUq[0]) {
        return {
          url: urlsUq[0],
          quality: "1080p",
          serverName: "Uqload",
          subtitles: fallbackSubs || [],
          headers: { "User-Agent": UA, "Referer": url }
        };
      }
    }

    // 3. StreamWish family
    if (/flaswish|streamwish|obeywish|swdyu|playerwish|hanerix|swishsrv|youdbox/i.test(url)) {
      var htmlSw = await fetchText(url, { Referer: BASE_URL + "/" }, 8000);
      var unpackedSw = unpackJs(htmlSw) || htmlSw;
      var mSw = unpackedSw.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i) ||
               unpackedSw.match(/sources:\s*\[\{file:\s*["']([^"']+)["']/i);
      if (mSw) {
        return {
          url: mSw[1] || mSw[0],
          quality: "1080p",
          serverName: latinServerName(serverLabel, "StreamWish"),
          subtitles: fallbackSubs || [],
          headers: { "User-Agent": UA, "Referer": url }
        };
      }
    }

    // 4. VidHide family
    if (/vidhide|morencius|callistanise|dintezuvio|minochinos/i.test(url)) {
      var htmlVh = await fetchText(url, { Referer: BASE_URL + "/" }, 8000);
      var unpackedVh = unpackJs(htmlVh) || htmlVh;
      var mVh = unpackedVh.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
      if (mVh) {
        return {
          url: mVh[0],
          quality: "1080p",
          serverName: "VidHide",
          subtitles: fallbackSubs || [],
          headers: { "User-Agent": UA, "Referer": url }
        };
      }
    }

    // 5. Sendvid
    if (url.indexOf("sendvid.com") !== -1) {
      var htmlSv = await fetchText(url, { Referer: BASE_URL + "/" }, 8000);
      var mSv = htmlSv.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i) ||
                htmlSv.match(/var\s+video_source\s*=\s*["']([^"']+)["']/i);
      if (mSv) {
        return {
          url: mSv[1],
          quality: "720p",
          serverName: "Sendvid",
          subtitles: fallbackSubs || [],
          headers: { "User-Agent": UA, "Referer": url }
        };
      }
    }
  } catch (e) {
    // skip unreachable embed
  }
  return null;
}

// ─── Main Plugin Entry ───────────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  console.log("[" + PROVIDER_NAME + "] Request: tmdbId=" + tmdbId + " type=" + mediaType + (isMovie ? "" : " S" + s + "E" + e));

  try {
    var tmdbInfo = await getTMDBInfo(tmdbId, mediaType);
    var baseTitle = tmdbInfo.title || ("TMDB " + tmdbId);
    var streamTitle = baseTitle +
      (isMovie ? "" : " S" + pad2(s) + "E" + pad2(e)) +
      (tmdbInfo.year ? " (" + tmdbInfo.year + ")" : "");

    // 1. Gather queries to search KurdFilm
    var candidateQueries = [];
    if (tmdbInfo.title) {
      candidateQueries.push(tmdbInfo.title);
      // If title has a subtitle / colon / dash, also try base title
      var basePart = tmdbInfo.title.split(/[:\-–]/)[0].trim();
      if (basePart && basePart !== tmdbInfo.title) candidateQueries.push(basePart);
    }
    if (tmdbInfo.originalTitle && tmdbInfo.originalTitle !== tmdbInfo.title) {
      candidateQueries.push(tmdbInfo.originalTitle);
      var origBasePart = tmdbInfo.originalTitle.split(/[:\-–]/)[0].trim();
      if (origBasePart && origBasePart !== tmdbInfo.originalTitle) candidateQueries.push(origBasePart);
    }
    if (tmdbInfo.title) {
      var cTitle = cleanTitle(tmdbInfo.title);
      if (cTitle && !candidateQueries.includes(cTitle)) candidateQueries.push(cTitle);
    }

    var searchResults = [];
    var seenSearchQueries = {};
    for (var query of candidateQueries) {
      if (seenSearchQueries[query]) continue;
      seenSearchQueries[query] = true;
      var res = await searchKurdFilm(query);
      if (res && res.length) {
        searchResults = searchResults.concat(res);
        // If we found a direct TMDB ID match, stop searching
        if (res.some(function(item) { return String(item.tmdb_id) === String(tmdbId); })) {
          break;
        }
      }
    }

    if (!searchResults.length) {
      console.log("[" + PROVIDER_NAME + "] No search results found");
      return [];
    }

    // 2. Content matching
    var match = null;
    var targetKind = isMovie ? "movie" : "tvshow";
    var strTmdb = String(tmdbId);

    // Pass 1: exact TMDB ID + kind match
    for (var it1 of searchResults) {
      if (String(it1.tmdb_id) === strTmdb && it1.kind === targetKind) {
        match = it1;
        break;
      }
    }

    // Pass 2: exact TMDB ID match regardless of kind
    if (!match) {
      for (var it2 of searchResults) {
        if (String(it2.tmdb_id) === strTmdb) {
          match = it2;
          break;
        }
      }
    }

    // Pass 3: normalized title + kind + year match
    if (!match) {
      var cTarget = cleanTitle(tmdbInfo.title);
      for (var it3 of searchResults) {
        if (it3.kind === targetKind && cleanTitle(it3.title) === cTarget) {
          if (!tmdbInfo.year || !it3.releasedate || String(it3.releasedate).startsWith(tmdbInfo.year)) {
            match = it3;
            break;
          }
        }
      }
    }

    if (!match) {
      console.log("[" + PROVIDER_NAME + "] Content not matched in search results");
      return [];
    }

    console.log("[" + PROVIDER_NAME + "] Matched: " + match.title + " (id=" + match.id + ")");

    // 3. Fetch media details
    var rawServers = [];
    var fallbackSubs = [];
    var subtitleDialects = [];

    if (isMovie) {
      var movieRes = await fetchJson(API_BASE + "/movies/" + match.id, { Referer: BASE_URL + "/" });
      var movie = movieRes && movieRes.data;
      if (!movie) return [];
      subtitleDialects = movie.subtitle_dialects || [];
      rawServers = (movie.servers || []).slice();
      if (movie.embed_url && !rawServers.some(function(x) { return x.url === movie.embed_url; })) {
        rawServers.push({ name: "کوردفیلم", url: movie.embed_url });
      }
    } else {
      var tvRes = await fetchJson(API_BASE + "/tvshows/" + match.id, { Referer: BASE_URL + "/" });
      var tv = tvRes && tvRes.data;
      if (!tv || !tv.seasons || !tv.seasons.length) return [];

      var targetSeason = null;
      for (var sItem of tv.seasons) {
        if (Number(sItem.number) === s) {
          targetSeason = sItem;
          break;
        }
      }
      if (!targetSeason) targetSeason = tv.seasons[0];
      if (!targetSeason || !targetSeason.episodes) return [];

      var targetEpisode = null;
      for (var epItem of targetSeason.episodes) {
        if (Number(epItem.number) === e) {
          targetEpisode = epItem;
          break;
        }
      }
      if (!targetEpisode) return [];

      subtitleDialects = targetEpisode.subtitle_dialects || [];
      rawServers = (targetEpisode.servers || []).slice();
      if (targetEpisode.embed_url && !rawServers.some(function(x) { return x.url === targetEpisode.embed_url; })) {
        rawServers.push({ name: "کوردفیلم", url: targetEpisode.embed_url });
      }
    }

    if (!rawServers.length) {
      console.log("[" + PROVIDER_NAME + "] No servers listed for content");
      return [];
    }

    console.log("[" + PROVIDER_NAME + "] Found " + rawServers.length + " server(s)");

    // 4. Resolve servers in parallel
    var streams = [];
    var seen = {};

    var resultsList = await Promise.all(rawServers.map(async function(srv) {
      var unwrapped = unwrapServerUrl(srv.url);
      if (!unwrapped) return [];

      // A. Cornclick
      if (unwrapped.indexOf("cornclick.com") !== -1) {
        return resolveCornclick(unwrapped, tmdbId, mediaType, s, e, subtitleDialects);
      }

      // B. Third-party embed
      var single = await resolveEmbed(unwrapped, srv.name, fallbackSubs);
      return single ? [single] : [];
    }));

    for (var list of resultsList) {
      for (var stream of list) {
        if (!stream || !stream.url || seen[stream.url]) continue;
        seen[stream.url] = true;
        streams.push({
          name: PROVIDER_NAME + " [" + stream.serverName + " · KU Sub]",
          title: streamTitle + " · " + stream.quality,
          url: stream.url,
          quality: stream.quality,
          headers: stream.headers || { "User-Agent": UA },
          subtitles: stream.subtitles || []
        });
        console.log("[" + PROVIDER_NAME + "] Resolved: " + stream.serverName + " -> " + stream.url.slice(0, 80) + "...");
      }
    }

    console.log("[" + PROVIDER_NAME + "] Done: " + streams.length + " stream(s) returned");
    return streams;

  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Fatal error: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
