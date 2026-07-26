import TorrentSearchApi from 'torrent-search-api';
import rankTVTorrent from './rankTVTorrent.js';
import rankDevice from './rankDevice.js';
import rankTorrents from './rankTorrents.js';
import rankTV from './rankTVTorrent.js';
async function search(query, movieCache, server) { //still rank but less strict
    console.log("query is" + query)
    try {
        const cachedResult = movieCache.get(query)
        if (cachedResult) {
            return cachedResult[Number(server) || 0].magnet
        } else {
            const results = await TorrentSearchApi.search(query, 'All', 20);
            const formattedResults = await Promise.all(results.map(async (result) => {
                try {
                    let magnet = await TorrentSearchApi.getMagnet(result);
                    if (!magnet && result.infoHash) {
                        magnet = `magnet:?xt=urn:btih:${result.infoHash}&dn=${encodeURIComponent(result.title)}`;
                    }
                    return magnet ? {
                        title: result.title,
                        magnet: magnet,
                        seeders: parseInt(result.seeds) || 0,
                        size: result.size || 'Unknown'
                    } : null;
                } catch (err) { return null; }
            }));
            const filteredResults = formattedResults
                .filter(r => {
                    const title = r.title.toLowerCase().replace(/[.\-_]/g, ' ') // normalize dots/dashes to spaces
                    const q = query.toLowerCase().replace(/[.\-_]/g, ' ')
                    return title.startsWith(q)
                })
                .sort((a, b) => b.seeders - a.seeders)
            movieCache.set(query, rankTVTorrent(filteredResults))
            console.log(rankTVTorrent(filteredResults))
            return rankTVTorrent(filteredResults)[Number(server) || 0].magnet
        }

    } catch (error) {
        console.log(error)
        return null;
        //res.status(500).json({ error: "Search failed" });
    }
}

const searchRank = async function (query, req, movieSelectionCache, movieCache, count) {
    console.log("query is" + query)
    const deviceTier = await rankDevice(req.headers["user-agent"] || "")
    const cachedDeviceResult = movieSelectionCache.get(deviceTier + "_" + query)
    if (cachedDeviceResult) {
        console.log(cachedDeviceResult)
        return cachedDeviceResult[Number(count) || 0].magnet

    } else {
        try {
            console.log("searching and ranking...")
            let resultSearch = null
            const cachedResult = movieCache.get(query)
            if (cachedResult) {
                resultSearch = cachedResult
            } else {
                const results = await TorrentSearchApi.search(query, 'All', 20);
                const formattedResults = await Promise.all(results.map(async (result) => {
                    try {
                        let magnet = await TorrentSearchApi.getMagnet(result);
                        if (!magnet && result.infoHash) {
                            magnet = `magnet:?xt=urn:btih:${result.infoHash}&dn=${encodeURIComponent(result.title)}`;
                        }
                        return magnet ? {
                            title: result.title,
                            magnet: magnet,
                            seeders: parseInt(result.seeds) || 0,
                            size: result.size || 'Unknown'
                        } : null;
                    } catch (err) { return null; }
                }));
                const filteredResults = formattedResults.filter(r => r)
                movieCache.set(query, filteredResults)
                resultSearch = filteredResults

            }
            const response = await rankTorrents(resultSearch, deviceTier)
            console.log(response)
            movieSelectionCache.set(deviceTier + "_" + query, response)
            return response[Number(count) || 0].magnet
        } catch (err) {
            console.error("Error in v2 search api" + err)
        }
    }
}

function getTorrentNameFromMagnet(magnet) {
    const dn = new URLSearchParams(magnet.replace('magnet:?', '')).get('dn')
    return dn ? decodeURIComponent(dn) : ''
}
function checkNeedsTranscode(magnet) {
    const name = getTorrentNameFromMagnet(magnet).toLowerCase()
    return name.includes('ddp') ||
        name.includes('eac3') ||
        name.includes('atmos') ||
        name.includes('truehd') ||
        name.includes('dts') ||
        name.includes('ac3')
}

export default { search, searchRank, getTorrentNameFromMagnet, checkNeedsTranscode };