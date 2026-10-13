/**
 * handlers/downloader/index.js
 *
 * Self contained torrent service. Nothing in here needs express: every
 * function except stream() takes and returns plain data, so it can be mounted
 * on any router.
 *
 *   search(query, options)                -> Promise<Result[]>
 *   stream(magnet, req, res, options)     -> Promise<File>
 *   downloadAndTranscode(magnet, minutes) -> Promise<Result>
 *   getProgress(magnet?)                  -> Progress | Progress[]
 *   heartbeat(magnet)                     -> { ok, status, expiresIn }
 *   cancel(magnet, { deleteFiles })       -> Promise<boolean>
 *
 * Everything is stored under <cwd>/downloads. A torrent is torn down (and its
 * data deleted) when no heartbeat() arrives within the timeout, so callers
 * must ping heartbeat() while a player is actually consuming the file.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { path as ffmpegBinary } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobeBinary } from '@ffprobe-installer/ffprobe';
import ffmpeg from 'fluent-ffmpeg';
import nodeCache from 'node-cache';
import TorrentSearchApi from 'torrent-search-api';
import WebTorrent from 'webtorrent';

ffmpeg.setFfmpegPath(ffmpegBinary);
ffmpeg.setFfprobePath(ffprobeBinary);

/* ------------------------------------------------------------------ *
 * configuration
 * ------------------------------------------------------------------ */

const MB = 1024 * 1024;

export const DOWNLOADS_DIR = path.resolve(process.cwd(), 'downloads');

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Minutes of silence before a job is cancelled and its data deleted. */
export const DEFAULT_TIMEOUT_MIN = toPositiveInt(process.env.DOWNLOADER_TIMEOUT_MIN, 10);
/** Minutes a finished/failed job stays in memory for status polling. */
const JOB_RETENTION_MIN = toPositiveInt(process.env.DOWNLOADER_RETENTION_MIN, 60);
/** Minutes search results (magnets included) stay cached. */
const SEARCH_CACHE_MIN = toPositiveInt(process.env.DOWNLOADER_SEARCH_CACHE_MIN, 60);

/** Only the top N ranked hits get a magnet resolved - that part is slow. */
const MAGNET_TOP_N = 12;
const MAGNET_CONCURRENCY = 4;

/** Hard timeout for the torrent metadata handshake. */
const METADATA_TIMEOUT_MS = 60_000;

const EXTRA_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'http://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:80/announce',
];

const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.avi', '.mov', '.webm', '.m4v',
  '.mpg', '.mpeg', '.ts', '.wmv', '.flv',
]);

const IGNORED_EXTENSIONS = new Set([
  '.nfo', '.txt', '.jpg', '.jpeg', '.png', '.gif', '.bmp',
  '.sfv', '.srt', '.sub', '.idx', '.ass', '.ssa', '.vtt', '.smi',
  '.7z', '.rar', '.zip', '.exe', '.iso', '.mka',
]);

/** Subtitle sidecars kept alongside the video (never picked as the main video). */
export const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa']);

/** Files that look like video but are never the one you want to play. */
const JUNK_NAME_RE = /(^|[\s._-])(sample|trailer|teaser|proof|preview|featurette)([\s._-]|$)/i;

/** Release names advertising lossless or lossy-atmos audio. */
const TRANSCODE_NAME_RE = /(ddp|dd\+|eac3|e-ac3|truehd|atmos|dts[\s._-]?(hd|ma|x)|[\s._-]ac3[\s._-])/i;

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
};

/* ------------------------------------------------------------------ *
 * module state
 * ------------------------------------------------------------------ */

const searchCache = new nodeCache({ stdTTL: SEARCH_CACHE_MIN * 60, checkPeriod: 600 });

/** jobKey -> job */
const jobs = new Map();

/** infoHash -> webtorrent torrent (the same magnet gets spelled many ways) */
const torrentIndex = new Map();

export const client = new WebTorrent();

ensureDownloadsDir();

try {
  TorrentSearchApi.enableProvider('ThePirateBay');
  TorrentSearchApi.enableProvider('1337x');
  TorrentSearchApi.enableProvider('Limetorrents');
} catch (err) {
  console.error('[search] failed to enable search providers:', err.message);
}

// No process-level error handler here on purpose: one would swallow real bugs
// and leave the process alive in a zombie state. stream() attaches its own
// handlers to the response and the torrent stream instead.

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

function ensureDownloadsDir() {
  if (!existsSync(DOWNLOADS_DIR)) mkdirSync(DOWNLOADS_DIR, { recursive: true });
  return DOWNLOADS_DIR;
}

function getMimeType(fileName) {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Lowercase, strip punctuation, collapse spaces - for fuzzy title matching. */
export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[._\-+]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `1.4 GB` / `1,200 MB` / `734003200` -> bytes (0 when unparseable).
 * Trackers label binary multiples as MB/GB, so those are read as MiB/GiB -
 * that keeps the result comparable with the MB thresholds used when ranking.
 */
export function parseSize(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const units = {
    b: 1, k: 1024, kb: 1024, kib: 1024,
    m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
    g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
    t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
  };
  const match = String(value).replace(/,/g, '').match(/([\d.]+)\s*([a-zA-Z]*)/);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * (units[match[2].toLowerCase()] ?? 1));
}

/** Infohash out of a magnet, or null. */
export function getInfoHash(magnet) {
  if (!magnet) return null;
  const match = String(magnet).match(/urn:btih:([A-Za-z0-9]+)/i);
  if (!match) return null;
  return match[1].toLowerCase();
}

/** True when a release name suggests audio browsers cannot play. */
export function needsTranscode(name) {
  return TRANSCODE_NAME_RE.test(String(name || ''));
}

/** Key a job by infohash so `{&tr=...}` variants collapse into one job. */
function jobKeyFor(magnet) {
  return getInfoHash(magnet) || createHash('sha1').update(String(magnet)).digest('hex');
}

function isVideoFile(name) {
  return VIDEO_EXTENSIONS.has(path.extname(String(name || '')).toLowerCase());
}

function isJunkName(name) {
  return JUNK_NAME_RE.test(path.basename(String(name || '')));
}

function isSubtitleFile(name) {
  return SUBTITLE_EXTENSIONS.has(path.extname(String(name || '')).toLowerCase());
}

/** code -> filename tokens that signal it (checked as whole tokens, not substrings). */
const SUBTITLE_LANG_ALIASES = [
  ['en', ['english', 'eng', 'en']],
  ['es', ['spanish', 'espanol', 'español', 'esp', 'spa', 'es']],
  ['fr', ['french', 'francais', 'français', 'fra', 'fre', 'fr']],
  ['de', ['german', 'deutsch', 'ger', 'deu', 'de']],
  ['it', ['italian', 'ita', 'it']],
  ['pt', ['portuguese', 'portugues', 'por', 'pt']],
  ['nl', ['dutch', 'nederlands', 'dut', 'nld', 'nl']],
  ['pl', ['polish', 'pol', 'pl']],
  ['ru', ['russian', 'rus', 'ru']],
  ['ar', ['arabic', 'ara', 'ar']],
  ['tr', ['turkish', 'tur', 'tr']],
  ['hi', ['hindi', 'hin', 'hi']],
  ['ja', ['japanese', 'jpn', 'ja', 'jp']],
  ['ko', ['korean', 'kor', 'ko', 'kr']],
  ['zh', ['chinese', 'chi', 'zho', 'zh', 'cn']],
];

/**
 * Guess a subtitle language code from a sidecar file name, e.g.
 * "Show.en.srt" -> "en", "Show.SPANISH.srt" -> "es".
 * @returns {string} ISO-ish code, or "unknown".
 */
export function guessSubtitleLang(fileName) {
  const tokens = new Set(
    String(fileName || '')
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .split(/[^a-z0-9\u00e0-\u00ff]+/)
      .filter(Boolean),
  );
  for (const [code, aliases] of SUBTITLE_LANG_ALIASES) {
    for (const alias of aliases) {
      if (tokens.has(alias)) return code;
    }
  }
  return 'unknown';
}

/**
 * Minimal SRT -> WebVTT conversion: comma timestamps become dots and the
 * required "WEBVTT" header is added. .vtt input passes through untouched.
 */
export function srtToVtt(srtText) {
  const body = String(srtText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim();
  if (!body) return 'WEBVTT\n\n';
  return `WEBVTT\n\n${body}\n`;
}

function sanitizeFileName(name) {
  return String(name || 'video')
    .replace(/[\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Parse a single-range `Range: bytes=...` header.
 * @returns {{start:number,end:number}|'unsatisfiable'|null} null = no/invalid header.
 */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;

  if (rawStart === '') {
    // bytes=-500 -> last 500 bytes
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
  }

  if (!Number.isFinite(start) || start < 0 || start >= size) return 'unsatisfiable';
  if (!Number.isFinite(end) || end >= size) end = size - 1;
  if (end < start) return 'unsatisfiable';

  return { start, end };
}

/* ------------------------------------------------------------------ *
 * ranking
 * ------------------------------------------------------------------ */

const QUALITY_LADDER = ['480p', '720p', '1080p', '2160p'];
const DEFAULT_QUALITY = '1080p';

const SOURCE_SCORES = {
  cam: -60,
  screener: -45,
  dvd: 0,
  hdtv: 6,
  bluray: 8,
  remux: -5,
  web: 15,
  unknown: 0,
};

const JUNK_TITLE_RE = /\b(xxx|pron|porn|camrip\s+trial|trailer\s*\d*\s*min|full\s+movie\s+inside)\b/i;

function detectQuality(title) {
  const text = String(title || '').toLowerCase();
  if (/\b(2160p|4k|uhd)\b/.test(text)) return '2160p';
  if (/\b1080[pi]\b/.test(text)) return '1080p';
  if (/\b720[pi]\b/.test(text)) return '720p';
  if (/\b(480[pi]|sd)\b/.test(text)) return '480p';
  return 'unknown';
}

function detectSource(title) {
  const text = String(title || '').toLowerCase();
  if (/\b(cam|camrip|hdts|telesync|tsrip|tvrip)\b/.test(text)) return 'cam';
  if (/\b(screener|scr|hc)\b/.test(text)) return 'screener';
  if (/\bremux\b/.test(text)) return 'remux';
  if (/\b(blu-?ray|bdrip|bdremux|brrip)\b/.test(text)) return 'bluray';
  if (/\b(web-?dl|webdl|web-?rip|webrip)\b/.test(text)) return 'web';
  if (/\b(hdtv|pdtv|sdtv)\b/.test(text)) return 'hdtv';
  if (/\b(dvdrip|dvd-?r)\b/.test(text)) return 'dvd';
  return 'unknown';
}

function qualityScore(quality, target) {
  const found = QUALITY_LADDER.indexOf(quality);
  const want = QUALITY_LADDER.indexOf(target);
  if (found < 0 || want < 0) return 0;
  if (found === want) return 25;
  // Smaller than asked: mild penalty, still watchable.
  if (found < want) return 10 - (want - found) * 12;
  // Bigger than asked: heavy penalty, those are the 50 GB remuxes.
  return -15 - (found - want) * 15;
}

/** Share of the query's words present in a title, plus a spaceless bonus. */
function relevance(title, queryTokens) {
  if (!queryTokens.length) return 0;
  const text = normalizeText(title);
  const hits = queryTokens.filter((token) => text.includes(token)).length;
  const share = hits / queryTokens.length;
  // Space/punctuation-proof: "s01e01" matches "s01 e01" and "SmilingFriends"
  // matches "Smiling Friends". +1 when the spaceless title contains the
  // spaceless query.
  const spacelessTitle = text.replace(/\s+/g, '');
  const spacelessQuery = queryTokens.join('');
  const spacelessBonus = spacelessQuery && spacelessTitle.includes(spacelessQuery) ? 1 : 0;
  return share + spacelessBonus;
}

/** True when every query token appears in the title in query order. */
function isOrderedMatch(title, queryTokens) {
  if (queryTokens.length < 2) return false;
  const spacelessTitle = normalizeText(title).replace(/\s+/g, '');
  let pos = 0;
  for (const token of queryTokens) {
    const idx = spacelessTitle.indexOf(token, pos);
    if (idx < 0) return false;
    pos = idx + token.length;
  }
  return true;
}

/**
 * Rank one search hit. Higher is better.
 * @param {object} item normalized search result
 * @param {{queryTokens:string[], targetQuality:string}} context
 */
export function scoreResult(item, { queryTokens, targetQuality }) {
  const text = normalizeText(item.title);
  const query = queryTokens.join(' ');
  let score = 0;

  // Seeds matter, but on a log curve so one 5000-seed release cannot bury
  // everything else; leechers only count when they outnumber seeds.
  score += Math.log10(1 + (item.seeders || 0)) * 25;
  if (item.seeders > 0) score -= clamp(item.leechers / item.seeders, 0, 1) * 5;

  // Relevance: prefix beats substring beats scattered words.
  // relevance() already includes the spaceless bonus (+1 -> +30 here).
  score += relevance(item.title, queryTokens) * 30;
  if (query && text.startsWith(query)) score += 40;
  else if (query && text.includes(query)) score += 20;
  // Word order matters: "The Matrix 1999" outranks "Matrix Reloaded 1999".
  if (isOrderedMatch(item.title, queryTokens)) score += 15;

  score += qualityScore(item.quality, targetQuality);
  score += SOURCE_SCORES[item.source] ?? 0;

  // Freshness: anything released inside ~18 months gets a nudge.
  if (item.timestamp) {
    const ageMonths = (Date.now() - item.timestamp) / (1000 * 60 * 60 * 24 * 30);
    if (ageMonths < 18) score += 5;
    else if (ageMonths > 60) score -= 5;
  }

  // Size sanity: under 300 MB is a sample or a short, over 60 GB is a
  // collection rather than the one title that was asked for.
  if (item.sizeBytes > 0) {
    if (item.sizeBytes < 300 * MB) score -= 50;
    else if (item.sizeBytes > 60 * 1024 * MB) score -= 25;
  }

  return Math.round(score * 100) / 100;
}

function normalizeSearchResult(raw) {
  const sizeBytes = parseSize(raw.size);
  const timestamp = raw.time ? new Date(raw.time).getTime() || 0 : 0;
  // Some providers (e.g. TPB) hand back the magnet directly - keep it so
  // resolveMagnet() doesn't have to re-scrape a detail page for it.
  const directMagnet = typeof raw.magnet === 'string' && raw.magnet.startsWith('magnet:')
    ? raw.magnet
    : null;

  return {
    title: String(raw.title || '').trim(),
    provider: raw.provider || null,
    link: raw.link || null,
    infoHash: raw.infoHash || getInfoHash(raw.link || ''),
    seeders: Number.parseInt(raw.seeds, 10) || 0,
    leechers: Number.parseInt(raw.leeches, 10) || 0,
    size: raw.size || null,
    sizeBytes,
    timestamp,
    quality: detectQuality(raw.title),
    source: detectSource(raw.title),
    needsTranscode: needsTranscode(raw.title),
    magnet: directMagnet,
    score: 0,
  };
}

async function resolveMagnet(item) {
  if (item.magnet) return item.magnet;

  try {
    const fetched = await TorrentSearchApi.getMagnet(item);
    if (typeof fetched === 'string' && fetched.startsWith('magnet:')) return fetched;
    // Some providers hand back an .torrent URL - keep only the infohash.
    const file = typeof fetched === 'string' && fetched.match(/\/torrent\/([A-Fa-f0-9]{40})\.torrent/i);
    if (file) return `magnet:?xt=urn:btih:${file[1]}`;
  } catch {
    // fall through to the infohash shortcut
  }

  if (item.infoHash && /^[A-Za-z0-9]{40}$/.test(item.infoHash)) {
    return `magnet:?xt=urn:btih:${item.infoHash}&dn=${encodeURIComponent(item.title)}`;
  }
  return null;
}

function sortResults(items, sort) {
  const copy = [...items];
  switch (sort) {
    case 'seeders':
      return copy.sort((a, b) => b.seeders - a.seeders || b.score - a.score);
    case 'size':
      return copy.sort((a, b) => b.sizeBytes - a.sizeBytes || b.score - a.score);
    case 'newest':
      return copy.sort((a, b) => b.timestamp - a.timestamp || b.score - a.score);
    default:
      return copy.sort((a, b) => b.score - a.score || b.seeders - a.seeders);
  }
}

export function clearSearchCache() {
  searchCache.flushAll();
}

/* ------------------------------------------------------------------ *
 * search
 * ------------------------------------------------------------------ */

/**
 * Search the providers, rank the hits, resolve magnets, cache the lot.
 *
 * @param {string} query free text, e.g. "Inception 2010"
 * @param {object} [options]
 * @param {string} [options.category='All'] provider category filter
 * @param {number} [options.limit=20] how many results to ask the providers for
 * @param {'score'|'seeders'|'size'|'newest'} [options.sort='score']
 * @param {string} [options.quality='1080p'] preferred resolution
 * @param {number} [options.minSeeders=0] drop anything below this
 * @param {number} [options.minRelevance=1.0] share of query words that must match
 * @param {boolean} [options.cache=true]
 * @returns {Promise<Array<object>>} ranked results, best first, magnet included
 */
export async function search(query, options = {}) {
  const text = String(query || '').trim();
  if (!text) throw new Error('search() requires a query string');

  const {
    category = 'All',
    limit = 20,
    sort = 'score',
    quality = DEFAULT_QUALITY,
    minSeeders = 0,
    minRelevance = 1.0,
    cache = true,
  } = options;

  const queryTokens = normalizeText(text).split(' ').filter(Boolean);
  const cacheKey = `${normalizeText(text)}|${category}|${limit}|${sort}|${quality}|${minSeeders}|${minRelevance}`;

  if (cache) {
    const cached = searchCache.get(cacheKey);
    if (cached) {
      console.log(`[search] cache hit for "${text}" (${cached.length} results)`);
      return cached.map((item) => ({ ...item }));
    }
  }

  const rawResults = await TorrentSearchApi.search(text, category, limit);

  const candidates = (rawResults || [])
    .map(normalizeSearchResult)
    .filter((item) => {
      if (!item.title || JUNK_TITLE_RE.test(item.title)) return false;
      if (item.seeders < minSeeders) return false;
      return relevance(item.title, queryTokens) >= minRelevance;
    })
    .map((item) => ({ ...item, score: scoreResult(item, { queryTokens, targetQuality: quality }) }));

  // Resolving magnets is the slow half of a search, so only pay for the top N
  // and silently drop anything that cannot produce one.
  const worthResolving = sortResults(candidates, sort).slice(0, Math.max(MAGNET_TOP_N, 1));
  const resolved = await mapLimit(worthResolving, MAGNET_CONCURRENCY, resolveMagnet);

  const results = [];
  resolved.forEach((magnet, index) => {
    if (!magnet) return;
    results.push({ ...worthResolving[index], magnet });
  });

  if (cache) searchCache.set(cacheKey, results);
  if (!results.length) {
    console.log(`[search] "${text}" -> 0 results`);
  } else {
    console.log(`[search] "${text}" -> ${results.length} results, top: "${results[0].title}" (${results[0].seeders} seeds)`);
  }
  return results.map((item) => ({ ...item }));
}

/* ------------------------------------------------------------------ *
 * torrent plumbing
 * ------------------------------------------------------------------ */

function addTrackers(magnet) {
  if (String(magnet).includes('&tr=')) return magnet;
  const trackers = EXTRA_TRACKERS.map((url) => `&tr=${encodeURIComponent(url)}`).join('');
  return `${magnet}${trackers}`;
}

function rememberTorrent(torrent) {
  if (torrent && typeof torrent.once === 'function' && torrent.infoHash) {
    torrentIndex.set(torrent.infoHash.toLowerCase(), torrent);
  }
}

function isLiveTorrent(value) {
  return !!value && typeof value.once === 'function' && !value.destroyed;
}

async function findTorrent(magnet) {
  const infoHash = getInfoHash(magnet);
  if (infoHash && torrentIndex.has(infoHash)) {
    const cached = torrentIndex.get(infoHash);
    // Anything that isn't a live torrent (e.g. a Promise cached by the old
    // sync client.get call) is dropped, never returned.
    if (isLiveTorrent(cached)) return cached;
    torrentIndex.delete(infoHash);
  }
  try {
    // NOTE: client.get() is async in WebTorrent v3 - it must be awaited.
    // The raw Promise is truthy, so using it un-awaited looks like a found
    // torrent and dies later at torrent.once ("torrent.once is not a function").
    const found = await client.get(magnet);
    if (isLiveTorrent(found)) {
      rememberTorrent(found);
      return found;
    }
  } catch {
    // client.get throws on ids it cannot parse - treat it as "not here"
  }
  return undefined;
}

function waitForMetadata(torrent, timeoutMs = METADATA_TIMEOUT_MS) {
  if (torrent.ready) return Promise.resolve(torrent);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      // Guarded: if setup threw halfway (or the torrent died), an orphaned
      // timer firing cleanup must never crash the process with a second error.
      try {
        torrent.removeListener('ready', onReady);
        torrent.removeListener('error', onError);
      } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for torrent metadata'));
    }, timeoutMs);
    const onReady = () => { cleanup(); resolve(torrent); };
    const onError = (err) => { cleanup(); reject(err); };

    torrent.once('ready', onReady);
    torrent.once('error', onError);
  });
}

