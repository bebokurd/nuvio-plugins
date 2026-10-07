// ani.pm Scraper for Nuvio Local Scrapers
// Subbed & dubbed anime via the ani.pm Player API
//   search -> playback-bootstrap -> settlar session -> embed session -> HLS
// Compatible with React Native / Hermes and Node.js

"use strict";

var PROVIDER_NAME = "AniPM";
var BASE_URL = "https://ani.pm";
var API_URL = BASE_URL + "/api";
var SETTLAR_ORIGIN = "https://embed.settlar.io";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 12000;
var SETTLAR_TIMEOUT_MS = 15000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
var CACHE_TTL_MS = 20 * 60 * 1000;

// ─── In-Memory Cache ──────────────────────────────────────────────────────────

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

function cacheSet(key, value) {
  _cache[key] = { t: Date.now(), v: value };
  return value;
}

// ─── Network Utilities ────────────────────────────────────────────────────────

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
  opts.headers = Object.assign({
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*"
  }, opts.headers || {});
  if (controller) opts.signal = controller.signal;
  return fetch(url, opts).then(function (res) {
    if (timer) clearTimeout(timer);
    return res;
  }, function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
}

function fetchText(url, headers, timeoutMs) {
  return fetchWithTimeout(url, { headers: headers }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  });
}

function fetchJson(url, headers, timeoutMs) {
  return fetchWithTimeout(url, { headers: headers }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  });
}

// ─── String Utilities ─────────────────────────────────────────────────────────

function pad2(n) {
  var num = Number(n) || 0;
  return num < 10 ? "0" + num : String(num);
}

function queryEscape(value) {
  return encodeURIComponent(String(value || ""));
}

function normalizeTitle(str) {
  return String(str || "")
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/&/g, " and ")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase()
    .replace(/\bthe\s+/g, " ")
    .replace(/\bseason\s*\d+\b/g, " ")
    .replace(/\bpart\s*\d+\b/g, " ")
    .replace(/\bs\d+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensOf(str) {
  var norm = normalizeTitle(str);
  return norm ? norm.split(" ") : [];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.indexOf(b) === 0 || b.indexOf(a) === 0) return 0.9;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 0.8;

  var at = tokensOf(a);
  var bt = tokensOf(b);
  if (!at.length || !bt.length) return 0;
  var hit = 0;
  for (var i = 0; i < at.length; i++) {
    if (bt.indexOf(at[i]) !== -1) hit++;
  }
  return (2 * hit) / (at.length + bt.length);
}

function yearOf(value) {
  var m = String(value || "").match(/(19\d\d|20\d\d)/);
  return m ? m[1] : "";
}

function bucketQuality(height) {
  if (height >= 2000) return "4K";
  if (height >= 1300) return "1440p";
  if (height >= 900) return "1080p";
  if (height >= 600) return "720p";
  if (height >= 400) return "480p";
  if (height >= 300) return "360p";
  return "Auto";
}

var QUALITY_ORDER = {
  "4K": 5,
  "1440p": 4,
  "1080p": 3,
  "720p": 2,
  "480p": 1,
  "360p": 0,
  "Auto": -1
};

// ─── TMDB Details Lookup ─────────────────────────────────────────────────────

async function getTMDBInfo(tmdbId, mediaType) {
  var type = mediaType === "movie" ? "movie" : "tv";
  var key = "tmdb:" + type + ":" + tmdbId;
  var cached = cacheGet(key);
  if (cached) return cached;

  var url = "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  try {
    var data = await fetchJson(url);
    var titles = [];
    if (data.title) titles.push(data.title);
    if (data.name) titles.push(data.name);
    if (data.original_title) titles.push(data.original_title);
    if (data.original_name) titles.push(data.original_name);

    var year = ((data.release_date || data.first_air_date || "").split("-")[0]) || "";
    var info = {
      title: data.title || data.name || "",
      titles: titles,
      year: year
    };
    cacheSet(key, info);
    return info;
  } catch (e) {
    return { title: "", titles: [], year: "" };
  }
}

// ─── ani.pm Catalog Search ───────────────────────────────────────────────────

// GET /api/anime/search?q=<term>&content=3 -> [ { anilistId, title, type, year, ... } ]
async function searchAniPM(term) {
  var key = "search:" + String(term || "").toLowerCase();
  var cached = cacheGet(key);
  if (cached) return cached;

  var url = API_URL + "/anime/search?q=" + queryEscape(term) + "&content=3";
  try {
    var data = await fetchJson(url, {
      "Accept": "application/json",
      "Referer": BASE_URL + "/"
    }, 10000);
    var items = Array.isArray(data) ? data : ((data && (data.items || data.results)) || []);
    cacheSet(key, items);
    return items;
  } catch (e) {
    return [];
  }
}

