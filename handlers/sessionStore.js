import session from "express-session";
import { Op } from "sequelize";
import { Session } from "../database/models/Session.js";

const DAY = 24 * 60 * 60 * 1000;

/** express-session store backed by the same database as the rest of the app. */
export class SequelizeSessionStore extends session.Store {
    constructor(options = {}) {
        super();
        this.defaultMaxAge = options.defaultMaxAge || 30 * DAY;
        this.cleanupTimer = setInterval(() => {
            this.cleanup().catch((err) => console.error("[session] cleanup failed:", err.message));
        }, 60 * 60 * 1000);
        if (typeof this.cleanupTimer.unref === "function") this.cleanupTimer.unref();
    }

    expiresFor(sess) {
        const raw = sess?.cookie?.expires;
        const date = raw ? new Date(raw) : new Date(Date.now() + this.defaultMaxAge);
        return Number.isNaN(date.getTime()) ? new Date(Date.now() + this.defaultMaxAge) : date;
    }

    get(sid, callback) {
        Session.findByPk(String(sid))
            .then((row) => {
                if (!row) return callback(null, null);
                if (row.expires && new Date(row.expires).getTime() <= Date.now()) {
                    return row.destroy().then(() => callback(null, null)).catch(() => callback(null, null));
                }
                try {
                    return callback(null, JSON.parse(row.data));
                } catch (err) {
                    return callback(err);
                }
            })
            .catch(callback);
    }

    set(sid, sess, callback) {
        const data = JSON.stringify(sess);
        const expires = this.expiresFor(sess);
        Session.upsert({ sid: String(sid), data, expires })
            .then(() => callback?.(null))
            .catch(callback);
    }

    touch(sid, sess, callback) {
        Session.update({ expires: this.expiresFor(sess) }, { where: { sid: String(sid) } })
            .then(() => callback?.(null))
            .catch(callback);
    }

    destroy(sid, callback) {
        Session.destroy({ where: { sid: String(sid) } })
            .then(() => callback?.(null))
            .catch(callback);
    }

    length(callback) {
        Session.count().then((count) => callback(null, count)).catch(callback);
    }

    clear(callback) {
        Session.destroy({ where: {} }).then(() => callback?.(null)).catch(callback);
    }

    async cleanup() {
        return Session.destroy({ where: { expires: { [Op.lt]: new Date() } } });
    }
}

export default SequelizeSessionStore;
