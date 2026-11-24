const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * System Viewer (2026-10-15): a read-only role that can open every page
 * (except User Management / audit logs — see authorizeStrict below) but
 * can never change anything.
 *
 * Enforced in TWO layers so a route that forgot an authorize() call can't
 * become a write hole:
 *   1. authenticate() rejects every non-read request from a Viewer up
 *      front, before any route handler runs.
 *   2. authorize() lets a Viewer through on read requests regardless of
 *      the route's role list, so GET endpoints don't each need 'Viewer'
 *      appended.
 *
 * READ_ONLY_POSTS lists the few POST endpoints that only compute and
 * return data (nothing persisted) — a Viewer may call these. Matched
 * against req.originalUrl without the query string.
 */
const VIEWER_ROLE = 'Viewer';
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const READ_ONLY_POSTS = new Set([
  '/api/procurement/production-planning/plan',
]);

/**
 * GRN Reviewer (2026-11-23): sees every page like a System Viewer (read-only),
 * and may also write one thing — the reasons on flagged GRN checks before the
 * Director approves (routes/grn-approval.routes.js).
 */
const GRN_REVIEWER_ROLE = 'GrnReviewer';
const READ_ALL_ROLES = new Set([VIEWER_ROLE, GRN_REVIEWER_ROLE]);
const GRN_REVIEWER_WRITES = [/^\/api\/grn-approvals\/\d+\/reasons$/];

function isReviewerWrite(req) {
  const path = (req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
  return req.method === 'POST' && GRN_REVIEWER_WRITES.some((re) => re.test(path));
}

function isReadRequest(req) {
  if (READ_METHODS.has(req.method)) return true;
  if (req.method === 'POST') {
    const path = (req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
    return READ_ONLY_POSTS.has(path);
  }
  return false;
}

/**
 * Express middleware: verifies JWT and attaches req.user
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = payload; // { userId, username, role }
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (req.user.role === VIEWER_ROLE && !isReadRequest(req)) {
    return res.status(403).json({ error: 'Read-only access — System Viewer accounts cannot make changes' });
  }
  if (req.user.role === GRN_REVIEWER_ROLE && !isReadRequest(req) && !isReviewerWrite(req)) {
    return res.status(403).json({ error: 'Read-only access — a GRN Reviewer can only give reasons on GRN checks' });
  }
  next();
}

/**
 * Factory: returns middleware that checks role membership.
 * A Viewer passes on read requests (see header comment).
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (READ_ALL_ROLES.has(req.user.role) && isReadRequest(req)) {
      return next();
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Same as authorize() but WITHOUT the Viewer read pass-through — for the
 * few read endpoints a Viewer must not see (user accounts, audit trail).
 */
function authorizeStrict(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, authorize, authorizeStrict, VIEWER_ROLE };
