// Cartoony Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js
// cartoony.net (API host: carateen.tv) — Arabic dubbed cartoons, Spacetoon-era
// shows and movies. API responses are AES-256-CBC encrypted; streams are HLS.

"use strict";

var PROVIDER_NAME = "Cartoony";
var API_BASE = "https://carateen.tv";
var SITE = "https://cartoony.net";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var CRYPTO_KEY = "7annaba3l_loves_crypto_safe_key!";
var TIMEOUT_MS = 20000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
var API_HEADERS = {
  "Accept": "application/json",
  "Origin": "https://carateen.tv",
  "Referer": "https://carateen.tv/",
  "X-Cartoony-Client": "web-frontend-v1"
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
  if (!opts.headers) opts.headers = {};
  if (!opts.headers["User-Agent"]) opts.headers["User-Agent"] = UA;
  if (!opts.headers["Referer"]) opts.headers["Referer"] = SITE + "/";
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
    // collapse long runs of a single letter (e.g., "بووم" → "بوم").
    .replace(/([\u0600-\u06FFa-z])\1{1,}/g, "$1")
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

// Site splits shows into season entries like "الباكوغان الجزء الثاني".
function parseSeasonFromText(text) {
  var t = String(text || "");
  var m = t.match(/(?:الموسم|الجزء)\s*(\d+)/);
  if (!m) m = t.match(/(\d+)/);
  if (m) return parseInt(m[1], 10);
  var ords = ["الاول", "الثاني", "الثلاثي", "الثالث", "الرابع", "الخامس",
    "السادس", "السابع", "الثامن", "التاسع", "العاشر"];
  var vals = [1, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10];
  for (var i = 0; i < ords.length; i++) {
    if (t.indexOf(ords[i]) !== -1) return vals[i];
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

// ─── AES-256-CBC payload decryption ──────────────────────────────────────────

function decryptJSON(payload) {
  try {
    var C = require("crypto-js");
    var key = C.enc.Utf8.parse(CRYPTO_KEY);
    var iv = C.enc.Hex.parse(payload.iv);
    var cipher = C.enc.Hex.parse(payload.encryptedData);
    var dec = C.AES.decrypt({ ciphertext: cipher }, key,
      { iv: iv, mode: C.mode.CBC, padding: C.pad.Pkcs7 });
    var txt = dec.toString(C.enc.Utf8);
    return txt ? JSON.parse(txt) : null;
  } catch (e) {
    console.log("[Cartoony] Decrypt failed: " + e.message);
    return null;
  }
}

function apiJson(path, options) {
  var opts = options || {};
  var headers = {};
  var k, base = API_HEADERS;
  for (k in base) headers[k] = base[k];
  if (opts.headers) { for (k in opts.headers) headers[k] = opts.headers[k]; }
  opts.headers = headers;
  return fetchWithTimeout(API_BASE + path, opts).then(function (res) {
    if (!res.ok) throw new Error("API HTTP " + res.status);
    var ct = String(res.headers.get("Content-Type") || "");
    if (ct.indexOf("json") === -1) throw new Error("API non-JSON response");
    return res.json();
  }).then(function (body) {
    if (!body) return null;
    if (body.encryptedData && body.iv) return decryptJSON(body);
    return body;
  });
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────

async function getTMDBInfo(tmdbId, mediaType) {
  var type = mediaType === "movie" ? "movie" : "tv";
  var titles = [];
  var primary = "";
  var year = "";
  var numSeasons = 0;
  try {
    var res = await fetchWithTimeout(
      "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY
    );
    if (res.ok) {
      var d = await res.json();
      titles.push(d.title, d.name, d.original_title, d.original_name);
      primary = d.title || d.name || "";
      year = (d.first_air_date || d.release_date || "").split("-")[0];
      numSeasons = Number(d.number_of_seasons) || 0;
    }
  } catch (e) {
    console.log("[Cartoony] TMDB error: " + e.message);
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
    console.log("[Cartoony] TMDB translations error: " + e.message);
  }

  return {
    primaryTitle: primary,
    year: year,
    numSeasons: numSeasons,
    titles: uniqueNonEmpty(titles)
  };
}

// TMDB per-season episode counts (used to map a requested S/E onto the site's
// flat, single-entry episode list for shows like Danny Phantom / SpongeBob).
function getSeasonCounts(tmdbId, upTo) {
  var counts = [];
  var maxFetch = Math.min(upTo, 6);
  var s = 1;
  function next() {
    if (s > maxFetch) return Promise.resolve(counts);
    return fetchWithTimeout(
      "https://api.themoviedb.org/3/tv/" + tmdbId + "/season/" + s + "?api_key=" + TMDB_API_KEY
    ).then(function (res) {
      if (res.ok) {
        return res.json().then(function (d) {
          counts[s - 1] = (d.episodes || []).length;
        });
      }
      counts[s - 1] = -1;
    }).catch(function () {
      counts[s - 1] = -1;
    }).then(function () {
      s++;
      return next();
    });
  }
  return next();
}

// ─── Local library search ────────────────────────────────────────────────────

var SITE_STRIP = ["فيلم", "كرتون", "مدبلج", "مدبلجة", "مترجم", "مسلسل", "الرسوم", "انمي", "أنمي"];

// Arabic ↔ English aliases for well-known titles. Guarantees a match even when
// TMDB has no (or a different) Arabic translation, e.g. the site names an entry
// "داني الشبح" while TMDB only returns "Danny Phantom".
// Format: [Arabic, English] — normalized at match time.
var TITLE_ALIASES = [
  ["داني الشبح", "danny phantom"],
  ["سبونج بوب سكوير بانتس", "spongebob squarepants"],
  ["المحقق كونان", "detective conan"],
  ["توم وجيري", "tom and jerry"],
  ["سكوبي دو", "scooby doo"],
  ["ون بيس", "one piece"],
  ["بوكيمون", "pokemon"],
  ["بن 10", "ben 10"]
];

function cleanSiteTitle(str) {
  var t = normalizeAr(str);
  for (var i = 0; i < SITE_STRIP.length; i++) {
    t = t.replace(new RegExp("(?:^|\\s)" + SITE_STRIP[i] + "(?:\\s|$)", "g"), " ");
  }
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function arKey(w) {
  return String(w).replace(/^ال/, "");
}

function nameScore(entry, tmdbTitles) {
  var split = splitSeasonTitle(entry.title);
  var n = cleanSiteTitle(split.base);
  if (!n) return 0;
  var best = 0;
  var tn, te, w, shared, all, i, a;

  // Arabic↔English alias guarantee (works without TMDB Arabic translations).
  for (var q = 0; q < TITLE_ALIASES.length; q++) {
    var al = normalizeAr(TITLE_ALIASES[q][0]);
    if (!al || (n !== al && n.indexOf(al) === -1)) continue;
    var enAlias = normalizeEn(TITLE_ALIASES[q][1]);
    for (i = 0; i < tmdbTitles.length; i++) {
      if (enAlias && normalizeEn(tmdbTitles[i]).indexOf(enAlias) !== -1) return 95;
    }
  }

  for (i = 0; i < tmdbTitles.length; i++) {
    tn = normalizeAr(tmdbTitles[i]);
    te = normalizeEn(tmdbTitles[i]);
    if (tn && arKey(tn) === arKey(n)) return 100;
    if (tn && n.length >= 1 && (tn.indexOf(n) !== -1 || n.indexOf(tn) !== -1)) best = Math.max(best, 76);
    if (tn && arKey(n).length >= 1 &&
        (arKey(tn).indexOf(arKey(n)) !== -1 || arKey(n).indexOf(arKey(tn)) !== -1)) best = Math.max(best, 76);
    if (te && n.length >= 3) {
      w = te.split(" ");
      for (a = 0; a < w.length; a++) {
        if (w[a].length >= 3 && normalizeAr(w[a]) === n) best = Math.max(best, 74);
      }
    }
    // Arabic word-overlap: all meaningful words of the shorter name appear in the other.
    if (tn) {
      var nw = n.split(" ");
      var tw = tn.split(" ");
      shared = 0;
      for (a = 0; a < nw.length; a++) {
        if (nw[a].length < 3) continue;
        for (var b = 0; b < tw.length; b++) {
          if (tw[b] === nw[a] || arKey(tw[b]) === arKey(nw[a])) { shared++; break; }
        }
      }
      if (shared >= 2) {
        var total = 0;
        for (a = 0; a < tw.length; a++) if (tw[a].length >= 3) total++;
        best = Math.max(best, shared === total ? 88 : 70);
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

async function loadCatalog(isMovie) {
  var out = [];
  try {
    var regs = await apiJson("/api/tvshows");
    if (Array.isArray(regs)) {
      for (var i = 0; i < regs.length; i++) {
        var r = regs[i];
        if (!r || !r.id) continue;
        var rMovie = String(r.category || "").indexOf("فيلم") === 0;
        if (rMovie !== isMovie) continue;
        out.push({
          site: "tg",
          id: r.id,
          title: r.title || r.name || "",
          quality: r.quality || ""
        });
      }
    }
  } catch (e) {
    console.log("[Cartoony] Regular catalog failed: " + e.message);
  }
  try {
    var sps = await apiJson("/api/sp/tvshows");
    if (Array.isArray(sps)) {
      for (var j = 0; j < sps.length; j++) {
        var s = sps[j];
        if (!s || !s.id) continue;
        var sMovie = Number(s.is_movie) === 1;
        if (sMovie !== isMovie) continue;
        out.push({
          site: "sp",
          id: s.id,
          title: s.name || "",
          quality: s.ep_duration ? "" : ""
        });
      }
    }
  } catch (e) {
    console.log("[Cartoony] SP catalog failed: " + e.message);
  }
  return out;
}

// ─── Stream resolution ───────────────────────────────────────────────────────

function epNumber(ep) {
  var t = String(ep.title || ep.pref || "قط");
  var m = t.match(/^\s*(\d{1,4})[\s.\-\u2013\u2014,:،]/);
  if (m) {
    var n = parseInt(m[1], 10);
    if (n > 0 && n < 10000) return n;
  }
  var o = Number(ep.order_id);
  if (o && o > 0) return o;
  return 0;
}

function findEpisode(eps, reqEpisode) {
  var i, num, ep;
  for (i = 0; i < eps.length; i++) {
    num = epNumber(eps[i]);
    if (num === reqEpisode) return eps[i];
  }
  // Fallback: assume plain 1-based ordering.
  for (i = 0; i < eps.length; i++) {
    num = epNumber(eps[i]);
    if (num === 0 && (i + 1) === reqEpisode) return eps[i];
  }
  return null;
}

async function resolveTG(entry, episodeId) {
  var d = await apiJson("/api/episode?episodeId=" + episodeId);
  return d && d.streamUrl ? d.streamUrl : null;
}

async function resolveSP(entry, episodeId) {
  var d = await apiJson("/api/sp/episode/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ episodeId: episodeId, userId: null })
  });
  return d && d.link ? d.link : null;
}

async function resolveStream(entry, isMovie, reqSeason, reqEpisode, baseTitle, tmdbId, numSeasons) {
  var eps;
  if (entry.site === "tg") {
    eps = await apiJson("/api/episodes?id=" + entry.id);
    if (!Array.isArray(eps) || !eps.length) return null;
    if (isMovie) {
      var pick = eps[0];
      var url = await resolveTG(entry, pick.id);
      if (!url) return null;
      return {
        site: entry.site,
        url: url,
        title: baseTitle,
        epTitle: String(pick.title || pick.pref || "")
      };
    }

    var isFlat = true;
    var i;
    for (i = 0; i < eps.length; i++) {
      if (Number(eps[i].season) > 0) { isFlat = false; break; }
    }
    if (splitSeasonTitle(entry.title).season !== null) isFlat = false;

    var targetEp = reqEpisode;
    var usedOffset = false;
    if (isFlat && reqSeason > 1 && tmdbId && numSeasons > 1) {
      var counts = await getSeasonCounts(tmdbId, reqSeason - 1);
      var offset = 0;
      for (i = 1; i < reqSeason; i++) {
        var c = counts[i - 1];
        offset += (c > 0) ? c : Math.max(1, Math.round(eps.length / numSeasons));
      }
      targetEp = offset + reqEpisode;
      usedOffset = true;
    }

    pick = findEpisode(eps, targetEp);
    if (!pick && !usedOffset) pick = findEpisode(eps, reqEpisode);
    if (!pick) return null;
    url = await resolveTG(entry, pick.id);
    if (!url) return null;
    return {
      site: entry.site,
      url: url,
      title: baseTitle + " S" + pad2(reqSeason) + "E" + pad2(reqEpisode),
      epTitle: String(pick.title || pick.pref || "")
    };
  }

  // SP
  eps = await apiJson("/api/sp/episodes?id=" + entry.id);
  if (!Array.isArray(eps) || !eps.length) return null;
  pick = isMovie ? eps[0] : null;
  if (!pick && !isMovie) {
    for (i = 0; i < eps.length; i++) {
      if (Number(eps[i].number) === reqEpisode) { pick = eps[i]; break; }
    }
  }
  if (!pick) return null;
  url = await resolveSP(entry, pick.id);
  if (!url) return null;
  return {
    site: entry.site,
    url: url,
    title: isMovie ? baseTitle : (baseTitle + " S" + pad2(reqSeason) + "E" + pad2(reqEpisode)),
    epTitle: String(pick.pref || pick.title || "")
  };
}

function makeStream(url, streamTitle, quality) {
  return {
    name: PROVIDER_NAME,
    title: streamTitle + (quality ? " · " + quality : ""),
    url: url,
    quality: quality || "Auto",
    headers: {
      "User-Agent": UA,
      "Referer": SITE + "/",
      "Origin": SITE
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

  console.log("[Cartoony] Request: tmdbId=" + tmdbId + " type=" + mediaType +
    (isMovie ? "" : " S" + reqSeason + "E" + reqEpisode));

  try {
    var info = await getTMDBInfo(tmdbId, mediaType);
    if (!info.titles.length) {
      console.log("[Cartoony] No TMDB titles, returning []");
      return [];
    }

    var candidates = await loadCatalog(isMovie);
    var ranked = [];
    for (var i = 0; i < candidates.length; i++) {
      var sc = scoreEntry(candidates[i], info, reqSeason);
      if (sc >= 55) ranked.push({ entry: candidates[i], score: sc });
    }
    ranked.sort(function (a, b) { return b.score - a.score; });

    var baseTitle = info.primaryTitle || ("TMDB " + tmdbId);
    var yearText = info.year ? " (" + info.year + ")" : "";

    for (var r = 0; r < ranked.length && r < 4; r++) {
      try {
        var res = await resolveStream(ranked[r].entry, isMovie, reqSeason, reqEpisode, baseTitle + yearText, tmdbId, info.numSeasons);
        if (res && res.url) {
          console.log("[Cartoony] Match: " + ranked[r].entry.title + " (score " + ranked[r].score +
            ", " + res.site + ", " + res.epTitle + ")");
          console.log("[Cartoony] Done: 1 stream");
          return [makeStream(res.url, res.title, ranked[r].entry.quality || "Auto")];
        }
      } catch (e) {
        console.log("[Cartoony] Resolve failed for " + ranked[r].entry.title + ": " + e.message);
      }
    }

    console.log("[Cartoony] Not found on site");
    return [];

  } catch (err) {
    console.error("[Cartoony] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };