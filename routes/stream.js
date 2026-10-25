import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import NodeCache from 'node-cache';
import * as downloader from '../handlers/downloader/index.js';
import tmdb from '../handlers/downloader/tmdb.js';

const router = express.Router();

/** tmdb id (+season/episode) -> magnet, so progress polls don't re-search. */
const magnetCache = new NodeCache({ stdTTL: 3600, checkPeriod: 600 });
/** Same key -> every magnet found, best first. The player's server switcher cycles this list. */
const candidateCache = new NodeCache({ stdTTL: 3600, checkPeriod: 600 });

const keyFor = (id, season, episode) =>
    season && episode ? `tv:${id}:${season}:${episode}` : `movie:${id}`;

/** How many alternative torrents a title keeps for the server switcher. */
const MAX_CANDIDATES = 10;

/** One-line request target for logs, e.g. `id=123 season=1 episode=2`. */
const describeTarget = (id, season, episode) =>
    season && episode ? `id=${id} season=${season} episode=${episode}` : `id=${id}`;

/**
 * All magnets for a title, best first (seeders where the provider ranks).
 * Queries are tried in order and results deduped by info hash, so this is
 * both the resolution path and the server-switcher candidate pool.
 */
async function resolveCandidates(id, season, episode) {
    const key = keyFor(id, season, episode);
    const cached = candidateCache.get(key);
    if (cached) return cached;

    const isSeries = Boolean(season && episode);
    let queries;
    try {
        queries = isSeries
            ? await tmdb.buildTVQueries(String(id), String(season), String(episode))
            : await tmdb.buildMovieQueries(String(id));
    } catch (err) {
        console.log(`[stream] could not build queries for ${key}: ${err.message}`);
        return [];
    }

    queries = (queries || []).filter((query) => query && !query.includes('undefined'));
    if (!queries.length) {
        console.log(`[stream] no TMDB query for ${key}`);
        return [];
    }
    console.log(`[search] trying ${queries.length} queries for ${key}: ${queries.join(' | ')}`);

    const seen = new Set();
    const magnets = [];

    for (const query of queries) {
        console.log(`[search] TMDB query: "${query}" (${key})`);
        let results = [];
        try {
            results = await downloader.search(query, isSeries ? { limit: 20, sort: 'seeders' } : { limit: 20 });
        } catch (err) {
            console.log(`[search] "${query}" failed: ${err.message}`);
            continue;
        }

        for (const result of results || []) {
            const magnet = result?.magnet;
            if (!magnet) continue;
            const hash = /btih:([a-z0-9]+)/i.exec(String(magnet));
            const identity = hash ? hash[1].toLowerCase() : String(magnet);
            if (seen.has(identity)) continue;
            seen.add(identity);
            magnets.push(magnet);
            if (magnets.length >= MAX_CANDIDATES) break;
        }

        if (magnets.length > 0 && queries.indexOf(query) === 0) {
            console.log(`[stream] ${magnets.length} candidate(s) via "${query}" for ${key}`);
        }
        if (magnets.length >= MAX_CANDIDATES) break;
    }

    if (!magnets.length) {
        console.log(`[stream] no magnet found for ${key} after ${queries.length} queries`);
        return [];
    }

    candidateCache.set(key, magnets);
    magnetCache.set(key, magnets[0]);
    console.log(`[stream] resolved ${magnets.length} source(s) for ${key}`);
    return magnets;
}

async function resolveMagnet(id, season, episode) {
    const key = keyFor(id, season, episode);
    const cached = magnetCache.get(key);
    if (cached) {
        console.log(`[stream] magnet cache hit for ${key}`);
        return cached;
    }
    const magnets = await resolveCandidates(id, season, episode);
    return magnets[0] || null;
}

/* ------------------------------------------------------------------ *
 * server switcher (one entry per player session)
 * ------------------------------------------------------------------ */

/** player session id -> { key, index, magnet, updatedAt } */
const sourceSessions = new Map();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

const sessionSweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, entry] of sourceSessions) {
        if (!entry.updatedAt || entry.updatedAt < cutoff) sourceSessions.delete(id);
    }
}, 30 * 60_000);
if (typeof sessionSweeper.unref === 'function') sessionSweeper.unref();

/** Session ids are client generated; keep them short and boring. */
function sanitizeSession(value) {
    const id = String(value ?? '').trim();
    return /^[a-z0-9-]{6,64}$/i.test(id) ? id : null;
}

