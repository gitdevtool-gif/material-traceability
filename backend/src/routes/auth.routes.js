const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../db');
const config = require('../config');
const { authenticate, authorize, authorizeStrict } = require('../middleware/auth');
const { writeAuditLog } = require('../services/audit.service');
const { getErpPool } = require('../erpDb');
const { listBusyUsers, resolveBusyUser } = require('../services/busy-po.service');
const { normalizeBusyMatCenter } = require('../services/requisition-item-catalog.service');
const busyBridge = require('../services/busy-bridge.service');

const router = express.Router();

// Exact Busy login for a name typed/selected in User Management; '' / null = not linked.
// Throws a 400-able error when Busy has no such user.
async function checkedBusyUser(name) {
  const wanted = String(name || '').trim();
  if (!wanted) return null;
  const found = await resolveBusyUser(await getErpPool(), wanted);
  if (!found) {
    const err = new Error(`"${wanted}" is not a user in Busy`);
    err.status = 400;
    throw err;
  }
  return found;
}

// Exact Busy Material Centre name for a user's assigned store; '' / null = not set.
// Throws a 400-able error when Busy has no such store (the LPO push would fail on it).
async function checkedMatCenter(name) {
  const wanted = String(name || '').trim();
  if (!wanted) return null;
  const found = await normalizeBusyMatCenter(wanted);
  if (!found) {
    const err = new Error(`"${wanted}" is not a Material Centre in Busy — pick one from the list`);
    err.status = 400;
    throw err;
  }
  return found;
}

// ──── POST /api/auth/login ────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('email', sql.VarChar(100), email)
      .query('SELECT UserId, Username, Email, PasswordHash, FullName, Role, Department, IsActive FROM dbo.Users WHERE Email = @email');

    const user = result.recordset[0];
    if (!user || !user.IsActive) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.PasswordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.UserId, username: user.Username, role: user.Role, fullName: user.FullName, email: user.Email, department: user.Department },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    // Update last login
    await pool.request()
      .input('userId', sql.Int, user.UserId)
      .query('UPDATE dbo.Users SET LastLoginAt = GETUTCDATE() WHERE UserId = @userId');

    await writeAuditLog({
      entityType: 'User', entityId: user.UserId, action: 'Login',
      userId: user.UserId, ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });

    res.json({
      token,
      user: { userId: user.UserId, username: user.Username, fullName: user.FullName, role: user.Role, department: user.Department, email: user.Email },
    });
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/auth/me ────
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('userId', sql.Int, req.user.userId)
      .query('SELECT UserId, Username, FullName, Email, Role, Department FROM dbo.Users WHERE UserId = @userId');

    if (!result.recordset[0]) {
      return res.status(404).json({ error: 'User not found' });
    }
    const u = result.recordset[0];
    res.json({ userId: u.UserId, username: u.Username, fullName: u.FullName, email: u.Email, role: u.Role, department: u.Department });
  } catch (err) {
    next(err);
  }
});

// ──── Busy login link for the signed-in user (2026-10-19) ────
// Raising a PO in Busy needs the raiser's own Busy login, proved once with
// their Busy password. Busy checks it (COM ValidUserPassword through the
// bridge); only the user name and when it was verified are stored — the
// password never is, and is never logged.
const BUSY_LINK_ROLES = ['Admin', 'Procurement'];
const BUSY_LINK_MAX_FAILS = 5;
const BUSY_LINK_WINDOW_MS = 15 * 60 * 1000;
const busyLinkFails = new Map(); // userId -> [timestamps of failed tries]

router.get('/me/busy-link', authenticate, authorizeStrict(...BUSY_LINK_ROLES), async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().input('id', sql.Int, req.user.userId)
      .query('SELECT BusyUserName, BusyUserVerifiedAt FROM dbo.Users WHERE UserId = @id');
    const u = r.recordset[0] || {};
    res.json({ busyUserName: u.BusyUserName || null, verifiedAt: u.BusyUserVerifiedAt || null });
  } catch (err) { next(err); }
});