/** Wait for the file list, logging the stall-prone handshake at stage level. */
async function waitForMetadataLogged(torrent, short) {
  try {
    await waitForMetadata(torrent);
  } catch (err) {
    console.error(`[download] metadata timeout for ${short}...: ${err.message}`);
    throw err;
  }
  console.log(`[download] metadata ready: "${torrent.name}" (${torrent.files?.length ?? 0} files)`);
  return torrent;
}

/** Add (or reuse) a torrent and wait until its file list is known. */
async function addTorrent(magnet, { job, sequential = false } = {}) {
  const short = String(magnet).slice(0, 30);
  const existing = await findTorrent(magnet);
  if (existing) {
    rememberTorrent(existing);
    if (job) job.torrent = existing;
    console.log(`[download] reusing torrent, waiting for metadata ${short}...`);
    await waitForMetadataLogged(existing, short);
    return existing;
  }

  ensureDownloadsDir();

  const torrent = client.add(addTrackers(magnet), {
    path: DOWNLOADS_DIR,
    sequential,
    maxWebConns: 8,
  });

  rememberTorrent(torrent);

  if (job) {
    job.torrent = torrent;
    torrent.on('error', (err) => {
      if (job.status === 'error') return;
      job.error = err.message;
      job.status = 'error';
      finishJob(job);
    });
  }

  console.log(`[download] adding torrent, waiting for metadata ${short}...`);
  await waitForMetadataLogged(torrent, short);
  return torrent;
}

/** Score a torrent file so `foo.mkv` beats `foo-sample.mkv` beats `Subs/2.srt`. */
function scoreTorrentFile(file, poolSize) {
  const name = path.basename(file.name);
  let score = Math.log10(Math.max(file.length, 1)) * 40;

  if (isJunkName(name)) score -= 100;
  if (VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())) score += 10;

  // Root-level files beat files buried in a sample/ or extras/ folder.
  const depth = String(file.path || name).split('/').length;
  score -= (depth - 1) * 5;

  if (file.length < 100 * MB) score -= 30;
  // The runt of the pool is a sample even when it is not named one.
  if (poolSize > 1 && file.length < 200 * MB) score -= 10;

  return score;
}

