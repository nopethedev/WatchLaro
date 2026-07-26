import { DataTypes } from "sequelize";
import { sequelize } from "../sequelize.js";

export const Settings = sequelize.define("Settings", {
    key: {
        type: DataTypes.STRING,
        unique: true
    },
    value: {
        type: DataTypes.TEXT
    },
    hidden: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    }
});