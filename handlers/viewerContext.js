import { getAdminSettings } from "./adminSettings.js";
import { APP_VERSION } from "./version.js";
import { Profile } from "../database/index.js";
import { ensureDefaultProfile } from "./profiles.js";

const PUBLIC_EXACT = new Set([
    "/login",
    "/register",
    "/logout",
    "/api/version",
    "/player.html",
    "/favicon.ico"
]);

const PUBLIC_PREFIXES = [
    "/share/",
    "/api/stream/",
    "/vendor/",
    "/themes/"
];

export function isPublicPath(pathname) {
    const value = String(pathname || "");
    return PUBLIC_EXACT.has(value) || PUBLIC_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function wantsJson(req) {
    return req.path.startsWith("/api/") || String(req.get("accept") || "").includes("application/json");
}

export function requireUser(req, res, next) {
    if (req.session?.user?.uuid) return next();
    if (wantsJson(req)) return res.status(401).json({ error: "Sign in to use profiles." });
    return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl || "/"));
}

export function requireActiveProfile(req, res, next) {
    if (req.activeProfile) return next();
    if (wantsJson(req)) return res.status(401).json({ error: "Choose a profile first." });
    return res.redirect(req.session?.user ? "/profiles" : "/login");
}

function isTvArea(pathname) {
    return pathname === "/tvui" || pathname === "/tvui/" || pathname.startsWith("/tvui/");
}

/**
 * Resolve the signed-in account and its active viewing profile for every
 * request. Normal pages fall back to the default profile; TV routes are
 * deliberately left alone so the viewer has to choose a profile first.
 */
export async function loadViewer(req, res, next) {
    res.locals.appVersion = APP_VERSION;
    res.locals.uuid = req.session?.user?.uuid || null;
    res.locals.username = req.session?.user?.username || null;
    res.locals.rank = req.session?.user?.rank || null;
    res.locals.profile = null;
    req.activeProfile = null;

    let settings;
    try {
        settings = getAdminSettings();
    } catch (err) {
        console.error("[access] could not read admin settings:", err.message);
        settings = { guestMode: true };
    }
    res.locals.guestMode = settings.guestMode !== false;

    try {
        if (req.session?.user?.uuid) {
            let profile = null;
            if (req.session.profileId) {
                profile = await Profile.findOne({
                    where: { id: Number(req.session.profileId), userUuid: req.session.user.uuid }
                });
                if (!profile) delete req.session.profileId;
            }

            // The TV interface always owns an explicit profile choice. Normal
            // pages can fall back to the account's default profile.
            if (!profile && !isTvArea(req.path)) {
                profile = await ensureDefaultProfile({
                    uuid: req.session.user.uuid,
                    username: req.session.user.username
                });
                if (profile) req.session.profileId = profile.id;
            }

            // A normal-site default profile is not a TV selection. Keep the
            // TV picker authoritative until the viewer confirms a profile there.
            if (profile && isTvArea(req.path) && !req.session.tvProfileConfirmed) {
                profile = null;
            }

            if (profile) {
                req.activeProfile = profile;
                res.locals.profile = profile;
            }
        } else if (req.session?.guest) {
            req.activeProfile = {
                id: "guest",
                name: "Guest",
                avatar: "https://api.dicebear.com/10.x/thumbs/svg?seed=watchlaro-guest",
                guest: true
            };
            res.locals.profile = req.activeProfile;
        }
        return next();
    } catch (err) {
        return next(err);
    }
}

/** When guest mode is off, everything except share/player/stream routes needs an account. */
export function gateAccess(req, res, next) {
    if (res.locals.guestMode || req.session?.user?.uuid || isPublicPath(req.path)) return next();
    if (wantsJson(req)) return res.status(401).json({ error: "This server requires an account." });
    return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl || "/"));
}

/** Parse a local return path and reject protocol-relative/open redirects. */
export function safeLocalPath(value, fallback = "/") {
    const text = String(value || "");
    if (!text.startsWith("/") || text.startsWith("//")) return fallback;
    return text;
}
