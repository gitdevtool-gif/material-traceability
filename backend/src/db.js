const sql = require('mssql');
const config = require('./config');
const logger = require('./logger');

let pool = null;

async function getPool() {
  if (pool && pool.connected) return pool;
  pool = await new sql.ConnectionPool({
    server: config.db.server,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    requestTimeout: config.db.requestTimeout,
    options: config.db.options,
    pool: { ...config.db.pool, min: 2 },
  }).connect();
  pool.on('error', (err) => {
    logger.error('MSSQL pool error — will reconnect on next request', err);
    pool = null;
  });
  logger.info('MSSQL connection pool established');
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.close();
    pool = null;
    logger.info('MSSQL connection pool closed');
  }
}

module.exports = { sql, getPool, closePool };
