// WeCima (MyCima) Scraper for Nuvio Local Scrapers
// Compatible with React Native / Hermes and Node.js
// Support for Arabic Dubbed Movies (افلام مدبلجة), Subtitled Movies & TV Series
// wecima.cx / wecima.live / wecima.cc — multi-server streams with direct HLS & MP4 links

"use strict";

var PROVIDER_NAME = "WeCima";
var BASE_URL = "https://wecima.cx";
var MIRRORS = [
  "https://wecima.cx",
  "https://wecima.live",
  "https://wecima.cc",
  "https://wecima.show",
  "https://wecima.video"
];
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 14000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
var CACHE_TTL_MS = 15 * 60 * 1000;

var PLAYABLE_EXT = /\.(mp4|mkv|webm|avi|m3u8)(\?|$)/i;

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
  return val;
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
  if (!opts.headers) opts.headers = {};
  if (!opts.headers["User-Agent"]) opts.headers["User-Agent"] = UA;
  if (!opts.headers["Referer"]) opts.headers["Referer"] = BASE_URL + "/";
  if (!opts.headers["Accept"]) opts.headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8";
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

// ─── Arabic & String Normalization ──────────────────────────────────────────

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

function pad2(n) {
  var num = Number(n) || 0;
  return num < 10 ? "0" + num : String(num);
}

var SITE_STRIP = [
  "فيلم", "فلم", "مسلسل", "مدبلج", "مدبلجة", "مترجم", "مترجمة",
  "كامل", "مشاهدة", "تحميل", "اون", "لاين", "انمي", "أنمي",
  "كرتون", "حصريا", "بجودة", "عالية", "نسخة", "اصلية", "وي", "سيما", "ماي"
];

function cleanSiteTitle(str) {
  var t = normalizeAr(str);
  for (var i = 0; i < SITE_STRIP.length; i++) {
    t = t.replace(new RegExp("(?:^|\\s)" + SITE_STRIP[i] + "(?:\\s|$)", "g"), " ");
  }
  return t.replace(/\s+/g, " ").trim();
}

function inferQuality(str) {
  var m = String(str || "").match(/(2160|1440|1080|720|480|360|4k)\s*p?/i);
  if (!m) return "1080p";
  var q = m[1].toLowerCase();
  return q === "4k" ? "4K" : q + "p";
}

function latinServerName(serverName, url, idx) {
  var raw = String(serverName || "").trim();
  if (/wecima|mycima/i.test(raw) || /wecima|mycima/i.test(url || "")) return "WeCima Stream";
  if (/uqload/i.test(raw) || /uqload/i.test(url || "")) return "Uqload";
  if (/streamwish|flaswish|obeywish/i.test(raw) || /streamwish|wish/i.test(url || "")) return "StreamWish";
  if (/vidhide/i.test(raw) || /vidhide/i.test(url || "")) return "VidHide";
  if (/vidmoly/i.test(raw) || /vidmoly/i.test(url || "")) return "Vidmoly";
  if (/dood/i.test(raw) || /dood/i.test(url || "")) return "DoodStream";
  if (/mp4upload/i.test(raw) || /mp4upload/i.test(url || "")) return "Mp4Upload";
  if (/upstream/i.test(raw) || /upstream/i.test(url || "")) return "Upstream";
  if (/sendvid/i.test(raw) || /sendvid/i.test(url || "")) return "Sendvid";
  if (/yourupload/i.test(raw) || /yourupload/i.test(url || "")) return "YourUpload";
  if (/mixdrop/i.test(raw) || /mixdrop/i.test(url || "")) return "MixDrop";
  if (/voe/i.test(raw) || /voe/i.test(url || "")) return "VOE";

  var latin = raw.replace(/[^\x00-\x7F]+/g, " ").replace(/\s+/g, " ").trim();
  if (latin) return latin;
  var hostMatch = String(url || "").match(/^https?:\/\/([^/:]+)/i);
  if (hostMatch) return hostMatch[1].replace(/^www\./, "");
  return "Server " + ((Number(idx) || 0) + 1);
}

// ─── Unpack JS (Dean Edwards P.A.C.K.E.R) ────────────────────────────────────

