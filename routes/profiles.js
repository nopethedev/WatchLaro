import express from "express";
import { z } from "zod";
import { requireUser, requireActiveProfile, safeLocalPath } from "../handlers/viewerContext.js";
import {
    MAX_PROFILES,
    PROFILE_AVATARS,
    avatarFor,
    createProfile,
    deleteProfile,
    ensureDefaultProfile,
    getProfileForUser,
    historyForProfile,
    listProfiles,
    onboardingTitles,
    parseGenreWeights,
    profileJson,
    recordWatch,
    updateProfile
} from "../handlers/profiles.js";

const app = express.Router();

const avatarSchema = z.string().max(500).refine((value) => {
    if (!value) return true;
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}, "Use an HTTP or HTTPS avatar URL").optional();

const createSchema = z.object({
    name: z.string().trim().min(1).max(24),
    avatar: avatarSchema,
    seeds: z.array(z.object({
        type: z.enum(["movie", "tv"]),
        id: z.coerce.number().int().positive()
    })).length(3, "Choose exactly three titles")
});

const updateSchema = z.object({
    name: z.string().trim().min(1).max(24).optional(),
    avatar: avatarSchema
});

const historySchema = z.object({
    type: z.enum(["movie", "tv"]),
    id: z.coerce.number().int().positive(),
    title: z.string().trim().max(200).optional(),
    season: z.coerce.number().int().positive().optional(),
    episode: z.coerce.number().int().positive().optional()
});

function fail(res, err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error("[profiles]", err);
    return res.status(status).json({ error: status >= 500 ? "Could not save profile changes." : err.message });
}

function normalAvatar(value) {
    const text = String(value || "").trim();
    if (text) return text;
    return avatarFor("blue");
}

app.get("/profiles", requireUser, async (req, res, next) => {
    try {
        let profiles = await listProfiles(req.session.user.uuid);
        if (!profiles.length) {
            await ensureDefaultProfile(req.session.user);
            profiles = await listProfiles(req.session.user.uuid);
        }
        res.render("profiles/index.ejs", {
            pageTitle: "Profiles",
            profiles,
            activeProfileId: req.activeProfile?.id,
            maxProfiles: MAX_PROFILES
        });
    } catch (err) { next(err); }
});

app.get("/profiles/new", requireUser, async (req, res, next) => {
    try {
        const profiles = await listProfiles(req.session.user.uuid);
        if (profiles.length >= MAX_PROFILES) return res.redirect("/profiles");
        res.render("profiles/new.ejs", {
            pageTitle: "Create a profile",
            avatars: PROFILE_AVATARS,
            maxProfiles: MAX_PROFILES
        });
    } catch (err) { next(err); }
});

app.get("/profiles/:id/edit", requireUser, async (req, res, next) => {
    try {
        const profile = await getProfileForUser(req.session.user.uuid, req.params.id);
        if (!profile) return res.status(404).send("Profile not found");
        res.render("profiles/edit.ejs", {
            pageTitle: "Edit profile",
            profile,
            avatars: PROFILE_AVATARS
        });
    } catch (err) { next(err); }
});

app.post("/profiles/:id/select", requireUser, async (req, res, next) => {
    try {
        const profile = await getProfileForUser(req.session.user.uuid, req.params.id);
        if (!profile) return res.status(404).send("Profile not found");
        req.session.profileId = profile.id;
        delete req.session.guest;
        // A normal-site switch is not a TV choice. TV routes require their own
        // explicit confirmation so the picker cannot be bypassed by a login.
        req.session.tvProfileConfirmed = safeLocalPath(req.query.next, "").startsWith("/tvui");
        await profile.update({ lastUsedAt: new Date() });
        return res.redirect(safeLocalPath(req.query.next, "/"));
    } catch (err) { next(err); }
});

