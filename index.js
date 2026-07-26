import express, { response } from "express";
import path from "path"; import { fileURLToPath } from "url";
import fs from "fs";
import session from "express-session";
//import { Sequelize, DataTypes } from "sequelize";
import { sequelize, initDB } from "./database/index.js";
import dotenv from "dotenv";
import multer from "multer";
import cors from "cors";
import axios from "axios";
import nodeCache from "node-cache"
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT;


const tvSearchCache = new nodeCache({ stdTTL: 43200, checkperiod: 600 })
//handlers

import * as userHandler from "./handlers/usersHandler.js"
import { profile } from "console";
import createAdminAccount from "./handlers/createAdminAccount.js";
//import { uploadVideo } from "./videoHandler.js/index.js";

import feedRoutes from "./routes/feed.js";
import movieRoutes from "./routes/movies.js";

//Init Database First
await initDB();

//check admin
await createAdminAccount();
//set up sessions
app.use(cors())
app.use(session({
    secret: 'Poop7283WetTowels69Piss23YourMom38483849Diarrhea1239',
    resave: false,
    saveUninitialized: false,
}));


const storage = multer.memoryStorage();
export const upload = multer({ storage });

//set up other stuaf
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('views', path.join(__dirname, 'views'));
app.use(express.static("public"));
app.locals.basedir = app.get('views');
app.locals.basedir = path.join(__dirname, 'views');

// Middleware to set default variables for all views
app.use((req, res, next) => {
    res.locals.userid = req.session.userid || null;
    next(); // Proceed to the next middleware or route handler
});

//routes
app.use(feedRoutes);
app.use(movieRoutes);

//Auth Middelware

function checkSession(req, res, next) {
    if (req.session.loggedin) {
        next();
    } else {
        res.status(403)
        res.render('accessdenied.ejs')
    }
}
//routes thingy
app.get('/', (req, res) => {
    res.render('index.ejs');
});

app.get('/troubleshoot', (req, res) => {
    res.render('troubleshoot.ejs');
});

app.get('/install', (req, res) => {
    res.render('install.ejs');
});

app.get('/signin', (req, res) => {
    res.render('signin.ejs', { error: " " }); // Add route-specific variables
});

app.get('/register', (req, res) => {
    if (!req.session.username) {
        res.render('register.ejs', { error: " " });
    } else {
        res.redirect("/user/" + req.session.username);
    }
});

app.get('/user/:usern', async (req, res) => {
    const data = await userHandler.getUserDataFromusername(req.params.usern);
    res.render('user.ejs', {
        pfp: data.data.profilePicture || " ",
        profileUsername: data.data.username || " ",
        profileRank: data.data.rank || " ",
        profileBio: data.data.bio || " ",
        error: data.error_msg,
        profileFollowers: data.data.followers || "0"
    });
});

//movies
app.get('/movies/search', async (req, res) => {
    res.render('movies/search.ejs')
});
app.get('/movies/m', async (req, res) => {
    res.render('movies/m.ejs', { embed: "https://de.laro.voidcities.xyz/embedv2?id=" + req.query.q })
});
app.get('/movies/info', async (req, res) => {
    res.render(path.join(__dirname, 'views', 'movies', 'info.ejs'));
})

//tv
app.get('/tv/search', async (req, res) => {
    res.render('tv/search.ejs')
});
app.get('/tv/:id', async (req, res) => {
    res.render(path.join(__dirname, "views", "tv", "info.ejs"))
})

app.get('/tv/:id/:season', async (req, res) => {
    res.render(path.join(__dirname, "views", "tv", "season.ejs"))
})

app.get('/tv/:id/:season/:episode', async (req, res) => {
    res.render(path.join(__dirname, "views", "tv", "watch.ejs"), { embed: "https://de.laro.voidcities.xyz/tv/embedv2?id=" + req.params.id + "&season=" + req.params.season + "&episode=" + req.params.episode })
})
//apis

app.post("/register", async (req, res) => {
    const { username, password, email, "h-captcha-response": token } = req.body;
    const response = await userHandler.registerUser(username, password, email, token);

    if (!response.error) {
        res.render('register.ejs', { error: "You have successfully registered your account! Head to the sign-in page to log in." });
    } else {
        res.render('register.ejs', { error: response.error_msg });
    }
});

app.post("/signin", async (req, res) => {
    const { username, password } = req.body;
    const response = await userHandler.loginUser(username, password);

    if (response.success && !response.error) {
        req.session.username
        res.redirect("/user/" + username);
    } else {
        res.render('signin.ejs', { error: response.error_msg });
    }
});

//APIS

app.post("/api/tv/search", async (req, res) => {
    const getCache = tvSearchCache.get(req.body.q)
    if (!getCache) {
        let response = await axios.get('https://api.themoviedb.org/3/search/tv', {
            headers: {
                Authorization: `Bearer ${process.env.TMDB_KEY}`
            },
            params: {
                query: req.body.q,
                api_key: process.env.TMDB_KEY
            }
        });
        tvSearchCache.set(req.body.q, response.data)
        res.json(response.data)
    } else {
        res.json(getCache)
    }


});

//also returns season info.
app.post("/api/tv/info", async (req, res) => {
    const query = req.body.q
    const getCache = movieDataCache.get(toString("tv" + query))
    if (!getCache) {
        try {
            let response = await axios.get("https://api.themoviedb.org/3/tv/" + Number(query), {
                headers: { Authorization: "Bearer " + process.env.TMDB_KEY, "Content-Type": "application/json" }
            })
            movieDataCache.set("tv" + query, response.data)
            return res.json(response.data)
        } catch (err) {
            return res.status(500)
        }

    } else {
        return res.json(getCache)
    }
})

app.post("/api/tv/season/info", async (req, res) => {
    const query = req.body.q
    const season = req.body.season
    const getCache = movieDataCache.get(toString("tv" + "S" + season + query))
    if (!getCache) {
        try {
            let response = await axios.get("https://api.themoviedb.org/3/tv/" + Number(query) + "/season/" + Number(season), {
                headers: { Authorization: "Bearer " + process.env.TMDB_KEY, "Content-Type": "application/json" }
            })
            movieDataCache.set("tv" + "S" + season + query, response.data)
            return res.json(response.data)
        } catch (err) {
            return res.status(500)
        }

    } else {
        return res.json(getCache)
    }
})


//apis that need session



function checkSessionUser(req, res, next) {
    if (req.session.loggedin && req.session.userid === req.body.userid) {
        next();
    } else {
        res.status(401).json({ error: "Error: Unauthorized, please log in to use this rescource." })
    }
}
app.post("/api/user/auth/bioupdate", checkSessionUser, async (req, res) => {
    const response = await userHandler.updateUserBio(req.body.userid, req.body.bio);
    if (!response.error) {
        res.json(response)
    } else {
        res.json(response)
    }
});
//start
app.listen(process.env.PORT, () => {
    console.log('Main code: Everything OK, started up fine. ✅');
});