/**
 * The one file a player should actually receive.
 * @returns {object|null} a webtorrent File
 */
export function pickMainVideoFile(torrent) {
  const files = torrent?.files || [];
  if (!files.length) return null;

  const videos = files.filter((file) => isVideoFile(file.name));
  const pool = videos.length
    ? videos
    : files.filter((file) => !IGNORED_EXTENSIONS.has(path.extname(file.name).toLowerCase()));
  const candidates = pool.length ? pool : files;

  return candidates
    .map((file) => ({ file, score: scoreTorrentFile(file, candidates.length) }))
    .sort((a, b) => b.score - a.score)[0]?.file ?? null;
}

/** Deselect everything, then select the video files plus subtitle sidecars. */
function selectVideoFilesOnly(torrent) {
  torrent.files.forEach((file) => file.deselect());
  const wanted = torrent.files.filter((file) => isVideoFile(file.name) || isSubtitleFile(file.name));
  wanted.forEach((file) => file.select());
  const subCount = wanted.filter((file) => isSubtitleFile(file.name)).length;
  if (subCount > 0) console.log(`[download] keeping ${subCount} subtitle sidecar(s)`);
}

/** Deselect everything, then select exactly one file. */
function selectOnlyFile(torrent, file) {
  torrent.files.forEach((other) => other.deselect());
  file.select();
}

/* ------------------------------------------------------------------ *
 * jobs: status, progress, heartbeat, timeout
 * ------------------------------------------------------------------ */

/** Subtitle sidecars for a job: [{ name, lang }] (best-effort, never throws). */
function listSubtitles(job) {
  try {
    const files = job?.torrent?.files || [];
    const found = files.filter((file) => isSubtitleFile(file?.name));
    if (found.length) {
      return found.map((file) => ({
        name: path.basename(String(file.name)),
        lang: guessSubtitleLang(file.name),
      }));
    }
    if (Array.isArray(job?.subtitles) && job.subtitles.length) return job.subtitles;
  } catch { /* subtitles are best-effort */ }
  return [];
}

function snapshot(job) {
  const torrent = job.torrent;
  const files = torrent?.files || [];
  const mainFile = job.file || pickMainVideoFile(torrent);

  let downloadProgress = job.downloadProgress;
  let downloaded = job.downloaded;
  let size = job.size;
  let speed = job.speed;
  let peers = job.peers;

  if (torrent && !job.done) {
    // Measure over the video files only - torrent.progress also counts the
    // deselected junk that will never download and stalls the bar at 97%.
    const videos = files.filter((file) => isVideoFile(file.name));
    const pool = videos.length ? videos : files;
    const total = pool.reduce((sum, file) => sum + file.length, 0);
    const got = pool.reduce((sum, file) => sum + file.downloaded, 0);

    if (total > 0) downloadProgress = clamp((got / total) * 100, 0, 100);
    downloaded = got;
    size = total;
    speed = Math.max(0, torrent.downloadSpeed || 0);
    peers = torrent.numPeers || 0;
  }

  const progress = job.status === 'transcoding' ? job.transcodeProgress : downloadProgress;

  return {
    status: job.status,
    done: job.done,
    progress: Math.round(clamp(progress, 0, 100) * 100) / 100,
    downloadProgress: Math.round(downloadProgress * 100) / 100,
    transcodeProgress: Math.round(job.transcodeProgress * 100) / 100,
    speed,
    peers,
    downloaded,
    size,
    name: torrent?.name || job.name || null,
    file: mainFile?.name || job.fileName || null,
    outputFile: job.outputFile || null,
    subtitles: listSubtitles(job),
    magnet: job.magnet,
    infoHash: job.infoHash || null,
    transcodeNeeded: job.transcodeNeeded ?? false,
    error: job.error,
    lastHeartbeat: job.lastHeartbeat,
    expiresIn: job.timer && job.deadline ? Math.max(0, job.deadline - Date.now()) : null,
  };
}

function getJob(magnet) {
  return jobs.get(jobKeyFor(magnet)) || null;
}

/**
 * Current state of a download/transcode job.
 * @param {string} [magnet] omit to get every job
 * @returns {object|Array<object>} status is 'downloading'|'transcoding'|'error'|'idle'
 */
export function getProgress(magnet) {
  if (!magnet) return Array.from(jobs.values()).map(snapshot);
  const job = getJob(magnet);
  return job
    ? snapshot(job)
    : { status: 'idle', done: false, progress: 0, magnet, error: null };
}

export function getAllProgress() {
  return getProgress();
}

