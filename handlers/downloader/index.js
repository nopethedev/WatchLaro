import WebTorrent from 'webtorrent';
import TorrentSearchApi from 'torrent-search-api';
import path, { join } from 'path';
import { createHash } from 'crypto';
import fs, { existsSync, mkdirSync, statSync, createReadStream } from 'fs';
import nodeCache from 'node-cache';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import ffmpegLib from 'fluent-ffmpeg';
import searchMagnet from './searchMagnet.js';
import tmdb from './tmdb.js';

process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE') return; // ignore epipe
    console.error('Uncaught exception:', err);
});

ffmpegLib.setFfmpegPath(ffmpegPath);

let cleanupTimers = {};
let heartbeatTimers = {};

const movieCache = new nodeCache({ stdTTL: 432000, checkPeriod: 600 });
const heartbeatMapCache = new nodeCache({ stdTTL: 43200, checkperiod: 600 });
const movieSelectionCache = new nodeCache({ stdTTL: 432000, checkPeriod: 600 });

// Initialize WebTorrent client
export const client = new WebTorrent();

const DOWNLOAD_PATH = path.join(process.cwd(), 'downloads');
if (!existsSync(DOWNLOAD_PATH)) {
    mkdirSync(DOWNLOAD_PATH);
}

try {
    TorrentSearchApi.enableProvider('ThePirateBay');
    TorrentSearchApi.enableProvider('1337x');
    TorrentSearchApi.enableProvider('Limetorrents');
} catch (e) {
    console.error('[ERROR] Failed to enable providers:', e.message);
}

const getMimeType = (fileName) => {
    const ext = path.extname(fileName).toLowerCase();
    const map = {
        '.mp4': 'video/mp4',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.m4v': 'video/x-m4v'
    };
    return map[ext] || 'video/mp4';
};

async function timerClearDownload(magnet) {
    if (cleanupTimers[magnet]) clearTimeout(cleanupTimers[magnet]);

    console.log(`[IDLE] Potential stop detected. Waiting 15s...`);
    cleanupTimers[magnet] = setTimeout(() => {
        deleteDownloaded(magnet);
        delete cleanupTimers[magnet];
    }, 15 * 1000);
}

async function deleteDownloaded(magnet) {
    console.log("Stream stopped!");
    const activeTorrent = await client.get(magnet);
    if (activeTorrent) {
        console.log(`[CLEANUP] Deleting temp files for: ${activeTorrent.name}`);
        activeTorrent.destroy({ destroyStore: true }, (err) => {
            if (err) console.error('[ERROR] Cleanup failed:', err.message);
            else console.log('[SUCCESS] Disk space reclaimed.');
        });
    }
}

function createHeartbeatTimer(key) {
    heartbeatTimers[key] = setTimeout(() => {
        console.log("cleaning up, no heartbeat");
        const magnet = heartbeatMapCache.get(key);
        if (magnet) timerClearDownload(magnet);
        delete heartbeatTimers[key];
    }, 3 * 60 * 1000);
}

const serveFile = (filePath, fileSize, range, res) => {
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4'
        });
        createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': fileSize,
            'Accept-Ranges': 'bytes'
        });
        createReadStream(filePath).pipe(res);
    }
};

const startStreaming = async (torrent, req, res, magnet) => {
    let index = req.query?.server;
    if (!index || index === "null") {
        index = 0;
    }
    console.log('checking key:', req.params.id + "-" + index);
    console.log('heartbeatTimers keys:', Object.keys(heartbeatTimers));

    if (!req.params.season && !req.params.episode) {
        if (!heartbeatTimers[req.params.id + "-" + index]) {
            console.log("no heartbeat first");
            return res.status(403).send("Forbidden: No active heartbeat");
        }
        console.log("setting cache");
        heartbeatMapCache.set(req.params.id + "-" + index, magnet);
    } else {
        if (!heartbeatTimers[`${req.params.id}-${req.params.season}-${req.params.episode}`]) {
            return res.status(403).send("Forbidden: No active heartbeat");
        }
        heartbeatMapCache.set(`${req.params.id}-${req.params.season}-${req.params.episode}`, magnet);
    }

    let files = torrent.files.filter(f =>
        ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v'].some(ext => f.name.toLowerCase().endsWith(ext))
    );

    if (files.length === 0) {
        files = [...torrent.files].sort((a, b) => b.length - a.length);
    } else {
        files.sort((a, b) => b.length - a.length);
    }

    console.log("init stream...");
    const file = files[0];
    if (!file) return res.status(404).send("No video file found.");

    torrent.files.forEach(f => f.deselect());
    file.select(0, file.length - 1, 1);

    const mimeType = getMimeType(file.name);
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
        const chunksize = (end - start) + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${file.length}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': mimeType,
            'Connection': 'keep-alive'
        });

        const stream = file.createReadStream({ start, end, highWaterMark: 1024 * 1024 });
        stream.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Type': mimeType,
            'Content-Length': file.length,
            'Accept-Ranges': 'bytes'
        });
        const stream = file.createReadStream({ highWaterMark: 1024 * 1024 });
        stream.pipe(res);
    }
};

