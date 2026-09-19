import {User} from "../database/models/User.js";
import bcrypt from "bcrypt";

export default async function(){
    const find = await User.findOne({where: {username: "admin"}});

    if (!find){
        console.log("No admin account found, creating new")
        const pass = await bcrypt.hash("Admin123!", 13)
        await User.create({
            username: "admin",
            email: "example@example.com",
            password: pass,
            bio: "An admin or somehting idk",
            rank: "admin"
        });

        console.log("Created default admin account. U can login using admin and Admin123!")
    }
}