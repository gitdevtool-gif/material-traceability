const { getPool } = require('./src/db');
(async () => {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT at.TokenId, at.EntryNo, at.Action, at.IsUsed, at.ExpiresAt, at.UsedAt, at.CreatedAt,
           de.Status AS EntryStatus, de.VersionNo,
           qi.OverallStatus, qi.OpsManagerDecision, qi.OpsManagerApprovedAt
    FROM dbo.ApprovalTokens at
    JOIN dbo.DeliveryEntries de ON de.EntryId = at.EntryId
    LEFT JOIN dbo.QAInspections qi ON qi.EntryId = at.EntryId
    ORDER BY at.CreatedAt DESC
  `);
  console.log(JSON.stringify(r.recordset, null, 2));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
