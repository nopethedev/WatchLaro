import axios from "axios";
import express from "express";
import NodeCache from "node-cache";

const tvSearchCache = new NodeCache({ stdTTL: 43200, checkperiod: 600 })
const app = express.Router();

app.post("/api/tv/search", async (req, res) => {
    const getCache = tvSearchCache.get(req.body.q)
    if (!getCache) {
        let response = await axios.get('https://api.themoviedb.org/3/search/tv', {
            headers: {
                Authorization: `Bearer ${process.env.TMDB_KEY}`
            },
            params: {
                query: req.body.q,
                api_key: process.env.TMDB_KEY
            }
        });
        tvSearchCache.set(req.body.q, response.data)
        res.json(response.data)
    } else {
        res.json(getCache)
    }


});

//also returns season info.
app.post("/api/tv/info", async (req, res) => {
    const query = req.body.q
    const getCache = movieDataCache.get(toString("tv" + query))
    if (!getCache) {
        try {
            let response = await axios.get("https://api.themoviedb.org/3/tv/" + Number(query), {
                headers: { Authorization: "Bearer " + process.env.TMDB_KEY, "Content-Type": "application/json" }
            })
            movieDataCache.set("tv" + query, response.data)
            return res.json(response.data)
        } catch (err) {
            return res.status(500)
        }

    } else {
        return res.json(getCache)
    }
})

app.post("/api/tv/season/info", async (req, res) => {
    const query = req.body.q
    const season = req.body.season
    const getCache = movieDataCache.get(toString("tv" + "S" + season + query))
    if (!getCache) {
        try {
            let response = await axios.get("https://api.themoviedb.org/3/tv/" + Number(query) + "/season/" + Number(season), {
                headers: { Authorization: "Bearer " + process.env.TMDB_KEY, "Content-Type": "application/json" }
            })
            movieDataCache.set("tv" + "S" + season + query, response.data)
            return res.json(response.data)
        } catch (err) {
            return res.status(500)
        }

    } else {
        return res.json(getCache)
    }
})

export default app