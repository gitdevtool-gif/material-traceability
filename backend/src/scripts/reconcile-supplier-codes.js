/**
 * Reconcile Supplier Codes
 *
 * ONE-TIME utility. Run this BEFORE ever running supplier-sync.service.js's
 * syncSuppliers() / startSyncJob() against a database that was manually
 * seeded (e.g. via seed-suppliers.js) with placeholder codes like NCF-0001.
 *
 * Problem it solves
 * ------------------
 * The seed script assigned sequential NCF-xxxx codes that have no relation
 * to Busy ERP's real Code values. If syncSuppliers() runs against that data
 * as-is, it will not find a SupplierCode match for almost any seeded
 * supplier, and will flip them all to IsActive = 0 via the
 * "WHEN NOT MATCHED BY SOURCE" branch — even though they are very much
 * still active suppliers, just linked under the wrong code.
 *
 * What this script does
 * ----------------------
 * 1. Pulls all local suppliers and all Busy ERP suppliers (PartyType='Supplier').
 * 2. Normalizes names (case, punctuation, whitespace) and matches them.
 * 3. For EXACT, UNAMBIGUOUS matches only:
 *      - proposes updating the local SupplierCode to Busy's real Code
 * 4. Anything ambiguous (name normalizes to match >1 Busy row, e.g. an
 *    "...LTD" vs "...LIMITED" pair under two different Busy codes) or
 *    unmatched (no Busy row found — likely a local-only ledger entry like
 *    "TRAINING LEVY" or "CASH ACCOUNT SUNDRY VENDORS") is NEVER auto-applied.
 *    It is written to the report for manual review.
 * 5. SupplierId is never touched. Only SupplierCode is updated, and only
 *    for confident matches.
 *
 * Usage
 * -----
 *   node reconcile-supplier-codes.js            # dry run, writes report only
 *   node reconcile-supplier-codes.js --apply    # applies confident matches
 *
 * Adjust the require paths below if this script lives outside src/scripts.
 */

const fs = require('fs');
const path = require('path');

const { getErpPool } = require('../erpDb');
const { getPool, sql } = require('../db');
const logger = require('../logger');

const APPLY = process.argv.includes('--apply');
const REPORT_PATH = path.join(__dirname, 'reconciliation-report.json');

