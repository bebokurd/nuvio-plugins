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
var DOBLAJ_GENRE_RE = /(^|-)(all-)?doblaj(-|$)/;

// Players that only work inside a browser (their manifests are built by page JS)
var EMBED_ONLY_HOSTS = /abyssplayer|ok\.ru|vkvideo|vk\.com\/video/i;

// Playable media extensions
var PLAYABLE_EXT = /\.(m3u8|mp4|mkv)(\?|$)/i;

// Server pages that report an unavailable upload
var DEAD_FILE_RE = /file is no longer available|no longer available|video (?:has been )?(?:deleted|removed)|expired or has been deleted/i;

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
    "Accept-Language": "en-US,ckb;q=0.9"
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

function cleanTitle(str) {
  return (str || "")
    .replace(/[\u064B-\u0652]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractIframeSrc(html) {
  var m = html.match(/<iframe[^>]*\bsrc=["']([^"']+)["']/i);
  return m ? m[1].trim() : "";
}

// ─── Dean Edwards Packer Unpacker ────────────────────────────────────────────

function unpackJs(code) {
  try {
    var m = code.match(/eval\(function\(p,a,c,k,e,[rd]\)\{.*?\}\s*\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
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
  var it = cleanTitle(item.name);
  if (!it) return 0;

  var yearOk = !expectedYear || !item.year || item.year === String(expectedYear);

  var best = 0;
  for (var i = 0; i < expectedTitles.length; i++) {
    var et = cleanTitle(expectedTitles[i]);
    if (!et) continue;
    if (it === et && yearOk) return 100;
    if (it.indexOf(et) !== -1 || et.indexOf(it) !== -1) {
      best = Math.max(best, yearOk ? 85 : 55);
      continue;
    }
    var etTokens = et.split(" ").filter(function (t) { return t.length > 2; });
    if (!etTokens.length) continue;
    var hits = etTokens.filter(function (t) { return it.indexOf(t) !== -1; }).length;
    if (hits === etTokens.length) best = Math.max(best, yearOk ? 80 : 50);
    else if (hits >= etTokens.length - 1 && hits > 0) best = Math.max(best, yearOk ? 65 : 40);
  }
  return best;
}

function hasDoblajGenre(html) {
  var block = (String(html || "").match(/<div class="sgeneros">([\s\S]{0,1200}?)<\/div>/i) || [])[1];
  if (block === undefined) return false;
  var genres = (block.match(/\/genre\/([a-z0-9-]+)\//gi) || []).map(function (g) {
    return g.match(/\/genre\/([a-z0-9-]+)/i)[1];
  });
  for (var i = 0; i < genres.length; i++) {
    if (DOBLAJ_GENRE_RE.test(genres[i])) return true;
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
      if (scored[k].score < 65) break;

      var html = await getItemPage(scored[k].item.url);
      if (!html) continue;
      if (!hasDoblajGenre(html)) {
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
    var embed = normalizeUrl((data && (data.embed_url || data.url || data.src)) || "", BASE_URL);
    if (!embed || embed.indexOf("http") !== 0) return null;
    if (/youtu\.?be|youtube\.com/i.test(embed)) return null;

    return {
      server: option.server,
      quality: option.server,
      url: embed
    };
  } catch (e) {
    return null;
  }
}

// Find the episode page for a requested season/episode pair
function findEpisodeUrl(showHtml, season, episode) {
  var re = /href=["'](https?:\/\/www\.kurd-movie\.com\/episodes?\/[^"'#?]+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi;
  var m;
  var fallback = "";

  while ((m = re.exec(showHtml))) {
    var url = m[1];
    var slug = url.substring(url.lastIndexOf("/") + 1);
    var se = slug.match(/(\d+)[x-](\d+)$/);
    if (!se) continue;

    if (Number(se[1]) === Number(season) && Number(se[2]) === Number(episode)) return url;
    if (!fallback && Number(se[1]) === Number(season)) fallback = url;
  }

  // Some uploads only expose the first playable episode of a season
  if (fallback) return fallback;
  return "";
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

// 1. StreamWish family (HgCloud, HgLink, Hanerix, UasOpt, ByseZoxexe, ObeyWish, ...)
var STREAMWISH_HOSTS = /streamwish|obeywish|playerwish|jodwish|strwish|sfastwish|hlswish|swishsrv|audinifer|wishembed|hgcloud|hglink|hanerix|swdyu|swishhub|filesb|buzzfile|1oxa|streamhie|uasopt|bingezove|bysezoxexe|davioad|wishstream|awish/i;

async function resolveStreamWish(iframeUrl) {
  var codeMatch = iframeUrl.match(/\/(?:e|f)\/([a-zA-Z0-9_-]+)/);
  if (!codeMatch) return null;
  var fileCode = codeMatch[1];
  var ownOrigin = originOf(iframeUrl);

  var mirrors = [
    "https://obeywish.com",
    ownOrigin,
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

      // the mirrors share one backend, so their verdict covers the whole family
      if (DEAD_FILE_RE.test(html)) {
        deadSeen = true;
        continue;
      }

      var streamUrl = extractFromHtml(html, origin);
      if (streamUrl) return { url: streamUrl, origin: origin };
    } catch (e) {}
  }

  // Some mirrors expose the download route only
  if (ownOrigin) {
    try {
      var html2 = await fetchText(ownOrigin + "/f/" + fileCode, { "Referer": ownOrigin + "/" }, 7000);
      answered++;
      if (DEAD_FILE_RE.test(html2)) deadSeen = true;
      else {
        var s2 = extractFromHtml(html2, ownOrigin);
        if (s2) return { url: s2, origin: ownOrigin };
      }
    } catch (e) {}
  }

  // The upload is reported as removed, so it is not worth offering
  return (answered > 0 && deadSeen) ? { dead: true } : null;
}

// 2. VidHide family (Morencius, Minochinos, Dingtezuni, Bingezove, FileLions, ...)
var VIDHIDE_HOSTS = /vidhide|filelions|morencius|minochinos|dingtezuni|dintezuvio|callistanise|guccihide|fviplions|megacloud|blackcdn|bingezove/i;

async function resolveVidHide(iframeUrl) {
  var origin = originOf(iframeUrl);
  if (!origin) return null;
  try {
    var html = await fetchText(iframeUrl, {
      "Referer": origin + "/",
      "Origin": origin
    }, 8000);
    if (DEAD_FILE_RE.test(html)) return { dead: true };
    var streamUrl = extractFromHtml(html, origin);
    if (streamUrl) return { url: streamUrl, origin: origin };
  } catch (e) {}
  return null;
}

// 3. StreamTape (link is assembled from document.write fragments, then exposed by get_video)
async function resolveStreamTape(iframeUrl) {
  var origin = originOf(iframeUrl) || "https://streamtape.com";
  try {
    var html = await fetchText(iframeUrl, { "Referer": origin + "/" }, 8000);
    if (DEAD_FILE_RE.test(html)) return null;

    var robot = html.match(/robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*([^;]+)/);
    if (robot) {
      var url = "https:" + robot[1];
      var parts = robot[2].split("+");
      for (var i = 0; i < parts.length; i++) {
        var chunk = parts[i].match(/['"]([^'"]+)['"]/);
        if (!chunk) continue;
        var value = chunk[1];
        // the page slices the same string several times, so apply every call in order
        var slices = parts[i].match(/substring\(\d+\)/g) || [];
        for (var j = 0; j < slices.length; j++) {
          value = value.substring(parseInt(slices[j].match(/\d+/)[0], 10));
        }
        url += value;
      }

      if (isUsableStream(url)) return { url: url, origin: origin };

      try {
        var res = await fetchWithTimeout(url, {
          headers: { "Referer": origin + "/", "X-Requested-With": "XMLHttpRequest" }
        }, 6000);
        var location = res.headers.get("location") || "";
        if (isUsableStream(location)) return { url: location, origin: origin };

        var body = (await res.text()).trim().replace(/^["']|["']$/g, "");
        if (isUsableStream(body)) return { url: body, origin: origin };
      } catch (e2) {}
    }

    var direct = extractFromHtml(html, origin);
    if (direct) return { url: direct, origin: origin };
  } catch (e) {}
  return null;
}

// 4. FileMoon (embed page, then the JSON API as backup)
async function resolveFileMoon(iframeUrl) {
  var codeMatch = iframeUrl.match(/\/e\/([a-zA-Z0-9]+)/i);
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
    } catch (e) {}
  }

  return null;
}

// Detect the client-side redirect targets some players use
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

// 5. Generic embed resolver (follows JS / meta redirects and nested iframes)
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

    if (level < 3) {
      var inner = extractIframeSrc(html) || extractRedirectTarget(html, url);
      if (inner) {
        var nextUrl = normalizeUrl(inner, url);
        if (nextUrl && nextUrl !== url) {
          var resInner = await resolveGenericEmbed(nextUrl, level + 1);
          if (resInner) return resInner;
        }
      }
    }

    // json based players that expose the manifest through a separate endpoint
    var apiMatch = html.match(/["'](https?:\/\/[^"']*(?:sources?|playlist|master)[^"']*\.(?:m3u8|mp4)[^"']*)["']/i);
    if (apiMatch) {
      var apiUrl = apiMatch[1].replace(/\\\//g, "/");
      if (isUsableStream(apiUrl)) return { url: apiUrl, origin: originOf(apiUrl) || origin };
    }

    // Fresh StreamWish aliases keep the /e/<code> route, so try the mirror chain
    if (level === 0 && /\/(?:e|f)\/[a-zA-Z0-9_-]+/.test(url)) {
      var aliased = await resolveStreamWish(url);
      if (aliased) return aliased;
    }
  } catch (e) {}

  return null;
}

// Master dispatch
async function resolveEmbed(url) {
  var host = hostOf(url);

  // ok.ru, abyss and vk build their manifests in the browser, so keep the embed as-is
  if (EMBED_ONLY_HOSTS.test(host)) return null;

  if (STREAMWISH_HOSTS.test(host)) {
    var sw = await resolveStreamWish(url);
    if (sw) return sw;
  }
  if (VIDHIDE_HOSTS.test(host)) {
    var vh = await resolveVidHide(url);
    if (vh) return vh;
  }
  if (/streamtape|stape/i.test(host)) {
    var st = await resolveStreamTape(url);
    if (st) return st;
  }
  if (/filemoon|moonplayer/i.test(host)) {
    var fm = await resolveFileMoon(url);
    if (fm) return fm;
  }

  return resolveGenericEmbed(url, 0);
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
  if (/1440|2k/.test(q)) return "1440p";
  if (/1080|qhd|fhd/.test(q)) return "1080p";
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
  if (!/\.m3u8(\?|$)/i.test(url)) {
    if (known !== "Auto") return known;
    var qMatch = url.match(/(2160|1440|1080|720|480|360)p?/i);
    return qMatch ? qMatch[1] + "p" : "720p";
  }

  // Some CDNs only serve the manifest for their own origin, others need the embed origin
  var referers = [originOf(url) + "/"];
  if (headers && headers.Referer && headers.Referer !== referers[0]) referers.push(headers.Referer);

  for (var i = 0; i < referers.length; i++) {
    try {
      var text = await fetchText(url, {
        "User-Agent": UA,
        "Referer": referers[i]
      }, 4500);
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
  return known !== "Auto" ? known : "720p";
}

// Some players hand back their own page (or an HTML error) instead of media
async function servesMedia(url, headers) {
  if (/\.m3u8(\?|$)/i.test(url)) return true;
  try {
    var res = await fetchWithTimeout(url, { headers: headers }, 7000);
    var ct = (res.headers.get("content-type") || "").toLowerCase();
    try {
      if (res.body && res.body.cancel) {
        res.body.cancel().catch(function () {});
      }
    } catch (e) {}
    return /mpegurl|video\/|audio\/|application\/octet-stream|mp4|matroska|quicktime/.test(ct);
  } catch (e) {
    return false;
  }
}

function serverLabel(video) {
  var name = String(video.server || "").trim();
  if (!name) {
    var host = hostOf(video.url).replace(/^www\./, "");
    name = host.split(".")[0];
  }
  return name;
}

function makeStream(resolved, streamTitle, quality, label, direct) {
  var referer = resolved.origin ? resolved.origin + "/" : BASE_URL + "/";
  return {
    name: PROVIDER_NAME + " [" + label + (direct ? "" : " · KU Dub") + "]",
    title: streamTitle + " · " + quality,
    url: resolved.url,
    quality: quality,
    isDirect: !!direct,
    headers: {
      "User-Agent": UA,
      "Referer": referer,
      "Origin": resolved.origin || BASE_URL
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

    console.log("[" + PROVIDER_NAME + "] Servers: " +
      videos.map(function (v) { return serverLabel(v); }).join(", "));

    var resolvedList = await Promise.all(videos.map(async function (video) {
      try {
        var resolved = await resolveEmbed(video.url);
        if (resolved) return { resolved: resolved, video: video };
      } catch (err) {
        console.log("[" + PROVIDER_NAME + "] " + serverLabel(video) + " resolver error: " + err.message);
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
        console.log("[" + PROVIDER_NAME + "] " + serverLabel(item.video) + " -> upload removed, skipped");
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

    // Measuring real resolutions hits the network, so do it in parallel
    streams = (await Promise.all(pending.map(async function (p) {
      var headers = {
        "User-Agent": UA,
        "Referer": (p.resolved.origin || BASE_URL) + "/"
      };

      if (!(await servesMedia(p.resolved.url, headers))) {
        // The resolver only found the player page, so let the in-app player handle it
        delete seenUrls[p.resolved.url];
        delete solvedVideos[p.video.url];
        console.log("[" + PROVIDER_NAME + "] " + serverLabel(p.video) + " -> answered with a page, kept as embed");
        return null;
      }

      var quality = await inferQuality(p.resolved.url, headers, p.video.quality);

      console.log("[" + PROVIDER_NAME + "] " + serverLabel(p.video) + " (" + quality + ") -> " +
        p.resolved.url.slice(0, 90) + "...");

      return makeStream(p.resolved, streamTitle, quality, serverLabel(p.video), p.isDirect);
    }))).filter(Boolean);

    // Unresolved embeds are still offered so the in-app player can try them
    for (var j = 0; j < videos.length; j++) {
      var v = videos[j];
      if (deadVideos[v.url] || solvedVideos[v.url] || seenUrls[v.url]) continue;
      seenUrls[v.url] = true;
      streams.push({
        name: PROVIDER_NAME + " [" + serverLabel(v) + " · Embed]",
        title: streamTitle + " · " + normalizeQualityLabel(v.quality),
        url: v.url,
        quality: normalizeQualityLabel(v.quality),
        isDirect: false,
        headers: {
          "User-Agent": UA,
          "Referer": BASE_URL + "/",
          "Origin": originOf(v.url) || BASE_URL
        },
        subtitles: []
      });
    }

    streams.sort(function (a, b) {
      if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
      return (QUALITY_ORDER[b.quality] || -1) - (QUALITY_ORDER[a.quality] || -1);
    });
    streams.forEach(function (st) { delete st.isDirect; });

    console.log("[" + PROVIDER_NAME + "] Done: " + streams.length + " stream(s)");
    return streams;

  } catch (err) {
    console.error("[" + PROVIDER_NAME + "] Fatal: " + err.message);
    return [];
  }
}

module.exports = { getStreams };
