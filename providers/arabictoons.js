// ArabicToons Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js
// arabic-toons.com — Arabic dubbed cartoons (anime), series & movies.
// JSON search + per-episode pages embedding a direct MP4 stream with a token.

"use strict";

var PROVIDER_NAME = "ArabicToons";
var BASE_URL = "https://www.arabic-toons.com";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 15000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

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
  if (!opts.headers) opts.headers = {};
  if (!opts.headers["User-Agent"]) opts.headers["User-Agent"] = UA;
  if (!opts.headers["Referer"]) opts.headers["Referer"] = BASE_URL + "/";
  if (controller) opts.signal = controller.signal;
  return fetch(url, opts).then(function (res) {
    if (timer) clearTimeout(timer);
    return res;
  }).catch(function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
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

// Normalize Arabic: strip diacritics, unify alef/hamza/ya/ta-marbuta.
function normalizeAr(str) {
  return String(str || "")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, function (d) { return String("٠١٢٣٤٥٦٧٨٩".indexOf(d)); })
    .replace(/[۰-۹]/g, function (d) { return String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)); })
    .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeEn(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Season parsing. Site splits shows into entries like
// "سبونج بوب الموسم 11" or "سبايدرمان الجزء الأول".
function parseSeasonFromText(text) {
  var t = String(text || "");
  var m = t.match(/(?:الموسم|الجزء)\s*(\d+)/);
  if (!m) m = t.match(/(\d+)/);
  if (m) return parseInt(m[1], 10);
  var ords = ["الاول", "الثاني", "الثلاثي", "الثالث", "الرابع", "الخامس",
    "السادس", "السابع", "الثامن", "التاسع", "العاشر"];
  var vals = [1, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10];
  for (var i = 0; i < ords.length; i++) {
    if (String(text || "").indexOf(ords[i]) !== -1) return vals[i];
  }
  return null;
}

function splitSeasonTitle(title) {
  var t = normalizeAr(title);
  var idx = t.indexOf("الموسم");
  var idx2 = t.indexOf("الجزء");
  if (idx2 !== -1 && (idx === -1 || idx2 < idx)) idx = idx2;
  if (idx === -1) return { base: t, season: null };
  return {
    base: t.slice(0, idx).trim(),
    season: parseSeasonFromText(t.slice(idx))
  };
}

function pad2(n) {
  n = Number(n) || 0;
  return n < 10 ? "0" + n : String(n);
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────

async function getTMDBInfo(tmdbId, mediaType) {
  var type = mediaType === "movie" ? "movie" : "tv";
  var titles = [];
  var primary = "";
  var year = "";
  try {
    var res = await fetchWithTimeout(
      "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY
    );
    if (res.ok) {
      var d = await res.json();
      titles.push(d.title, d.name, d.original_title, d.original_name);
      primary = d.title || d.name || "";
      year = (d.first_air_date || d.release_date || "").split("-")[0];
    }
  } catch (e) {
    console.log("[ArabicToons] TMDB error: " + e.message);
  }

  // Arabic translated titles (best match for this Arabic site).
  try {
    var trRes = await fetchWithTimeout(
      "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "/translations?api_key=" + TMDB_API_KEY
    );
    if (trRes.ok) {
      var tr = await trRes.json();
      var list = tr.translations || [];
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].iso_639_1).slice(0, 2) === "ar") {
          var arT = list[i].data.title || list[i].data.name || "";
          if (arT) titles.push(arT);
        }
      }
    }
  } catch (e) {
    console.log("[ArabicToons] TMDB translations error: " + e.message);
  }

  return {
    primaryTitle: primary,
    year: year,
    titles: uniqueNonEmpty(titles)
  };
}

// ─── Site search ──────────────────────────────────────────────────────────────

function siteQueryUrl(query) {
  return BASE_URL + "/search_results.php?q=" + encodeURIComponent(query) + "&ajax=1";
}

async function searchSite(query) {
  try {
    var res = await fetchWithTimeout(siteQueryUrl(query));
    if (!res.ok) throw new Error("Search HTTP " + res.status);
    var data = await res.json();
    return {
      movies: (data.results && data.results.movies) || [],
      series: (data.results && data.results.series) || []
    };
  } catch (e) {
    console.log("[ArabicToons] Search failed: " + e.message);
    return { movies: [], series: [] };
  }
}

