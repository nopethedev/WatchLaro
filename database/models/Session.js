import { DataTypes } from "sequelize";
import { sequelize } from "../sequelize.js";

/** Persistent express-session storage so logins survive a server restart. */
export const Session = sequelize.define("sessions", {
    sid: {
        type: DataTypes.STRING(128),
        primaryKey: true
    },
    data: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    expires: {
        type: DataTypes.DATE,
        allowNull: false
    }
}, {
    timestamps: false,
    indexes: [{ fields: ["expires"] }]
});
