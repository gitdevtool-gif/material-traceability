/**
 * Mark Local-Only Suppliers
 *
 * ONE-TIME utility. Reads reconciliation-report.json (produced by
 * reconcile-supplier-codes.js) and flags every supplier in its
 * "unmatched" bucket as IsLocalOnly = 1.
 *
 * These are suppliers that have no corresponding row in Busy ERP's
 * vw_CustomersAndSuppliers view — typically internal ledger entries like
 * TRAINING LEVY, LOCAL FARMERS, CASH ACCOUNT SUNDRY VENDORS — and should
 * never be auto-deactivated by supplier-sync.service.js just because
 * Busy doesn't know about them.
 *
 * Run this AFTER reconcile-supplier-codes.js --apply, and AFTER you've
 * manually resolved anything in the "ambiguous" bucket, so that only
 * genuinely local-only suppliers get flagged.
 *
 * Usage:
 *   node mark-local-only-suppliers.js
 *
 * Adjust require paths if this script lives outside src/scripts.
 */

const fs = require('fs');
const path = require('path');

const { getPool, sql } = require('../db');
const logger = require('../logger');

const REPORT_PATH = path.join(__dirname, 'reconciliation-report.json');

async function markLocalOnlySuppliers() {

    logger.info('[MarkLocalOnly] Starting...');

    if (!fs.existsSync(REPORT_PATH)) {
        logger.error(
            `[MarkLocalOnly] Report not found at ${REPORT_PATH}. Run reconcile-supplier-codes.js first.`
        );
        throw new Error('reconciliation-report.json not found');
    }

    const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
    const unmatched = report.unmatched || [];

    if (unmatched.length === 0) {
        logger.info('[MarkLocalOnly] No unmatched suppliers to flag. Nothing to do.');
        return { flagged: 0 };
    }

    logger.info(
        `[MarkLocalOnly] ${unmatched.length} unmatched supplier(s) found in report. Flagging as IsLocalOnly...`
    );

    const pool = await getPool();

    const transaction = new sql.Transaction(pool);

    await transaction.begin();

    try {

        let flagged = 0;

        for (const supplier of unmatched) {

            await new sql.Request(transaction)

                .input('id', sql.Int, supplier.SupplierId)

                .query(`

                    UPDATE dbo.Suppliers
                    SET IsLocalOnly = 1,
                        UpdatedAt = GETUTCDATE()
                    WHERE SupplierId = @id

                `);

            logger.info(
                `[MarkLocalOnly] SupplierId ${supplier.SupplierId} ("${supplier.SupplierName}") flagged as local-only.`
            );

            flagged++;

        }

        await transaction.commit();

        logger.info(`[MarkLocalOnly] Done. ${flagged} supplier(s) flagged.`);

        return { flagged };

    }
    catch (err) {

        await transaction.rollback().catch(() => {});

        logger.error('[MarkLocalOnly] Failed:', err);

        throw err;

    }

}

if (require.main === module) {

    markLocalOnlySuppliers()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));

}

module.exports = { markLocalOnlySuppliers };