import express from "express";
import { z } from "zod";
import { Op } from "sequelize";
import checkDiskSpace from "check-disk-space";
import authMiddleware from "../../handlers/authMiddleware.js";
import { Files } from "../../database/index.js";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import axios from "axios";
import torrenter from "../../handlers/downloader/torrenter.js"
import { downloadsDir, resolveStoredFile } from "../../handlers/downloadsPath.js"

import { getAdminSettings } from '../../handlers/adminSettings.js';
const app = express.Router();

// we call it media but its files.

app.get("/api/admin/files", authMiddleware.checkManager, async (req, res) => {
  const pagecount = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 25;
  const offset = (pagecount - 1) * limit;

  const where = req.query.q ? { name: { [Op.like]: `%${String(req.query.q).slice(0, 100)}%` } } : {};
  if (['movie','tv'].includes(req.query.type)) where.type = req.query.type;
  if (['downloading','paused','transcoding','done','failed'].includes(req.query.status)) where.status = req.query.status;
  let files = await Files.findAndCountAll({ where, limit, offset, order: [["createdAt", "DESC"]] });

  // Sequelize instances only serialize model attributes, so build plain objects
  // and attach the live torrent progress onto those instead.
  const rows = await Promise.all(files.rows.map(async file => {
    const plain = file.toJSON();
    plain.queued = queue.some(item => item.uuid === file.uuid);
    if (file.status === "downloading") {
      const stats = await torrenter.getProgress(file.torrentHash);
      plain.progress = stats ? Number(stats.progress) : 0;
    }
    return plain;
  }));

  res.json({ files: rows, total: files.count, page: pagecount, pages: Math.max(1, Math.ceil(files.count / limit)) });
});

app.get("/api/admin/movie/search", authMiddleware.checkManager, async (req, res) => {
  //const getCache = tvSearchCache.get(req.body.q)
  try {
    let response = await axios.get('https://api.themoviedb.org/3/search/movie', {
      headers: {
        Authorization: `Bearer ${process.env.TMDB_KEY}`
      },
      params: {
        query: req.query.q,
        api_key: process.env.TMDB_KEY
      }
    });
    //tvSearchCache.set(req.query.q, response.data)
    res.json(response.data.results.filter(movie => !movie.adult))
  } catch { res.status(502).json({ error: "Movie search failed" }); }


});

app.get("/api/admin/torrent/search", authMiddleware.checkManager, async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) return res.status(400).json({ error: 'Missing search query' });
    return res.json(await torrenter.search(query, { limit: 50 }));
  } catch { return res.status(502).json({ error: 'Torrent search failed' }); }
});

// Runs the full download + conversion pipeline for a Files DB row.
// Used by the create route and to resume downloads after a server restart.
async function startTorrentDownload(dbFile) {
  let currentStage = 'download';

  return torrenter.downloadAndConvert(
    dbFile.magnet,
    {
      downloadDir: path.join(downloadsDir, dbFile.uuid),
      outputPath: path.join(downloadsDir, `${dbFile.uuid}.mp4`),
      selectVideo: dbFile.type === 'tv' ? (name) => {
        const match = /s(\d+)e(\d+)(?!\d)|\b(\d+)x(\d+)(?!\d)/i.exec(name);
        return match && Number(match[1] || match[3]) === dbFile.season && Number(match[2] || match[4]) === dbFile.episode;
      } : undefined,
      // Triggered 1-3 seconds after metadata arrives
      onReady: async ({ outputPath, videoFile, torrent }) => {
        // Store the path relative to downloads/ so it stays short (and
        // resolvable); the column is only VARCHAR(100)
        const relPath = path.relative(downloadsDir, outputPath);
        const safePath = relPath.length <= 100 ? relPath : '/pending';
        console.log(outputPath)
        await dbFile.update({
          name: videoFile.name,
          path: safePath,
          torrentHash: torrent ? torrent.infoHash : dbFile.torrentHash
        });
        console.log("Start download for file")
      }
    },
    async (progress) => {
      // Update database status to 'transcoding' when FFmpeg starts
      if (progress.stage === 'convert' && currentStage !== 'convert') {
        currentStage = 'convert';
        await dbFile.update({ status: "transcoding" });
      }

      if (progress.stage === 'download') {
        console.log("downlaoding... progress:" + progress.progress + "speed: " + progress.downloadSpeed)
      } else if (progress.stage === 'convert') {
        console.log(`[File #${dbFile.id}] Transcoding: ${progress.percent?.toFixed(1)}%`);
      }
    }
  ).then(async (result) => {
    // Update status to 'done' when process finishes
    const finalPath = result.outputPath || result.inputPath;
    const relPath = path.relative(downloadsDir, finalPath);
    const safePath = relPath;

    await dbFile.update({
      status: "done",
      path: safePath
    });
    await torrenter.remove(dbFile.torrentHash, false);
    console.log(`[File #${dbFile.id}] Finished successfully.`);
  }).catch(async (err) => {
    // Update status to 'failed' if an error occurs
    console.error(`[File #${dbFile.id}] Process failed:`, err);
    await dbFile.update({ status: "failed" });
    await torrenter.remove(dbFile.torrentHash, false);
  });
}

