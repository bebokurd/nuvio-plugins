// Doblaj Scraper for Nuvio Local Scrapers
// Kurdish dubbed (Doblaj) movies & TV series from kurd-movie.com
// Compatible with React Native / Hermes and Node.js

"use strict";

var PROVIDER_NAME = "Doblaj";
var BASE_URL = "https://www.kurd-movie.com";
var PLAYER_API = BASE_URL + "/wp-json/dooplayer/v2";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var TIMEOUT_MS = 12000;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
var CACHE_TTL_MS = 20 * 60 * 1000;

// Only Kurdish-dubbed titles belong to this provider
var DOBLAJ_GENRE_RE = /(^|-)(all-)?doblaj(-|$)/i;

// Playable media extensions
var PLAYABLE_EXT = /\.(m3u8|mp4|mkv)(\?|$)/i;

// Server pages that report an unavailable upload
var DEAD_FILE_RE = /file is no longer available|no longer available|video (?:has been )?(?:deleted|removed)|expired or has been deleted|видео заблокировано|файл не найден/i;

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
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,ckb;q=0.9,ku;q=0.8,ar;q=0.7"
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

// ─── String and Normalization Utilities ──────────────────────────────────────

function pad2(n) {
  var num = Number(n) || 0;
  return num < 10 ? "0" + num : String(num);
}