/** The magnet the player picked, only when it belongs to this title. */
function sessionMagnet(id, season, episode, sessionId) {
    const entry = sessionId ? sourceSessions.get(sessionId) : null;
    if (!entry) return null;
    if (entry.key !== keyFor(id, season, episode)) return null;
    return entry.magnet || null;
}

/** Chosen server first, otherwise the best search result. */
async function magnetFor(id, season, episode, sessionId) {
    return sessionMagnet(id, season, episode, sessionId)
        || resolveMagnet(id, season, episode);
}

/**
 * Drop a magnet's job once its last viewer has gone. Retries for a minute so
 * the old stream has time to actually close after a switch.
 */
function scheduleRelease(magnet) {
    if (!magnet) return;
    let attempt = 0;
    const tryRelease = async () => {
        attempt += 1;
        let released = false;
        try {
            released = await downloader.releaseIfUnwatched(magnet);
        } catch (err) {
            console.log(`[stream] release failed: ${err.message}`);
        }
        if (!released && attempt < 7) {
            const timer = setTimeout(tryRelease, 10_000);
            if (typeof timer.unref === 'function') timer.unref();
        }
    };
    const first = setTimeout(tryRelease, 5_000);
    if (typeof first.unref === 'function') first.unref();
}

/** Serve a finished transcode (downloads/<outputFile>) with range support. */
/** @returns {boolean} true when the file existed and the response was sent. */
function serveFinishedFile(req, res, outputFile) {
    if (!outputFile) return false;
    const abs = path.join(downloader.DOWNLOADS_DIR, path.basename(outputFile));
    if (!abs.startsWith(downloader.DOWNLOADS_DIR) || !fs.existsSync(abs)) return false;

    const stat = fs.statSync(abs);
    const size = stat.size;
    const range = req.headers.range;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'HEAD') {
        res.setHeader('Content-Length', size);
        res.end();
        return true;
    }

    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (match) {
            let [, s, e] = match;
            let start = s === '' ? Math.max(0, size - Number(e)) : Number(s);
            let end = e === '' || s === '' ? size - 1 : Number(e);
            if (Number.isFinite(start) && Number.isFinite(end) && start < size && end >= start) {
                end = Math.min(end, size - 1);
                res.writeHead(206, {
                    'Content-Length': end - start + 1,
                    'Content-Range': `bytes ${start}-${end}/${size}`,
                });
                console.log(`[stream] serving finished "${path.basename(outputFile)}" 206 bytes ${start}-${end}/${size}`);
                fs.createReadStream(abs, { start, end }).pipe(res);
                return true;
            }
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            res.end();
            return true;
        }
    }

    res.writeHead(200, { 'Content-Length': size });
    console.log(`[stream] serving finished "${path.basename(outputFile)}" 200 full file (${size} bytes)`);
    fs.createReadStream(abs).pipe(res);
    return true;
}

async function handleStream(req, res) {
    const { id, season, episode } = req.params;
    if (!id) return res.status(400).json({ status: 'error', error: 'missing id' });
    const session = sanitizeSession(req.query.session);
    console.log(`[stream] incoming stream request ${describeTarget(id, season, episode)}`);
    try {
        const magnet = await magnetFor(id, season, episode, session);
        if (!magnet) return res.status(404).json({ status: 'error', error: 'no torrent found' });

        // Series path finishes into a browser-ready mp4 - prefer it when done.
        try {
            const prog = downloader.getProgress(magnet);
            if (prog?.outputFile && serveFinishedFile(req, res, prog.outputFile)) return;
        } catch { /* fall through to live torrent streaming */ }

        // Idle timeout is 10m here; the downloader default is configurable via DOWNLOADER_TIMEOUT_MIN.
        await downloader.stream(magnet, req, res, { timeoutMin: 10 });
    } catch (err) {
        console.error('[stream]', err.message);
        if (!res.headersSent) res.status(500).json({ status: 'error', error: err.message });
    }
}