function normalizeName(name) {
    return String(name || '')
        .toUpperCase()
        .replace(/[.,'’`"()]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function reconcileSupplierCodes() {

    logger.info(
        `[ReconcileSupplierCodes] Starting ${APPLY ? 'APPLY' : 'DRY RUN'}...`
    );

    try {

        const [localPool, erpPool] = await Promise.all([
            getPool(),
            getErpPool()
        ]);

        //-------------------------------------------------------
        // Load Busy ERP suppliers
        //-------------------------------------------------------

        const busyResult = await erpPool.request().query(`

            SELECT

                LTRIM(RTRIM(Code))  AS SupplierCode,
                LTRIM(RTRIM(Name))  AS SupplierName

            FROM dbo.vw_CustomersAndSuppliers

            WHERE PartyType='Supplier'

        `);

        const busySuppliers = busyResult.recordset;

        // Map: normalizedName -> [ { SupplierCode, SupplierName }, ... ]
        const busyByNormalizedName = new Map();

        for (const b of busySuppliers) {

            const key = normalizeName(b.SupplierName);

            if (!busyByNormalizedName.has(key)) {
                busyByNormalizedName.set(key, []);
            }

            busyByNormalizedName.get(key).push(b);

        }

        logger.info(
            `[ReconcileSupplierCodes] ${busySuppliers.length} supplier(s) loaded from Busy ERP.`
        );

        //-------------------------------------------------------
        // Load local suppliers
        //-------------------------------------------------------

        const localResult = await localPool.request().query(`

            SELECT

                SupplierId,
                SupplierCode,
                SupplierName

            FROM dbo.Suppliers

        `);

        const localSuppliers = localResult.recordset;

        logger.info(
            `[ReconcileSupplierCodes] ${localSuppliers.length} supplier(s) loaded from local DB.`
        );

        // Track Busy codes already claimed by a proposed update, to avoid
        // two local suppliers being pointed at the same Busy code.
        const claimedBusyCodes = new Set(
            localSuppliers.map(s => s.SupplierCode)
        );

        const proposedUpdates = [];   // { SupplierId, oldCode, newCode, name }
        const alreadyLinked = [];     // local SupplierCode already equals a real Busy code
        const ambiguous = [];         // normalized name matched >1 Busy row
        const unmatched = [];         // no Busy row found
        const collisions = [];        // confident match, but target code already in use locally

        const busyCodeSet = new Set(busySuppliers.map(b => b.SupplierCode));

        for (const local of localSuppliers) {

            // Already correctly linked to a real Busy code — nothing to do.
            if (busyCodeSet.has(local.SupplierCode)) {
                alreadyLinked.push(local);
                continue;
            }

            const key = normalizeName(local.SupplierName);
            const matches = busyByNormalizedName.get(key) || [];

            if (matches.length === 0) {
                unmatched.push(local);
                continue;
            }

            if (matches.length > 1) {
                ambiguous.push({
                    local,
                    candidates: matches
                });
                continue;
            }

            const target = matches[0];

            if (
                claimedBusyCodes.has(target.SupplierCode) &&
                target.SupplierCode !== local.SupplierCode
            ) {
                collisions.push({ local, target });
                continue;
            }

            proposedUpdates.push({
                SupplierId: local.SupplierId,
                oldCode: local.SupplierCode,
                newCode: target.SupplierCode,
                name: local.SupplierName
            });

            claimedBusyCodes.add(target.SupplierCode);

        }

        //-------------------------------------------------------
        // Write report
        //-------------------------------------------------------

        const report = {
            generatedAt: new Date().toISOString(),
            mode: APPLY ? 'apply' : 'dry-run',
            summary: {
                totalLocal: localSuppliers.length,
                totalBusy: busySuppliers.length,
                alreadyLinked: alreadyLinked.length,
                confidentUpdates: proposedUpdates.length,
                ambiguous: ambiguous.length,
                unmatched: unmatched.length,
                collisions: collisions.length
            },
            proposedUpdates,
            ambiguous,
            unmatched,
            collisions
        };

        fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

        logger.info(
            `[ReconcileSupplierCodes] Report written to ${REPORT_PATH}`
        );
        logger.info(
            `[ReconcileSupplierCodes] Summary: ${proposedUpdates.length} confident update(s), ` +
            `${ambiguous.length} ambiguous, ${unmatched.length} unmatched, ${collisions.length} collision(s).`
        );

        if (!APPLY) {
            logger.info(
                '[ReconcileSupplierCodes] Dry run complete. Review the report, then re-run with --apply.'
            );
            return report;
        }

        if (proposedUpdates.length === 0) {
            logger.info('[ReconcileSupplierCodes] Nothing to apply.');
            return report;
        }

        //-------------------------------------------------------
        // Apply confident updates in a transaction
        //-------------------------------------------------------

        const transaction = new sql.Transaction(localPool);

        await transaction.begin();

        try {

            for (const update of proposedUpdates) {

                await new sql.Request(transaction)

                    .input('id', sql.Int, update.SupplierId)
                    .input('newCode', sql.VarChar(20), update.newCode)

                    .query(`

                        UPDATE dbo.Suppliers
                        SET SupplierCode = @newCode,
                            UpdatedAt = GETUTCDATE()
                        WHERE SupplierId = @id

                    `);

                logger.info(
                    `[ReconcileSupplierCodes] SupplierId ${update.SupplierId} ("${update.name}"): ` +
                    `${update.oldCode} -> ${update.newCode}`
                );

            }

            await transaction.commit();

            logger.info(
                `[ReconcileSupplierCodes] Applied ${proposedUpdates.length} update(s) successfully.`
            );

        }
        catch (err) {

            await transaction.rollback().catch(() => {});

            throw err;

        }

        return report;

    }
    catch (err) {

        logger.error('[ReconcileSupplierCodes] Failed:', err);

        throw err;

    }

}

if (require.main === module) {

    reconcileSupplierCodes()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));

}

module.exports = { reconcileSupplierCodes };