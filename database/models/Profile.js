import { DataTypes } from "sequelize";
import { sequelize } from "../sequelize.js";

/**
 * One viewing profile inside a WatchLaro account. Accounts can have up to
 * five; each profile owns its own history and genre taste.
 */
export const Profile = sequelize.define("profiles", {
    userUuid: {
        type: DataTypes.STRING(36),
        allowNull: false
    },
    name: {
        type: DataTypes.STRING(32),
        allowNull: false
    },
    avatar: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    genreWeights: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: "{}"
    },
    onboarded: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    lastUsedAt: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    timestamps: true,
    indexes: [
        { unique: true, fields: ["userUuid", "name"] },
        { fields: ["userUuid"] }
    ]
});