//unused
const startStreamingV2 = async (torrent, req, res, magnet) => {
    let files = torrent.files.filter(f =>
        ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v', '.ts'].some(ext => f.name.toLowerCase().endsWith(ext))
    );

    if (files.length === 0) {
        files = [...torrent.files].sort((a, b) => b.length - a.length);
    } else {
        files.sort((a, b) => b.length - a.length);
    }

    const file = files[0];
    if (!file) return res.status(404).send("No video file found.");
    torrent.files.forEach(f => f.deselect());
    file.select(0, file.length - 1, 1);

    const filePath = join(DOWNLOAD_PATH, file.path);
    const fileSize = statSync(filePath).size;
    const range = req.headers.range;

    const dn = file.name.toLowerCase();
    const needsTranscode = dn.includes('ddp') ||
        dn.includes('eac3') ||
        dn.includes('atmos') ||
        dn.includes('truehd') ||
        dn.includes('dts') ||
        dn.includes('ac3');

    if (needsTranscode) {
        const hash = createHash('md5').update(magnet).digest('hex').slice(0, 8);
        const outPath = join(DOWNLOAD_PATH, `${hash}_transcoded.mp4`);

        if (!existsSync(outPath)) {
            console.log('[TRANSCODE] Converting audio to AAC:', file.name);
            await new Promise((resolve, reject) => {
                ffmpegLib(filePath)
                    .inputOptions(['-probesize 50M', '-analyzeduration 50M'])
                    .outputOptions([
                        '-c:v copy',
                        '-c:a aac',
                        '-b:a 192k',
                        '-movflags +faststart',
                        '-fflags +genpts',
                        '-avoid_negative_ts make_zero'
                    ])
                    .on('start', cmd => console.log('[ffmpeg started]', cmd))
                    .on('end', () => {
                        console.log('[TRANSCODE] Done!');
                        resolve();
                    })
                    .on('error', err => reject(err))
                    .save(outPath);
            });
        } else {
            console.log('[TRANSCODE] Already transcoded, serving cached file');
        }

        const transcodedSize = statSync(outPath).size;
        serveFile(outPath, transcodedSize, range, res);
    } else {
        console.log('[STREAM] Direct serve:', file.name);
        serveFile(filePath, fileSize, range, res);
    }
};

// --- EXPORTED SERVICE FUNCTIONS ---

export async function getTorrentProgress(id, season, episode) {
    const magnet = await searchMagnet.search(await tmdb.buildTVQuery(id, season, episode), movieCache);
    const torrent = await client.get(magnet);

    if (!torrent) return { progress: 0, speed: 0, peers: 0 };

    return {
        progress: Math.round(torrent.progress * 100),
        speed: Math.round(torrent.downloadSpeed / 1024 / 1024),
        peers: torrent.numPeers
    };
}

export async function checkNeedsPreload(id, season, episode) {
    const magnet = await searchMagnet.search(await tmdb.buildTVQuery(id, season, episode), movieCache);
    const needs = searchMagnet.checkNeedsTranscode(magnet);
    return { needs };
}

export async function preloadTorrent(id, season, episode) {
    const key = `${id}-${season}-${episode}`;
    const magnet = await searchMagnet.search(await tmdb.buildTVQuery(id, season, episode), movieCache);

    movieCache.set(key, magnet);
    createHeartbeatTimer(key);
    console.log("downloading video...");

    let torrent = await client.get(magnet);
    if (!torrent) {
        torrent = await client.add(magnet, {
            sequential: true,
            path: DOWNLOAD_PATH,
        });
        torrent.on('error', err => console.error('[TORRENT ERROR]', err));
    }

    await new Promise((resolve) => {
        if (torrent.name) return resolve();
        torrent.once('metadata', resolve);
    });

    const dn = torrent.name.toLowerCase();
    const needsTranscode = dn.includes('ddp') ||
        dn.includes('eac3') ||
        dn.includes('atmos') ||
        dn.includes('truehd') ||
        dn.includes('dts') ||
        dn.includes('ac3');

    return { status: 'downloading', quickPlay: !needsTranscode };
}

