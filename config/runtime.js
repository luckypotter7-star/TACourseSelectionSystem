const fs = require("node:fs");
const path = require("node:path");

const BASE_DIR = path.resolve(__dirname, "..");
const DB_PATH = path.join(BASE_DIR, "ta_system_node.db");
const UPLOAD_DIR = path.join(BASE_DIR, "uploads");
const ASSET_DIR = path.join(BASE_DIR, "assets");
const LOCAL_ENV_PATH = path.join(BASE_DIR, ".env.local");

function loadLocalEnv(filePath = LOCAL_ENV_PATH) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv();

const DB_CLIENT = (process.env.DB_CLIENT || "mysql").trim().toLowerCase();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

module.exports = {
  BASE_DIR,
  DB_PATH,
  UPLOAD_DIR,
  ASSET_DIR,
  LOCAL_ENV_PATH,
  DB_CLIENT,
  PORT,
  HOST,
  loadLocalEnv
};
