/**
 * Who approves a requisition before Procurement sees it.
 *
 * Two gates share the same flow (PendingOpsApproval -> Pending / RejectedByOps):
 *   - factory floors F1-F10  -> Ops Manager
 *   - Mat Centre "Workshop"  -> Workshop HOD (role WorkshopHOD)
 * Admin and Director can decide either.
 */
const GATE_DECIDER_ROLES = ['OpsManager', 'WorkshopHOD', 'Director', 'Admin'];

function isWorkshopMatCenter(matCenter) {
  return String(matCenter || '').trim().toLowerCase() === 'workshop';
}

/** May this role approve / reject / hold a requisition raised on `matCenter`? */
function canDecideFor(role, matCenter) {
  if (role === 'WorkshopHOD') return isWorkshopMatCenter(matCenter);
  if (role === 'OpsManager') return !isWorkshopMatCenter(matCenter);
  return role === 'Director' || role === 'Admin';
}

/**
 * SQL condition limiting a requisitions query to what `role` is responsible
 * for ('' = everything). `alias` is the requisitions table alias.
 */
function gateScopeSql(role, alias = 'r') {
  const workshop = `LTRIM(RTRIM(${alias}.MatCenter)) = 'Workshop'`;
  if (role === 'WorkshopHOD') return ` AND ${workshop}`;
  if (role === 'OpsManager') return ` AND NOT (${workshop})`;
  return '';
}

module.exports = { GATE_DECIDER_ROLES, isWorkshopMatCenter, canDecideFor, gateScopeSql };
