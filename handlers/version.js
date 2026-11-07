import fs from "node:fs";

let pkg = { version: "0.0.0", name: "watchlaro" };
try {
    pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
} catch (err) {
    console.error("[version] could not read package.json:", err.message);
}

export const APP_VERSION = String(pkg.version || "0.0.0");
export const APP_NAME = String(pkg.name || "watchlaro");

export default { version: APP_VERSION, name: APP_NAME };
