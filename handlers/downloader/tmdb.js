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

export default {tvInfo, movieInfo, buildTVQuery, buildMovieQuery}