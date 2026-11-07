import axios from "axios";
import NodeCache from "node-cache";
import { APP_VERSION } from "./version.js";

const BASE = "https://api.opensubtitles.com/api/v1";
const searchCache = new NodeCache({ stdTTL: 30 * 60, checkperiod: 300 });
const fileCache = new NodeCache({ stdTTL: 2 * 60 * 60, checkperiod: 300 });

export function configured() {
    return Boolean(String(process.env.OPENSUBTITLES_API_KEY || "").trim());
}

function headers() {
    return {
        "Api-Key": String(process.env.OPENSUBTITLES_API_KEY || "").trim(),
        "User-Agent": `WatchLaro v${APP_VERSION}`,
        Accept: "application/json"
    };
}

function languageName(code) {
    return String(code || "unknown").toLowerCase();
}

function parseTrack(record) {
    const attr = record?.attributes || {};
    const file = Array.isArray(attr.files) ? attr.files.find((entry) => entry?.file_id) : null;
    if (!file) return null;
    const title = attr.feature_details?.title || attr.feature_details?.movie_name || "";
    return {
        fileId: String(file.file_id),
        name: String(attr.release || file.file_name || title || "Subtitle").slice(0, 160),
        lang: languageName(attr.language),
        downloads: Number(attr.download_count) || 0,
        source: "opensubtitles",
        format: attr.format || "srt"
    };
}

async function searchRequest(params) {
    const response = await axios.get(BASE + "/subtitles", {
        headers: headers(),
        params,
        timeout: 15000
    });
    return Array.isArray(response.data?.data) ? response.data.data : [];
}

/**
 * Find English/all-language subtitle tracks for a TMDB title. The API can
 * search movies by tmdb_id and episodes by tmdb_id + season/episode; the
 * title fallback covers releases whose parent id is not indexed the same way.
 */
export async function searchSubtitles({ tmdbId, season, episode, title } = {}) {
    if (!configured()) return { configured: false, tracks: [] };
    const id = Number(tmdbId);
    if (!Number.isInteger(id) || id <= 0) return { configured: true, tracks: [] };

    const cacheKey = `search:${id}:${season || ""}:${episode || ""}:${title || ""}`;
    const cached = searchCache.get(cacheKey);
    if (cached) return cached;

    const attempts = [];
    if (season && episode) {
        attempts.push({
            tmdb_id: id,
            season_number: Number(season),
            episode_number: Number(episode),
            order_by: "download_count",
            order_direction: "desc"
        });
        attempts.push({
            parent_tmdb_id: id,
            season_number: Number(season),
            episode_number: Number(episode),
            order_by: "download_count",
            order_direction: "desc"
        });
    } else {
        attempts.push({
            tmdb_id: id,
            order_by: "download_count",
            order_direction: "desc"
        });
    }
    if (title) {
        attempts.push({
            query: String(title).slice(0, 120),
            ...(season ? { season_number: Number(season) } : {}),
            ...(episode ? { episode_number: Number(episode) } : {}),
            order_by: "download_count",
            order_direction: "desc"
        });
    }

    let records = [];
    let lastError = null;
    for (const params of attempts) {
        try {
            records = await searchRequest(params);
            if (records.length) break;
        } catch (err) {
            lastError = err;
            if (err?.response?.status === 401 || err?.response?.status === 403) break;
        }
    }

    if (!records.length && lastError) {
        const status = lastError?.response?.status;
        if (status === 401 || status === 403) {
            const error = new Error("OpenSubtitles rejected the API key.");
            error.status = 502;
            throw error;
        }
    }

    const seen = new Set();
    const tracks = records
        .map(parseTrack)
        .filter(Boolean)
        .filter((track) => {
            if (seen.has(track.fileId)) return false;
            seen.add(track.fileId);
            return true;
        })
        .sort((a, b) => b.downloads - a.downloads)
        .slice(0, 24);

    const payload = { configured: true, tracks };
    searchCache.set(cacheKey, payload);
    return payload;
}

/** Convert the SRT payload OpenSubtitles returns into WebVTT. */
export function srtToVtt(raw) {
    const text = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (/^\s*WEBVTT\b/i.test(text)) return text;
    return "WEBVTT\n\n" + text
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
        .replace(/(\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}

export async function downloadSubtitle(fileId) {
    if (!configured()) {
        const error = new Error("OpenSubtitles is not configured.");
        error.status = 404;
        throw error;
    }
    const id = Number(fileId);
    if (!Number.isInteger(id) || id <= 0) {
        const error = new Error("Invalid subtitle id.");
        error.status = 400;
        throw error;
    }

    const cached = fileCache.get(String(id));
    if (cached) return cached;

    const manifest = await axios.post(BASE + "/download", {
        file_id: id,
        sub_format: "srt"
    }, {
        headers: { ...headers(), "Content-Type": "application/json" },
        timeout: 15000
    });

    const link = manifest.data?.link;
    if (!link) {
        const error = new Error("OpenSubtitles did not return a download link.");
        error.status = 502;
        throw error;
    }

    const file = await axios.get(link, {
        responseType: "arraybuffer",
        headers: { "User-Agent": headers()["User-Agent"] },
        timeout: 20000,
        maxContentLength: 8 * 1024 * 1024
    });
    const text = Buffer.from(file.data).toString("utf8");
    const vtt = srtToVtt(text);
    const payload = { vtt, fileName: manifest.data?.file_name || `subtitle-${id}.srt` };
    fileCache.set(String(id), payload);
    return payload;
}

export default { configured, searchSubtitles, downloadSubtitle, srtToVtt };