router.post('/me/busy-link', authenticate, authorizeStrict(...BUSY_LINK_ROLES), async (req, res, next) => {
  try {
    const wanted = String(req.body.busyUserName || '').trim();
    const password = String(req.body.busyPassword || '');
    if (!wanted || !password) return res.status(400).json({ error: 'Enter your Busy user name and Busy password.' });
    if (!config.busyCom.enabled) return res.status(503).json({ error: 'Busy connection is not switched on.' });

    const now = Date.now();
    const fails = (busyLinkFails.get(req.user.userId) || []).filter((t) => now - t < BUSY_LINK_WINDOW_MS);
    if (fails.length >= BUSY_LINK_MAX_FAILS) {
      return res.status(429).json({ error: 'Too many wrong attempts — try again in 15 minutes.' });
    }

    const exact = await resolveBusyUser(await getErpPool(), wanted);
    const check = exact ? await busyBridge.checkUser(exact, password) : { ok: true, exists: false, valid: false };
    if (!check.ok) return res.status(502).json({ error: `Busy could not check the login: ${check.error}` });
    if (!check.exists || !check.valid) {
      busyLinkFails.set(req.user.userId, [...fails, now]);
      await writeAuditLog({
        entityType: 'User', entityId: req.user.userId, action: 'Update', userId: req.user.userId,
        newValues: { event: 'BusyLoginLinkFailed', busyUserName: wanted },
        ipAddress: req.ip, userAgent: req.get('User-Agent'),
      });
      return res.status(400).json({ error: 'Busy did not accept that user name and password.' });
    }
    busyLinkFails.delete(req.user.userId);

    const pool = await getPool();
    const r = await pool.request()
      .input('id', sql.Int, req.user.userId)
      .input('busyUserName', sql.NVarChar(50), exact)
      .query(`UPDATE dbo.Users SET BusyUserName = @busyUserName, BusyUserVerifiedAt = SYSUTCDATETIME(), UpdatedAt = GETUTCDATE()
              OUTPUT INSERTED.BusyUserVerifiedAt WHERE UserId = @id`);
    await writeAuditLog({
      entityType: 'User', entityId: req.user.userId, action: 'Update', userId: req.user.userId,
      newValues: { event: 'BusyLoginLinked', busyUserName: exact },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });
    res.json({ busyUserName: exact, verifiedAt: r.recordset[0]?.BusyUserVerifiedAt || null });
  } catch (err) { next(err); }
});

// ──── GET /api/auth/users (Admin only — list users) ────
router.get('/users', authenticate, authorizeStrict('Admin'), async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT UserId, Username, FullName, Email, Role, Department, AssignedMatCenter, BusyUserName, BusyUserVerifiedAt, IsActive, CreatedAt FROM dbo.Users ORDER BY FullName');
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
});

// ──── GET /api/auth/busy-users (Admin only — Busy logins a user can be linked to) ────
router.get('/busy-users', authenticate, authorizeStrict('Admin'), async (req, res) => {
  try {
    res.json(await listBusyUsers(await getErpPool()));
  } catch (err) {
    res.json([]);
  }
});

// ──── POST /api/auth/users (Admin only — create user) ────
router.post('/users', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const { username, password, fullName, email, role, department, assignedMatCenter, busyUserName } = req.body;
    if (!username || !password || !fullName || !role) {
      return res.status(400).json({ error: 'username, password, fullName, and role are required' });
    }

    const busyUser = await checkedBusyUser(busyUserName);
    const matCenter = await checkedMatCenter(assignedMatCenter);
    const passwordHash = await bcrypt.hash(password, 12);
    const pool = await getPool();

    const result = await pool.request()
      .input('username', sql.VarChar(50), username)
      .input('passwordHash', sql.VarChar(255), passwordHash)
      .input('fullName', sql.NVarChar(150), fullName)
      .input('email', sql.VarChar(100), email || null)
      .input('role', sql.VarChar(30), role)
      .input('department', sql.VarChar(100), department || null)
      .input('assignedMatCenter', sql.NVarChar(100), matCenter)
      .input('busyUserName', sql.NVarChar(50), busyUser)
      .query(`INSERT INTO dbo.Users (Username, PasswordHash, FullName, Email, Role, Department, AssignedMatCenter, BusyUserName)
              OUTPUT INSERTED.UserId, INSERTED.Username, INSERTED.FullName, INSERTED.Role
              VALUES (@username, @passwordHash, @fullName, @email, @role, @department, @assignedMatCenter, @busyUserName)`);

    await writeAuditLog({
      entityType: 'User', entityId: result.recordset[0].UserId, action: 'Create',
      userId: req.user.userId, newValues: { username, fullName, role, department, busyUserName: busyUser },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    next(err);
  }
});