function buildQueries(info) {
  var queries = [];
  var arParts, enParts;
  for (var ti = 0; ti < info.titles.length; ti++) {
    var title = info.titles[ti];
    queries.push(title);
    if (title.indexOf(":") !== -1) queries.push(title.split(":")[0].trim());

    arParts = normalizeAr(title).split(" ");
    enParts = normalizeEn(title).split(" ");

    if (arParts.length >= 2) queries.push(arParts.slice(0, 2).join(" "));
    if (enParts.length >= 2) queries.push(enParts.slice(0, 2).join(" "));
    if (arParts.length && arParts[0]) queries.push(arParts[0]);
    if (enParts.length && enParts[0]) queries.push(enParts[0]);

    for (var hi = 0; hi < enParts.length; hi++) {
      if (enParts[hi].length >= 3) queries.push(enParts[hi]);
    }
    for (var ai = 0; ai < arParts.length; ai++) {
      if (arParts[ai].length >= 3) queries.push(arParts[ai]);
    }
  }
  var out = uniqueNonEmpty(queries);
  out.sort(function (a, b) { return a.length - b.length; });
  return out.slice(0, 10);
}

var SITE_STRIP = ["فيلم", "كرتون", "مدبلج", "مدبلجة", "الرسوم"];

function cleanSiteTitle(str) {
  var t = normalizeAr(str);
  for (var i = 0; i < SITE_STRIP.length; i++) {
    t = t.replace(new RegExp("(?:^|\\s)" + SITE_STRIP[i] + "(?:\\s|$)", "g"), " ");
  }
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function nameScore(entry, tmdbTitles) {
  var split = splitSeasonTitle(entry.title);
  var n = cleanSiteTitle(split.base);
  var sub = normalizeEn(entry.subtitle);
  if (!n && !sub) return 0;
  var best = 0;
  var tn, te, tw;
  for (var i = 0; i < tmdbTitles.length; i++) {
    tn = normalizeAr(tmdbTitles[i]);
    te = normalizeEn(tmdbTitles[i]);
    if (tn && n && tn === n) return 100;
    if (te && sub && te === sub) return 100;
    if (te && sub.length >= 3 && (te.indexOf(sub) !== -1 || sub.indexOf(te) !== -1)) best = Math.max(best, 78);
    if (tn && n.length >= 1 && (tn.indexOf(n) !== -1 || n.indexOf(tn) !== -1)) best = Math.max(best, 78);
    if (te && sub.length >= 3) {
      tw = te.split(" ");
      for (var a = 0; a < tw.length; a++) {
        if (tw[a].length >= 3 && tw[a] === sub) best = Math.max(best, 62);
      }
    }
  }
  return best;
}

function scoreEntry(entry, info, reqSeason) {
  var sc = nameScore(entry, info.titles);
  if (sc <= 0) return 0;
  if (reqSeason) {
    var split = splitSeasonTitle(entry.title);
    if (split.season !== null) {
      if (split.season === reqSeason) sc += 25;
      else sc -= 20;
    } else {
      sc += 5; // base entry (assume season 1)
    }
  }
  if (info.year && String(entry.title).indexOf(info.year) !== -1) sc += 5;
  return sc;
}

async function findEntry(info, mediaType, reqSeason) {
  var queries = buildQueries(info);
  var isMovie = mediaType === "movie";
  var best = null;
  var bestScore = 0;

  for (var qi = 0; qi < queries.length; qi++) {
    try {
      var found = await searchSite(queries[qi]);
      var list = isMovie ? found.movies : found.series;
      for (var di = 0; di < list.length; di++) {
        var sc = scoreEntry(list[di], info, reqSeason);
        if (sc > bestScore) {
          bestScore = sc;
          best = list[di];
        }
        if (bestScore >= 100) break;
      }
      if (bestScore >= 100) break;
    } catch (e) {
      console.log("[ArabicToons] Search attempt failed: " + e.message);
    }
  }

  if (!best || bestScore < 55) {
    console.log("[ArabicToons] Not found on site (best score " + bestScore + ")");
    return null;
  }
  console.log("[ArabicToons] Match: " + best.title + " (score " + bestScore + ")");
  return best;
}

// ─── Pages & streams ──────────────────────────────────────────────────────────

function buildEntryUrl(entry, isMovie) {
  var slug = String(entry.subtitle || entry.id).replace(/\s+/g, "-");
  var suffix = isMovie ? "-movies-streaming.html" : "-anime-streaming.html";
  return BASE_URL + "/" + slug + "-" + entry.id + suffix;
}

async function fetchText(url) {
  var res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("Page HTTP " + res.status);
  return res.text();
}

function extractVideoSrc(html) {
  if (!html) return null;
  var m = html.match(/const\s+videoSrc\s*=\s*"([^"]+)"/);
  if (m) return m[1];
  m = html.match(/<video[^>]*>[\s\S]*?<source[^>]+src="([^"]+\.(?:mp4|m3u8)[^"]*)"/i);
  if (m) return m[1];
  m = html.match(/"(https[^"]+stream[^"]+\.(?:mp4|m3u8)[^"]*)"/i);
  return m ? m[1] : null;
}

