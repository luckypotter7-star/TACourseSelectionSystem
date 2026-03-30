const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");

function loadLocalEnv(filePath) {
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

async function main() {
  const baseDir = path.resolve(__dirname, "..");
  loadLocalEnv(path.join(baseDir, ".env.local"));
  const schemaSql = fs.readFileSync(path.join(baseDir, "db", "mysql_schema.sql"), "utf8");

  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    multipleStatements: true
  });

  try {
    await connection.query(schemaSql);
    console.log("MySQL schema initialized successfully.");
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error("Failed to initialize MySQL schema.");
  console.error(error);
  process.exit(1);
});