// Score a catalog entry against TMDB metadata; the best hit wins
function seasonOfTitle(str) {
  var m = String(str || "").match(/\bseason\s*(\d+)\b/i);
  return m ? Number(m[1]) : 0;
}

function scoreMatch(item, titles, expectedYear, isMovie, season) {
  if (!item) return 0;

  var score = 0;
  var itemTitle = String(item.title || "");
  var candidates = [];
  if (titles && titles.length) candidates = candidates.concat(titles);
  if (itemTitle) candidates.push(itemTitle);
  if (item.native) candidates.push(item.native);

  var best = 0;
  for (var i = 0; i < candidates.length; i++) {
    var s = similarity(normalizeTitle(candidates[i]), normalizeTitle(itemTitle));
    if (s > best) best = s;
    if (item.native) {
      var sn = similarity(normalizeTitle(candidates[i]), normalizeTitle(item.native));
      if (sn > best) best = sn;
    }
  }
  if (best < 0.34) return 0;
  score += Math.round(best * 100);

  // ani.pm numbers each TV season as its own entry (season 1 often has no marker)
  var itemSeason = seasonOfTitle(itemTitle) || seasonOfTitle(item.native);
  if (!isMovie && Number(season) > 1) {
    if (itemSeason === Number(season)) score += 30;
    else if (itemSeason) score -= 50;
  } else if (!isMovie && itemSeason > 1) {
    score -= 50;
  }

  var itemYear = yearOf(item.year);
  if (expectedYear && itemYear) {
    var diff = Math.abs(Number(itemYear) - Number(expectedYear));
    if (diff === 0) score += 12;
    else if (diff === 1) score += 6;
    else if (diff >= 3) score -= 10;
  }

  var itemType = String(item.type || "").toLowerCase();
  if (isMovie && itemType.indexOf("movie") !== -1) score += 18;
  else if (!isMovie && itemType && itemType.indexOf("movie") === -1) score += 18;
  else if (isMovie && itemType && itemType.indexOf("movie") === -1) score -= 25;

  if (!item.anilistId && !item.id) score -= 40;

  return score;
}

async function findAniEntry(tmdbInfo, isMovie, season) {
  var names = [];
  var seen = {};
  var pool = (tmdbInfo.titles || []).concat(tmdbInfo.title ? [tmdbInfo.title] : []);
  for (var i = 0; i < pool.length; i++) {
    var n = normalizeTitle(pool[i]);
    if (n && !seen[n]) {
      seen[n] = true;
      names.push(pool[i]);
    }
  }
  if (!names.length) return null;

  // Each season is its own entry on ani.pm, so query the season explicitly first
  var terms = [];
  if (!isMovie && Number(season) > 1) {
    for (var t = 0; t < names.length; t++) terms.push(names[t] + " Season " + season);
  }
  for (var u = 0; u < names.length; u++) terms.push(names[u]);

  var bestEntry = null;
  var bestScore = 0;

  for (var j = 0; j < terms.length; j++) {
    var items = await searchAniPM(terms[j]);
    if (!items.length) continue;

    for (var k = 0; k < items.length; k++) {
      var score = scoreMatch(items[k], pool, tmdbInfo.year, isMovie, season);
      if (score > bestScore) {
        bestScore = score;
        bestEntry = items[k];
      }
    }
    if (bestScore >= 110) break;
  }

  if (!bestEntry || bestScore < 70) return null;
  return bestEntry;
}

// ─── ani.pm Player API ───────────────────────────────────────────────────────

// The bootstrap route accepts either anilist/{anilistId} or settlar/{settlarId}
function entryRef(entry) {
  var anilist = String((entry && entry.anilistId) || "").trim();
  if (/^[0-9]+$/.test(anilist)) return { provider: "anilist", id: anilist };
  var settlar = String((entry && entry.id) || "").trim();
  if (/^[0-9]+$/.test(settlar)) return { provider: "settlar", id: settlar };
  return null;
}

// GET /api/anime/playback-bootstrap/{provider}/{id}?ep=&lang=[&backup=1]
async function fetchBootstrap(ref, episode, language, backup) {
  var url = API_URL + "/anime/playback-bootstrap/" + ref.provider + "/" + ref.id +
    "?ep=" + queryEscape(episode) + "&lang=" + queryEscape(language) +
    (backup ? "&backup=1" : "");
  return fetchJson(url, {
    "Accept": "application/json",
    "Referer": BASE_URL + "/"
  }, SETTLAR_TIMEOUT_MS);
}

