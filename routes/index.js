//all the routes ig
import admin from "./admin/index.js";
import adminAPIUsers from "./admin/users.js";
import adminAPIMedia from "./admin/media.js";
import share from "./share.js";
import auth from "./auth.js";
import feed from "./feed.js";
import movies from "./movies.js";
import tv from "./tv.js";
import user from "./user.js";


export default [
    admin,
    adminAPIUsers,
    adminAPIMedia,
    share,
    auth, 
    feed,
    movies,
    tv,
    user,
]