app.post("/profiles/guest/select", async (req, res, next) => {
    try {
        if (!res.locals.guestMode) return res.redirect("/login");
        if (req.session.user) return res.redirect(safeLocalPath(req.query.next, "/tvui/"));
        req.session.guest = true;
        req.session.tvProfileConfirmed = true;
        delete req.session.profileId;
        return res.redirect(safeLocalPath(req.query.next, "/tvui/home"));
    } catch (err) { next(err); }
});

app.get("/api/profiles", requireUser, async (req, res, next) => {
    try {
        const profiles = await listProfiles(req.session.user.uuid);
        res.json({
            profiles: profiles.map(profileJson),
            activeProfileId: req.activeProfile?.id || null,
            maxProfiles: MAX_PROFILES
        });
    } catch (err) { next(err); }
});

app.get("/api/profiles/onboarding", requireUser, async (req, res, next) => {
    try {
        const items = await onboardingTitles();
        res.json({ items });
    } catch (err) {
        console.error("[profiles/onboarding]", err.message);
        res.status(502).json({ error: "Could not load onboarding titles." });
    }
});

app.post("/api/profiles", requireUser, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join(" ") });
    }
    try {
        const profile = await createProfile(req.session.user.uuid, {
            name: parsed.data.name,
            avatar: normalAvatar(parsed.data.avatar),
            seeds: parsed.data.seeds
        });
        req.session.profileId = profile.id;
        req.session.tvProfileConfirmed = true;
        delete req.session.guest;
        return res.status(201).json({ profile: profileJson(profile) });
    } catch (err) { return fail(res, err); }
});

app.patch("/api/profiles/:id", requireUser, async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join(" ") });
    }
    try {
        const profile = await updateProfile(req.session.user.uuid, req.params.id, {
            ...parsed.data,
            avatar: parsed.data.avatar === undefined ? undefined : normalAvatar(parsed.data.avatar)
        });
        if (!profile) return res.status(404).json({ error: "Profile not found." });
        return res.json({ profile: profileJson(profile) });
    } catch (err) { return fail(res, err); }
});

app.delete("/api/profiles/:id", requireUser, async (req, res) => {
    try {
        const deleted = await deleteProfile(req.session.user.uuid, req.params.id);
        if (!deleted) return res.status(404).json({ error: "Profile not found." });
        if (Number(req.session.profileId) === Number(req.params.id)) delete req.session.profileId;
        return res.json({ success: true });
    } catch (err) { return fail(res, err); }
});

app.post("/api/profiles/:id/select", requireUser, async (req, res, next) => {
    try {
        const profile = await getProfileForUser(req.session.user.uuid, req.params.id);
        if (!profile) return res.status(404).json({ error: "Profile not found." });
        req.session.profileId = profile.id;
        delete req.session.guest;
        await profile.update({ lastUsedAt: new Date() });
        return res.json({ profile: profileJson(profile) });
    } catch (err) { next(err); }
});

// Called by the shared player when playback begins. No active profile means
// this is a public/share playback, so history is simply skipped.
app.post("/api/history", requireActiveProfile, async (req, res) => {
    const parsed = historySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid title." });
    if (!req.activeProfile || req.activeProfile.guest) return res.json({ ok: false });
    try {
        const row = await recordWatch(req.activeProfile.id, parsed.data);
        return res.json({ ok: Boolean(row) });
    } catch (err) {
        console.error("[history]", err.message);
        return res.status(500).json({ error: "Could not save watch history." });
    }
});

app.get("/api/history", requireActiveProfile, async (req, res, next) => {
    try {
        if (!req.activeProfile || req.activeProfile.guest) return res.json({ items: [] });
        const rows = await historyForProfile(req.activeProfile.id, 50);
        res.json({
            items: rows.map((row) => ({
                type: row.mediaType,
                id: row.tmdbId,
                title: row.title,
                poster: row.poster,
                backdrop: row.backdrop,
                year: row.year,
                rating: row.rating,
                season: row.season,
                episode: row.episode,
                watchedAt: row.lastWatchedAt
            })),
            taste: parseGenreWeights(req.activeProfile)
        });
    } catch (err) { next(err); }
});

export default app;