// GET /api/anime/settlar/session?... -> { embedUrl, expiresAt, provider }
async function fetchSettlarSession(selection, episode, language) {
  var url = API_URL + "/anime/settlar/session?selection=" + queryEscape(selection) +
    "&provider=anipm&ep=" + queryEscape(episode) +
    "&channel=" + queryEscape(language) + "&telemetry=0";
  return fetchJson(url, {
    "Accept": "application/json",
    "Referer": BASE_URL + "/"
  }, SETTLAR_TIMEOUT_MS);
}

function tokenOf(embedUrl) {
  var m = String(embedUrl || "").match(/[?&]t=([^&]+)/);
  return m ? m[1] : "";
}

// GET https://embed.settlar.io/api/embed/session?t=... -> { kind, source, subtitles }
async function fetchEmbedSession(token) {
  var url = SETTLAR_ORIGIN + "/api/embed/session?t=" + queryEscape(token);
  var data = await fetchJson(url, {
    "Accept": "application/json",
    "Referer": SETTLAR_ORIGIN + "/"
  }, SETTLAR_TIMEOUT_MS);

  if (!data || data.kind !== "hls" || typeof data.source !== "string" || !/^https:\/\//.test(data.source)) {
    throw new Error("no hls source in embed session");
  }
  return data;
}

// Primary: bootstrap -> settlar session -> embed session
// Fallback: bootstrap&backup=1 -> backupEmbed.direct.stream -> same embed session
async function resolveChannel(entry, episode, language) {
  var ref = entryRef(entry);
  if (!ref) throw new Error("missing ani.pm id");

  var boot = null;
  try {
    boot = await fetchBootstrap(ref, episode, language, false);
  } catch (e) {
    boot = null;
  }

  if (boot && boot.availability && boot.availability[language] === false) {
    throw new Error(language + " unavailable");
  }

  if (boot && boot.core && Array.isArray(boot.core.episodes) && boot.core.episodes.length) {
    if (Number(episode) > boot.core.episodes.length) {
      console.log("[" + PROVIDER_NAME + "] episode " + episode + " > " +
        boot.core.episodes.length + " known, trying anyway");
    }
  }

  if (boot && typeof boot.settlarSelection === "string" && boot.settlarSelection) {
    try {
      var session = await fetchSettlarSession(boot.settlarSelection, episode, language);
      if (session && typeof session.embedUrl === "string" && session.embedUrl) {
        var token = tokenOf(session.embedUrl);
        if (token) {
          var primary = await fetchEmbedSession(token);
          return { source: primary.source, subtitles: primary.subtitles || [], path: "primary" };
        }
      }
    } catch (e) {
      console.log("[" + PROVIDER_NAME + "] primary path failed: " + e.message);
    }
  }

  // Backup path (direct source token, still resolved through the embed session API)
  var backup = await fetchBootstrap(ref, episode, language, true);
  var direct = backup && backup.backupEmbed && backup.backupEmbed.direct;
  if (!backup || !backup.backupEmbed || backup.backupEmbed.available !== true || !direct ||
      typeof direct.stream !== "string") {
    throw new Error("no backup source");
  }

  var backupToken = tokenOf(direct.stream);
  if (!backupToken) throw new Error("no backup token");

  var backupSession = await fetchEmbedSession(backupToken);
  return { source: backupSession.source, subtitles: backupSession.subtitles || [], path: "backup" };
}

// GET /api/anime/src/download/sizes?anilistId=&ep=&lang= -> rungs[{height,...}]
// Cheapest way to learn the ladder without touching the settlar CDN.
async function fetchHeight(anilistId, episode, language) {
  var key = "sizes:" + anilistId + ":" + episode + ":" + language;
  var cached = cacheGet(key);
  if (cached !== null) return cached;

  var url = API_URL + "/anime/src/download/sizes?anilistId=" + queryEscape(anilistId) +
    "&ep=" + queryEscape(episode) + "&lang=" + queryEscape(language);
  var height = 0;
  try {
    var data = await fetchJson(url, {
      "Accept": "application/json",
      "Referer": BASE_URL + "/"
    }, 8000);
    var rungs = (data && data.rungs) || [];
    for (var i = 0; i < rungs.length; i++) {
      var h = Number(rungs[i] && rungs[i].height) || 0;
      if (h > height) height = h;
    }
  } catch (e) {
    height = 0;
  }
  cacheSet(key, height);
  return height;
}

