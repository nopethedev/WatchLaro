import axios from 'axios'

export default async function () {
    try {
        const jsonOutput = {
            now_playing: {},
            popular: {},
            top_rated: {}
        }
        let now_playing = await axios.get("https://api.themoviedb.org/3/movie/now_playing", {
            headers: {
                Authorization: "Bearer " + process.env.TMDB_KEY,
                "Content-Type": "application/json"
            }
        })
        let popular = await axios.get("https://api.themoviedb.org/3/movie/popular", {
            headers: {
                Authorization: "Bearer " + process.env.TMDB_KEY,
                "Content-Type": "application/json"
            }
        })
        let top_rated = await axios.get("https://api.themoviedb.org/3/movie/top_rated", {
            headers: {
                Authorization: "Bearer " + process.env.TMDB_KEY,
                "Content-Type": "application/json"
            }
        })
        jsonOutput.now_playing = now_playing.data
        jsonOutput.popular = popular.data
        jsonOutput.top_rated = top_rated.data
        console.log(jsonOutput)
        return jsonOutput
        
    } catch (err) {
        console.log(err)
    }


}