// ──── PUT /api/auth/users/:id (Admin only — update user) ────
router.put('/users/:id', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const { username, fullName, email, role, department, assignedMatCenter, busyUserName, password, isActive } = req.body;
    if (!username || !fullName || !role) {
      return res.status(400).json({ error: 'username, fullName, and role are required' });
    }

    const busyUser = await checkedBusyUser(busyUserName);
    const matCenter = await checkedMatCenter(assignedMatCenter);
    const pool = await getPool();

    // Build dynamic update
    let query = `UPDATE dbo.Users SET Username = @username, FullName = @fullName,
      Email = @email, Role = @role, Department = @department, AssignedMatCenter = @assignedMatCenter,
      BusyUserName = @busyUserName, IsActive = @isActive, UpdatedAt = GETUTCDATE(),
      BusyUserVerifiedAt = CASE WHEN ISNULL(BusyUserName, '') = ISNULL(@busyUserName, '') THEN BusyUserVerifiedAt ELSE NULL END`;
    const request = pool.request()
      .input('userId', sql.Int, userId)
      .input('username', sql.VarChar(50), username)
      .input('fullName', sql.NVarChar(150), fullName)
      .input('email', sql.VarChar(100), email || null)
      .input('role', sql.VarChar(30), role)
      .input('department', sql.VarChar(100), department || null)
      .input('assignedMatCenter', sql.NVarChar(100), matCenter)
      .input('busyUserName', sql.NVarChar(50), busyUser)
      .input('isActive', sql.Bit, isActive !== false ? 1 : 0);

    if (password) {
      const passwordHash = await bcrypt.hash(password, 12);
      query += ', PasswordHash = @passwordHash';
      request.input('passwordHash', sql.VarChar(255), passwordHash);
    }

    query += ' WHERE UserId = @userId';
    const result = await request.query(query);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await writeAuditLog({
      entityType: 'User', entityId: userId, action: 'Update',
      userId: req.user.userId, newValues: { username, fullName, role, department, assignedMatCenter: matCenter, isActive },
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });

    res.json({ message: 'User updated successfully' });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    next(err);
  }
});

// ──── DELETE /api/auth/users/:id (Admin only — deactivate user) ────
router.delete('/users/:id', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    // Prevent self-deletion
    if (userId === req.user.userId) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('userId', sql.Int, userId)
      .query('UPDATE dbo.Users SET IsActive = 0, UpdatedAt = GETUTCDATE() WHERE UserId = @userId');

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await writeAuditLog({
      entityType: 'User', entityId: userId, action: 'Deactivate',
      userId: req.user.userId,
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });

    res.json({ message: 'User deactivated successfully' });
  } catch (err) {
    next(err);
  }
});

// ──── DELETE /api/auth/users/:id/permanent (Admin only — permanently delete user) ────
router.delete('/users/:id/permanent', authenticate, authorize('Admin'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    if (userId === req.user.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('userId', sql.Int, userId)
      .query('DELETE FROM dbo.Users WHERE UserId = @userId');

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await writeAuditLog({
      entityType: 'User', entityId: userId, action: 'Delete',
      userId: req.user.userId,
      ipAddress: req.ip, userAgent: req.get('User-Agent'),
    });

    res.json({ message: 'User permanently deleted' });
  } catch (err) {
    if (err.number === 547) {
      return res.status(409).json({ error: 'Cannot delete user — they have associated records. Deactivate instead.' });
    }
    next(err);
  }
});

module.exports = router;