export function handleHeartbeat(key) {
    console.log("got heartbeat key is: " + key);
    if (heartbeatTimers[key]) clearTimeout(heartbeatTimers[key]);
    createHeartbeatTimer(key);
    return { ok: true };
}

export async function getSubtitles(id, season = null, episode = null) {
    let url;
    if (season && episode) {
        url = `https://api.subdl.com/api/v1/subtitles?tmdb_id=${id}&season_number=${season}&episode_number=${episode}&language=EN`;
    } else {
        url = `https://api.subdl.com/api/v1/subtitles?tmdb_id=${id}&language=EN`;
    }

    const response = await fetch(url, { headers: { 'Api-Key': "subdl_IgTOLTBdcOuic7B6TZGw0L3KwhHiLQnEJD1zJHPcbIo" } });
    const data = await response.json();
    return { subUrl: data.subtitles?.[0]?.url };
}

export async function streamPreloadedMedia(id, season, episode, req, res) {
    const magnet = await searchMagnet.search(await tmdb.buildTVQuery(id, season, episode), movieCache);
    let torrent = await client.get(magnet);

    if (!torrent) return res.status(404).send('Torrent not found, preload first');

    if (torrent.ready) {
        startStreamingV2(torrent, req, res, magnet);
    } else {
        torrent.once('ready', () => startStreamingV2(torrent, req, res, magnet));
    }
}

export async function streamMedia(req, res) {
    let magnet;
    if (req.params.season && req.params.episode) {
        magnet = await searchMagnet.search(await tmdb.buildTVQuery(req.params.id, req.params.season, req.params.episode), movieCache, req.query.server || 0);
    } else {
        magnet = await searchMagnet.searchRank(await tmdb.buildMovieQuery(req.params.id), req, movieSelectionCache, movieCache, req.query.server || 0);
    }
    console.log(magnet);

    if (!magnet) return res.status(400).send("Magnet link required");

    let torrent = await client.get(magnet);

    if (torrent) {
        if (torrent.ready) startStreaming(torrent, req, res, magnet);
        else torrent.on('ready', () => startStreaming(torrent, req, res, magnet));
    } else {
        try {
            const extraTrackers = [
                'wss://tracker.openwebtorrent.com',
                'wss://tracker.btorrent.xyz',
                'http://tracker.opentrackr.org:1337/announce',
                'udp://tracker.openbittorrent.com:80/announce'
            ].map(t => `&tr=${encodeURIComponent(t)}`).join('');

            torrent = client.add(magnet + extraTrackers, {
                sequential: true,
                path: DOWNLOAD_PATH,
                maxWebConns: 4
            }, (t) => {
                t.files.forEach(file => file.deselect());
                console.log(`[START] Streaming: ${t.name}`);
                startStreaming(t, req, res, magnet);
            });

            torrent.on('error', (err) => console.error('[TORRENT ERROR]', err));
        } catch (err) {
            res.status(500).send("Failed to add torrent");
        }
    }
}

export async function downloadTorrent(magnet, downloadAll) {
    if (!magnet) return "error!";

    console.log("DOWNLOADER -- Loading in magnet...")
    let torrent = await client.get(magnet);

    if (torrent) {

    } else {
        try {
            console.log("DOWNLOADER -- Adding magnet...")
            const extraTrackers = [
                'wss://tracker.openwebtorrent.com',
                'wss://tracker.btorrent.xyz',
                'http://tracker.opentrackr.org:1337/announce',
                'udp://tracker.openbittorrent.com:80/announce'
            ].map(t => `&tr=${encodeURIComponent(t)}`).join('');

            torrent = client.add(magnet + extraTrackers, {
                path: DOWNLOAD_PATH
            }, async (t) => {
                console.log("DOWNLOADER -- Downloading torrent " + torrent.name);

                t.files.forEach(file => file.deselect());

                t.files
                    .filter(file =>
                        [".mp4", ".mkv", ".avi", ".webm", ".mov", ".m4v"]
                            .some(ext => file.name.toLowerCase().endsWith(ext))
                    )
                    .forEach(file => file.select());
            })
        } catch (err) {

        }
    }
}

export async function getDownloadProgress(magnet){
    const torrent = await client.get(magnet)

    if (!torrent){
        return 0
    }else{
        return Math.floor(torrent.progress * 100)
    }
}