// Serial jobs avoid duplicate WebTorrent instances for season packs and bound CPU/disk work.
const queue = [];
let running = false;
function enqueue(file) {
  queue.push(file);
  void drainQueue().catch(err => console.error('[queue]', err.message));
}
export async function drainQueue() {
  if (running || getAdminSettings().pauseQueue) return;
  running = true;
  try {
    while (queue.length && !getAdminSettings().pauseQueue) {
      const file = queue.shift();
      try { await file.reload(); } catch (err) {
        if (err.name === 'SequelizeInstanceError') continue;
        throw err;
      }
      if (file.status !== 'downloading') continue;
      try { await startTorrentDownload(file); }
      catch (err) { console.error('[queue]', err.message); }
    }
  } finally { running = false; }
}

const downloadSchema = z.object({
  magnet: z.string().regex(/^magnet:\?.*xt=urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})(?:&|$)/i),
  tmdbId: z.coerce.number().int().positive(),
  type: z.enum(['movie', 'tv']).default('movie'),
  season: z.coerce.number().int().min(0).nullable().optional(),
  episode: z.coerce.number().int().positive().nullable().optional(),
  quality: z.string().min(1).max(30).default('1080p')
}).refine(data => data.type !== 'tv' || (data.season != null && data.episode != null), { message: 'TV downloads require season and episode' });

let creating = Promise.resolve();
function createDownload(data) {
  const job = creating.then(async () => {
    const where = { linkedId: data.tmdbId, type: data.type,
      season: data.type === 'tv' ? data.season : null,
      episode: data.type === 'tv' ? data.episode : null,
      status: { [Op.in]: ['downloading', 'paused', 'transcoding', 'done'] } };
    const existing = await Files.findOne({ where });
    if (existing && (existing.status !== 'done' || resolveStoredFile(existing.path))) return { file: existing, skipped: true };
    const file = await Files.create({ ...where, status: 'downloading', name: data.type === 'tv' ? `S${data.season}E${data.episode} — Waiting for download` : 'Waiting for download',
      path: '/pending', magnet: data.magnet, torrentHash: /btih:([a-z0-9]+)/i.exec(data.magnet)[1].toLowerCase(),
      quality: data.quality, createdAt: Math.floor(Date.now() / 1000) });
    enqueue(file);
    return { file, skipped: false };
  });
  creating = job.catch(() => {});
  return job;
}

app.get('/api/admin/tv/search', authMiddleware.checkManager, async (req, res) => {
  try {
    const response = await axios.get('https://api.themoviedb.org/3/search/tv', {
      headers: { Authorization: `Bearer ${process.env.TMDB_KEY}` }, params: { query: String(req.query.q || '') }, timeout: 15000
    });
    res.json(response.data.results.filter(show => !show.adult));
  } catch { res.status(502).json({ error: 'Series search failed' }); }
});

