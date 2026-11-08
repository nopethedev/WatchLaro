import NodeCache from "node-cache";
import axios from "axios";
import { User, Profile, WatchHistory } from "../database/index.js";
import tmdb from "./downloader/tmdb.js";

export const MAX_PROFILES = 5;
export const PROFILE_AVATARS = [
    { id: "blue", label: "Blue", seed: "watchlaro-blue" },
    { id: "gold", label: "Gold", seed: "watchlaro-gold" },
    { id: "mint", label: "Mint", seed: "watchlaro-mint" },
    { id: "coral", label: "Coral", seed: "watchlaro-coral" },
    { id: "violet", label: "Violet", seed: "watchlaro-violet" },
    { id: "midnight", label: "Midnight", seed: "watchlaro-midnight" },
    { id: "sunset", label: "Sunset", seed: "watchlaro-sunset" },
    { id: "forest", label: "Forest", seed: "watchlaro-forest" }
];

const TMDB_BASE = "https://api.themoviedb.org/3";
const tmdbCache = new NodeCache({ stdTTL: 60 * 60, checkperiod: 300 });
const recommendationCache = new NodeCache({ stdTTL: 30 * 60, checkperiod: 600 });

const cleanName = (value) => String(value ?? "").trim().replace(/\s+/g, " ");

export function avatarFor(seed) {
    const preset = PROFILE_AVATARS.find((item) => item.id === seed);
    const value = preset ? preset.seed : String(seed || "watchlaro");
    return `https://api.dicebear.com/10.x/thumbs/svg?seed=${encodeURIComponent(value)}`;
}

export function parseGenreWeights(profile) {
    try {
        const raw = typeof profile?.genreWeights === "string"
            ? JSON.parse(profile.genreWeights)
            : profile?.genreWeights;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
        const out = {};
        for (const [key, value] of Object.entries(raw)) {
            const id = Number(key);
            const weight = Number(value);
            if (Number.isInteger(id) && Number.isFinite(weight) && weight > 0) out[id] = weight;
        }
        return out;
    } catch {
        return {};
    }
}

function addWeights(weights, genres) {
    for (const genre of genres || []) {
        const id = Number(genre?.id ?? genre);
        if (Number.isInteger(id) && id > 0) weights[id] = (weights[id] || 0) + 1;
    }
    return weights;
}

function serializeWeights(weights) {
    return JSON.stringify(weights || {});
}

function tmdbHeaders() {
    return {
        Authorization: "Bearer " + process.env.TMDB_KEY,
        "Content-Type": "application/json"
    };
}

async function tmdbGet(pathname, params = {}) {
    const key = pathname + JSON.stringify(params);
    const cached = tmdbCache.get(key);
    if (cached) return cached;
    const response = await axios.get(TMDB_BASE + pathname, {
        headers: tmdbHeaders(),
        params,
        timeout: 15000
    });
    tmdbCache.set(key, response.data);
    return response.data;
}

function mediaTypeOf(media) {
    if (media?.media_type === "movie" || media?.media_type === "tv") return media.media_type;
    if (media?.first_air_date !== undefined || media?.name !== undefined) return "tv";
    return "movie";
}

function mapMedia(media) {
    if (!media || !media.id) return null;
    const type = mediaTypeOf(media);
    const date = type === "tv" ? media.first_air_date : media.release_date;
    return {
        id: Number(media.id),
        type,
        title: (type === "tv" ? media.name : media.title) || media.original_title || media.original_name || "Untitled",
        overview: media.overview || "",
        poster: media.poster_path || null,
        backdrop: media.backdrop_path || null,
        year: date ? String(date).slice(0, 4) : null,
        rating: typeof media.vote_average === "number" && media.vote_average > 0
            ? Math.round(media.vote_average * 10) / 10
            : null,
        genreIds: Array.isArray(media.genre_ids)
            ? media.genre_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
            : []
    };
}

export function profileJson(profile) {
    if (!profile) return null;
    return {
        id: profile.id,
        name: profile.name,
        avatar: profile.avatar,
        onboarded: Boolean(profile.onboarded),
        genres: Object.keys(parseGenreWeights(profile)).length,
        lastUsedAt: profile.lastUsedAt || null
    };
}

export async function ensureDefaultProfile(user) {
    if (!user?.uuid) return null;
    const existing = await Profile.findOne({
        where: { userUuid: user.uuid },
        order: [["lastUsedAt", "DESC"], ["createdAt", "ASC"]]
    });
    if (existing) return existing;

    const name = cleanName(user.username || "Viewer").slice(0, 32) || "Viewer";
    try {
        return await Profile.create({
            userUuid: user.uuid,
            name,
            avatar: avatarFor("blue"),
            genreWeights: "{}",
            onboarded: true,
            lastUsedAt: new Date()
        });
    } catch (err) {
        // A concurrent request may have created the default first.
        const fallback = await Profile.findOne({ where: { userUuid: user.uuid } });
        if (fallback) return fallback;
        throw err;
    }
}

