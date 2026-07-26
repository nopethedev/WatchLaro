import { DataTypes } from "sequelize";
import { sequelize } from "../sequelize.js";

//downloaded files etc etc

export const Files = sequelize.define("files", {
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  path: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  torrentHash: {
    type: DataTypes.STRING,
    allowNull: true
  }, 
  quality: {
    type: DataTypes.STRING,
    defaultValue: "1080p"
  },
  linkedId: {
    type: DataTypes.INTEGER, //tmdb id
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM("unknown", "downloading", "transcoding", "done", "failed"),
    defaultValue: "unknown" //unknown, downloading, transcoding, available
  },
  createdAt: {
    type: DataTypes.INTEGER, 
    defaultValue: 0
  },
  type: {
    type: DataTypes.ENUM("movie", "tv"),
    allowNull: false //movie, tv
  },
  season: {
    type: DataTypes.INTEGER,
    allowNull: true
  }, 
  episode: {
    type: DataTypes.INTEGER,
    allowNull: true
  }
});