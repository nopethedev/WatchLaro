import { sequelize, User } from "../database/index.js";
import { verify } from "hcaptcha";
import bcrypt from "bcrypt";
//import { Sequelize } from "sequelize";
const hCaptchaSecret = "ES_2fc9190ff4ac4bb2888a87ab55c3d9b0"



//const followTable = //sequelize.define('et_follow', {
//);
 //TODO: Fix




export async function registerUser(username, password, email, token) {
  try {


    const verifyCaptcha = await verify(hCaptchaSecret, token);
    if (verifyCaptcha.success) {
      if (username, password, email) {
        const usernameexists = await User.findOne({ where: { username: username } });
        const emailexists = await User.findOne({ where: { email: email } });

        if (usernameexists || emailexists) {
          return { error: true, error_msg: "User already exist!" };
        } else {

          const isValid = /^[A-Za-z0-9_-]+$/.test(username);


          if (isValid) {
            if (username.length <= 16) {
              await User.create({
                username: username,
                email: email,
                password: bcrypt.hashSync(password, bcrypt.genSaltSync(10)),
                createdAt: Date.now(),
                bio: "Hey! I am a new Laro user!",
                followers: 0,
                following: 0,
                rank: "Member",
                userid: Math.random().toString(36).substring(2, 10),
                isAdmin: false
              });
              return { error: false, error_msg: "", success: true }
            } else {
              return { error: true, error_msg: "Username is too long! (Limit: 16)" };
            }
          } else {
            return { error: true, error_msg: "Username contains unsupported characters!" };
          }
        }
      } else {
        return { error: true, error_msg: "Please provide." };
      }
    } else {
      return { error: true, error_msg: "Please solve the captcha." };
    }



  } catch (error) {
    return { error: true, error_msg: error };
  }


};

export async function loginUser(username, password) {
  try {



    if (username, password) {
      const userFromDB = await User.findOne({ where: { username: username } });
      if (userFromDB) {
        //verify password
        const passCheck = await bcrypt.compare(password, userFromDB.password);
        if (passCheck) {
          return { error: false, error_msg: " ", success: true, userid: userFromDB.userid, rank: userFromDB.rank, isadmin: userFromDB.isAdmin };
        } else {
          return { error: true, error_msg: "Wrong password try again!" };
        }
      } else {
        return { error: true, error_msg: "User is not found!" };
      }
    } else {
      return { error: true, error_msg: "Please provide your username & password!" };
    }



  } catch (error) {
    return { error: true, error_msg: error };
  }


}

export async function getUserDataFromusername(username) {
  const userFind = await User.findOne({ where: { username: username } });

  if (userFind) {
    return { error: false, error_msg: " ", data: userFind };
  } else {
    return { error: true, error_msg: "User is not found!" };
  }
}

export async function updateUserBio(userid, bio) {
  const userFind = await User.findOne({ where: { userid: userid } });

  if (userFind) {
    userFind.bio = bio;
    let hasError = false;
    try {
      await userFind.save();
    } catch (error) {
      hasError = true;
      return { error: true, error_msg: error, success: false };
    }
    if (!hasError) {
      return { error: false, error_msg: " ", success: true };
    }
  } else {
    return { error: true, error_msg: "User is not found!" };
  }
}

export async function followUser(userToFollowId, user) {
  const userFind = await User.findOne({ where: { userToFollowId: userid } });

  if (userFind) {
    
  } else {
    return { error: true, error_msg: "User is not found!" };
  }
}

//export {registerUser};