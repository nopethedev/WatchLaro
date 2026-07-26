import axios from "axios";
import express from "express";
import nodeCache from "node-cache"

const movieDataCache = new nodeCache({ stdTTL: "43200", checkperiod: "600" });

const app = express.Router()

app.post("/api/movies/search", async (req, res) => {
    let response = await fetch("https://api.2embed.cc/search?q=" + req.body.q);
    response = await response.json();
    res.json(response);
});

app.post("/api/movies/info", async (req, res) => {
    const query = req.body.q
    const getCache = movieDataCache.get(toString(query))
    if (!getCache) {
        try {
            let response = await axios.get("https://api.themoviedb.org/3/movie/" + Number(query), {
                headers: { Authorization: "Bearer " + process.env.TMDB_KEY, "Content-Type": "application/json" }
            })

            movieDataCache.set(query, response.data)
            return res.json(response.data)
        } catch (err) {
            return res.status(500)
        }

    } else {
        return res.json(getCache)
    }
})

export default app;