require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  db: {
    server: process.env.DB_SERVER || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 1433,
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'MaterialTraceability',
    // Default (15s) is too short for the Aging Analysis sync's MERGE,
    // which reconciles against the full dbo.AgingStock table (120k+ rows)
    // since it also deletes stale rows now (2026-09-23 fix) — raised here
    // at the pool level since node-mssql/tedious has no working per-request
    // override (Request.timeout is not read by this driver).
    requestTimeout: parseInt(process.env.DB_REQUEST_TIMEOUT_MS, 10) || 120000,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  },
  erpDb: {
    server:         process.env.ERP_DB_SERVER   || 'njoro-server',
    port:           parseInt(process.env.ERP_DB_PORT, 10) || 1433,
    user:           process.env.ERP_DB_USER     || 'o2d',
    password:       process.env.ERP_DB_PASSWORD || '',
    database:       process.env.ERP_DB_NAME     || 'BusyComp0006_db12026',
    requestTimeout: parseInt(process.env.ERP_REQUEST_TIMEOUT_MS, 10) || 60000,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  },
  // Raising Purchase Orders in Busy through Busy's own COM API (see
  // backend/busy-bridge/busy-bridge.ps1). Needs the Busy 21 client
  // installed on the machine running this API. Off until explicitly enabled.
  busyCom: {
    enabled:  process.env.BUSY_PO_PUSH_ENABLED === 'true',
    busyPath: process.env.BUSY_COM_PATH      || 'C:\\BusyWin',
    server:   process.env.BUSY_COM_SERVER    || process.env.ERP_DB_SERVER   || 'njoro-server',
    user:     process.env.BUSY_COM_USER      || process.env.ERP_DB_USER     || 'o2d',
    password: process.env.BUSY_COM_PASSWORD  || process.env.ERP_DB_PASSWORD || '',
    // Busy's company code as OpenCSDBForYear expects it ("Comp0006", not "0006")
    compCode: process.env.BUSY_COM_COMPANY   || 'Comp0006',
    fy:       parseInt(process.env.BUSY_COM_FY, 10) || 2026,
    poSeriesName: process.env.BUSY_PO_SERIES || 'NCF',
    timeoutMs: parseInt(process.env.BUSY_COM_TIMEOUT_MS, 10) || 120000,
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h',
  },
  email: {
    host: process.env.SMTP_HOST || 'mail.njorocanning.co.ke',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: false,
    user: process.env.SMTP_USER || 'procurement@njorocanning.co.ke',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'procurement@njorocanning.co.ke',
    opsManagerEmail: process.env.OPS_MANAGER_EMAIL || 'devendra.mishra@njorocanning.co.ke, gilbert@njorocanning.co.ke, vipul.patel@njorocanning.co.ke',
    // Requisition ops-approval notifications (factory-floor Busy indents
    // awaiting the Ops Manager's per-item review) go to this list —
    // separate from the broader opsManagerEmail list above, which is for
    // Goods Receiving/QA escalations. Includes the Director too (2026-09-14)
    // since Director can now decide these the same as the Ops Manager, both
    // in-app and via this email's one-click Approve All / Hold links.
    requisitionOpsManagerEmail: process.env.REQUISITION_OPS_MANAGER_EMAIL || 'devendra.mishra@njorocanning.co.ke, vipul.patel@njorocanning.co.ke',
    // Directors notified when a supplier submits/updates an RFQ quotation,
    // so they know to log in and pick a winner. Comma-separated list.
    directorEmails: process.env.DIRECTOR_EMAILS || 'vipul.patel@njorocanning.co.ke, gilbert@njorocanning.co.ke',
    // Procurement dept CC'd on the same supplier-responded notification —
    // they can view (but not approve) evaluations, and this keeps them
    // aware of which suppliers have responded without needing to poll the
    // evaluation page. Comma-separated list.
    procurementEmails: process.env.PROCUREMENT_EMAILS || 'procurement@njorocanning.co.ke, Catherine.wanjohi@njorocanning.co.ke',
  },
  appUrl: process.env.APP_URL || 'http://192.168.1.9:4008',
};