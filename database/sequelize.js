import { Sequelize } from "sequelize";
import path from "node:path";
import fs from "node:fs";

/**
 * Connection factory.
 *
 * DB_DIALECT=mariadb (default) - uses the MySQL style env vars:
 *   DB_NAME, DB_USER, DB_PASS, DB_HOST, DB_PORT
 *
 * DB_DIALECT=sqlite - none of those are needed, just an optional file path:
 *   DB_STORAGE=./database/watchlaro.sqlite   (default)
 */
const dialect = String(process.env.DB_DIALECT || "mariadb").toLowerCase();
const logging = process.env.DB_LOGGING === "false" ? false : console.log;

export const isSQLite = dialect === "sqlite";

function build() {
  if (isSQLite) {
    const storage = path.resolve(
      process.cwd(),
      process.env.DB_STORAGE || path.join("database", "watchlaro.sqlite")
    );
    // sequelize creates the file, but not the directory holding it
    fs.mkdirSync(path.dirname(storage), { recursive: true });
    return new Sequelize({ dialect: "sqlite", storage, logging });
  }

  return new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
    dialect,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    logging,
  });
}

export const sequelize = build();
