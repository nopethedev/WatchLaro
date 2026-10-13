import axios from "axios";
import express from "express";
import NodeCache from "node-cache";

const tvSearchCache = new NodeCache({ stdTTL: 43200, checkperiod: 600 })
const tvInfoCache = new NodeCache({ stdTTL: 43200, checkperiod: 600 })
const app = express.Router();

app.post("/api/tv/search", async (req, res) => {
    const q = String(req.body?.q ?? "")
    if (!q.trim()) {
        return res.status(400).json({ error: "Missing query" })
    }
    const cached = tvSearchCache.get(q)
    if (cached) {
        return res.json(cached)
    }
    try {
        let response = await axios.get('https://api.themoviedb.org/3/search/tv', {
            headers: {
                Authorization: `Bearer ${process.env.TMDB_KEY}`
            },
            params: {
                query: q
            }
        });
        tvSearchCache.set(q, response.data)
        return res.json(response.data)
    } catch (err) {
        console.error("TMDB tv search failed:", err?.response?.status ?? err?.message ?? err)
        return res.status(502).json({ error: "TMDB request failed" })
    }
});

//also returns season info.
app.post("/api/tv/info", async (req, res) => {
    const query = String(req.body?.q ?? "")
    if (!query.trim() || !Number.isFinite(Number(query))) {
        return res.status(400).json({ error: "Missing or invalid id" })
    }
    const cacheKey = "tv:info:" + query
    const getCache = tvInfoCache.get(cacheKey)
    if (!getCache) {
        try {
            let response = await axios.get("https://api.themoviedb.org/3/tv/" + Number(query), {
                headers: { Authorization: "Bearer " + process.env.TMDB_KEY, "Content-Type": "application/json" }
            })
            tvInfoCache.set(cacheKey, response.data)
            return res.json(response.data)
        } catch (err) {
            console.error("TMDB tv info failed:", err?.response?.status ?? err?.message ?? err)
            if (err?.response?.status === 404) {
                return res.status(404).json({ error: "TV show not found" })
            }
            return res.status(502).json({ error: "TMDB request failed" })
        }

    } else {
        return res.json(getCache)
    }
})

app.post("/api/tv/season/info", async (req, res) => {
    const query = String(req.body?.q ?? "")
    const season = String(req.body?.season ?? "")
    if (!query.trim() || !Number.isFinite(Number(query)) || !Number.isFinite(Number(season))) {
        return res.status(400).json({ error: "Missing or invalid id/season" })
    }
    const cacheKey = "tv:season:" + query + ":" + season
    const getCache = tvInfoCache.get(cacheKey)
    if (!getCache) {
        try {
            let response = await axios.get("https://api.themoviedb.org/3/tv/" + Number(query) + "/season/" + Number(season), {
                headers: { Authorization: "Bearer " + process.env.TMDB_KEY, "Content-Type": "application/json" }
            })
            tvInfoCache.set(cacheKey, response.data)
            return res.json(response.data)
        } catch (err) {
            console.error("TMDB tv season info failed:", err?.response?.status ?? err?.message ?? err)
            if (err?.response?.status === 404) {
                return res.status(404).json({ error: "Season not found" })
            }
            return res.status(502).json({ error: "TMDB request failed" })
        }

    } else {
        return res.json(getCache)
    }
})

export default app
