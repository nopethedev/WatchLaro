import express from "express";
import authMiddleware from "../../handlers/authMiddleware.js";
import { Files, User, sequelize } from '../../database/index.js';
import { downloadsDir } from '../../handlers/downloadsPath.js';
import checkDiskSpace from 'check-disk-space';
import fs from 'node:fs';

import { getAdminSettings, saveAdminSettings, settingsSchema } from '../../handlers/adminSettings.js';
import { drainQueue } from './media.js';
const app = express.Router();

app.get('/admin', authMiddleware.checkManager, async (req, res) => {
    try {
        const files = await Files.findAll({ attributes: ['status'], raw: true });
        const counts = files.reduce((out, file) => { out[file.status] = (out[file.status] || 0) + 1; return out; }, {});
        const users = req.session.user.rank === 'admin' ? await User.count() : null;
        const recent = await Files.findAll({ limit: 6, order: [['createdAt','DESC']] });
        fs.mkdirSync(downloadsDir, { recursive: true });
        const disk = await checkDiskSpace(downloadsDir);
        res.render('admin/index.ejs', { counts, total: files.length, users, recent, disk, queueSettings: getAdminSettings() });
    } catch { res.status(500).send('Could not load dashboard'); }
});

app.get('/admin/media', authMiddleware.checkManager, async (req, res) => {
    res.render("admin/media.ejs");
});

app.get('/admin/media/create', authMiddleware.checkManager, async (req, res) => {
    res.render("admin/media/createMedia.ejs", { defaultQuality: getAdminSettings().defaultQuality });
})

app.get('/admin/users', authMiddleware.checkAdmin, async (req, res) => {
    res.render("admin/users.ejs");
});

app.get('/admin/users/create', authMiddleware.checkAdmin, async (req, res) => {
    res.render("admin/user/createUser.ejs")
});

app.get('/admin/users/edit/:uuid', authMiddleware.checkAdmin, async(req,res) => {
    res.render("admin/user/editUser.ejs", { userUuid: req.params.uuid })
});

app.get('/admin/settings', authMiddleware.checkManager, async (req, res) => {
    try {
        fs.mkdirSync(downloadsDir, { recursive: true });
        const disk = await checkDiskSpace(downloadsDir);
        res.render('admin/settings.ejs', { settings: { downloadsDir, disk, dialect: sequelize.getDialect(), node: process.version, tmdbConfigured: Boolean(process.env.TMDB_KEY), ...getAdminSettings() } });
    } catch { res.status(500).send('Could not load server settings'); }
});

app.post('/api/admin/settings', authMiddleware.checkAdmin, async (req, res) => {
    const result = settingsSchema.safeParse(req.body);
    if (!result.success) return res.status(400).json({ error: 'Invalid queue settings' });
    try {
        const settings = saveAdminSettings(result.data);
        void drainQueue().catch(err => console.error('[queue]', err.message));
        res.json({ success: true, settings });
    } catch { res.status(500).json({ error: 'Could not save settings' }); }
});
export default app;