function unpackJs(packed) {
  if (!packed || typeof packed !== "string") return "";
  var match = packed.match(/eval\(function\(p,a,c,k,e,d\)\{([\s\S]*?)\}\(([\s\S]*?)\)\)/);
  if (!match) return "";
  try {
    var fnBody = match[1];
    var argsStr = match[2];
    var args = [];
    var cur = "";
    var inQuotes = false;
    var quoteChar = "";
    for (var i = 0; i < argsStr.length; i++) {
      var ch = argsStr[i];
      if ((ch === "'" || ch === '"') && (i === 0 || argsStr[i - 1] !== "\\")) {
        if (!inQuotes) { inQuotes = true; quoteChar = ch; }
        else if (quoteChar === ch) { inQuotes = false; }
        cur += ch;
      } else if (ch === "," && !inQuotes) {
        args.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) args.push(cur.trim());
    if (args.length < 4) return "";

    var p = args[0].replace(/^['"]|['"]$/g, "");
    var a = parseInt(args[1], 10);
    var c = parseInt(args[2], 10);
    var kStr = args[3];
    var k = [];
    if (kStr.indexOf(".split(") !== -1) {
      var delimMatch = kStr.match(/\.split\((['"])(.*?)\1\)/);
      var delim = delimMatch ? delimMatch[2] : "|";
      var rawK = kStr.replace(/\.split\([\s\S]*\)$/, "").replace(/^['"]|['"]$/g, "");
      k = rawK.split(delim);
    } else {
      var cleanK = kStr.replace(/^\[|\]$/g, "");
      k = cleanK.split(",").map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ""); });
    }

    var eFn = function (c2) {
      return (c2 < a ? "" : eFn(parseInt(c2 / a, 10))) +
        ((c2 = c2 % a) > 35 ? String.fromCharCode(c2 + 29) : c2.toString(36));
    };

    while (c--) {
      if (k[c]) {
        var re = new RegExp("\\b" + eFn(c) + "\\b", "g");
        p = p.replace(re, k[c]);
      }
    }
    return p;
  } catch (err) {
    return "";
  }
}

// ─── TMDB Metadata ────────────────────────────────────────────────────────────

async function getTMDBDetails(tmdbId, mediaType) {
  var ck = "tmdb:" + mediaType + ":" + tmdbId;
  var hit = cacheGet(ck);
  if (hit) return hit;

  var type = mediaType === "movie" ? "movie" : "tv";
  var titles = [];
  var primary = "";
  var original = "";
  var year = "";

  try {
    var res = await fetchWithTimeout(
      "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY
    );
    if (res.ok) {
      var d = await res.json();
      primary = d.title || d.name || "";
      original = d.original_title || d.original_name || "";
      year = (d.release_date || d.first_air_date || "").split("-")[0];
      if (primary) titles.push(primary);
      if (original && original !== primary) titles.push(original);
    }
  } catch (e) {
    console.log("[WeCima] TMDB details error: " + e.message);
  }

  // Fetch Arabic translations
  try {
    var trRes = await fetchWithTimeout(
      "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "/translations?api_key=" + TMDB_API_KEY
    );
    if (trRes.ok) {
      var tr = await trRes.json();
      var list = tr.translations || [];
      for (var i = 0; i < list.length; i++) {
        var iso = String(list[i].iso_639_1 || "").toLowerCase();
        if (iso === "ar") {
          var arTitle = (list[i].data && (list[i].data.title || list[i].data.name)) || "";
          if (arTitle) titles.unshift(arTitle); // Prioritize Arabic title
        }
      }
    }
  } catch (e) {
    console.log("[WeCima] TMDB translations error: " + e.message);
  }

  return cacheSet(ck, {
    primaryTitle: primary,
    originalTitle: original,
    year: year,
    titles: uniqueNonEmpty(titles)
  });
}

// ─── Mirror Health Check ──────────────────────────────────────────────────────

async function getWorkingBaseUrl() {
  var ck = "active_mirror";
  var cached = cacheGet(ck);
  if (cached) return cached;

  for (var i = 0; i < MIRRORS.length; i++) {
    var mirror = MIRRORS[i];
    try {
      var res = await fetchWithTimeout(mirror, { method: "HEAD" }, 4000);
      if (res.ok || res.status === 301 || res.status === 302) {
        return cacheSet(ck, mirror);
      }
    } catch (e) {
      // try next mirror
    }
  }
  return cacheSet(ck, BASE_URL);
}

// ─── Search & Catalog Scraping ───────────────────────────────────────────────

function parseSearchResults(html, baseDomain) {
  var results = [];
  var seen = {};

  // Matches WeCima / MyCima grid item format:
  // <div class="GridItem">...<a href="URL" title="TITLE">...
  var cardRegex = /<div class="[^"]*(?:GridItem|Thumb--GridItem)[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi;
  var linkRegex = /<a[^>]+href="([^"]+)"[^>]*title="([^"]*)"/i;
  var yearRegex = /<(?:strong|span)[^>]*class="[^"]*hasyear[^"]*"[^>]*>(\d{4})<\//i;

  var cards = html.match(cardRegex) || [];
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];
    var linkMatch = card.match(linkRegex);
    if (!linkMatch) continue;

    var href = linkMatch[1];
    var rawTitle = linkMatch[2];
    if (!href || !rawTitle) continue;

    if (href.indexOf("http") !== 0) {
      href = baseDomain.replace(/\/+$/, "") + "/" + href.replace(/^\/+/, "");
    }
    if (seen[href]) continue;
    seen[href] = true;

    var yearMatch = card.match(yearRegex) || rawTitle.match(/\b(19\d\d|20\d\d)\b/);
    var itemYear = yearMatch ? yearMatch[1] : "";
    var isDubbed = /مدبلج/i.test(rawTitle) || /dubbed/i.test(href);

    results.push({
      url: href,
      title: rawTitle,
      year: itemYear,
      isDubbed: isDubbed
    });
  }

  // Fallback: extract any /watch/ or /film/ or /series/ anchor links if cards structure differed
  if (!results.length) {
    var generalAnchor = /<a[^>]+href="([^"]+(?:\/watch\/|\/film\/|\/series\/)[^"]*)"[^>]*title="([^"]*)"/gi;
    var m;
    while ((m = generalAnchor.exec(html)) !== null) {
      var u = m[1];
      var t = m[2];
      if (u.indexOf("http") !== 0) {
        u = baseDomain.replace(/\/+$/, "") + "/" + u.replace(/^\/+/, "");
      }
      if (!seen[u]) {
        seen[u] = true;
        var yM = t.match(/\b(19\d\d|20\d\d)\b/);
        results.push({
          url: u,
          title: t,
          year: yM ? yM[1] : "",
          isDubbed: /مدبلج/i.test(t) || /dubbed/i.test(u)
        });
      }
    }
  }

  return results;
}

async function searchWeCima(query, baseDomain) {
  var url = baseDomain + "/search/" + encodeURIComponent(query) + "/";
  try {
    var html = await fetchText(url);
    return parseSearchResults(html, baseDomain);
  } catch (e) {
    console.log("[WeCima] Search error for query '" + query + "': " + e.message);
    return [];
  }
}

// ─── Match Scoring ────────────────────────────────────────────────────────────

function scoreMatch(entry, tmdbInfo, targetYear, preferDubbed) {
  var entryTitleAr = cleanSiteTitle(entry.title);
  var entryTitleEn = normalizeEn(entry.title);
  var score = 0;

  for (var i = 0; i < tmdbInfo.titles.length; i++) {
    var candidate = tmdbInfo.titles[i];
    var cAr = cleanSiteTitle(candidate);
    var cEn = normalizeEn(candidate);

    if (cAr && entryTitleAr && (cAr === entryTitleAr || entryTitleAr.indexOf(cAr) !== -1 || cAr.indexOf(entryTitleAr) !== -1)) {
      score = Math.max(score, 90);
    }
    if (cEn && entryTitleEn && (cEn === entryTitleEn || entryTitleEn.indexOf(cEn) !== -1 || cEn.indexOf(entryTitleEn) !== -1)) {
      score = Math.max(score, 85);
    }
  }

  if (score > 0) {
    // Year check
    if (targetYear && entry.year) {
      if (entry.year === targetYear) score += 10;
      else if (Math.abs(parseInt(entry.year, 10) - parseInt(targetYear, 10)) <= 1) score += 5;
      else score -= 15;
    }

    // Boost dubbed movies when requested or available
    if (entry.isDubbed) {
      score += preferDubbed ? 20 : 5;
    }
  }

  return score;
}

// ─── Watch Page & Servers Extraction ──────────────────────────────────────────

async function getTargetWatchPage(entryUrl, isMovie, season, episode, baseDomain) {
  if (isMovie) return entryUrl;

  try {
    var html = await fetchText(entryUrl);
    // For series, find the target episode link matching season & episode:
    // e.g. /watch/...-الموسم-1-الحلقة-5/ or episode list
    var s = Number(season) || 1;
    var e = Number(episode) || 1;

    // Pattern 1: Links matching season and episode in Arabic
    var epLinkPattern = new RegExp(
      '<a[^>]+href="([^"]+)"[^>]*>[\\s\\S]*?' +
      '(?:الموسم\\s*' + s + '[^<]*?)?' +
      'الحلقة\\s*' + e + '\\b[^<]*?<\\/a>',
      "i"
    );
    var match = html.match(epLinkPattern);
    if (match) {
      var link = match[1];
      return link.indexOf("http") === 0 ? link : baseDomain.replace(/\/+$/, "") + "/" + link.replace(/^\/+/, "");
    }

    // Pattern 2: URL slug containing season-s-episode-e
    var slugPattern = new RegExp('href="([^"]*?(?:season-' + s + '.*?episode-' + e + '|الحلقة-' + e + '|ep-' + e + ')[^"]*)"', "i");
    var slugMatch = html.match(slugPattern);
    if (slugMatch) {
      var sLink = slugMatch[1];
      return sLink.indexOf("http") === 0 ? sLink : baseDomain.replace(/\/+$/, "") + "/" + sLink.replace(/^\/+/, "");
    }

    // Fallback: return series page directly
    return entryUrl;
  } catch (err) {
    return entryUrl;
  }
}

function extractServers(html, pageUrl) {
  var servers = [];
  var seen = {};

  function addServer(url, name, quality) {
    if (!url || typeof url !== "string") return;
    url = url.trim();
    if (url.indexOf("//") === 0) url = "https:" + url;
    if (url.indexOf("http") !== 0) return;
    if (seen[url]) return;
    seen[url] = true;
    servers.push({
      url: url,
      name: name || "Server",
      quality: quality || "1080p"
    });
  }

  // 1. WatchServersList: <ul class="WatchServersList"> ... <btn data-url="URL"><span>Server</span></btn>
  var watchBtnRegex = /<(?:btn|li|button|a)[^>]+data-(?:url|embed)="([^"]+)"[^>]*>([\s\S]*?)<\/(?:btn|li|button|a)>/gi;
  var wMatch;
  while ((wMatch = watchBtnRegex.exec(html)) !== null) {
    var rawUrl = wMatch[1];
    var sNameRaw = wMatch[2].replace(/<[^>]+>/g, " ").trim();
    var q = inferQuality(sNameRaw);
    addServer(rawUrl, latinServerName(sNameRaw, rawUrl, servers.length), q);
  }

  // 2. Download list: <ul class="List--Download--Wecima--Single"> ... <a href="URL"><span>1080p</span></a>
  var downloadRegex = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*hoverable[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  var dMatch;
  while ((dMatch = downloadRegex.exec(html)) !== null) {
    var dUrl = dMatch[1];
    var label = dMatch[2].replace(/<[^>]+>/g, " ").trim();
    var dQual = inferQuality(label);
    addServer(dUrl, "WeCima Direct (" + dQual + ")", dQual);
  }

  // 3. Embedded iframes: <iframe src="URL" ...>
  var iframeRegex = /<iframe[^>]+src="([^"]+)"/gi;
  var ifMatch;
  while ((ifMatch = iframeRegex.exec(html)) !== null) {
    var ifUrl = ifMatch[1];
    if (ifUrl.indexOf("facebook.com") === -1 && ifUrl.indexOf("twitter.com") === -1 && ifUrl.indexOf("googletag") === -1) {
      addServer(ifUrl, latinServerName("Player Embed", ifUrl, servers.length), "1080p");
    }
  }

  return servers;
}

