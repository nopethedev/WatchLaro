import express from "express";
import authMiddleware from "../../handlers/authMiddleware.js";

const app = express.Router();

app.get('/admin', authMiddleware.checkManager, async (req, res) => {
    res.render("admin/index.ejs");
});

app.get('/admin/media', authMiddleware.checkManager, async (req, res) => {
    res.render("admin/media.ejs");
});

app.get('/admin/media/create', authMiddleware.checkManager, async (req, res) => {
    res.render("admin/media/createMedia.ejs");
})

app.get('/admin/users', authMiddleware.checkAdmin, async (req, res) => {
    res.render("admin/users.ejs");
});

app.get('/admin/users/create', authMiddleware.checkAdmin, async (req, res) => {
    res.render("admin/user/createUser.ejs")
});

app.get('/admin/users/edit/:uuid', authMiddleware.checkAdmin, async(req,res) => {
    res.render("admin/user/editUser.ejs")
});

app.get('/admin/settings', authMiddleware.checkManager, async (req, res) => {
    res.render("admin/settings.ejs");
});

export default app;