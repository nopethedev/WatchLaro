import nodeCache from "node-cache";
import axios from "axios";
const movieAPICache = new nodeCache({ stdTTL: 43200, checkperiod: 600 })
async function tvInfo(id) {
    try {
        console.log("getting!")
        const cache = movieAPICache.get("TV" + id)
        if (!cache) {
            const response = await axios.get(`https://api.themoviedb.org/3/tv/${id}`, {
                headers: { Authorization: "Bearer " + process.env.TMDB_KEY, "Content-Type": "application/json" }
            });
            movieAPICache.set("TV" + id, response.data)
            console.log(response.data)
            return response.data
        } else {
            return cache
        }

    } catch (err) {
        console.log(err)
        return {error: "tmdb error!"}
    }
}

async function movieInfo(id){
     try {
        const cache = movieAPICache.get(id)
        if (!cache) {
            const response = await axios.get(`https://api.themoviedb.org/3/movie/${id}`, {
                headers: { Authorization: "Bearer " + process.env.TMDB_KEY, "Content-Type": "application/json" }
            });
            movieAPICache.set(id, response.data)
            return response.data;
        } else {
            return cache
        }

    } catch (err) {
        console.log(err)
        return {error: "tmdb error!"}
    }
}

async function buildTVQuery(id, season, episode){
    const { name } = await tvInfo(id)
    return `${name} S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`
}

async function buildMovieQuery(id){
    const { title, release_date } = await movieInfo(id)
    return `${title} ${release_date.slice(0,4)}`
}

/* ------------------------------------------------------------------ *
 * Release queries
 * Trackers name releases differently from TMDB ("The.Show.S01E01.1080p"
 * instead of "The Show S01E01"), and foreign titles are often only listed
 * under their original or alternative name. Build a list of queries to try
 * in order so a miss on one spelling does not mean the show is unavailable.
 * ------------------------------------------------------------------ */

const tmdbHeaders = () => ({
    Authorization: "Bearer " + process.env.TMDB_KEY,
    "Content-Type": "application/json",
});

const yearOf = (date) => (typeof date === "string" && date.length >= 4 ? date.slice(0, 4) : "");

/** TMDB title, original title and alternative titles, most useful first. */
async function releaseNames(type, id) {
    const cacheKey = `names:${type}:${id}`;
    const cached = movieAPICache.get(cacheKey);
    if (cached) return cached;

    const info = type === "tv" ? await tvInfo(id) : await movieInfo(id);
    const names = [];
    const add = (value) => {
        const text = String(value || "").trim();
        if (!text) return;
        if (names.some((name) => name.toLowerCase() === text.toLowerCase())) return;
        names.push(text);
    };

    add(type === "tv" ? info.name : info.title);
    add(type === "tv" ? info.original_name : info.original_title);

    try {
        const response = await axios.get(`https://api.themoviedb.org/3/${type}/${id}/alternative_titles`, {
            headers: tmdbHeaders(),
        });
        const list = type === "tv" ? response.data?.results : response.data?.titles;
        (list || []).forEach((entry) => add(entry?.title));
    } catch (err) {
        console.log("[tmdb] alternative titles failed:", err.message);
    }

    const result = {
        names: names.slice(0, 7),
        year: yearOf(type === "tv" ? info.first_air_date : info.release_date),
    };
    movieAPICache.set(cacheKey, result);
    return result;
}

/** "The Last of Us" -> "The.Last.of.Us", "Spider-Man" -> "Spider.Man". */
function dotify(name) {
    return String(name || "")
        .replace(/[\u2019']/g, "")
        .replace(/[^a-z0-9]+/gi, ".")
        .replace(/^\.+|\.+$/g, "");
}

const episodeTag = (season, episode) =>
    `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

async function buildTVQueries(id, season, episode) {
    const { names } = await releaseNames("tv", id);
    const tag = episodeTag(season, episode);
    const queries = [];

    names.forEach((name) => {
        queries.push(`${name} ${tag}`);
        const dotted = dotify(name);
        if (dotted && dotted !== name) queries.push(`${dotted}.${tag}`);
    });

    return [...new Set(queries)].slice(0, 8);
}

async function buildMovieQueries(id) {
    const { names, year } = await releaseNames("movie", id);
    const queries = [];
    const primary = names[0];

    if (primary) {
        const dotted = dotify(primary);
        if (year) queries.push(`${primary} ${year}`);
        if (year && dotted && dotted !== primary) queries.push(`${dotted}.${year}`);
        // Last resorts: some indexers only match the bare title, spaced or dotted.
        queries.push(primary);
        if (dotted && dotted !== primary) queries.push(dotted);
    }

    // Original / alternative titles help foreign releases that indexers list
    // under a different name than the English one.
    names.slice(1).forEach((name) => {
        const dotted = dotify(name);
        if (year) queries.push(`${name} ${year}`);
        if (year && dotted && dotted !== name) queries.push(`${dotted}.${year}`);
    });

    return [...new Set(queries)].slice(0, 10);
}

export default { tvInfo, movieInfo, buildTVQuery, buildMovieQuery, buildTVQueries, buildMovieQueries, releaseNames }