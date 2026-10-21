/**
 * ERP Database connection pool (Busy ERP — read-only).
 * Separate from the main Material Traceability DB.
 */
const sql = require('mssql');
const config = require('./config');
const logger = require('./logger');

let erpPool = null;

async function getErpPool() {
  if (erpPool && erpPool.connected) return erpPool;
  erpPool = await new sql.ConnectionPool(config.erpDb).connect();
  erpPool.on('error', (err) => {
    logger.error('ERP MSSQL pool error — will reconnect on next request', err);
    erpPool = null;
  });
  logger.info('ERP MSSQL connection pool established');
  return erpPool;
}

async function closeErpPool() {
  if (erpPool) {
    await erpPool.close();
    erpPool = null;
    logger.info('ERP MSSQL connection pool closed');
  }
}

module.exports = { getErpPool, closeErpPool, sql };