function hostOf(url) {
  var m = String(url || "").match(/^https?:\/\/([^/:]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function originOf(url) {
  var m = String(url || "").match(/^(https?:\/\/[^/]+)/i);
  return m ? m[1] : "";
}

function normalizeUrl(url, base) {
  var u = String(url || "").trim();
  if (!u) return "";
  if (u.indexOf("//") === 0) return "https:" + u;
  if (u.charAt(0) === "/") return (originOf(base) || BASE_URL) + u;
  return u;
}

function cleanEmbedUrl(raw, base) {
  var str = String(raw || "").trim();
  if (!str) return "";
  var ifMatch = str.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (ifMatch) str = ifMatch[1];
  str = str.replace(/["'\s].*$/, "").trim();
  return normalizeUrl(str, base);
}

function decodeEntities(str) {
  return String(str || "")
    .replace(/&#(\d+);/g, function (_, code) {
      var num = parseInt(code, 10);
      return num > 0 && num < 65536 ? String.fromCharCode(num) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function cleanTitle(str) {
  return (str || "")
    .replace(/[\u064B-\u0652\u0670\u0640\u200C\u200B]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[\u0649\u064A]/g, "ی")
    .replace(/ك/g, "ک")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

var TITLE_STRIP = [
  "دۆبلاژی کوردی", "دۆبلاژ", "ژێرنووسی کوردی", "ژێرنووس", "ژێرنوس",
  "کورد-مۆڤی", "کورد مۆڤی", "فلیمی", "فیلمی", "زنجیرەی",
  "kurdish dubbed", "dubbed", "doblaj", "full movie", "movie"
];

function stripSiteKeywords(str) {
  var t = cleanTitle(str);
  for (var i = 0; i < TITLE_STRIP.length; i++) {
    t = t.replace(new RegExp("(?:^|\\s)" + TITLE_STRIP[i] + "(?:\\s|$)", "g"), " ");
  }
  return t.replace(/\s+/g, " ").trim();
}

function extractIframeSrc(html) {
  var m = String(html || "").match(/<iframe[^>]*\bsrc=["']([^"']+)["']/i);
  return m ? m[1].trim() : "";
}

// ─── Dean Edwards Packer Unpacker ────────────────────────────────────────────

function unpackJs(code) {
  try {
    var m = (code || "").match(/eval\(function\(p,a,c,k,e,[rd]\)\{.*?\}\s*\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
    if (!m) return null;
    var p = m[1];
    var a = parseInt(m[2], 10);
    var k = m[4].split("|");
    var ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

    p = p.replace(/\b\w+\b/g, function (token) {
      var val = 0;
      for (var i = 0; i < token.length; i++) {
        var idx = ALPHABET.indexOf(token[i]);
        if (idx === -1 || idx >= a) { val = -1; break; }
        val = val * a + idx;
      }
      if (val !== -1 && val < k.length && k[val]) return k[val];
      return token;
    });
    return p;
  } catch (err) {
    return null;
  }
}

// ─── TMDB Details Lookup ─────────────────────────────────────────────────────

async function getTMDBInfo(tmdbId, mediaType) {
  var type = mediaType === "movie" ? "movie" : "tv";
  var key = "tmdb:" + type + ":" + tmdbId;
  var cached = cacheGet(key);
  if (cached) return cached;

  var url = "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  try {
    var data = await fetchJson(url, null, 8000);
    var titles = [];
    if (data.title) titles.push(data.title);
    if (data.name) titles.push(data.name);
    if (data.original_title && titles.indexOf(data.original_title) === -1) titles.push(data.original_title);
    if (data.original_name && titles.indexOf(data.original_name) === -1) titles.push(data.original_name);

    // Fetch Kurdish & Arabic translation titles for better site matching
    try {
      var trUrl = "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "/translations?api_key=" + TMDB_API_KEY;
      var trData = await fetchJson(trUrl, null, 4000);
      var trList = (trData && trData.translations) || [];
      for (var i = 0; i < trList.length; i++) {
        var iso = (trList[i].iso_639_1 || "").toLowerCase();
        if (iso === "ku" || iso === "ar" || iso === "ckb") {
          var trTitle = (trList[i].data && (trList[i].data.title || trList[i].data.name)) || "";
          if (trTitle && titles.indexOf(trTitle) === -1) titles.push(trTitle);
        }
      }
    } catch (eTr) {}

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

// ─── Site Search (WordPress ?s=) ─────────────────────────────────────────────

function parseSearchItems(html) {
  var items = [];
  var blocks = String(html || "").split('<div class="result-item">').slice(1);

  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i].split('<div class="result-item">')[0];
    var linkMatch = block.match(/<div class="title">\s*<a[^>]*href=["']([^"']+)["']/i);
    if (!linkMatch) linkMatch = block.match(/<a[^>]*href=["'](https?:\/\/www\.kurd-movie\.com\/(?:movies|tvshows)\/[^"']+)["']/i);
    if (!linkMatch) continue;

    var url = normalizeUrl(linkMatch[1], BASE_URL);
    if (!/\/(movies|tvshows)\//.test(url)) continue;

    var nameMatch = block.match(/<div class="title">\s*<a[^>]*>([^<]+)</i) ||
                    block.match(/alt=["']([^"']+)["']/i);
    var name = nameMatch ? decodeEntities(nameMatch[1]).trim() : "";
    var yearMatch = block.match(/<span class="year">([^<]*)<\/span>/i);
    var kindMatch = block.match(/<span class="movies">([^<]*)<\/span>/i);

    items.push({
      name: name,
      url: url,
      year: (yearMatch ? yearMatch[1] : "").replace(/[^\d]/g, ""),
      isTv: /\/tvshows\//.test(url) || /series|tv/i.test(kindMatch ? kindMatch[1] : "")
    });
  }

  return items;
}

async function searchSite(term) {
  var key = "search:" + String(term || "").toLowerCase();
  var cached = cacheGet(key);
  if (cached) return cached;

  var items = [];
  try {
    var html = await fetchText(BASE_URL + "/?s=" + encodeURIComponent(term), { "Referer": BASE_URL + "/" }, 11000);
    items = parseSearchItems(html);
  } catch (e) {
    items = [];
  }
  cacheSet(key, items);
  return items;
}

function scoreMatch(item, expectedTitles, expectedYear) {
  var itRaw = cleanTitle(item.name);
  var itClean = stripSiteKeywords(item.name);
  if (!itRaw && !itClean) return 0;

  var yearOk = !expectedYear || !item.year || item.year === String(expectedYear);
  var best = 0;

  for (var i = 0; i < expectedTitles.length; i++) {
    var etRaw = cleanTitle(expectedTitles[i]);
    var etClean = stripSiteKeywords(expectedTitles[i]);
    if (!etRaw && !etClean) continue;

    if ((itClean === etClean || itClean === etRaw || itRaw === etClean) && yearOk) return 100;
    if (itClean === etClean) best = Math.max(best, 90);

    if (etClean && (itClean.indexOf(etClean) !== -1 || etClean.indexOf(itClean) !== -1)) {
      best = Math.max(best, yearOk ? 85 : 55);
      continue;
    }

    var etTokens = etClean.split(" ").filter(function (t) { return t.length > 2; });
    if (!etTokens.length) etTokens = etRaw.split(" ").filter(function (t) { return t.length > 2; });
    if (!etTokens.length) continue;

    var hits = etTokens.filter(function (t) { return itClean.indexOf(t) !== -1 || itRaw.indexOf(t) !== -1; }).length;
    if (hits === etTokens.length) best = Math.max(best, yearOk ? 80 : 50);
    else if (hits >= etTokens.length - 1 && hits > 0) best = Math.max(best, yearOk ? 65 : 40);
  }

  return best;
}

function hasDoblajGenre(html, url, title) {
  if (DOBLAJ_GENRE_RE.test(url || "")) return true;
  if (/دۆبلاژ|doblaj/i.test(title || "")) return true;

  var str = String(html || "");
  if (/<span class=["']quality["'][^>]*>\s*doblaj\s*<\/span>/i.test(str)) return true;
  if (/genre\/(?:all-)?doblaj/i.test(str)) return true;

  var block = (str.match(/<div class="sgeneros">([\s\S]{0,1200}?)<\/div>/i) || [])[1];
  if (block !== undefined) {
    var genres = (block.match(/\/genre\/([a-z0-9-]+)\//gi) || []).map(function (g) {
      return g.match(/\/genre\/([a-z0-9-]+)/i)[1];
    });
    for (var i = 0; i < genres.length; i++) {
      if (DOBLAJ_GENRE_RE.test(genres[i])) return true;
    }
  }

  return false;
}

async function getItemPage(url) {
  var key = "page:" + url;
  var cached = cacheGet(key);
  if (cached) return cached;

  var html = "";
  try {
    html = await fetchText(url, { "Referer": BASE_URL + "/" }, 11000);
  } catch (e) {
    html = "";
  }
  cacheSet(key, html);
  return html;
}

// Locate the requested title and keep it only when it is Kurdish dubbed
async function findDoblajEntry(tmdbInfo, isMovie) {
  var expectedTitles = tmdbInfo.titles.length ? tmdbInfo.titles : [tmdbInfo.title];
  var expectedYear = tmdbInfo.year || "";

  var terms = [];
  for (var i = 0; i < expectedTitles.length; i++) {
    var t = expectedTitles[i];
    if (!t) continue;
    if (terms.indexOf(t) === -1) terms.push(t);
    var clean = cleanTitle(t);
    if (clean && clean !== t && terms.indexOf(clean) === -1) terms.push(clean);
  }
  if (!terms.length) return null;

  for (var j = 0; j < terms.length; j++) {
    var results = await searchSite(terms[j]);
    if (!results.length) continue;

    var candidates = results.filter(function (item) { return isMovie ? !item.isTv : item.isTv; });
    if (!candidates.length) candidates = results;

    var scored = candidates.map(function (item) {
      return { item: item, score: scoreMatch(item, expectedTitles, expectedYear) };
    }).sort(function (a, b) { return b.score - a.score; });

    for (var k = 0; k < scored.length; k++) {
      if (scored[k].score < 60) break;

      var html = await getItemPage(scored[k].item.url);
      if (!html) continue;
      if (!hasDoblajGenre(html, scored[k].item.url, scored[k].item.name)) {
        console.log("[" + PROVIDER_NAME + "] " + scored[k].item.name + " is not tagged doblaj, skipped");
        continue;
      }

      return { item: scored[k].item, html: html, score: scored[k].score };
    }
  }

  return null;
}

// ─── Server Lists (DooPlay player options) ───────────────────────────────────

function parsePlayerOptions(html) {
  var out = [];
  var re = /<li[^>]*class=["'][^"']*dooplay_player_option[^"']*["'][\s\S]*?<\/li>/gi;
  var m;

  while ((m = re.exec(html))) {
    var tag = m[0];
    var post = (tag.match(/data-post=["'](\d+)["']/i) || [])[1];
    var type = ((tag.match(/data-type=["']([a-z]+)["']/i) || [])[1] || "").toLowerCase();
    var nume = (tag.match(/data-nume=["']([^"']+)["']/i) || [])[1];
    var title = (tag.match(/<span class=["']title["'][^>]*>([^<]*)<\/span>/i) || [])[1];

    if (!post || !type || !nume) continue;

    var label = decodeEntities(title || "").trim();
    if (nume.toLowerCase() === "trailer" || !label || /trailer|مهێڵەر/i.test(label)) continue;

    out.push({
      post: post,
      type: type,
      nume: nume,
      server: label
    });
  }

  return out;
}

// Resolve one DooPlay option into the real embed URL
async function resolveOption(option) {
  var url = PLAYER_API + "/" + encodeURIComponent(option.post) + "/" +
    encodeURIComponent(option.type) + "/" + encodeURIComponent(option.nume);
  try {
    var data = await fetchJson(url, { "Referer": BASE_URL + "/" }, 9000);
    var raw = (data && (data.embed_url || data.url || data.src)) || "";
    var embed = cleanEmbedUrl(raw, BASE_URL);
    if (!embed || embed.indexOf("http") !== 0) return null;
    if (/youtu\.?be|youtube\.com/i.test(embed)) return null;

    var isDub = !/ژێرنوس|ژێرنووس|sub|subtitled/i.test(option.server);

    return {
      server: option.server,
      quality: option.server,
      url: embed,
      isDub: isDub
    };
  } catch (e) {
    return null;
  }
}

// Find the episode page for a requested season/episode pair
function findEpisodeUrl(showHtml, season, episode) {
  var sNum = Number(season) || 1;
  var eNum = Number(episode) || 1;

  var re = /href=["'](https?:\/\/www\.kurd-movie\.com\/episodes?\/[^"'#?]+)["'][^>]*>([\s\S]{0,240}?)<\/a>/gi;
  var m;
  var fallback = "";

  while ((m = re.exec(showHtml))) {
    var url = m[1];
    var inner = m[2];
    var clean = url.replace(/\/+$/, "");
    var slug = clean.substring(clean.lastIndexOf("/") + 1);

    var seSlug = slug.match(/(\d+)[x-](\d+)$/) ||
                 slug.match(/season-(\d+)-episode-(\d+)/i) ||
                 slug.match(/s(\d+)e(\d+)/i);
    if (seSlug) {
      if (Number(seSlug[1]) === sNum && Number(seSlug[2]) === eNum) return url;
      if (!fallback && Number(seSlug[1]) === sNum) fallback = url;
      continue;
    }

    var numMatch = inner.match(/(?:class=["']numerando["'][^>]*>|\b)(\d+)\s*(?:-|x|–)\s*(\d+)/i) ||
                   inner.match(/season\s*(\d+)\s*episode\s*(\d+)/i);
    if (numMatch) {
      if (Number(numMatch[1]) === sNum && Number(numMatch[2]) === eNum) return url;
      if (!fallback && Number(numMatch[1]) === sNum) fallback = url;
    }
  }

  return fallback || "";
}

async function getMovieSources(entryHtml) {
  var options = parsePlayerOptions(entryHtml).filter(function (o) { return o.type === "movie"; });
  if (!options.length) options = parsePlayerOptions(entryHtml);
  return collectSources(options);
}

async function getEpisodeSources(entryHtml, season, episode) {
  var episodeUrl = findEpisodeUrl(entryHtml, season, episode);
  if (!episodeUrl) {
    console.log("[" + PROVIDER_NAME + "] Episode S" + season + "E" + episode + " not listed");
    return [];
  }

  var html = await getItemPage(episodeUrl);
  if (!html) return [];

  var options = parsePlayerOptions(html).filter(function (o) { return o.type === "tv" || o.type === "episode"; });
  if (!options.length) options = parsePlayerOptions(html);
  return collectSources(options);
}

async function collectSources(options) {
  if (!options.length) return [];

  var resolvedList = await Promise.all(options.map(resolveOption));
  var videos = [];
  var seen = {};

  for (var i = 0; i < resolvedList.length; i++) {
    var v = resolvedList[i];
    if (!v || seen[v.url]) continue;
    seen[v.url] = true;
    videos.push(v);
  }

  return videos;
}

// ─── Individual Embed Resolvers ──────────────────────────────────────────────

function isUsableStream(url) {
  if (!url || typeof url !== "string") return false;
  return PLAYABLE_EXT.test(url) || /\/master\.|\/hls\d?\//i.test(url) || url.indexOf(".m3u8") !== -1;
}

function extractStreamFromCode(code, baseOrigin) {
  if (!code) return null;
  var patterns = [
    /"hls4"\s*:\s*"([^"]+)"/,
    /"hls2"\s*:\s*"([^"]+)"/,
    /"hls"\s*:\s*"([^"]+)"/,
    /file\s*:\s*["']([^"']+\.(?:m3u8|mp4|mkv)[^"']*)["']/i,
    /sources\s*:\s*\[[^\]]*?["'](https?:\/\/[^"']+\.(?:m3u8|mp4|mkv)[^"']*)["']/i,
    /["'](https?:\/\/[^"'\s\\]+\.(?:m3u8|mp4|mkv)[^"'\s\\]*)["']/i,
    /["'](\/\/[^"'\s\\]+\.(?:m3u8|mp4|mkv)[^"'\s\\]*)["']/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = code.match(patterns[i]);
    if (m && m[1]) {
      var u = m[1].replace(/\\\//g, "/");
      if (u.indexOf("//") === 0) u = "https:" + u;
      else if (u.charAt(0) === "/") u = (baseOrigin || "") + u;
      if (isUsableStream(u)) return u;
    }
  }
  return null;
}

function extractFromHtml(html, origin) {
  var raw = extractStreamFromCode(html, origin);
  if (raw) return raw;
  var unpacked = unpackJs(html);
  if (unpacked) {
    var fromPacked = extractStreamFromCode(unpacked, origin);
    if (fromPacked) return fromPacked;
  }
  return null;
}

// 1. StreamWish family (HgCloud, Hanerix, UasOpt, ByseZoxexe, ObeyWish, Swdyu, ...)
var STREAMWISH_HOSTS = /streamwish|obeywish|playerwish|jodwish|strwish|sfastwish|hlswish|swishsrv|audinifer|wishembed|hgcloud|hglink|hanerix|swdyu|swishhub|filesb|buzzfile|1oxa|streamhie|uasopt|bingezove|bysezoxexe|davioad|wishstream|awish|flaswish|youdbox|dumpor|swtube|swcloud|streamhg/i;

async function resolveStreamWish(iframeUrl) {
  var codeMatch = iframeUrl.match(/\/(?:e|f|embed|d)\/([a-zA-Z0-9_-]+)/);
  if (!codeMatch) return null;
  var fileCode = codeMatch[1];
  var ownOrigin = originOf(iframeUrl);

  // Always attempt the origin that hosts the file FIRST
  var mirrors = [
    ownOrigin,
    "https://obeywish.com",
    "https://swdyu.com",
    "https://playerwish.com",
    "https://strwish.com",
    "https://hlswish.com",
    "https://streamwish.to"
  ];

  var tried = {};
  var answered = 0;
  var deadSeen = false;

  for (var i = 0; i < mirrors.length; i++) {
    var origin = mirrors[i];
    if (!origin || tried[origin]) continue;
    tried[origin] = true;

    var targetUrl = origin + "/e/" + fileCode;
    try {
      var html = await fetchText(targetUrl, {
        "Referer": origin + "/",
        "Origin": origin
      }, 7000);
      answered++;

      if (DEAD_FILE_RE.test(html)) {
        deadSeen = true;
        continue;
      }

      var streamUrl = extractFromHtml(html, origin);
      if (streamUrl) return { url: streamUrl, origin: origin };
    } catch (e) {}
  }

  // Some mirrors only expose the direct download /f/ route
  if (ownOrigin) {
    try {
      var html2 = await fetchText(ownOrigin + "/f/" + fileCode, { "Referer": ownOrigin + "/" }, 7000);
      answered++;
      if (DEAD_FILE_RE.test(html2)) deadSeen = true;
      else {
        var s2 = extractFromHtml(html2, ownOrigin);
        if (s2) return { url: s2, origin: ownOrigin };
      }
    } catch (e2) {}
  }

  return (answered > 0 && deadSeen) ? { dead: true } : null;
}

// 2. VidHide family (Morencius, Minochinos, Dingtezuni, Earnvids, FileLions, ...)
var VIDHIDE_HOSTS = /vidhide|filelions|morencius|minochinos|dingtezuni|dintezuvio|callistanise|guccihide|fviplions|megacloud|blackcdn|bingezove|earnvids?|vidhidepro|vidhidepre|vidhidevip/i;

async function resolveVidHide(iframeUrl) {
  var origin = originOf(iframeUrl);
  if (!origin) return null;
  var codeMatch = iframeUrl.match(/\/(?:embed|e|v|d)\/([a-zA-Z0-9_-]+)/);
  var fileCode = codeMatch ? codeMatch[1] : "";

  try {
    var html = await fetchText(iframeUrl, {
      "Referer": origin + "/",
      "Origin": origin
    }, 8000);
    if (DEAD_FILE_RE.test(html)) return { dead: true };
    var streamUrl = extractFromHtml(html, origin);
    if (streamUrl) return { url: streamUrl, origin: origin };
  } catch (e) {}

  if (fileCode) {
    var mirrors = ["https://vidhidepre.com/v/", "https://filelions.to/v/", "https://vidhidevip.com/v/"];
    for (var i = 0; i < mirrors.length; i++) {
      var mUrl = mirrors[i] + fileCode;
      var mOrigin = originOf(mUrl);
      try {
        var mHtml = await fetchText(mUrl, { "Referer": mOrigin + "/" }, 7000);
        if (DEAD_FILE_RE.test(mHtml)) continue;
        var sUrl = extractFromHtml(mHtml, mOrigin);
        if (sUrl) return { url: sUrl, origin: mOrigin };
      } catch (eM) {}
    }
  }

  return null;
}

// 3. StreamTape
async function resolveStreamTape(iframeUrl) {
  var origin = originOf(iframeUrl) || "https://streamtape.com";
  var targetUrl = iframeUrl.replace(/\/v\/([a-zA-Z0-9_-]+)/i, "/e/$1");

  try {
    var html = await fetchText(targetUrl, { "Referer": origin + "/" }, 8000);
    if (DEAD_FILE_RE.test(html)) return { dead: true };

    var m = html.match(/(?:robotlink|botlink|cphld|ideooLink)['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*([^;]+)/i);
    if (m) {
      var url = "https:" + m[1];
      var parts = m[2].split("+");
      for (var i = 0; i < parts.length; i++) {
        var chunk = parts[i].match(/['"]([^'"]+)['"]/);
        if (!chunk) continue;
        var value = chunk[1];
        var slices = parts[i].match(/substring\(\d+\)/g) || [];
        for (var j = 0; j < slices.length; j++) {
          value = value.substring(parseInt(slices[j].match(/\d+/)[0], 10));
        }
        url += value;
      }

      if (url && url.indexOf("http") === 0) {
        return {
          url: url,
          origin: "https://streamtape.com",
          headers: { "Referer": "https://streamtape.com/" }
        };
      }
    }

    var direct = extractFromHtml(html, origin);
    if (direct) return { url: direct, origin: origin };
  } catch (e) {}

  return null;
}

// 4. FileMoon (embed page, then the JSON API as backup)
async function resolveFileMoon(iframeUrl) {
  var codeMatch = iframeUrl.match(/\/(?:e|d)\/([a-zA-Z0-9_-]+)/i);
  var origin = originOf(iframeUrl) || "https://filemoon.to";

  try {
    var html = await fetchText(iframeUrl, { "Referer": origin + "/" }, 8000);
    if (!DEAD_FILE_RE.test(html)) {
      var streamUrl = extractFromHtml(html, origin);
      if (streamUrl) return { url: streamUrl, origin: origin };
    }
  } catch (e) {}

  if (codeMatch) {
    try {
      var data = await fetchJson(origin + "/api/v1/video?id=" + codeMatch[1], {
        "Referer": origin + "/"
      }, 8000);
      var apiUrl = normalizeUrl(data.hls || data.file || data.url || "", origin);
      if (isUsableStream(apiUrl)) return { url: apiUrl, origin: origin };
    } catch (eApi) {}
  }

  return null;
}

// 5. OK.ru (direct MP4 qualities or HLS manifest extraction)
async function resolveOkRu(iframeUrl) {
  var m = iframeUrl.match(/video(?:embed)?\/(\d+)/i);
  if (!m) return null;
  var vidId = m[1];

  try {
    var html = await fetchText("https://www.ok.ru/videoembed/" + vidId, {
      "Referer": BASE_URL + "/"
    }, 8000);

    if (DEAD_FILE_RE.test(html) || /видео заблокировано|video has been deleted|файл не найден/i.test(html)) {
      return { dead: true };
    }

    var optMatch = html.match(/data-options=["']([^"']+)["']/i);
    var metadata = null;

    if (optMatch) {
      try {
        var optJson = JSON.parse(decodeEntities(optMatch[1]));
        if (optJson && optJson.flashvars && optJson.flashvars.metadata) {
          metadata = typeof optJson.flashvars.metadata === "string"
            ? JSON.parse(optJson.flashvars.metadata)
            : optJson.flashvars.metadata;
        }
      } catch (eOpt) {}
    }

    if (!metadata) {
      try {
        metadata = await fetchJson("https://ok.ru/dk?cmd=videoPlayerMetadata&mid=" + vidId, {
          "Referer": "https://ok.ru/"
        }, 6000);
      } catch (eMeta) {}
    }

    if (metadata) {
      if (metadata.hlsManifestUrl && isUsableStream(metadata.hlsManifestUrl)) {
        return {
          url: metadata.hlsManifestUrl,
          origin: "https://ok.ru",
          quality: "1080p"
        };
      }

      if (Array.isArray(metadata.videos) && metadata.videos.length > 0) {
        var qMap = {
          ultra: 5,
          quad: 4,
          full: 3,
          hd: 2,
          sd: 1,
          low: 0,
          lowest: -1,
          mobile: -2
        };
        var qLabels = {
          ultra: "4K",
          quad: "1440p",
          full: "1080p",
          hd: "720p",
          sd: "480p",
          low: "360p",
          lowest: "240p",
          mobile: "144p"
        };

        var sorted = metadata.videos.slice().sort(function (a, b) {
          return (qMap[b.name] || 0) - (qMap[a.name] || 0);
        });

        for (var i = 0; i < sorted.length; i++) {
          if (sorted[i].url && sorted[i].url.indexOf("http") === 0) {
            return {
              url: sorted[i].url,
              origin: "https://ok.ru",
              quality: qLabels[sorted[i].name] || "720p"
            };
          }
        }
      }
    }
  } catch (e) {}

  return null;
}

// 6. VK / VKVideo
async function resolveVk(iframeUrl) {
  try {
    var html = await fetchText(iframeUrl, { "Referer": BASE_URL + "/" }, 8000);
    if (DEAD_FILE_RE.test(html)) return { dead: true };

    var hlsMatch = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (hlsMatch && isUsableStream(hlsMatch[1])) {
      return { url: hlsMatch[1].replace(/\\\//g, "/"), origin: "https://vkvideo.ru", quality: "1080p" };
    }

    var qList = ["url2160", "url1440", "url1080", "url720", "url480", "url360"];
    var labels = { url2160: "4K", url1440: "1440p", url1080: "1080p", url720: "720p", url480: "480p", url360: "360p" };
    for (var i = 0; i < qList.length; i++) {
      var re = new RegExp('"' + qList[i] + '"\\s*:\\s*"([^"]+)"', "i");
      var m = html.match(re);
      if (m && m[1]) {
        var u = m[1].replace(/\\\//g, "/");
        if (u.indexOf("http") === 0) {
          return { url: u, origin: "https://vkvideo.ru", quality: labels[qList[i]] || "720p" };
        }
      }
    }
  } catch (e) {}

  return null;
}

// 7. Uqload
async function resolveUqload(iframeUrl) {
  var origin = originOf(iframeUrl) || "https://uqload.io";
  try {
    var html = await fetchText(iframeUrl, { "Referer": BASE_URL + "/" }, 8000);
    var unpacked = unpackJs(html) || html;
    var m = unpacked.match(/sources:\s*\[\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i) ||
            unpacked.match(/https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*/i);
    if (m) {
      return { url: m[1] || m[0], origin: origin, quality: "1080p" };
    }
  } catch (e) {}
  return null;
}

// 8. Sendvid
async function resolveSendvid(iframeUrl) {
  var url = iframeUrl.includes("/embed/") ? iframeUrl : iframeUrl.replace(/sendvid\.com\/([a-z0-9]+)/i, "sendvid.com/embed/$1");
  try {
    var html = await fetchText(url, { "Referer": BASE_URL + "/" }, 8000);
    var m = html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i) ||
            html.match(/var\s+video_source\s*=\s*["']([^"']+)["']/i);
    if (m) {
      return { url: m[1], origin: "https://sendvid.com", quality: "720p" };
    }
  } catch (e) {}
  return null;
}

// 9. YourUpload
async function resolveYourUpload(iframeUrl) {
  try {
    var html = await fetchText(iframeUrl, { "Referer": BASE_URL + "/" }, 8000);
    var m = html.match(/file:\s*['"]([^'"]+\.mp4[^'"]*)['']/i) ||
            html.match(/og:video(?::secure_url)?[^"']+content=["']([^"']+)["']/i);
    if (m) {
      return { url: m[1], origin: "https://yourupload.com", quality: "720p" };
    }
  } catch (e) {}
  return null;
}

// Detect client-side redirect targets
function extractRedirectTarget(html, currentUrl) {
  var patterns = [
    /window\.location\.href\s*=\s*['"]([^'"]+)['"]/i,
    /window\.location\.replace\(\s*['"]([^'"]+)['"]\s*\)/i,
    /window\.location\.assign\(\s*['"]([^'"]+)['"]\s*\)/i,
    /location\.href\s*=\s*['"]([^'"]+)['"]/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>\s]+)/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = html.match(patterns[i]);
    if (m && m[1]) {
      var target = normalizeUrl(decodeEntities(m[1]), currentUrl);
      if (target && target !== currentUrl) return target;
    }
  }
  return null;
}

// 10. Generic embed resolver (follows JS / meta redirects and nested iframes)
async function resolveGenericEmbed(iframeUrl, depth) {
  var level = depth || 0;
  var url = normalizeUrl(iframeUrl, BASE_URL);
  if (!url || url.indexOf("http") !== 0) return null;
  var origin = originOf(url);

  try {
    var html = await fetchText(url, { "Referer": BASE_URL + "/", "Origin": origin }, 8000);
    if (DEAD_FILE_RE.test(html)) return { dead: true };

    var streamUrl = extractFromHtml(html, origin);
    if (streamUrl) return { url: streamUrl, origin: origin };

    if (level < 2) {
      var inner = extractIframeSrc(html) || extractRedirectTarget(html, url);
      if (inner) {
        var nextUrl = cleanEmbedUrl(inner, url);
        if (nextUrl && nextUrl !== url) {
          var resInner = await resolveEmbed(nextUrl, level + 1);
          if (resInner) return resInner;
        }
      }
    }

    var apiMatch = html.match(/["'](https?:\/\/[^"']*(?:sources?|playlist|master)[^"']*\.(?:m3u8|mp4)[^"']*)["']/i);
    if (apiMatch) {
      var apiUrl = apiMatch[1].replace(/\\\//g, "/");
      if (isUsableStream(apiUrl)) return { url: apiUrl, origin: originOf(apiUrl) || origin };
    }
  } catch (e) {}

  return null;
}

// Master dispatch
async function resolveEmbed(url, depth) {
  var host = hostOf(url);

  if (STREAMWISH_HOSTS.test(host)) {
    var sw = await resolveStreamWish(url);
    if (sw) return sw;
  }
  if (VIDHIDE_HOSTS.test(host)) {
    var vh = await resolveVidHide(url);
    if (vh) return vh;
  }
  if (STREAMTAPE_HOSTS.test(host)) {
    var st = await resolveStreamTape(url);
    if (st) return st;
  }
  if (FILEMOON_HOSTS.test(host)) {
    var fm = await resolveFileMoon(url);
    if (fm) return fm;
  }
  if (/ok\.ru|odnoklassniki/i.test(host)) {
    var ok = await resolveOkRu(url);
    if (ok) return ok;
  }
  if (/vkvideo\.ru|vk\.com/i.test(host)) {
    var vk = await resolveVk(url);
    if (vk) return vk;
  }
  if (/uqload/i.test(host)) {
    var uq = await resolveUqload(url);
    if (uq) return uq;
  }
  if (/sendvid/i.test(host)) {
    var sv = await resolveSendvid(url);
    if (sv) return sv;
  }
  if (/yourupload/i.test(host)) {
    var yu = await resolveYourUpload(url);
    if (yu) return yu;
  }

  return resolveGenericEmbed(url, depth || 0);
}

// ─── Stream Formatting & Quality ─────────────────────────────────────────────

function bucketQuality(height) {
  if (height >= 2000) return "4K";
  if (height >= 1300) return "1440p";
  if (height >= 900) return "1080p";
  if (height >= 600) return "720p";
  if (height >= 400) return "480p";
  if (height >= 300) return "360p";
  return "Auto";
}

function normalizeQualityLabel(value) {
  var q = String(value || "").toLowerCase();
  if (!q) return "Auto";
  if (/2160|4k|uhd/.test(q)) return "4K";
  if (/1440|2k|qhd/.test(q)) return "1440p";
  if (/1080|fhd/.test(q)) return "1080p";
  if (/720|hd\b/.test(q)) return "720p";
  if (/480|sd\b/.test(q)) return "480p";
  if (/360/.test(q)) return "360p";
  var m = q.match(/(\d{3,4})p/);
  if (m) return bucketQuality(parseInt(m[1], 10));
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

async function inferQuality(url, headers, fallback) {
  var known = normalizeQualityLabel(fallback);
  if (known !== "Auto") return known;

  if (!/\.m3u8(\?|$)/i.test(url)) {
    var qMatch = url.match(/(2160|1440|1080|720|480|360)p?/i);
    return qMatch ? normalizeQualityLabel(qMatch[1]) : "1080p";
  }

  var referers = [originOf(url) + "/"];
  if (headers && headers.Referer && headers.Referer !== referers[0]) referers.push(headers.Referer);

  for (var i = 0; i < referers.length; i++) {
    try {
      var text = await fetchText(url, {
        "User-Agent": UA,
        "Referer": referers[i]
      }, 3500);
      var best = 0;
      var re = /RESOLUTION=\d+x(\d+)/gi;
      var m;
      while ((m = re.exec(text))) {
        var h = parseInt(m[1], 10);
        if (h > best) best = h;
      }
      if (best) return bucketQuality(best);
    } catch (e) {}
  }
  return "1080p";
}

// Media verification
async function servesMedia(url, headers) {
  if (/\.m3u8(\?|$)/i.test(url)) return true;
  try {
    var res = await fetchWithTimeout(url, {
      method: "HEAD",
      headers: headers
    }, 4000);

    if (!res.ok) {
      res = await fetchWithTimeout(url, {
        headers: Object.assign({}, headers, { "Range": "bytes=0-1" })
      }, 4000);
    }

    var ct = (res.headers.get("content-type") || "").toLowerCase();
    try {
      if (res.body && res.body.cancel) res.body.cancel().catch(function () {});
    } catch (eBody) {}

    if (/html|text\/plain/.test(ct)) return false;
    return /mpegurl|video\/|audio\/|application\/octet-stream|mp4|matroska|quicktime|binary/.test(ct) || res.ok;
  } catch (e) {
    return PLAYABLE_EXT.test(url) || url.indexOf("get_video") !== -1;
  }
}

function formatServerName(rawServer, url) {
  var s = String(rawServer || "").trim();
  var h = hostOf(url).replace(/^www\./, "");

  if (/streamhg|hanerix|hgcloud|uasopt|bysezoxexe|swdyu|streamwish|obeywish|playerwish|hlswish/i.test(s) || /streamwish|obeywish|hgcloud|hanerix|bysezoxexe|uasopt/i.test(h)) return "StreamWish";
  if (/vidhide|morencius|minochinos|earnvids?|callistanise|dingtezuni|filelions/i.test(s) || /vidhide|morencius|minochinos|filelions/i.test(h)) return "VidHide";
  if (/abyss/i.test(s) || /abyssplayer/i.test(h)) return "AbyssPlayer";
  if (/streamtape|stape/i.test(s) || /streamtape|stape/i.test(h)) return "StreamTape";
  if (/filemoon|moonplayer/i.test(s) || /filemoon|moonplayer/i.test(h)) return "FileMoon";
  if (/ok\.?ru|ok\b/i.test(s) || /ok\.ru/i.test(h)) return "OK.ru";
  if (/vkvideo|vk\.com|vk\b/i.test(s) || /vkvideo|vk\.com/i.test(h)) return "VK";
  if (/uqload/i.test(s) || /uqload/i.test(h)) return "Uqload";
  if (/sendvid/i.test(s) || /sendvid/i.test(h)) return "Sendvid";
  if (/yourupload/i.test(s) || /yourupload/i.test(h)) return "YourUpload";
  if (/dood/i.test(s) || /dood/i.test(h)) return "DoodStream";

  var clean = s.replace(/دۆبلاژ|ژێرنوس|ژێرنووس|کوردی|کورد|سێرڤەری?|سیرڤەر|بینین/g, "").trim();
  if (clean) return clean.charAt(0).toUpperCase() + clean.slice(1);
  return h.split(".")[0].toUpperCase() || "Server";
}

function makeStream(resolved, streamTitle, quality, label, isDirect, isDub) {
  var referer = (resolved && resolved.headers && resolved.headers.Referer) ||
                (resolved.origin ? resolved.origin + "/" : BASE_URL + "/");
  var dubTag = isDub ? "KU Dub" : "KU Sub";
  var typeTag = isDirect ? "" : " · Embed";

  return {
    name: PROVIDER_NAME + " [" + label + typeTag + " · " + dubTag + "]",
    title: streamTitle + " · " + quality,
    url: resolved.url,
    quality: quality,
    isDirect: !!isDirect,
    isDub: !!isDub,
    headers: {
      "User-Agent": UA,
      "Referer": referer,
      "Origin": resolved.origin || BASE_URL
    },
    subtitles: (resolved && resolved.subtitles) || []
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

    var entry = await findDoblajEntry(tmdbInfo, isMovie);
    if (!entry) {
      console.log("[" + PROVIDER_NAME + "] No Kurdish dubbed match found");
      return [];
    }
    console.log("[" + PROVIDER_NAME + "] Matched: " + entry.item.name + " -> " + entry.item.url);

    var videos = isMovie
      ? await getMovieSources(entry.html)
      : await getEpisodeSources(entry.html, s, e);

    if (!videos.length) {
      console.log("[" + PROVIDER_NAME + "] No playable servers for this request");
      return [];
    }

    var streamTitle = (tmdbInfo.title || entry.item.name) +
      (isMovie ? "" : " S" + pad2(s) + "E" + pad2(e)) +
      (tmdbInfo.year ? " (" + tmdbInfo.year + ")" : "");

    console.log("[" + PROVIDER_NAME + "] Servers (" + videos.length + "): " +
      videos.map(function (v) { return formatServerName(v.server, v.url); }).join(", "));

    var resolvedList = await Promise.all(videos.map(async function (video) {
      try {
        var resolved = await resolveEmbed(video.url);
        if (resolved) return { resolved: resolved, video: video };
      } catch (err) {
        console.log("[" + PROVIDER_NAME + "] " + formatServerName(video.server, video.url) + " error: " + err.message);
      }
      return null;
    }));

    var streams = [];
    var seenUrls = {};
    var solvedVideos = {};
    var deadVideos = {};
    var pending = [];

    for (var i = 0; i < resolvedList.length; i++) {
      var item = resolvedList[i];
      if (!item) continue;

      var resolved = item.resolved;
      if (resolved.dead) {
        deadVideos[item.video.url] = true;
        solvedVideos[item.video.url] = true;
        console.log("[" + PROVIDER_NAME + "] " + formatServerName(item.video.server, item.video.url) + " -> upload removed, skipped");
        continue;
      }

      if (seenUrls[resolved.url]) continue;
      seenUrls[resolved.url] = true;
      solvedVideos[item.video.url] = true;

      pending.push({
        resolved: resolved,
        video: item.video,
        isDirect: !!isUsableStream(resolved.url)
      });
    }

    // Verify media & determine qualities in parallel
    var directStreams = (await Promise.all(pending.map(async function (p) {
      var headers = {
        "User-Agent": UA,
        "Referer": (p.resolved.origin || BASE_URL) + "/"
      };

      if (!(await servesMedia(p.resolved.url, headers))) {
        delete seenUrls[p.resolved.url];
        delete solvedVideos[p.video.url];
        console.log("[" + PROVIDER_NAME + "] " + formatServerName(p.video.server, p.video.url) + " -> not playable media, kept as embed");
        return null;
      }

      var fallbackQuality = p.resolved.quality || p.video.quality;
      var quality = await inferQuality(p.resolved.url, headers, fallbackQuality);
      var sLabel = formatServerName(p.video.server, p.video.url);

      console.log("[" + PROVIDER_NAME + "] " + sLabel + " (" + quality + ") -> " +
        p.resolved.url.slice(0, 90) + "...");

      return makeStream(p.resolved, streamTitle, quality, sLabel, p.isDirect, p.video.isDub);
    }))).filter(Boolean);

    streams = streams.concat(directStreams);

    // Unresolved embeds are offered as web embeds so in-app player can display them
    for (var j = 0; j < videos.length; j++) {
      var v = videos[j];
      if (deadVideos[v.url] || solvedVideos[v.url] || seenUrls[v.url]) continue;
      seenUrls[v.url] = true;

      var embedQuality = normalizeQualityLabel(v.quality);
      var embLabel = formatServerName(v.server, v.url);

      streams.push(makeStream(
        { url: v.url, origin: originOf(v.url) || BASE_URL },
        streamTitle,
        embedQuality,
        embLabel,
        false,
        v.isDub
      ));
    }

    // Sort: Dubbed first, Direct first, Quality descending
    streams.sort(function (a, b) {
      if (a.isDub !== b.isDub) return a.isDub ? -1 : 1;
      if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
      return (QUALITY_ORDER[b.quality] || -1) - (QUALITY_ORDER[a.quality] || -1);
    });

    var finalStreams = [];
    var finalSeen = {};
    for (var k = 0; k < streams.length; k++) {
      var st = streams[k];
      delete st.isDirect;
      delete st.isDub;
      if (!st.url || finalSeen[st.url]) continue;
      finalSeen[st.url] = true;
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
