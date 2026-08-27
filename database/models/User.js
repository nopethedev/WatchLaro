import { DataTypes } from "sequelize";
import { sequelize } from "../sequelize.js";

export const User = sequelize.define("users", {
  username: {
    type: DataTypes.STRING(16),
    allowNull: false,
    unique: true
  },
  email: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false
  },
  bio: {
    type: DataTypes.STRING,
    charset: "utf8mb4",
    collate: "utf8mb4_unicode_ci"
  },
  profilePicture: {
    type: DataTypes.STRING,
    defaultValue: "https://api.dicebear.com/10.x/thumbs/svg?seed=defaultpfp"
  },
  rank: {
    type: DataTypes.STRING,
    defaultValue: "user",
    allowNull: false // has user, manager, admin
  },
  uuid: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    allowNull: false
  }
}, {timestamps: true});