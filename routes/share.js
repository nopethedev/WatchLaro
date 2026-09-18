import express from "express";
import path from "path";
import { createReadStream, statSync } from "fs";
import { Files } from "../database/index.js";
import { resolveStoredFile } from "../handlers/downloadsPath.js";

const app = express.Router();

const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo"
};

// Public share link: /share/<short code> streams the converted file
app.get("/share/:code", async (req, res) => {
  try {
    const file = await Files.findOne({ where: { shareCode: req.params.code } });
    if (!file || file.status !== "done") {
      return res.status(404).send("Share link not found");
    }

    const filePath = resolveStoredFile(file.path);
    if (!filePath) {
      return res.status(404).send("File is no longer available");
    }

    const fileSize = statSync(filePath).size;
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": contentType
      });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": fileSize,
        "Accept-Ranges": "bytes"
      });
      createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    console.error("Error serving shared file:", error);
    return res.status(500).send("Server error");
  }
});

export default app;
