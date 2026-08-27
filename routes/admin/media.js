import express from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import checkDiskSpace from "check-disk-space";
import authMiddleware from "../../handlers/authMiddleware.js";
import { Files } from "../../database/index.js";
import path from "path";
import axios from "axios";
import torrenter from "../../handlers/downloader/torrenter.js"

const app = express.Router();

// we call it media but its files.

app.get("/api/admin/files", authMiddleware.checkManager, async (req, res) => {
  const pagecount = req.query.page || 1;
  const limit = 75;
  const offset = (pagecount - 1) * limit;

  let files = await Files.findAndCountAll({ limit, offset, order: [["createdAt", "DESC"]] });
  await Promise.all(files.rows.map(async file => {
    console.log("Lopp")
    if (file.status === "downloading") {
      console.log("get progres")
      file.progress = await torrenter.getProgress(file.torrentHash) || 0;
    }
  }));
  res.json({ files: files.rows });
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
    console.log(hashMatch);
    const torrentHash = hashMatch ? hashMatch[1].toLowerCase() : null;
    console.log(torrentHash);

    // 1. Create initial DB record with status 'downloading'
    const dbFile = await Files.create({
      name: "Loading Name...",
      path: "/pending",
      torrentHash: hashMatch[1].toLowerCase(),
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
    let currentStage = 'download';

    torrenter.downloadAndConvert(
      magnet,
      {
        downloadDir: "../../../downloads",
        // Triggered 1-3 seconds after metadata arrives
        onReady: async ({ outputPath, videoFile, torrent }) => {
          // Ensure path doesn't break VARCHAR(100) limit
          const safePath = outputPath.length > 100
            ? outputPath.substring(outputPath.length - 100)
            : outputPath;
          console.log(outputPath)
          await dbFile.update({
            name: videoFile.name,
            path: safePath,
            torrentHash: torrent ? torrent.infoHash : null
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
      // 4. Update status to 'done' when process finishes
      const finalPath = result.outputPath || result.inputPath;
      const safePath = finalPath.length > 100
        ? finalPath.substring(finalPath.length - 100)
        : finalPath;

      await dbFile.update({
        status: "done",
        path: safePath
      });
      console.log(`[File #${dbFile.id}] Finished successfully.`);
    }).catch(async (err) => {
      // 5. Update status to 'failed' if an error occurs
      console.error(`[File #${dbFile.id}] Process failed:`, err);
      await dbFile.update({ status: "failed" });
    });

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

app.get("/api/admin/files/diskQuota", authMiddleware.checkManager, async (req, res) => {
  const diskPath = process.platform === "win32" ? path.parse(process.cwd()).root : "/";
  const disk = await checkDiskSpace(path.parse(diskPath));

  return res.json(disk);
});


export default app;