export async function ensureDefaultProfiles() {
    const users = await User.findAll({ attributes: ["uuid", "username"] });
    let created = 0;
    for (const user of users) {
        const before = await Profile.count({ where: { userUuid: user.uuid } });
        if (!before) {
            await ensureDefaultProfile(user);
            created += 1;
        }
    }
    if (created) console.log(`[profiles] created ${created} default profile(s)`);
    return created;
}

export async function listProfiles(userUuid) {
    if (!userUuid) return [];
    return Profile.findAll({
        where: { userUuid },
        order: [["lastUsedAt", "DESC"], ["createdAt", "ASC"]]
    });
}

export async function getProfileForUser(userUuid, id) {
    if (!userUuid || !id) return null;
    return Profile.findOne({ where: { id: Number(id), userUuid } });
}

export async function fetchSeedGenres(seeds) {
    const weights = {};
    const picked = [];
    for (const seed of (Array.isArray(seeds) ? seeds : []).slice(0, 3)) {
        const type = seed?.type === "tv" ? "tv" : "movie";
        const id = Number(seed?.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        try {
            const info = type === "tv" ? await tmdb.tvInfo(id) : await tmdb.movieInfo(id);
            const genres = Array.isArray(info?.genres) ? info.genres : [];
            addWeights(weights, genres);
            picked.push({ id, type, title: type === "tv" ? info?.name : info?.title });
        } catch (err) {
            console.log("[profiles] seed lookup failed:", type, id, err.message);
        }
    }
    return { weights, picked };
}

export async function createProfile(userUuid, { name, avatar, seeds } = {}) {
    const count = await Profile.count({ where: { userUuid } });
    if (count >= MAX_PROFILES) {
        const err = new Error(`You can have up to ${MAX_PROFILES} profiles.`);
        err.status = 409;
        throw err;
    }

    const clean = cleanName(name).slice(0, 32);
    if (!clean) {
        const err = new Error("Give this profile a name.");
        err.status = 400;
        throw err;
    }

    const { weights } = await fetchSeedGenres(seeds);
    try {
        const profile = await Profile.create({
            userUuid,
            name: clean,
            avatar: avatar || avatarFor("blue"),
            genreWeights: serializeWeights(weights),
            onboarded: true,
            lastUsedAt: new Date()
        });
        return profile;
    } catch (err) {
        if (err.name === "SequelizeUniqueConstraintError") {
            const conflict = new Error("A profile with that name already exists.");
            conflict.status = 409;
            throw conflict;
        }
        throw err;
    }
}

export async function updateProfile(userUuid, id, { name, avatar } = {}) {
    const profile = await getProfileForUser(userUuid, id);
    if (!profile) return null;
    const patch = {};
    if (name !== undefined) {
        const clean = cleanName(name).slice(0, 32);
        if (!clean) {
            const err = new Error("Give this profile a name.");
            err.status = 400;
            throw err;
        }
        patch.name = clean;
    }
    if (avatar !== undefined) patch.avatar = String(avatar || "").slice(0, 500) || avatarFor("blue");
    try {
        await profile.update(patch);
    } catch (err) {
        if (err.name === "SequelizeUniqueConstraintError") {
            const conflict = new Error("A profile with that name already exists.");
            conflict.status = 409;
            throw conflict;
        }
        throw err;
    }
    return profile;
}

export async function deleteProfile(userUuid, id) {
    const count = await Profile.count({ where: { userUuid } });
    if (count <= 1) {
        const err = new Error("Keep at least one profile on this account.");
        err.status = 409;
        throw err;
    }
    const profile = await getProfileForUser(userUuid, id);
    if (!profile) return false;
    await WatchHistory.destroy({ where: { profileId: profile.id } });
    await profile.destroy();
    return true;
}

export async function deleteProfilesForUser(userUuid) {
    const profiles = await Profile.findAll({ where: { userUuid }, attributes: ["id"] });
    const ids = profiles.map((profile) => profile.id);
    if (ids.length) await WatchHistory.destroy({ where: { profileId: ids } });
    await Profile.destroy({ where: { userUuid } });
}

export async function recordWatch(profileId, { type, id, title, season, episode } = {}) {
    const profile = await Profile.findByPk(Number(profileId));
    const tmdbId = Number(id);
    const mediaType = type === "tv" ? "tv" : "movie";
    if (!profile || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;

    let info = {};
    try {
        info = mediaType === "tv" ? await tmdb.tvInfo(tmdbId) : await tmdb.movieInfo(tmdbId);
    } catch (err) {
        console.log("[history] metadata unavailable:", err.message);
    }

    const genres = Array.isArray(info?.genres) ? info.genres.map((genre) => Number(genre.id)).filter(Boolean) : [];
    const date = mediaType === "tv" ? info?.first_air_date : info?.release_date;
    const values = {
        profileId: profile.id,
        mediaType,
        tmdbId,
        title: String(title || (mediaType === "tv" ? info?.name : info?.title) || "Untitled").slice(0, 255),
        poster: info?.poster_path || null,
        backdrop: info?.backdrop_path || null,
        year: date ? String(date).slice(0, 4) : null,
        rating: typeof info?.vote_average === "number" && info.vote_average > 0 ? info.vote_average : null,
        overview: info?.overview || null,
        genres: JSON.stringify(genres),
        season: mediaType === "tv" && Number.isInteger(Number(season)) ? Number(season) : null,
        episode: mediaType === "tv" && Number.isInteger(Number(episode)) ? Number(episode) : null,
        lastWatchedAt: new Date()
    };

    const where = { profileId: profile.id, mediaType, tmdbId };
    const existing = await WatchHistory.findOne({ where });
    let row;
    let created = false;
    if (existing) {
        row = await existing.update(values);
    } else {
        try {
            row = await WatchHistory.create(values);
            created = true;
        } catch (err) {
            if (err.name !== "SequelizeUniqueConstraintError") throw err;
            // Another player/client recorded the same title at the same time.
            const raced = await WatchHistory.findOne({ where });
            if (!raced) throw err;
            row = await raced.update(values);
        }
    }
    if (created) {
        // Count a title once toward taste, not once per rewatch/episode.
        const weights = parseGenreWeights(profile);
        addWeights(weights, genres);
        await profile.update({ genreWeights: serializeWeights(weights), lastUsedAt: new Date() });
    } else {
        await profile.update({ lastUsedAt: new Date() });
    }
    return row;
}

export async function continueWatching(profileId, limit = 15) {
    if (!profileId) return [];
    const rows = await WatchHistory.findAll({
        where: { profileId },
        order: [["lastWatchedAt", "DESC"]],
        limit
    });
    return rows.map((row) => ({
        id: row.tmdbId,
        type: row.mediaType,
        title: row.title,
        poster: row.poster,
        backdrop: row.backdrop,
        year: row.year,
        rating: row.rating,
        overview: row.overview,
        season: row.season,
        episode: row.episode
    }));
}

async function discoverForGenres(genreIds) {
    const withGenres = genreIds.join("|");
    const common = {
        with_genres: withGenres,
        sort_by: "popularity.desc",
        include_adult: "false",
        "vote_count.gte": 75,
        page: 1
    };
    const settled = await Promise.allSettled([
        tmdbGet("/discover/movie", common),
        tmdbGet("/discover/tv", common)
    ]);
    const items = [];
    for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        for (const media of result.value?.results || []) {
            const item = mapMedia(media);
            if (item) items.push(item);
        }
    }
    return items;
}

export async function recommendationsForProfile(profile, limit = 18) {
    if (!profile?.id) return [];
    const weights = parseGenreWeights(profile);
    const ranked = Object.entries(weights)
        .map(([id, weight]) => ({ id: Number(id), weight: Number(weight) }))
        .filter((entry) => Number.isInteger(entry.id) && entry.weight > 0)
        .sort((a, b) => b.weight - a.weight);
    if (!ranked.length) return [];

    const genreIds = ranked.slice(0, 3).map((entry) => entry.id);
    const cacheKey = "rec:" + genreIds.join(",") + ":" + limit;
    const cached = recommendationCache.get(cacheKey);
    let items = cached;
    if (!items) {
        try {
            items = await discoverForGenres(genreIds.slice(0, 2));
            recommendationCache.set(cacheKey, items);
        } catch (err) {
            console.log("[profiles] recommendation lookup failed:", err.message);
            return [];
        }
    }

    const watched = new Set(
        (await WatchHistory.findAll({ where: { profileId: profile.id }, attributes: ["mediaType", "tmdbId"] }))
            .map((row) => row.mediaType + ":" + row.tmdbId)
    );

    const seen = new Set();
    return items
        .filter((item) => {
            const key = item.type + ":" + item.id;
            if (watched.has(key) || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, limit);
}

export async function onboardingTitles() {
    const cached = recommendationCache.get("onboarding:50");
    if (cached) return cached;

    const settled = await Promise.allSettled([
        tmdbGet("/trending/all/week"),
        tmdbGet("/movie/popular"),
        tmdbGet("/tv/popular")
    ]);
    const seen = new Set();
    const items = [];
    for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        for (const media of result.value?.results || []) {
            const item = mapMedia(media);
            if (!item || !item.poster) continue;
            const key = item.type + ":" + item.id;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push(item);
            if (items.length >= 50) break;
        }
        if (items.length >= 50) break;
    }
    recommendationCache.set("onboarding:50", items);
    return items;
}

export async function historyForProfile(profileId, limit = 50) {
    if (!profileId) return [];
    return WatchHistory.findAll({
        where: { profileId },
        order: [["lastWatchedAt", "DESC"]],
        limit
    });
}
