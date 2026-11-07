import express from "express";
import getAndBuildFeedData from "../handlers/getAndBuildFeedData.js";
import nodeCache from "node-cache";
import { continueWatching, recommendationsForProfile } from "../handlers/profiles.js";
const feedCache = new nodeCache({ stdTTL: 43200, checkperiod: 600 })

const router = express.Router()

router.get("/api/movies/feed", async (req, res) => {
    let feed = feedCache.get("feed")
    if (!feed) {
        feed = await getAndBuildFeedData()
        if (feed) feedCache.set("feed", feed)
    }
    if (!feed) return res.status(502).json({ error: "Could not load the catalogue." })

    const profile = req.activeProfile && !req.activeProfile.guest ? req.activeProfile : null
    let recommended = []
    let continue_watching = []
    if (profile) {
        [recommended, continue_watching] = await Promise.all([
            recommendationsForProfile(profile, 18).catch(() => []),
            continueWatching(profile.id, 15).catch(() => [])
        ])
    }
    res.json({ ...feed, recommended, continue_watching })
})

export default router