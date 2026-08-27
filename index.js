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

//handlers

import * as userHandler from "./handlers/usersHandler.js"
import { profile } from "console";
import createAdminAccount from "./handlers/createAdminAccount.js";
import routes from "./routes/index.js";

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
    res.locals.uuid = req.session.user?.uuid || null;
    res.locals.username = req.session.user?.username || null;
    res.locals.rank = req.session.user?.rank || null;
    next(); // Proceed to the next middleware or route handler
});

//routes
routes.forEach(route => app.use(route));

//Auth Middelware


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

app.get('/login', (req, res) => {
    res.render('login.ejs', { error: " " }); // Add route-specific variables
});

app.get('/register', (req, res) => {
    if (!req.session.username) {
        res.render('register.ejs', { error: " " });
    } else {
        res.redirect("/user/" + req.session.username);
    }
});

app.get('/profile/:username', async (req, res) => {
    res.render("profile.ejs");
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