import express from 'express';
import * as downloader from './handlers/downloader/index.js';
import tmdb from "./handlers/downloader/tmdb.js";

const router = express.Router();

router.get('/api/stream/:id{/:episode}{/:season}', async (req, res) => {
    const { id, season, episode } = req.params;
    if (!season && !episode && id) {
        const data = await tmdb.movieInfo(id);
        const magnet = await downloader.search(data.title)
        await downloader.stream(magnet, req, res, {timeoutMin: 5})
    }
})