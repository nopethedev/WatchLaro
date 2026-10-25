import axios from "axios";
import express from "express";
import NodeCache from "node-cache";

const router = express.Router();
const tvuiCache = new NodeCache({ stdTTL: 43200, checkperiod: 600 });

const TMDB_BASE = "https://api.themoviedb.org/3";

/** Home rows per TV UI mode. The first row also feeds the hero billboard. */
const MODES = {
    all: {
        title: "Home",
        rows: [
            { title: "Trending Now", path: "/trending/all/week" },
            { title: "Popular Movies", path: "/movie/popular" },
            { title: "Popular Shows", path: "/tv/popular" },
            { title: "New Releases", path: "/movie/now_playing" },
            { title: "Top Rated Movies", path: "/movie/top_rated" },
            { title: "Top Rated Shows", path: "/tv/top_rated" },
        ],
    },
    movie: {
        title: "Movies",
        rows: [
            { title: "Trending Movies", path: "/trending/movie/week" },
            { title: "Popular Movies", path: "/movie/popular" },
            { title: "New Releases", path: "/movie/now_playing" },
            { title: "Top Rated Movies", path: "/movie/top_rated" },
        ],
    },
    tv: {
        title: "Shows",
        rows: [
            { title: "Trending Shows", path: "/trending/tv/week" },
            { title: "Popular Shows", path: "/tv/popular" },
            { title: "On The Air", path: "/tv/on_the_air" },
            { title: "Top Rated Shows", path: "/tv/top_rated" },
        ],
    },
};

async function tmdbGet(pathname, params = {}) {
    const response = await axios.get(TMDB_BASE + pathname, {
        headers: {
            Authorization: "Bearer " + process.env.TMDB_KEY,
            "Content-Type": "application/json",
        },
        params,
        timeout: 15000,
    });
    return response.data;
}

/** Trim a TMDB movie/tv result down to what the TV cards need. */
function mapItem(media) {
    if (!media || !media.id) return null;
    const type = media.media_type === "tv" || media.media_type === "movie"
        ? media.media_type
        : (media.first_air_date !== undefined || media.name !== undefined ? "tv" : "movie");
    if (media.media_type === "person") return null;

    const date = type === "tv" ? media.first_air_date : media.release_date;
    const rating = typeof media.vote_average === "number" && media.vote_average > 0
        ? Math.round(media.vote_average * 10) / 10
        : null;

    return {
        id: media.id,
        type,
        title: (type === "tv" ? media.name : media.title) || "Untitled",
        overview: media.overview || "",
        poster: media.poster_path || null,
        backdrop: media.backdrop_path || null,
        year: date ? String(date).slice(0, 4) : null,
        rating,
    };
}

async function buildFeed(mode) {
    const config = MODES[mode] || MODES.all;
    const settled = await Promise.allSettled(config.rows.map((row) => tmdbGet(row.path)));

    const rows = [];
    settled.forEach((result, index) => {
        if (result.status !== "fulfilled") {
            console.error("[tvui] TMDB row failed:", config.rows[index].path, result.reason?.message);
            return;
        }
        const items = (result.value?.results || []).map(mapItem).filter(Boolean);
        if (items.length) rows.push({ title: config.rows[index].title, items });
    });

    // Bigger pool for the rotating billboard; dedupe titles that appear in
    // several rows (e.g. a show that is both popular and top rated).
    const seen = new Set();
    const hero = [];
    rows
        .flatMap((row) => row.items)
        .filter((item) => item.backdrop)
        .forEach((item) => {
            const key = item.type + ":" + item.id;
            if (seen.has(key)) return;
            seen.add(key);
            hero.push(item);
        });

    return { mode, rows, hero: hero.slice(0, 20) };
}

router.get("/api/tvui/feed", async (req, res) => {
    const mode = Object.hasOwn(MODES, String(req.query.type)) ? String(req.query.type) : "all";
    const cacheKey = "tvui:feed:" + mode;
    const cached = tvuiCache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
        const feed = await buildFeed(mode);
        if (!feed.rows.length) return res.status(502).json({ error: "Could not load the catalogue" });
        tvuiCache.set(cacheKey, feed);
        return res.json(feed);
    } catch (err) {
        console.error("[tvui/feed]", err?.message ?? err);
        return res.status(502).json({ error: "Could not load the catalogue" });
    }
});