/** Depth-capped recursive basename search (directories only, never file bodies). */
function walkForFileName(dir, baseName, depth = 0) {
  if (depth > 6) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === baseName) return path.join(dir, entry.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const hit = walkForFileName(path.join(dir, entry.name), baseName, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Absolute path of a subtitle sidecar for a magnet, or null.
 * Prefers the torrent's own file paths, then falls back to a basename
 * search under the downloads dir (the torrent may be gone from memory
 * while its files persist on disk).
 */
export function findSubtitleFile(magnet, fileName) {
  const base = path.basename(String(fileName || ''));
  if (!base) return null;
  const job = getJob(magnet);
  const files = job?.torrent?.files || [];
  for (const file of files) {
    if (path.basename(String(file?.name || '')) === base) {
      const abs = path.join(DOWNLOADS_DIR, String(file.path || file.name));
      if (abs.startsWith(DOWNLOADS_DIR) && existsSync(abs)) return abs;
    }
  }
  const direct = path.join(DOWNLOADS_DIR, base);
  if (existsSync(direct)) return direct;
  return walkForFileName(DOWNLOADS_DIR, base);
}

function armTimer(job) {
  clearTimeout(job.timer);
  job.deadline = Date.now() + job.timeoutMs;
  job.timer = setTimeout(() => { onTimeout(job); }, job.timeoutMs);
  if (typeof job.timer.unref === 'function') job.timer.unref();
}

/** Forget the job after the retention window. Files are left on disk. */
function armRetention(job) {
  clearTimeout(job.timer);
  job.deadline = null;
  job.timer = setTimeout(() => { jobs.delete(job.key); }, JOB_RETENTION_MIN * 60_000);
  if (typeof job.timer.unref === 'function') job.timer.unref();
}

function finishJob(job) {
  job.done = true;
  job.finishedAt = Date.now();
  armRetention(job);
}

/** Short human label for logs: the torrent name once known, else a key stub. */
function jobLabel(job) {
  return job.name ? `"${job.name}"` : job.key.slice(0, 8);
}

/**
 * Log download/transcode progress at 25/50/75/100 only. The last-logged
 * milestone lives on the job so per-piece/per-tick updates stay silent.
 */
function logMilestone(job, kind, pct) {
  const milestone = Math.floor(clamp(pct, 0, 100) / 25) * 25;
  const field = kind === 'transcode' ? 'lastTranscodeMilestone' : 'lastDownloadMilestone';
  if (milestone >= 25 && milestone > (job[field] || 0)) {
    job[field] = milestone;
    console.log(`[${kind === 'transcode' ? 'transcode' : 'download'}] ${jobLabel(job)} ${milestone}%`);
  }
}

async function destroyJob(job, { deleteFiles }) {
  if (job.command) {
    try { job.command.kill('SIGKILL'); } catch { /* already gone */ }
    job.command = null;
  }

  const torrent = job.torrent;
  if (torrent) {
    try {
      await new Promise((resolve) => {
        torrent.destroy({ destroyStore: deleteFiles }, () => resolve());
      });
    } catch (err) {
      console.error('[download] destroy failed:', err.message);
    }
    if (job.infoHash) torrentIndex.delete(job.infoHash);
    job.torrent = null;
  }

  if (deleteFiles && job.outputPath) {
    rmSync(job.outputPath, { force: true });
    job.outputFile = null;
    job.outputPath = null;
  }
}

async function onTimeout(job) {
  if (job.done) {
    armRetention(job);
    return;
  }
  const minutes = Math.round((job.timeoutMs / 60_000) * 10) / 10;
  console.log(`[heartbeat] ${jobLabel(job)} cancelled after ${minutes}m without heartbeat`);
  await destroyJob(job, { deleteFiles: job.deleteFilesOnTimeout });
  job.status = 'error';
  job.error = `no heartbeat for ${minutes}m - cancelled and data deleted`;
  armRetention(job);
}

/**
 * Create or refresh the job record for a magnet.
 * Repeat calls share one job, which is what lets a heartbeat extend a job that
 * was started by stream() or by downloadAndTranscode().
 */
function ensureJob(magnet, options = {}) {
  if (!magnet) throw new Error('a magnet link is required');

  const key = jobKeyFor(magnet);
  const timeoutMin = Number.isFinite(options.timeoutMin) ? options.timeoutMin : DEFAULT_TIMEOUT_MIN;

  let job = jobs.get(key);
  if (!job) {
    job = {
      key,
      magnet,
      infoHash: getInfoHash(magnet),
      status: 'idle',
      done: false,
      downloadProgress: 0,
      transcodeProgress: 0,
      downloaded: 0,
      size: 0,
      speed: 0,
      peers: 0,
      duration: 0,
      name: null,
      file: null,
      fileName: null,
      subtitles: [],
      outputFile: null,
      outputPath: null,
      transcodeNeeded: false,
      error: null,
      command: null,
      torrent: null,
      timeoutMs: timeoutMin * 60_000,
      timer: null,
      deadline: null,
      lastHeartbeat: null,
      startedAt: Date.now(),
      finishedAt: null,
      deleteFilesOnTimeout: true,
    };
    jobs.set(key, job);
  }

  job.magnet = magnet;
  job.timeoutMs = clamp(timeoutMin, 0.1, 24 * 60) * 60_000;
  job.deleteFilesOnTimeout = options.deleteFilesOnTimeout !== false;
  armTimer(job);
  return job;
}

/**
 * Push a job's timeout back. Call this while a player is actually watching,
 * otherwise the job gets cancelled and its files deleted.
 *
 * @param {string} magnet
 * @returns {{ok:boolean, status:string, expiresIn:number|null}}
 */
export function heartbeat(magnet) {
  const job = getJob(magnet);
  if (!job) {
    console.log(`[heartbeat] unknown job ${String(magnet).slice(0, 30)}...`);
    return { ok: false, status: 'idle', expiresIn: null };
  }

  job.lastHeartbeat = Date.now();
  armTimer(job);
  return { ok: true, status: job.status, expiresIn: Math.max(0, job.deadline - Date.now()) };
}

/**
 * Stop work on a magnet now.
 * @param {string} magnet
 * @param {{deleteFiles?:boolean}} [options] false keeps the data on disk
 * @returns {Promise<boolean>}
 */
export async function cancel(magnet, { deleteFiles = false } = {}) {
  const job = getJob(magnet);
  if (!job) {
    console.log(`[download] cancel: unknown job ${String(magnet).slice(0, 30)}...`);
    return false;
  }

  console.log(`[download] cancelling ${jobLabel(job)} (deleteFiles=${deleteFiles})`);
  await destroyJob(job, { deleteFiles });
  job.status = 'error';
  job.error = 'cancelled';
  finishJob(job);
  return true;
}

/* ------------------------------------------------------------------ *
 * stream
 * ------------------------------------------------------------------ */

/**
 * Stream a torrent to an HTTP response with byte-range (seek) support.
 *
 * Picks one file - the largest real video, ignoring samples and sidecar files
 * - selects only that file and pipes it straight out of the torrent store, so
 * playback starts before the download finishes. Handles `Range: bytes=a-b`,
 * `bytes=a-` and `bytes=-n`, answers 416 for out-of-bounds seeks, and supports
 * HEAD probes.
 *
 * @param {string} magnet magnet URI
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} [options]
 * @param {number} [options.timeoutMin=10] idle minutes before the job is cancelled
 * @param {boolean} [options.inline=true] inline playback vs attachment
 * @param {'inline'|'attachment'} [options.disposition] overrides inline
 * @returns {Promise<object|null>} the file that was selected
 */
export async function stream(magnet, req, res, options = {}) {
  if (!magnet) throw new Error('stream() requires a magnet link');
  if (!res) throw new Error('stream() requires a response object');

  const { inline = true, disposition } = options;
  const job = ensureJob(magnet, options);
  job.lastHeartbeat = Date.now();
  job.status = 'downloading';

  const torrent = await addTorrent(magnet, { job });

  const file = pickMainVideoFile(torrent);
  if (!file) {
    console.error(`[stream] no playable video file in ${String(magnet).slice(0, 30)}...`);
    job.status = 'error';
    job.error = 'no playable video file in this torrent';
    finishJob(job);
    if (!res.headersSent) res.status(404).send(job.error);
    else res.end();
    return null;
  }

  selectOnlyFile(torrent, file);
  job.file = file;
  job.fileName = file.name;
  job.name = torrent.name;
  job.transcodeNeeded = needsTranscode(torrent.name);
  console.log(`[stream] main file: "${file.name}" (${Math.round(file.length / MB)} MB)`);

  // Every play re-arms the timer: a player reconnecting to seek extends the job.
  armTimer(job);

  const size = file.length;
  const contentType = getMimeType(file.name);
  const mode = disposition || (inline ? 'inline' : 'attachment');
  const fileName = encodeURIComponent(file.name);
  const range = parseRange(req.headers?.range, size);

  if (range === 'unsatisfiable') {
    console.log(`[stream] 416 unsatisfiable range "${req.headers?.range}" for "${file.name}" (${size} bytes)`);
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
    res.end();
    return file;
  }

  const commonHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${mode}; filename="${fileName}"`,
    'Cache-Control': 'no-store',
  };

  if (range) {
    res.writeHead(206, {
      ...commonHeaders,
      'Content-Length': range.end - range.start + 1,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      Connection: 'keep-alive',
    });
    console.log(`[stream] serving "${file.name}" 206 bytes ${range.start}-${range.end}/${size}`);
  } else {
    res.writeHead(200, { ...commonHeaders, 'Content-Length': size });
    console.log(`[stream] serving "${file.name}" 200 full file (${size} bytes)`);
  }

  // HEAD probes and zero-length files need headers only.
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return file;
  }

  const source = file.createReadStream({
    start: range ? range.start : 0,
    end: range ? range.end : size - 1,
    highWaterMark: 1024 * 1024,
  });

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // The player leaving is normal - stop reading, let the timer handle cleanup.
    const teardown = () => {
      source.destroy();
      done();
    };

    res.on('close', teardown);
    res.on('error', teardown);
    source.on('error', (err) => {
      if (!res.headersSent) res.status(500);
      res.end(err.message);
      done();
    });
    source.on('end', done);

    source.pipe(res);
  });

  return file;
}

/* ------------------------------------------------------------------ *
 * download + transcode
 * ------------------------------------------------------------------ */

function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const streams = metadata?.streams || [];
      // Attached pictures (mkv cover art) are not the video track.
      const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
        || streams.find((s) => s.codec_type === 'video');
      const audio = streams.find((s) => s.codec_type === 'audio');
      resolve({
        duration: Number(metadata?.format?.duration) || 0,
        videoCodec: video?.codec_name?.toLowerCase() || null,
        audioCodec: audio?.codec_name?.toLowerCase() || null,
      });
    });
  });
}

function trackTranscodeProgress(job, progress) {
  if (typeof progress.percent === 'number' && Number.isFinite(progress.percent)) {
    job.transcodeProgress = clamp(progress.percent, 0, 100);
  } else {
    // ffmpeg only sends percent once it knows the duration.
    const [hours, minutes, seconds] = String(progress.timemark || '00:00:00').split(':').map(Number);
    const elapsed = (hours * 3600) + (minutes * 60) + seconds;
    if (job.duration > 0) job.transcodeProgress = clamp((elapsed / job.duration) * 100, 0, 100);
  }
  logMilestone(job, 'transcode', job.transcodeProgress);
}

function transcode(job, inputPath, outputPath, outputOptions) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const command = ffmpeg(inputPath);
    job.command = command;
    job.transcodeProgress = 0;

    command
      .inputOptions(['-probesize 50M', '-analyzeduration 50M'])
      .outputOptions(outputOptions)
      .on('progress', (progress) => trackTranscodeProgress(job, progress))
      .on('end', () => {
        if (settled) return;
        settled = true;
        job.command = null;
        job.transcodeProgress = 100;
        resolve();
      })
      .on('error', (err) => {
        if (settled) return;
        settled = true;
        job.command = null;
        reject(err);
      })
      .save(outputPath);
  });
}

function buildOutputOptions(probe) {
  const options = ['-movflags +faststart', '-fflags +genpts', '-avoid_negative_ts make_zero'];

  if (probe?.videoCodec === 'h264') {
    options.push('-c:v copy');
  } else {
    options.push('-c:v libx264', '-preset veryfast', '-crf 21');
  }

  if (probe?.audioCodec === 'aac') {
    options.push('-c:a copy');
  } else {
    options.push('-c:a aac', '-b:a 192k');
  }

  // Subtitle streams (PGS/ASS) cannot be muxed into mp4 and abort the job.
  options.push('-map 0:v:0', '-map 0:a:0?', '-sn');
  return options;
}

/**
 * Download a magnet's video and normalise it into a browser-playable mp4.
 *
 * Junk (samples, .nfo, artwork) is deselected so it never downloads.
 * Subtitle sidecars (.srt/.vtt/.ass/.ssa) are kept alongside the video but
 * never picked as the main file. Only the largest real video is kept. ffmpeg stream-copies whatever is
 * already H.264/AAC and re-encodes only the stream that needs it, so an mp4
 * that is already compatible is handed back untouched.
 *
 * Nothing is written outside <cwd>/downloads. The raw download is removed
 * after a successful transcode unless `deleteSource: false` is passed.
 *
 * @param {string} magnet magnet URI
 * @param {number} [timeoutMin=10] minutes of silence before the job is
 *   cancelled and its data deleted. Call heartbeat() to keep it alive.
 * @param {object} [options]
 * @param {string} [options.outputName] override the output file name
 * @param {boolean} [options.deleteSource=true] remove the raw file afterwards
 * @param {boolean} [options.deleteFilesOnTimeout=true] delete on timeout
 * @returns {Promise<{file:string, name:string, path:string, outputFile:string,
 *   outputPath:string, infoHash:string, transcodeNeeded:boolean,
 *   transcodeProgress:number}>} `file` is the name of the file in downloads/
 */
export async function downloadAndTranscode(magnet, timeoutMin = DEFAULT_TIMEOUT_MIN, options = {}) {
  if (!magnet) throw new Error('downloadAndTranscode() requires a magnet link');

  const { outputName, deleteSource = true } = options;
  ensureDownloadsDir();
  console.log(`[download] starting download ${String(magnet).slice(0, 30)}...`);

  const job = ensureJob(magnet, {
    timeoutMin,
    deleteFilesOnTimeout: options.deleteFilesOnTimeout,
  });
  job.lastHeartbeat = Date.now();
  job.status = 'downloading';

  try {
    const torrent = await addTorrent(magnet, { job, sequential: true });

    selectVideoFilesOnly(torrent);

    const file = pickMainVideoFile(torrent);
    if (!file) throw new Error('no playable video file in this torrent');

    job.file = file;
    job.fileName = file.name;
    job.name = torrent.name;
    job.transcodeNeeded = needsTranscode(torrent.name);
    console.log(`[download] main file: "${file.name}" (${Math.round(file.length / MB)} MB)`);

    // The torrent's 'done' waits for deselected junk too, so watch the file.
    if (!file.done) {
      await new Promise((resolve, reject) => {
        // Per-piece ticks stay silent; logMilestone only emits 25/50/75/100.
        const onDownload = () => {
          const files = torrent.files || [];
          const videos = files.filter((f) => isVideoFile(f.name));
          const pool = videos.length ? videos : files;
          const total = pool.reduce((sum, f) => sum + f.length, 0);
          const got = pool.reduce((sum, f) => sum + (f.downloaded || 0), 0);
          if (total > 0) logMilestone(job, 'download', (got / total) * 100);
        };
        const cleanup = () => {
          try {
            file.removeListener('done', onDone);
            torrent.removeListener('error', onError);
            torrent.removeListener('download', onDownload);
          } catch { /* already gone */ }
        };
        const onDone = () => { cleanup(); resolve(); };
        const onError = (err) => { cleanup(); reject(err); };

        torrent.on('download', onDownload);
        file.once('done', onDone);
        torrent.once('error', onError);
      });
      logMilestone(job, 'download', 100);
    } else {
      console.log(`[download] already complete ${jobLabel(job)}, skipping download wait`);
    }

    const sourcePath = path.join(DOWNLOADS_DIR, file.path);
    const baseName = sanitizeFileName(outputName || path.basename(file.name, path.extname(file.name)));
    const outputPath = path.join(DOWNLOADS_DIR, `${baseName}.mp4`);

    let probe = null;
    try {
      probe = await probeMedia(sourcePath);
    } catch (err) {
      console.error('[downloader] ffprobe failed, transcoding anyway:', err.message);
    }
    job.duration = probe?.duration || 0;

    const needsWork = !probe
      || probe.videoCodec !== 'h264'
      || probe.audioCodec !== 'aac'
      || path.extname(file.name).toLowerCase() !== '.mp4';

    if (needsWork) {
      job.status = 'transcoding';
      job.transcodeProgress = 0;
      console.log(`[transcode] starting transcode ${jobLabel(job)} (${probe?.videoCodec || '?'} video, ${probe?.audioCodec || '?'} audio -> mp4)`);
      rmSync(outputPath, { force: true });
      await transcode(job, sourcePath, outputPath, buildOutputOptions(probe));
      logMilestone(job, 'transcode', 100);
    } else {
      console.log(`[download] already browser-ready ${jobLabel(job)}, skipping transcode`);
    }

    job.outputPath = outputPath;
    job.outputFile = path.basename(outputPath);
    job.status = 'idle';
    job.downloadProgress = 100;
    job.transcodeProgress = 100;
    job.error = null;
    // Remember sidecars now: the torrent may be forgotten while files persist.
    job.subtitles = listSubtitles(job);
    finishJob(job);
    console.log(`[download] finished ${jobLabel(job)} -> "${job.outputFile}"`);

    if (deleteSource && sourcePath !== outputPath) {
      rmSync(sourcePath, { force: true });
    }

    return {
      file: job.outputFile,
      name: job.outputFile,
      path: outputPath,
      outputFile: job.outputFile,
      outputPath,
      infoHash: job.infoHash,
      transcodeNeeded: needsWork,
      transcodeProgress: 100,
    };
  } catch (err) {
    console.error(`[download] job failed ${jobLabel(job)}: ${err.message}`);
    job.status = 'error';
    job.error = err.message;
    finishJob(job);
    throw err;
  }
}

export default {
  search,
  stream,
  downloadAndTranscode,
  getProgress,
  getAllProgress,
  heartbeat,
  cancel,
  clearSearchCache,
  guessSubtitleLang,
  srtToVtt,
  findSubtitleFile,
  SUBTITLE_EXTENSIONS,
  client,
  DOWNLOADS_DIR,
  DEFAULT_TIMEOUT_MIN,
};