app.post('/api/admin/torrent/bulk', authMiddleware.checkManager, async (req, res) => {
  const parsed = z.object({ items: z.array(downloadSchema).min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Provide 1–500 valid episode downloads' });
  try {
    const results = [];
    for (const item of parsed.data.items) results.push(await createDownload(item));
    res.status(202).json({ success: true, added: results.filter(r => !r.skipped).length, skipped: results.filter(r => r.skipped).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Single movie or episode.
app.post("/api/admin/torrent/create", authMiddleware.checkManager, async (req, res) => {
  try {
    const parsed = downloadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'A valid magnet, TMDB id and episode coordinates (for TV) are required' });
    const result = await createDownload(parsed.data);
    return res.status(result.skipped ? 200 : 202).json({ success: true, ...result });


  } catch (error) {
    console.error("Error initiating torrent process:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

app.get("/api/admin/torrent/progress", authMiddleware.checkManager, async (req, res) => {
  return res.json(await torrenter.getProgress(req.query.hash));
});

app.delete("/api/admin/files/:uuid", authMiddleware.checkManager, async (req, res) => {
  try {
    const file = await Files.findOne({ where: { uuid: req.params.uuid } });

    if (!file) {
      return res.status(404).json({ success: false, error: "File not found" });
    }

    // Stop the torrent (and drop its data from disk) if it is still active
    if (file.status === "transcoding") return res.status(409).json({ error: "Wait for conversion to finish before deleting this file" });
    await file.update({ status: "failed" });
    if (file.torrentHash && torrenter.findClientTorrent(file.torrentHash)?.path === path.join(downloadsDir, file.uuid)) {
      try {
        await torrenter.remove(file.torrentHash, true);
      } catch (err) {
        console.error("Failed to remove torrent:", err);
      }
    }

    // torrenter.remove only wipes the torrent store; the converted MP4 (ffmpeg
    // output, not part of the torrent) must be deleted separately or it leaks
    // on disk forever.
    const filePath = resolveStoredFile(file.path);
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error("Failed to delete converted file:", err);
      }
    }

    fs.rmSync(path.join(downloadsDir, file.uuid), { recursive: true, force: true });
    fs.rmSync(path.join(downloadsDir, `${file.uuid}.mp4`), { force: true });
    await file.destroy();

    return res.json({ success: true });
  } catch (error) {
    console.error("Error deleting file:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/files/:uuid/pause", authMiddleware.checkManager, async (req, res) => {
  try {
    const file = await Files.findOne({ where: { uuid: req.params.uuid } });
    if (!file) {
      return res.status(404).json({ success: false, error: "File not found" });
    }
    if (file.status !== "downloading") {
      return res.status(400).json({ success: false, error: "File is not downloading" });
    }

    const paused = queue.some(item => item.uuid === file.uuid) || torrenter.pause(file.torrentHash);
    if (!paused) {
      return res.status(409).json({ success: false, error: "Torrent is not active on the server" });
    }

    await file.update({ status: "paused" });
    return res.json({ success: true, status: "paused" });
  } catch (error) {
    console.error("Error pausing download:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/files/:uuid/resume", authMiddleware.checkManager, async (req, res) => {
  try {
    const file = await Files.findOne({ where: { uuid: req.params.uuid } });
    if (!file) {
      return res.status(404).json({ success: false, error: "File not found" });
    }
    if (file.status !== "paused") {
      return res.status(400).json({ success: false, error: "File is not paused" });
    }

    const resumed = torrenter.findClientTorrent(file.torrentHash)?.path === path.join(downloadsDir, file.uuid) && torrenter.resume(file.torrentHash);
    await file.update({ status: "downloading" });
    if (!resumed && !queue.some(item => item.uuid === file.uuid)) enqueue(file);
    return res.json({ success: true, status: "downloading" });
  } catch (error) {
    console.error("Error resuming download:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Override for downloads stuck just below 100% (e.g. deselected junk files
// that never finish): stop waiting and transcode what is already downloaded.
app.post("/api/admin/files/:uuid/skip", authMiddleware.checkManager, async (req, res) => {
  try {
    const file = await Files.findOne({ where: { uuid: req.params.uuid } });
    if (!file) {
      return res.status(404).json({ success: false, error: "File not found" });
    }
    if (file.status !== "downloading") {
      return res.status(400).json({ success: false, error: "File is not downloading" });
    }

    const skipped = torrenter.requestSkip(file.torrentHash);
    if (!skipped) {
      return res.status(409).json({ success: false, error: "Torrent is not active on the server" });
    }

    await file.update({ status: "transcoding" });
    return res.json({ success: true, status: "transcoding" });
  } catch (error) {
    console.error("Error skipping download:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/files/:uuid/retry', authMiddleware.checkManager, async (req, res) => {
  try {
    const file = await Files.findOne({ where: { uuid: req.params.uuid } });
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.status !== 'failed') return res.status(409).json({ error: 'Only failed downloads can be retried' });
    await file.update({ status: 'downloading' });
    enqueue(file);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/admin/files/:uuid', authMiddleware.checkManager, async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(255), quality: z.string().min(1).max(30),
    linkedId: z.coerce.number().int().positive(), type: z.enum(['movie','tv']),
    season: z.number().int().min(0).nullable(), episode: z.number().int().positive().nullable()
  }).refine(data => data.type !== 'tv' || (data.season !== null && data.episode !== null), { message: 'Series require season and episode' }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the name, TMDB id, quality and episode numbers' });
  try {
    const file = await Files.findOne({ where: { uuid: req.params.uuid } });
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!['done','failed'].includes(file.status)) return res.status(409).json({ error: 'Finish or fail the download before editing its metadata' });
    await file.update({ ...parsed.data, ...(parsed.data.type === 'movie' ? {season:null,episode:null} : {}) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/files/:uuid/share', authMiddleware.checkManager, async (req, res) => {
  try {
    const file = await Files.findOne({ where: { uuid: req.params.uuid } });
    if (!file) return res.status(404).json({ error: 'File not found' });
    await file.update({ shareCode: null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const SHARE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid misreading
const generateShareCode = () =>
  Array.from(randomBytes(6)).map(byte => SHARE_ALPHABET[byte % SHARE_ALPHABET.length]).join("");

// Get (or create) a short share code for a finished download.
app.post("/api/admin/files/:uuid/share", authMiddleware.checkManager, async (req, res) => {
  try {
    const file = await Files.findOne({ where: { uuid: req.params.uuid } });
    if (!file) {
      return res.status(404).json({ success: false, error: "File not found" });
    }
    if (file.status !== "done") {
      return res.status(400).json({ success: false, error: "Only finished downloads can be shared" });
    }

    let code = file.shareCode;
    if (!code) {
      for (let i = 0; i < 5; i++) {
        const candidate = generateShareCode();
        const exists = await Files.findOne({ where: { shareCode: candidate } });
        if (!exists) {
          code = candidate;
          break;
        }
      }
      if (!code) {
        return res.status(500).json({ success: false, error: "Could not generate a unique share code" });
      }
      await file.update({ shareCode: code });
    }

    const url = `${req.protocol}://${req.get("host")}/share/${code}`;
    return res.json({ success: true, code, url });
  } catch (error) {
    console.error("Error creating share link:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/admin/files/diskQuota", authMiddleware.checkManager, async (req, res) => {
  try {
    const diskPath = process.platform === "win32" ? path.parse(process.cwd()).root : "/";
    // check-disk-space expects a plain path string, not a parsed path object
    const disk = await checkDiskSpace(diskPath);

    return res.json(disk);
  } catch (error) {
    console.error("Error checking disk space:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
// Re-attach downloads that were interrupted by a server restart (including
// ones stuck near 100% with deselected junk files) so they finish and convert.
export function resumeDownloads() {
return Files.findAll({ where: { status: { [Op.in]: ["downloading", "transcoding"] } } })
  .then(async (rows) => { for (const file of rows) {
    if (!file.magnet) continue;
    await file.update({ status: "downloading" });
    console.log(`[BOOT] Resuming download for file #${file.id}`);
    enqueue(file);
  } })
  .catch((err) => console.error("[BOOT] Failed to resume downloads:", err));


}

export default app;