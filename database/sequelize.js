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
const clean = (value, fallback = "") =>
  String(value ?? fallback).trim().replace(/^["']|["']$/g, "").trim();

const dialect = clean(process.env.DB_DIALECT, "mariadb").toLowerCase();
const logging = clean(process.env.DB_LOGGING, "true") === "false" ? false : console.log;

export const isSQLite = dialect === "sqlite";

function build() {
  if (isSQLite) {
    const storage = path.resolve(
      process.cwd(),
      clean(process.env.DB_STORAGE, path.join("database", "watchlaro.sqlite"))
    );
    // sequelize creates the file, but not the directory holding it
    fs.mkdirSync(path.dirname(storage), { recursive: true });
    return new Sequelize({ dialect: "sqlite", storage, logging });
  }

  return new Sequelize(clean(process.env.DB_NAME), clean(process.env.DB_USER), clean(process.env.DB_PASS), {
    dialect,
    host: clean(process.env.DB_HOST) || undefined,
    port: clean(process.env.DB_PORT) || undefined,
    logging,
  });
}

export const sequelize = build();