// Map episode number -> relative episode page url.
function parseEpisodes(html) {
  var out = {};
  var re = /<a\s+href="([^"]+\.html)#sets"[^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html))) {
    var href = m[1];
    if (href.indexOf("-anime-streaming") !== -1) continue;
    var numM = m[2].match(/episode-number">\s*(\d+)\s*</);
    if (!numM) continue;
    var num = parseInt(numM[1], 10);
    if (num > 0 && !out[num]) out[num] = href;
  }
  return out;
}

function makeStream(url, streamTitle, quality) {
  return {
    name: PROVIDER_NAME,
    title: streamTitle + (quality ? " · " + quality : ""),
    url: url,
    quality: quality || "Auto",
    headers: {
      "User-Agent": UA,
      "Referer": BASE_URL + "/"
    },
    subtitles: []
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var reqSeason = isMovie ? null : (Number(season) || 1);
  var reqEpisode = isMovie ? null : (Number(episode) || 1);

  console.log("[ArabicToons] Request: tmdbId=" + tmdbId + " type=" + mediaType +
    (isMovie ? "" : " S" + reqSeason + "E" + reqEpisode));

  try {
    var info = await getTMDBInfo(tmdbId, mediaType);
    if (!info.titles.length) {
      console.log("[ArabicToons] No TMDB titles, returning []");
      return [];
    }

    var entry = await findEntry(info, mediaType, reqSeason);
    if (!entry || !entry.id) return [];

    var pageUrl = buildEntryUrl(entry, isMovie);
    var html = await fetchText(pageUrl);
    var baseTitle = info.primaryTitle || entry.title || ("TMDB " + tmdbId);
    var yearText = info.year ? " (" + info.year + ")" : "";

    if (isMovie) {
      var src = extractVideoSrc(html);
      if (!src) {
        console.log("[ArabicToons] No videoSrc on movie page");
        return [];
      }
      console.log("[ArabicToons] Done: 1 stream");
      return [makeStream(src, baseTitle + yearText, "Auto")];
    }

    var epMap = parseEpisodes(html);
    var href = epMap[reqEpisode];
    if (!href) {
      console.log("[ArabicToons] Episode S" + reqSeason + "E" + reqEpisode + " not in this entry (" +
        Object.keys(epMap).length + " episodes)");
      return [];
    }

    var epHtml = await fetchText(BASE_URL + "/" + href);
    var epSrc = extractVideoSrc(epHtml);
    if (!epSrc) {
      console.log("[ArabicToons] No videoSrc on episode page");
      return [];
    }

    var streamTitle = baseTitle + " S" + pad2(reqSeason) + "E" + pad2(reqEpisode) + yearText;
    console.log("[ArabicToons] Done: 1 stream");
    return [makeStream(epSrc, streamTitle, "Auto")];

  } catch (err) {
    console.error("[ArabicToons] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };