const mysql = require("mysql2/promise");

let pool = null;

function getMysqlConfig() {
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "ta_system",
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    charset: "utf8mb4"
  };
}

function getMysqlPool() {
  if (!pool) {
    pool = mysql.createPool(getMysqlConfig());
  }
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getMysqlPool().execute(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function execute(sql, params = []) {
  const [result] = await getMysqlPool().execute(sql, params);
  return result;
}

async function withTransaction(fn) {
  const connection = await getMysqlPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  getMysqlConfig,
  getMysqlPool,
  query,
  one,
  execute,
  withTransaction
};
