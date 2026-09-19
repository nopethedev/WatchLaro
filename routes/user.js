import express from "express";
import { User } from "../database/models/User.js";

const app = express.Router();

app.get("/api/profile/info/:username", async(req,res) => {
    const profile = await User.findOne({where: {username: req.params.username}});
    if (profile){
        res.json({username: profile.username, uuid: profile.uuid, profilePicture: profile.profilePicture, rank: profile.rank, bio: profile.bio});
    }else{
        res.status(404).json({error: "Not found."})
    }
});

export default app;