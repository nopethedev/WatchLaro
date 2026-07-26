import { sequelize } from "./sequelize.js";
import "./models/index.js";

export async function initDB() {
  console.log("🔃 Authenticating...");
  await sequelize.authenticate();

  console.log("🔃 Syncing...");
  await sequelize.sync({ alter: true });

  console.log("✅ Database Ready");
}

export { sequelize };
export * from "./models/index.js";