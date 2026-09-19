import express from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import authMiddleware from "../../handlers/authMiddleware.js";
import { User } from "../../database/index.js";

const app = express.Router();

app.get("/api/admin/users", authMiddleware.checkAdmin, async (req, res) => {
    const pagecount = req.query.page || 1;
    const limit = 75;
    const offset = (pagecount - 1) * limit;

    const users = await User.findAndCountAll({ limit, offset, order: [["createdAt", "DESC"]] });

    res.json({ users: users.rows });
});

app.post("/api/admin/users/create", authMiddleware.checkAdmin, async (req, res) => {
    try {
        const schema = z.object({
            username: z.string().min(4).max(48),
            email: z.email(),
            password: z.string().min(4),
            rank: z.enum(['member', 'manager', 'admin'])
        });
        const result = schema.safeParse(req.body)
        if (!result.success) {
            return res.status(400).json(result.error.flatten());
        }

        const data = result.data

        const newuser = await User.create({ username: data.username, email: data.email, password: await bcrypt.hashSync(data.password, 12), bio: "Hello, I am a WL User!", profilePicture: "https://api.dicebear.com/10.x/thumbs/svg?seed=" + data.username, rank: data.rank });

        return res.redirect("/admin/users")
    }catch(err){
        console.log("Error: " + err);
        return res.status(500).json({error: err});
    }
});

app.get("/api/admin/users/info/:uuid", authMiddleware.checkAdmin, async(req,res) => {
    try {
        const uuid = req.params.uuid
        const findUser = await User.findOne({where: {uuid: uuid}});
        if (!findUser) return req.status(404).json({error: "User not found."});

        return res.json(findUser);
    }catch(err){
        console.log("Error: " + err);
        return res.status(500).json({error: err});
    }
});

app.post("/api/admin/users/edit/:uuid", authMiddleware.checkAdmin, async(req,res) => {
    try {
        const uuid = req.params.uuid
        const schema = z.object({
            username: z.string().min(4).max(48).optional(),
            email: z.email().optional(),
            password: z.string().optional(),
            bio: z.string().optional(),
            rank: z.enum(['member', 'manager', 'admin']).optional(),
            profilePicture: z.string().optional()
        });
        const result = schema.safeParse(req.body)
        if (!result.success) {
            return res.status(400).json(result.error.flatten());
        }

        const data = result.data

       const user = await User.findOne({where: {uuid: req.params.uuid}});
       if (!user) return req.status(404).json({error: "not found user"}) 

        if (data.password) {
            data.password = bcrypt.hashSync(data.password, 12);
        }else{
            delete data.password;
        }

        await user.update(data);

        return res.status(200).json({success: true});
    }catch(err){
        console.log("Error: " + err);
        return res.status(500).json({error: err});
    }
});

export default app;