// ─── Embed Resolvers ──────────────────────────────────────────────────────────

async function resolveEmbed(rawServer, pageUrl) {
  var url = rawServer.url;
  var sName = rawServer.name;
  var quality = rawServer.quality || "1080p";

  // Direct playable video
  if (PLAYABLE_EXT.test(url)) {
    return {
      url: url,
      name: sName,
      quality: quality,
      headers: { "User-Agent": UA, "Referer": pageUrl }
    };
  }

  try {
    // 1. Uqload
    if (/uqload\.(io|com|vc|to)/i.test(url)) {
      var htmlUq = await fetchText(url, { Referer: pageUrl }, 8000);
      var unpackedUq = unpackJs(htmlUq) || htmlUq;
      var mUq = unpackedUq.match(/https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*/i) ||
                unpackedUq.match(/sources:\s*\[\s*["']([^"']+)["']/i);
      if (mUq) {
        return {
          url: mUq[1] || mUq[0],
          name: "Uqload",
          quality: "1080p",
          headers: { "User-Agent": UA, "Referer": url }
        };
      }
    }

    // 2. StreamWish family
    if (/flaswish|streamwish|obeywish|swdyu|playerwish|hanerix|swishsrv|youdbox/i.test(url)) {
      var htmlSw = await fetchText(url, { Referer: pageUrl }, 8000);
      var unpackedSw = unpackJs(htmlSw) || htmlSw;
      var mSw = unpackedSw.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i) ||
                unpackedSw.match(/sources:\s*\[\{file:\s*["']([^"']+)["']/i);
      if (mSw) {
        return {
          url: mSw[1] || mSw[0],
          name: "StreamWish",
          quality: "1080p",
          headers: { "User-Agent": UA, "Referer": url }
        };
      }
    }

    // 3. VidHide family
    if (/vidhide|morencius|callistanise|dintezuvio|minochinos/i.test(url)) {
      var htmlVh = await fetchText(url, { Referer: pageUrl }, 8000);
      var unpackedVh = unpackJs(htmlVh) || htmlVh;
      var mVh = unpackedVh.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
      if (mVh) {
        return {
          url: mVh[0],
          name: "VidHide",
          quality: "1080p",
          headers: { "User-Agent": UA, "Referer": url }
        };
      }
    }

    // 4. Sendvid
    if (url.indexOf("sendvid.com") !== -1) {
      var htmlSv = await fetchText(url, { Referer: pageUrl }, 8000);
      var mSv = htmlSv.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i) ||
                htmlSv.match(/var\s+video_source\s*=\s*["']([^"']+)["']/i);
      if (mSv) {
        return {
          url: mSv[1],
          name: "Sendvid",
          quality: "720p",
          headers: { "User-Agent": UA, "Referer": url }
        };
      }
    }

    // 5. YourUpload
    if (url.indexOf("yourupload.com") !== -1) {
      var htmlYu = await fetchText(url, { Referer: pageUrl }, 8000);
      var mYu = htmlYu.match(/file:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i) ||
                htmlYu.match(/og:video(?::secure_url)?[^"']+content=["']([^"']+)["']/i);
      if (mYu) {
        return {
          url: mYu[1] || mYu[0],
          name: "YourUpload",
          quality: "720p",
          headers: { "User-Agent": UA, "Referer": url }
        };
      }
    }

    // 6. WeCima / MyCima Internal Player
    if (/wecima|mycima|upbaam/i.test(url)) {
      var htmlWc = await fetchText(url, { Referer: pageUrl }, 8000);
      var mWc = htmlWc.match(/source\s*=\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i) ||
                htmlWc.match(/file:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i) ||
                htmlWc.match(/<source[^>]+src=["']([^"']+)["']/i);
      if (mWc) {
        return {
          url: mWc[1],
          name: "WeCima Stream",
          quality: quality,
          headers: { "User-Agent": UA, "Referer": url }
        };
      }
    }

  } catch (err) {
    // skip failed resolution
  }

  // If no internal parser matched, return the embed URL directly so Nuvio webview player can play it
  return {
    url: url,
    name: sName,
    quality: quality,
    headers: { "User-Agent": UA, "Referer": pageUrl }
  };
}

// ─── Main Plugin Entry ───────────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  mediaType = mediaType || "movie";
  var isMovie = mediaType === "movie";
  var s = Number(season) || 1;
  var e = Number(episode) || 1;

  console.log("[" + PROVIDER_NAME + "] Request: tmdbId=" + tmdbId + " type=" + mediaType + (isMovie ? "" : " S" + s + "E" + e));

  try {
    var tmdbInfo = await getTMDBDetails(tmdbId, mediaType);
    if (!tmdbInfo.titles.length) {
      console.log("[" + PROVIDER_NAME + "] No TMDB titles found");
      return [];
    }

    var baseDomain = await getWorkingBaseUrl();
    console.log("[" + PROVIDER_NAME + "] Using domain: " + baseDomain);

    // Build search queries:
    // 1. Dubbed query (title + " مدبلج")
    // 2. Arabic title
    // 3. Primary English title
    var queries = [];
    for (var i = 0; i < tmdbInfo.titles.length; i++) {
      var t = tmdbInfo.titles[i];
      queries.push(t + " مدبلج"); // Look for dubbed version specifically
      queries.push(t);
    }
    queries = uniqueNonEmpty(queries);

    var allResults = [];
    for (var qi = 0; qi < Math.min(queries.length, 3); qi++) {
      var resList = await searchWeCima(queries[qi], baseDomain);
      for (var r = 0; r < resList.length; r++) {
        allResults.push(resList[r]);
      }
      if (allResults.length >= 6) break;
    }

    if (!allResults.length) {
      console.log("[" + PROVIDER_NAME + "] No search results returned");
      return [];
    }

    // Rank results
    var scored = [];
    var seenUrls = {};
    for (var k = 0; k < allResults.length; k++) {
      var item = allResults[k];
      if (seenUrls[item.url]) continue;
      seenUrls[item.url] = true;

      var sc = scoreMatch(item, tmdbInfo, tmdbInfo.year, true);
      if (sc > 50) {
        scored.push({ item: item, score: sc });
      }
    }

    scored.sort(function (a, b) { return b.score - a.score; });
    if (!scored.length) {
      console.log("[" + PROVIDER_NAME + "] No matching results scored above threshold");
      return [];
    }

    var bestMatch = scored[0].item;
    console.log("[" + PROVIDER_NAME + "] Best match: " + bestMatch.title + " (Dubbed: " + bestMatch.isDubbed + ")");

    var targetWatchPage = await getTargetWatchPage(bestMatch.url, isMovie, s, e, baseDomain);
    console.log("[" + PROVIDER_NAME + "] Fetching watch page: " + targetWatchPage);

    var watchHtml = await fetchText(targetWatchPage);
    var rawServers = extractServers(watchHtml, targetWatchPage);
    if (!rawServers.length) {
      console.log("[" + PROVIDER_NAME + "] No servers found on watch page");
      return [];
    }

    console.log("[" + PROVIDER_NAME + "] Found " + rawServers.length + " raw server(s)");

    var baseTitle = tmdbInfo.primaryTitle || bestMatch.title || ("TMDB " + tmdbId);
    var yearText = tmdbInfo.year ? " (" + tmdbInfo.year + ")" : "";
    var dubTag = bestMatch.isDubbed ? " [مدبلج]" : " [مترجم]";
    var streamTitle = baseTitle +
      (isMovie ? "" : " S" + pad2(s) + "E" + pad2(e)) +
      yearText + dubTag;

    var streams = [];
    var seenStreamUrls = {};

    for (var si = 0; si < rawServers.length; si++) {
      var resolved = await resolveEmbed(rawServers[si], targetWatchPage);
      if (!resolved || !resolved.url || seenStreamUrls[resolved.url]) continue;
      seenStreamUrls[resolved.url] = true;

      streams.push({
        name: PROVIDER_NAME + " [" + resolved.name + "]" + (bestMatch.isDubbed ? " · مدبلج" : ""),
        title: streamTitle + " · " + resolved.quality,
        url: resolved.url,
        quality: resolved.quality || "1080p",
        headers: resolved.headers || {
          "User-Agent": UA,
          "Referer": targetWatchPage
        },
        subtitles: []
      });
    }

    console.log("[" + PROVIDER_NAME + "] Done: " + streams.length + " stream(s)");
    return streams;

  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Fatal error: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
