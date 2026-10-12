import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import NodeCache from 'node-cache';
import * as downloader from '../handlers/downloader/index.js';
import tmdb from '../handlers/downloader/tmdb.js';

const router = express.Router();

/** tmdb id (+season/episode) -> magnet, so progress polls don't re-search. */
const magnetCache = new NodeCache({ stdTTL: 3600, checkPeriod: 600 });

const keyFor = (id, season, episode) =>
    season && episode ? `tv:${id}:${season}:${episode}` : `movie:${id}`;

async function resolveMagnet(id, season, episode) {
    const key = keyFor(id, season, episode);
    const cached = magnetCache.get(key);
    if (cached) return cached;

    let query;
    if (season && episode) {
        query = await tmdb.buildTVQuery(String(id), String(season), String(episode));
    } else {
        query = await tmdb.buildMovieQuery(String(id));
    }
    if (!query || query.includes('undefined')) return null;

    const results = await downloader.search(query, { limit: 20 });
    const magnet = results?.[0]?.magnet ?? null;
    if (magnet) magnetCache.set(key, magnet);
    return magnet;
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
                fs.createReadStream(abs, { start, end }).pipe(res);
                return true;
            }
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            res.end();
            return true;
        }
    }

    res.writeHead(200, { 'Content-Length': size });
    fs.createReadStream(abs).pipe(res);
    return true;
}

async function handleStream(req, res) {
    const { id, season, episode } = req.params;
    if (!id) return res.status(400).json({ status: 'error', error: 'missing id' });
    try {
        const magnet = await resolveMagnet(id, season, episode);
        if (!magnet) return res.status(404).json({ status: 'error', error: 'no torrent found' });

        // Series path finishes into a browser-ready mp4 - prefer it when done.
        try {
            const prog = downloader.getProgress(magnet);
            if (prog?.outputFile && serveFinishedFile(req, res, prog.outputFile)) return;
        } catch { /* fall through to live torrent streaming */ }

        await downloader.stream(magnet, req, res, { timeoutMin: 10 });
    } catch (err) {
        console.error('[stream]', err.message);
        if (!res.headersSent) res.status(500).json({ status: 'error', error: err.message });
    }
}

async function handleDownload(req, res) {
    const { id, season, episode } = req.params;
    if (!id) return res.status(400).json({ status: 'error', error: 'missing id' });
    try {
        const magnet = await resolveMagnet(id, season, episode);
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

// Specific paths first: Express matches in order, so /progress must come
// before /:id or "progress" gets swallowed as an id.
router.get('/api/stream/progress', async (req, res) => {
    const { id, season, episode } = req.query;
    if (!id) return res.status(400).json({ status: 'error', error: 'missing id' });
    try {
        const magnet = await resolveMagnet(String(id), season, episode);
        if (!magnet) return res.status(404).json({ status: 'error', error: 'no torrent found' });
        res.json(downloader.getProgress(magnet));
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

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
router.post('/api/stream/heartbeat', (req, res) => {
    const { id, season, episode } = req.query;
    if (!id) return res.status(400).json({ ok: false, status: 'idle' });
    const magnet = magnetCache.get(keyFor(String(id), season, episode));
    if (!magnet) return res.status(404).json({ ok: false, status: 'idle' });
    res.json(downloader.heartbeat(magnet));
});

export default router;