// Last resort: read RESOLUTION from the master playlist itself
async function inferQuality(url) {
  try {
    var text = await fetchText(url, {
      "User-Agent": UA,
      "Referer": SETTLAR_ORIGIN + "/"
    }, 6000);
    var best = 0;
    var re = /RESOLUTION=\d+x(\d+)/gi;
    var m;
    while ((m = re.exec(text))) {
      var h = parseInt(m[1], 10);
      if (h > best) best = h;
    }
    if (best) return bucketQuality(best);
  } catch (e) {}
  return "Auto";
}

// ─── Stream Formatting ───────────────────────────────────────────────────────

function mapSubtitles(list) {
  var out = [];
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length && i < 16; i++) {
    var s = list[i];
    if (!s || typeof s.url !== "string" || !/^https:\/\//.test(s.url)) continue;
    var lang = String(s.srclang || "").toLowerCase();
    out.push({
      url: s.url,
      name: String(s.label || s.srclang || "Subtitle").slice(0, 60),
      language: lang || "und"
    });
  }
  return out;
}

function makeStream(source, streamTitle, quality, language, isDub) {
  var tag = isDub ? "DUB" : "SUB";
  return {
    name: PROVIDER_NAME + " [" + tag + " · " + quality + "]",
    title: streamTitle + " · " + quality + (isDub ? " · Dub" : " · Sub"),
    url: source,
    quality: quality,
    isDub: !!isDub,
    headers: {
      "User-Agent": UA,
      "Referer": SETTLAR_ORIGIN + "/"
    },
    subtitles: []
  };
}

// ─── Main Scraper Entry Point ────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  console.log("[" + PROVIDER_NAME + "] Request: tmdbId=" + tmdbId + " type=" + mediaType +
    (isMovie ? "" : " S" + s + "E" + e));

  try {
    var tmdbInfo = await getTMDBInfo(tmdbId, mediaType);
    if (!tmdbInfo.title && !tmdbInfo.titles.length) {
      console.log("[" + PROVIDER_NAME + "] TMDB metadata unavailable");
      return [];
    }

    var entry = await findAniEntry(tmdbInfo, isMovie, s);
    if (!entry) {
      console.log("[" + PROVIDER_NAME + "] No ani.pm match for \"" + tmdbInfo.title + "\"");
      return [];
    }

    var ref = entryRef(entry);
    if (!ref) {
      console.log("[" + PROVIDER_NAME + "] Matched entry has no usable id");
      return [];
    }

    console.log("[" + PROVIDER_NAME + "] Matched: " + (entry.title || tmdbInfo.title) +
      " -> " + ref.provider + "/" + ref.id + (entry.type ? " (" + entry.type + ")" : ""));

    var channels = [];
    if (entry.subCount === 0 && entry.dubCount === 0) {
      channels.push("sub");
    } else {
      if (entry.subCount !== 0) channels.push("sub");
      if (entry.dubCount !== 0) channels.push("dub");
    }

    var streamTitle = (entry.title || tmdbInfo.title) +
      (isMovie ? "" : " S" + pad2(s) + "E" + pad2(e)) +
      (tmdbInfo.year ? " (" + tmdbInfo.year + ")" : "");

    var results = await Promise.all(channels.map(async function (language) {
      try {
        var resolved = await resolveChannel(entry, e, language);

        var quality = "Auto";
        if (ref.provider === "anilist") {
          var height = await fetchHeight(ref.id, e, language);
          if (height) quality = bucketQuality(height);
        }
        if (quality === "Auto") quality = await inferQuality(resolved.source);

        var stream = makeStream(resolved.source, streamTitle, quality, language, language === "dub");
        stream.subtitles = mapSubtitles(resolved.subtitles);

        console.log("[" + PROVIDER_NAME + "] " + language.toUpperCase() + " " + quality +
          " (" + resolved.path + ") -> " + resolved.source.slice(0, 90) + "...");
        return stream;
      } catch (err) {
        console.log("[" + PROVIDER_NAME + "] " + language.toUpperCase() + " failed: " + err.message);
        return null;
      }
    }));

    var streams = results.filter(Boolean);

    streams.sort(function (a, b) {
      if (a.isDub !== b.isDub) return a.isDub ? 1 : -1;
      return (QUALITY_ORDER[b.quality] || -1) - (QUALITY_ORDER[a.quality] || -1);
    });

    var finalStreams = [];
    var seen = {};
    for (var i = 0; i < streams.length; i++) {
      var st = streams[i];
      delete st.isDub;
      if (!st.url || seen[st.url]) continue;
      seen[st.url] = true;
      finalStreams.push(st);
    }

    console.log("[" + PROVIDER_NAME + "] Done: " + finalStreams.length + " stream(s)");
    return finalStreams;

  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
