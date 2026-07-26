import express from "express";
import getAndBuildFeedData from "../handlers/getAndBuildFeedData.js";
import nodeCache from "node-cache";
const feedCache = new nodeCache({ stdTTL: 43200, checkperiod: 600 })

const router = express.Router()

router.get("/api/movies/feed", async (req, res) => {
    const getCache = feedCache.get("feed")
    if (!getCache) {
        const response = await getAndBuildFeedData()
        feedCache.set("feed", response)
        return res.json(response)
    } else {
        return res.json(getCache)
    }
})

export default router