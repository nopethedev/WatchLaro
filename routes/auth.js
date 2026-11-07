import express from "express";
import * as userHandler from "../handlers/usersHandler.js"
import { ensureDefaultProfile } from "../handlers/profiles.js";
import { safeLocalPath } from "../handlers/viewerContext.js";
const app = express.Router();

function loginNext(req) {
    return safeLocalPath(req.body?.next || req.query?.next || "", "");
}

app.post("/register", async (req, res) => {
    const { username, password, email, "h-captcha-response": token } = req.body;
    const response = await userHandler.registerUser(username, password, email, token);

    if (!response.error) {
        res.render('register.ejs', { error: "You have successfully registered your account! Head to the sign-in page to log in." });
    } else {
        res.render('register.ejs', { error: response.error_msg });
    }
});

app.post("/login",  async (req, res) => {
    const { username, password } = req.body;
    const next = loginNext(req);
    const response = await userHandler.loginUser(username, password);

    if (response.success && !response.error) {
        req.session.user = {
            uuid: response.uuid,
            username: response.username,
            rank: response.rank
        }
        delete req.session.guest;
        delete req.session.profileId;
        delete req.session.tvProfileConfirmed;

        const profile = await ensureDefaultProfile({ uuid: response.uuid, username: response.username });
        // TV needs the explicit profile chooser; the normal site can use the
        // default profile immediately and still switch from the header.
        if (!next.startsWith("/tvui") && profile) req.session.profileId = profile.id;
        res.redirect(next || (next.startsWith("/tvui") ? "/tvui/" : "/"));
    } else {
        res.render('login.ejs', { error: response.error_msg, next });
    }
});

app.post("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
});

app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
});

export default app;