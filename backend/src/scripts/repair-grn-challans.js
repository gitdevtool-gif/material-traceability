/**
 * Make GRNs pushed from this system billable in Busy (2026-11-17).
 *
 * Busy lists a GRN in a Purchase voucher's pending-GRN picker from the GRN's
 * own "pending challan" refs (Tran3 RecType 3, Method 1). GRNs keyed in Busy
 * get them; GRNs saved through AddVchFromXML did not, so Accounts can't
 * select them. This re-saves Busy's own XML of each GRN with those refs added
 * (busy-grn.service addChallanRefs) and checks amount and PO refs are unchanged.
 *
 *   node src/scripts/repair-grn-challans.js                       list affected GRNs
 *   node src/scripts/repair-grn-challans.js Njr-2367---2026-27 --live   fix one
 *   node src/scripts/repair-grn-challans.js --all --live          fix all listed
 *
 * Run from the backend folder on a machine with the Busy client (busy-bridge).
 */
process.chdir(require('path').join(__dirname, '..', '..'));
const { getErpPool, sql } = require('../erpDb');
const { addChallanRefs, grnsMissingChallans } = require('../services/busy-grn.service');

(async () => {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const all = args.includes('--all');
  const wanted = args.filter((a) => !a.startsWith('--')).map((a) => a.trim());
  const erpPool = await getErpPool();

  let todo = await grnsMissingChallans(erpPool);
  console.log(`${todo.length} pushed GRN(s) without pending-challan refs (KES ${todo.reduce((s, g) => s + Number(g.Amount), 0).toLocaleString()}).`);
  if (wanted.length) todo = todo.filter((g) => wanted.includes(g.VchNo));
  else if (!all) {
    todo.forEach((g) => console.log(`  ${g.VchNo}  ${new Date(g.Date).toISOString().slice(0, 10)}  ${g.Party}  ${g.Amount}`));
    console.log('\nNothing changed. Name a GRN (or --all) and add --live to fix.');
    process.exit(0);
  }
  if (!live) console.log('DRY RUN — add --live to save in Busy.');

  for (const g of todo) {
    const r = await addChallanRefs(erpPool, g.VchCode, { dryRun: !live });
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${g.VchNo}  ${r.dryRun ? `(would add ${r.lines} ref(s))` : r.ok ? `${r.challans} challan ref(s)` : r.error}`);
  }
  if (live && todo.length) {
    const check = await erpPool.request().query(`
      SELECT LTRIM(t.VchNo) AS VchNo, COUNT(c.RefCode) AS Challans FROM dbo.Tran1 t
      LEFT JOIN dbo.Tran3 c ON c.VchCode = t.VchCode AND c.RecType = 3 AND c.Method = 1
      WHERE t.VchCode IN (${todo.map((g) => Number(g.VchCode)).join(',')}) GROUP BY t.VchNo`);
    console.log('\nIn Busy now:', check.recordset.map((x) => `${x.VchNo.trim()}=${x.Challans}`).join(', '));
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
