import { DataTypes } from "sequelize";
import { sequelize } from "../sequelize.js";

/**
 * Per-profile watch history. One row per title (series are updated to the
 * latest episode) so recommendations do not count the same show repeatedly.
 */
export const WatchHistory = sequelize.define("watch_history", {
    profileId: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    mediaType: {
        type: DataTypes.STRING(8),
        allowNull: false
    },
    tmdbId: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    title: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    poster: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    backdrop: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    year: {
        type: DataTypes.STRING(4),
        allowNull: true
    },
    rating: {
        type: DataTypes.FLOAT,
        allowNull: true
    },
    overview: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    genres: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: "[]"
    },
    season: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    episode: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    lastWatchedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    }
}, {
    timestamps: true,
    indexes: [
        { unique: true, fields: ["profileId", "mediaType", "tmdbId"] },
        { fields: ["profileId", "lastWatchedAt"] }
    ]
});