/** Serve a downloaded subtitle sidecar as WebVTT. */
async function handleSubs(req, res) {
    const { id, season, episode } = req.params;
    const lang = String(req.query.lang || '').toLowerCase().trim();
    const session = sanitizeSession(req.query.session);
    if (!id) return res.status(400).json({ status: 'error', error: 'missing id' });
    console.log(`[stream] incoming subs request ${describeTarget(id, season, episode)}${lang ? ` lang=${lang}` : ''}`);
    try {
        const magnet = await magnetFor(String(id), season, episode, session);
        if (!magnet) return res.status(404).json({ status: 'error', error: 'no torrent found' });

        const prog = downloader.getProgress(magnet);
        const subs = Array.isArray(prog?.subtitles) ? prog.subtitles : [];
        if (!subs.length) {
            console.log(`[stream] no subtitles for ${describeTarget(id, season, episode)}`);
            return res.status(404).json({ status: 'error', error: 'no subtitles available' });
        }

        // Prefer the requested lang (code or filename fragment), else the first.
        const pick = (lang && subs.find((s) =>
            String(s.lang || '').toLowerCase() === lang ||
            String(s.name || '').toLowerCase().includes(lang))) || subs[0];

        const abs = downloader.findSubtitleFile(magnet, pick.name);
        if (!abs) {
            console.log(`[stream] subtitle "${pick.name}" not on disk for ${describeTarget(id, season, episode)}`);
            return res.status(404).json({ status: 'error', error: 'no subtitles available' });
        }

        const ext = path.extname(abs).toLowerCase();
        const raw = fs.readFileSync(abs, 'utf8');
        // SRT is converted (comma timestamps -> dots + WEBVTT header);
        // .vtt passes through, .ass/.ssa are served as-is.
        const body = ext === '.srt' ? downloader.srtToVtt(raw) : raw;

        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        console.log(`[stream] serving subtitles "${pick.name}" as VTT for ${describeTarget(id, season, episode)}`);
        res.send(body);
    } catch (err) {
        console.error('[stream]', err.message);
        if (!res.headersSent) res.status(500).json({ status: 'error', error: err.message });
    }
}

async function handleDownload(req, res) {
    const { id, season, episode } = req.params;
    if (!id) return res.status(400).json({ status: 'error', error: 'missing id' });
    const session = sanitizeSession(req.query.session);
    console.log(`[stream] incoming download request ${describeTarget(id, season, episode)}`);
    try {
        const magnet = await magnetFor(id, season, episode, session);
        if (!magnet) return res.status(404).json({ status: 'error', error: 'no torrent found' });

        const existing = downloader.getProgress(magnet);
        if (existing?.done && existing?.outputFile) return res.json({ ok: true, ...existing });

        // Don't await: this runs for minutes, the player polls progress.
        downloader.downloadAndTranscode(magnet, 10).catch((err) => {
            console.error('[stream/download]', err.message);
        });

        res.status(202).json({ ok: true, status: 'downloading', magnet: undefined });
    } catch (err) {
        console.error('[stream/download]', err.message);
        if (!res.headersSent) res.status(500).json({ status: 'error', error: err.message });
    }
}

// POST /api/stream/source - pick the next (or previous) magnet for this player
// and drop the previous one once nobody is watching it any more.
router.post('/api/stream/source', async (req, res) => {
    const body = req.body || {};
    const id = String(body.id ?? '').trim();
    const season = String(body.season ?? '').trim();
    const episode = String(body.episode ?? '').trim();
    const session = sanitizeSession(body.session);
    const step = body.direction === 'prev' ? -1 : 1;

    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'invalid id' });
    if (!session) return res.status(400).json({ error: 'invalid session' });
    if ((season || episode) && !(/^\d+$/.test(season) && /^\d+$/.test(episode))) {
        return res.status(400).json({ error: 'invalid episode' });
    }

    const key = keyFor(id, season, episode);
    console.log(`[stream] source switch (${step > 0 ? 'next' : 'prev'}) for ${describeTarget(id, season, episode)}`);

    try {
        const magnets = await resolveCandidates(id, season, episode);
        if (!magnets.length) return res.status(404).json({ error: 'no torrent found' });

        const current = sourceSessions.get(session);
        const sameTitle = Boolean(current && current.key === key);
        const startIndex = sameTitle ? current.index : 0;
        // The options menu picks a server by number; without one, step to the
        // next (or previous) magnet.
        const requested = Number(body.index);
        const picked = Number.isInteger(requested) && requested >= 1 && requested <= magnets.length
            ? requested - 1
            : null;
        const index = picked !== null
            ? picked
            : (startIndex + step + magnets.length) % magnets.length;
        // Without a session entry the player is on the default (best) magnet,
        // so that is the one to release after moving away from it.
        const previous = sameTitle ? current.magnet : magnets[0];
        const magnet = magnets[index];

        sourceSessions.set(session, { key, index, magnet, updatedAt: Date.now() });

        // The old torrent is no longer the one being streamed. Clean it up
        // only when its last viewer has disconnected (checked with retries).
        if (previous && previous !== magnet) scheduleRelease(previous);

        console.log(`[stream] source ${index + 1}/${magnets.length} for ${describeTarget(id, season, episode)}`);
        return res.json({
            ok: true,
            index: index + 1,
            total: magnets.length,
            changed: previous !== magnet,
        });
    } catch (err) {
        console.error('[stream/source]', err.message);
        return res.status(500).json({ error: 'could not switch source' });
    }
});

