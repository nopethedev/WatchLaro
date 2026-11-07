import express from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { Op } from 'sequelize';
import authMiddleware from '../../handlers/authMiddleware.js';
import { User } from '../../database/index.js';
import { ensureDefaultProfile, deleteProfilesForUser } from '../../handlers/profiles.js';

const app = express.Router();
app.use('/api/admin/users', authMiddleware.checkAdmin);
const fields = z.object({
    username: z.string().trim().min(4).max(16),
    email: z.email().max(100),
    password: z.string().min(8).max(128),
    rank: z.enum(['member', 'manager', 'admin']),
    bio: z.string().max(255).optional(),
    profilePicture: z.union([z.literal(''), z.url().max(255).refine(value => /^https?:\/\//i.test(value), 'Use an HTTP or HTTPS image URL')]).optional()
});
function error(res, err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'That username or email is already in use.' });
    console.error('[admin/users]', err.message);
    return res.status(500).json({ error: 'Could not save user changes.' });
}
app.get('/api/admin/users', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1), limit = 25;
        const where = {};
        if (req.query.q) where[Op.or] = ['username', 'email'].map(key => ({ [key]: { [Op.like]: `%${String(req.query.q).slice(0, 100)}%` } }));
        if (['member', 'manager', 'admin'].includes(req.query.rank)) where.rank = req.query.rank === 'member' ? { [Op.in]: ['member', 'user'] } : req.query.rank;
        const result = await User.findAndCountAll({ where, attributes: { exclude: ['password'] }, limit, offset: (page - 1) * limit, order: [['createdAt', 'DESC']] });
        res.json({ users: result.rows, total: result.count, page, pages: Math.max(1, Math.ceil(result.count / limit)) });
    } catch (err) { error(res, err); }
});
app.post('/api/admin/users/create', async (req, res) => {
    const result = fields.safeParse(req.body);
    if (!result.success) return res.status(400).json({ error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    try {
        const data = result.data;
        const user = await User.create({ ...data, password: await bcrypt.hash(data.password, 12) });
        await ensureDefaultProfile(user);
        if (req.is('application/json')) return res.status(201).json({ success: true });
        res.redirect('/admin/users');
    } catch (err) { error(res, err); }
});
app.get('/api/admin/users/info/:uuid', async (req, res) => {
    try {
        const user = await User.findOne({ where: { uuid: req.params.uuid }, attributes: { exclude: ['password'] } });
        if (!user) return res.status(404).json({ error: 'User not found.' });
        res.json(user);
    } catch (err) { error(res, err); }
});
// Self-demotion/deletion is prohibited, so concurrent admins cannot remove their own last access.
app.post('/api/admin/users/edit/:uuid', async (req, res) => {
    const body = { ...req.body };
    if (!body.password) delete body.password;
    const result = fields.partial().safeParse(body);
    if (!result.success) return res.status(400).json({ error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (req.params.uuid === req.session.user.uuid && result.data.rank && result.data.rank !== 'admin') return res.status(409).json({ error: 'You cannot remove your own administrator access.' });
    try {
        const user = await User.findOne({ where: { uuid: req.params.uuid } });
        if (!user) return res.status(404).json({ error: 'User not found.' });
        const data = result.data;
        if (data.password) data.password = await bcrypt.hash(data.password, 12);
        await user.update(data);
        if (user.uuid === req.session.user.uuid) req.session.user.username = user.username;
        res.json({ success: true });
    } catch (err) { error(res, err); }
});
app.delete('/api/admin/users/:uuid', async (req, res) => {
    if (req.params.uuid === req.session.user.uuid) return res.status(409).json({ error: 'You cannot delete your own account.' });
    try {
        const user = await User.findOne({ where: { uuid: req.params.uuid } });
        if (!user) return res.status(404).json({ error: 'User not found.' });
        await deleteProfilesForUser(user.uuid);
        await user.destroy();
        res.json({ success: true });
    } catch (err) { error(res, err); }
});
export default app;
