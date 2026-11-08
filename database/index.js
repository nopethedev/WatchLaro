import { sequelize, isSQLite } from "./sequelize.js";
import { Profile, WatchHistory } from "./models/index.js";

const quote = (identifier) => `"${String(identifier).replace(/"/g, '""')}"`;

async function sqliteHasCorruptUniqueConstraints(model) {
  const table = model.getTableName();
  const [tables] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    { replacements: [table] }
  );
  if (!tables.length) return false;
  const [indexes] = await sequelize.query(`PRAGMA index_list(${quote(table)})`);
  return indexes.some((index) => Boolean(index.unique) && index.origin === "u");
}

async function repairSQLiteTable(model) {
  if (!(await sqliteHasCorruptUniqueConstraints(model))) return false;

  const table = model.getTableName();
  const backup = `${table}_repair_${Date.now()}`;
  const columns = Object.keys(model.rawAttributes).map(quote).join(", ");

  await sequelize.transaction(async (transaction) => {
    await sequelize.query(`ALTER TABLE ${quote(table)} RENAME TO ${quote(backup)}`, { transaction });
    const [oldIndexes] = await sequelize.query(`PRAGMA index_list(${quote(backup)})`, { transaction });
    for (const index of oldIndexes) {
      if (!String(index.name).startsWith("sqlite_autoindex")) {
        await sequelize.query(`DROP INDEX IF EXISTS ${quote(index.name)}`, { transaction });
      }
    }
    await model.sync({ transaction });
    await sequelize.query(
      `INSERT INTO ${quote(table)} (${columns}) SELECT ${columns} FROM ${quote(backup)}`,
      { transaction }
    );
    await sequelize.query(`DROP TABLE ${quote(backup)}`, { transaction });
  });

  console.log(`[database] repaired ${table} unique indexes`);
  return true;
}

export async function initDB() {
  console.log("🔃 Authenticating...");
  await sequelize.authenticate();

  console.log("🔃 Syncing...");
  if (isSQLite) {
    // SQLite's schema inspection marks each column of a composite unique
    // index as independently unique during sync({ alter: true }). That
    // corrupts profile names and watch-history media types, so repair any
    // affected tables and don't use alter mode on SQLite again.
    await repairSQLiteTable(Profile);
    await repairSQLiteTable(WatchHistory);
    await sequelize.sync();
  } else {
    await sequelize.sync({ alter: true });
  }

  console.log("✅ Database Ready");
}

export { sequelize };
export * from "./models/index.js";