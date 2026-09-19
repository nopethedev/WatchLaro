import express from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import checkDiskSpace from "check-disk-space";
import authMiddleware from "../../handlers/authMiddleware.js";
import { Files } from "../../database/index.js";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import axios from "axios";
import torrenter from "../../handlers/downloader/torrenter.js"
import { downloadsDir, resolveStoredFile } from "../../handlers/downloadsPath.js"

const app = express.Router();

// we call it media but its files.

app.get("/api/admin/files", authMiddleware.checkManager, async (req, res) => {
  const pagecount = req.query.page || 1;
  const limit = 75;
  const offset = (pagecount - 1) * limit;

  let files = await Files.findAndCountAll({ limit, offset, order: [["createdAt", "DESC"]] });

  // Sequelize instances only serialize model attributes, so build plain objects
  // and attach the live torrent progress onto those instead.
  const rows = await Promise.all(files.rows.map(async file => {
    const plain = file.toJSON();
    if (file.status === "downloading") {
      const stats = await torrenter.getProgress(file.torrentHash);
      plain.progress = stats ? Number(stats.progress) : 0;
    }
    return plain;
  }));

  res.json({ files: rows });
});

app.get("/api/admin/movie/search", authMiddleware.checkManager, async (req, res) => {
  //const getCache = tvSearchCache.get(req.body.q)
  if (true) {
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
  } else {
    res.json(getCache)
  }


});

app.get("/api/admin/torrent/search", authMiddleware.checkManager, async (req, res) => {
  const query = req.query.q
  const response = await torrenter.search(query, { limit: 50 });
  return res.json(response);
});

// Runs the full download + conversion pipeline for a Files DB row.
// Used by the create route and to resume downloads after a server restart.
async function startTorrentDownload(dbFile) {
  let currentStage = 'download';

  torrenter.downloadAndConvert(
    dbFile.magnet,
    {
      downloadDir: downloadsDir,
      // Triggered 1-3 seconds after metadata arrives
      onReady: async ({ outputPath, videoFile, torrent }) => {
        // Store the path relative to downloads/ so it stays short (and
        // resolvable); the column is only VARCHAR(100)
        const relPath = path.relative(downloadsDir, outputPath);
        const safePath = relPath.length > 100
          ? relPath.substring(relPath.length - 100)
          : relPath;
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
    const safePath = relPath.length > 100
      ? relPath.substring(relPath.length - 100)
      : relPath;

    await dbFile.update({
      status: "done",
      path: safePath
    });
    console.log(`[File #${dbFile.id}] Finished successfully.`);
  }).catch(async (err) => {
    // Update status to 'failed' if an error occurs
    console.error(`[File #${dbFile.id}] Process failed:`, err);
    await dbFile.update({ status: "failed" });
  });
}

//had to do this because its so confusing
app.post("/api/admin/torrent/create", authMiddleware.checkManager, async (req, res) => {
  try {
    const {
      magnet,
      tmdbId = 0,
      type = "movie",
      season = null,
      episode = null,
      quality = "1080p"
    } = req.body;

    if (!magnet) {
      return res.status(400).json({ success: false, error: "magnet and tmdbId are required" });
    }

    const hashMatch = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
    // BitTorrent info hashes are 40 hex chars (v1) or 32 base32 chars
    const isValidHash = hashMatch && (/^[a-f0-9]{40}$/i.test(hashMatch[1]) || /^[a-z2-7]{32}$/i.test(hashMatch[1]));
    if (!isValidHash) {
      return res.status(400).json({ success: false, error: "Invalid magnet: no valid info hash found" });
    }
    const torrentHash = hashMatch[1].toLowerCase();

    // 1. Create initial DB record with status 'downloading'
    const dbFile = await Files.create({
      name: "Loading Name...",
      path: "/pending",
      torrentHash: torrentHash,
      magnet: magnet,
      quality: quality,
      linkedId: parseInt(tmdbId, 10),
      status: "downloading",
      type: type, // "movie" or "tv"
      season: season ? parseInt(season, 10) : null,
      episode: episode ? parseInt(episode, 10) : null,
      createdAt: Math.floor(Date.now() / 1000) // 10-digit Unix timestamp
    });

    // 2. Respond immediately so the API request doesn't time out
    res.status(200).json({ success: true, file: dbFile });
    console.log("Loading...")

    // 3. Start background download & conversion process
    startTorrentDownload(dbFile);

  } catch (error) {
    console.error("Error initiating torrent process:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

app.get("/api/admin/torrent/progress", async (req, res) => {
  return res.json(await torrenter.getProgress(req.query.hash));
});

app.delete("/api/admin/files/:uuid", authMiddleware.checkManager, async (req, res) => {
  try {
    const file = await Files.findOne({ where: { uuid: req.params.uuid } });

    if (!file) {
      return res.status(404).json({ success: false, error: "File not found" });
    }

    // Stop the torrent (and drop its data from disk) if it is still active
    if (file.torrentHash) {
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

    const paused = torrenter.pause(file.torrentHash);
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

    const resumed = torrenter.resume(file.torrentHash);
    if (!resumed) {
      return res.status(409).json({ success: false, error: "Torrent is not active on the server" });
    }

    await file.update({ status: "downloading" });
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
Files.findAll({ where: { status: "downloading" } })
  .then((rows) => rows.forEach((file) => {
    if (!file.magnet) return;
    console.log(`[BOOT] Resuming download for file #${file.id}`);
    startTorrentDownload(file);
  }))
  .catch((err) => console.error("[BOOT] Failed to resume downloads:", err));


export default app;