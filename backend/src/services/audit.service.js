const { getPool, sql } = require('../db');
const logger = require('../logger');

// dbo.AuditLogs.Action has a CHECK constraint allowing only these. Specific
// actions (e.g. 'MarkRaisedInBusy', 'LinkBusyGRN', 'MergeIntoBusySupplier')
// used to be rejected by it — silently, since this function swallows errors
// — so they were never audited. They're now stored under the closest
// allowed action, with the specific one kept in NewValues.event.
const ALLOWED_ACTIONS = new Set(['Create', 'Update', 'Delete', 'Reverse', 'Lock', 'StatusChange', 'Login', 'Logout']);
const ACTION_MAP = {
  MarkRaisedInBusy: 'Create', RaisedInBusy: 'Create', LinkPushedToBusy: 'Create',
  LinkBusyGRN: 'StatusChange', Cancel: 'StatusChange',
  MergeIntoBusySupplier: 'Update',
};

/**
 * Write an immutable audit log entry.
 * Fire-and-forget safe — errors are logged but won't crash the caller.
 */
async function writeAuditLog({ entityType, entityId, action, userId, oldValues, newValues, ipAddress, userAgent }) {
  let storedAction = action;
  let storedNew = newValues;
  if (!ALLOWED_ACTIONS.has(action)) {
    storedAction = ACTION_MAP[action] || 'Update';
    storedNew = { event: action, ...(newValues || {}) };
  }
  try {
    const pool = await getPool();
    await pool.request()
      .input('entityType', sql.VarChar(30), entityType)
      .input('entityId', sql.VarChar(50), String(entityId))
      .input('action', sql.VarChar(30), storedAction)
      .input('userId', sql.Int, userId)
      .input('oldValues', sql.NVarChar(sql.MAX), oldValues ? JSON.stringify(oldValues) : null)
      .input('newValues', sql.NVarChar(sql.MAX), storedNew ? JSON.stringify(storedNew) : null)
      .input('ipAddress', sql.VarChar(45), ipAddress || null)
      .input('userAgent', sql.VarChar(300), userAgent || null)
      .query(`INSERT INTO dbo.AuditLogs
        (EntityType, EntityId, Action, UserId, OldValues, NewValues, IPAddress, UserAgent)
        VALUES (@entityType, @entityId, @action, @userId, @oldValues, @newValues, @ipAddress, @userAgent)`);
  } catch (err) {
    logger.error('Failed to write audit log', { entityType, entityId, action, error: err.message });
  }
}

/**
 * Write an immutable status transition record.
 * Fire-and-forget safe — errors are logged but won't crash the caller.
 */
async function writeStatusHistory({ entityType, entityId, fromStatus, toStatus, changedBy, remarks }) {
  try {
    const pool = await getPool();
    await pool.request()
      .input('entityType', sql.VarChar(30), entityType)
      .input('entityId', sql.Int, entityId)
      .input('fromStatus', sql.VarChar(30), fromStatus || null)
      .input('toStatus', sql.VarChar(30), toStatus)
      .input('changedBy', sql.Int, changedBy)
      .input('remarks', sql.NVarChar(500), remarks || null)
      .query(`INSERT INTO dbo.StatusHistory
        (EntityType, EntityId, FromStatus, ToStatus, ChangedBy, Remarks)
        VALUES (@entityType, @entityId, @fromStatus, @toStatus, @changedBy, @remarks)`);
  } catch (err) {
    logger.error('Failed to write status history', { entityType, entityId, toStatus, error: err.message });
  }
}

module.exports = { writeAuditLog, writeStatusHistory };
