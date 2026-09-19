import express from "express";
import * as userHandler from "../handlers/usersHandler.js"
const app = express.Router();

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
    const response = await userHandler.loginUser(username, password);

    if (response.success && !response.error) {
        req.session.user = {
            uuid: response.uuid,
            username: response.username,
            rank: response.rank
        }
        res.redirect("/profile/" + username);
    } else {
        res.render('login.ejs', { error: response.error_msg });
    }
});

export default app;