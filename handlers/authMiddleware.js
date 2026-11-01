import { User } from '../database/index.js';

async function authorize(req, res, next, ranks) {
    try {
        const uuid = req.session?.user?.uuid;
        const user = uuid ? await User.findOne({ where: { uuid }, attributes: ['uuid', 'username', 'rank'] }) : null;
        if (user && (!ranks || ranks.includes(user.rank))) {
            req.session.user = { uuid: user.uuid, username: user.username, rank: user.rank };
            Object.assign(res.locals, req.session.user);
            return next();
        }
        if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'You do not have permission to perform this action.' });
        return res.status(403).render('accessdenied.ejs');
    } catch (err) { next(err); }
}
const checkSession = (req, res, next) => authorize(req, res, next);
const checkManager = (req, res, next) => authorize(req, res, next, ['manager', 'admin']);
const checkAdmin = (req, res, next) => authorize(req, res, next, ['admin']);
export default { checkSession, checkManager, checkAdmin };