// GET /api/stream/sources - how many magnets this title has, and which one
// this player session is playing (1-based). Powers the player's options menu.
router.get('/api/stream/sources', async (req, res) => {
    const id = String(req.query.id ?? '').trim();
    const season = String(req.query.season ?? '').trim();
    const episode = String(req.query.episode ?? '').trim();
    const session = sanitizeSession(req.query.session);

    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'invalid id' });
    if ((season || episode) && !(/^\d+$/.test(season) && /^\d+$/.test(episode))) {
        return res.status(400).json({ error: 'invalid episode' });
    }

    try {
        const magnets = await resolveCandidates(id, season, episode);
        if (!magnets.length) return res.status(404).json({ error: 'no torrent found' });

        const key = keyFor(id, season, episode);
        const current = session ? sourceSessions.get(session) : null;
        const playing = current && current.key === key ? current.index : 0;
        return res.json({ count: magnets.length, index: playing + 1 });
    } catch (err) {
        console.error('[stream/sources]', err.message);
        return res.status(500).json({ error: 'could not list sources' });
    }
});

// Specific paths first: Express matches in order, so /progress must come
// before /:id or "progress" gets swallowed as an id.
router.get('/api/stream/progress', async (req, res) => {
    const { id, season, episode } = req.query;
    const session = sanitizeSession(req.query.session);
    console.log(`[stream] incoming progress request ${describeTarget(id, season, episode)}`);
    if (!id) return res.status(400).json({ status: 'error', error: 'missing id' });
    try {
        const magnet = await magnetFor(String(id), season, episode, session);
        if (!magnet) return res.status(404).json({ status: 'error', error: 'no torrent found' });
        res.json(downloader.getProgress(magnet));
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// GET {api}/stream/subs/{id}[/{season}/{episode}][?lang=] - WebVTT subtitles.
// Registered before /:id so "subs" is not swallowed as an id.
router.get('/api/stream/subs/:id', handleSubs);
router.get('/api/stream/subs/:id/:season/:episode', handleSubs);

// GET {api}/stream/{id}[/{season}/{episode}] - video, range requests
router.get('/api/stream/:id', handleStream);
router.get('/api/stream/:id/:season/:episode', handleStream);

// POST {api}/stream/download/{id}[/{season}/{episode}] - start the download
// (GET too: the player falls back to GET on 405/404.)
router.post('/api/stream/download/:id', handleDownload);
router.post('/api/stream/download/:id/:season/:episode', handleDownload);
router.get('/api/stream/download/:id', handleDownload);
router.get('/api/stream/download/:id/:season/:episode', handleDownload);

// Optional heartbeat - keeps the torrent alive during long watches (?heartbeat=1).
// Successful pings are silent (one per viewer per minute is spam); only
// failures are logged.
router.post('/api/stream/heartbeat', async (req, res) => {
    const { id, season, episode } = req.query;
    const session = sanitizeSession(req.query.session);
    if (!id) {
        console.log('[heartbeat] rejected: missing id');
        return res.status(400).json({ ok: false, status: 'idle' });
    }
    const magnet = sessionMagnet(String(id), season, episode, session)
        || magnetCache.get(keyFor(String(id), season, episode));
    if (!magnet) {
        console.log(`[heartbeat] unknown magnet for ${describeTarget(id, season, episode)}`);
        return res.status(404).json({ ok: false, status: 'idle' });
    }
    res.json(downloader.heartbeat(magnet));
});

export default router;