router.get("/api/tvui/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ items: [] });
    if (q.length > 120) return res.status(400).json({ error: "Query is too long" });

    const cacheKey = "tvui:search:" + q.toLowerCase();
    const cached = tvuiCache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
        const data = await tmdbGet("/search/multi", { query: q, include_adult: "false", page: 1 });
        const items = (data.results || []).map(mapItem).filter(Boolean);
        const payload = { items };
        tvuiCache.set(cacheKey, payload);
        return res.json(payload);
    } catch (err) {
        console.error("[tvui/search]", err?.response?.status ?? err?.message ?? err);
        return res.status(502).json({ error: "Search is unavailable right now" });
    }
});

// Trailer lookup for the TV UI billboards. Returns null when TMDB has none,
// the client then simply keeps the title's banner image.
router.get("/api/tvui/videos/:type/:id", async (req, res) => {
    const type = req.params.type === "tv" ? "tv" : req.params.type === "movie" ? "movie" : null;
    const id = String(req.params.id ?? "");
    if (!type || !/^\d+$/.test(id)) return res.status(400).json({ error: "Invalid title" });

    const cacheKey = `tvui:videos:${type}:${id}`;
    const cached = tvuiCache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
        const data = await tmdbGet(`/${type}/${id}/videos`);
        const youtube = (data.results || []).filter((video) => video && video.site === "YouTube" && video.key);
        // Prefer English trailers, but fall back to whatever language exists.
        const english = youtube.filter((video) => !video.iso_639_1 || video.iso_639_1 === "en");
        const pool = english.length ? english : youtube;
        const trailer = pool.find((video) => video.type === "Trailer" && video.official)
            || pool.find((video) => video.type === "Trailer")
            || pool.find((video) => video.type === "Teaser")
            || null;

        const payload = {
            trailer: trailer ? { key: trailer.key, name: trailer.name, type: trailer.type } : null,
        };
        tvuiCache.set(cacheKey, payload);
        return res.json(payload);
    } catch (err) {
        console.error("[tvui/videos]", err?.response?.status ?? err?.message ?? err);
        return res.status(502).json({ error: "Could not load the trailer" });
    }
});

// Regex so it only matches the bare path: Express otherwise also matches
// "/tvui/", which would redirect the profile page to itself.
router.get(/^\/tvui$/, (req, res) => res.redirect("/tvui/"));

router.get("/tvui/", (req, res) => {
    res.render("tvui/profiles.ejs", { active: "profiles" });
});

for (const [slug, mode] of Object.entries({ home: "all", movies: "movie", shows: "tv" })) {
    router.get("/tvui/" + slug, (req, res) => {
        res.render("tvui/browse.ejs", {
            active: slug,
            mode,
            pageTitle: MODES[mode].title,
        });
    });
}

router.get("/tvui/search", (req, res) => {
    res.render("tvui/search.ejs", { active: "search", pageTitle: "Search" });
});

router.get("/tvui/info/:type/:id", (req, res) => {
    const { type, id } = req.params;
    if ((type !== "movie" && type !== "tv") || !/^\d+$/.test(String(id))) {
        return res.redirect("/tvui/home");
    }
    res.render("tvui/info.ejs", {
        active: "",
        pageTitle: "Details",
        type,
        id: String(id),
    });
});

router.get("/tvui/watch", (req, res) => {
    const type = req.query.type === "tv" ? "tv" : "movie";
    const id = String(req.query.id ?? "");
    if (!/^\d+$/.test(id)) return res.redirect("/tvui/home");

    const season = /^\d+$/.test(String(req.query.season ?? "")) ? String(req.query.season) : "";
    const episode = /^\d+$/.test(String(req.query.episode ?? "")) ? String(req.query.episode) : "";
    const title = typeof req.query.title === "string" ? req.query.title.slice(0, 200) : "";
    const episodeTitle = typeof req.query.episodeTitle === "string" ? req.query.episodeTitle.slice(0, 200) : "";
    const isSeries = type === "tv" && season !== "" && episode !== "";

    const embedParams = new URLSearchParams({ id });
    if (isSeries) {
        embedParams.set("season", season);
        embedParams.set("episode", episode);
    }
    // The player appends S/E itself, so pass the clean show title only.
    if (title) embedParams.set("title", title);
    if (episodeTitle) embedParams.set("episodeTitle", episodeTitle);
    embedParams.set("auto", "1");
    embedParams.set("embed", "1");
    embedParams.set("tvui", "1");

    const back = type === "tv" ? `/tvui/info/tv/${id}${season ? "?season=" + season : ""}` : `/tvui/info/movie/${id}`;
    const displayTitle = isSeries
        ? `${title || "Episode"} S${season}E${episode}`
        : (title || "Watch");

    res.render("tvui/watch.ejs", {
        pageTitle: displayTitle,
        embed: "/player.html?" + embedParams.toString(),
        back,
    });
});

export default router;
