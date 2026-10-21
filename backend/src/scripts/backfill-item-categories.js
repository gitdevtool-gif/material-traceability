/**
 * Backfill Item Categories
 *
 * ONE-TIME (but safely re-runnable) utility. Busy ERP's PurIndents.category
 * is the sole, mandatory, authoritative source for item categorization.
 * This script overwrites Category on ALL existing dbo.RequisitionItems rows
 * to match Busy, for requisitions ingested before ERP category sync existed
 * or before this rule was in place.
 *
 * Matching is done by ItemName (case/whitespace-normalized), not by ordno,
 * since category is a property of the item itself in Busy, not of a
 * specific order — the same item name should carry the same category
 * across every requisition. If Busy shows more than one category for the
 * same item name across different rows (a data inconsistency in Busy
 * itself), that item name is flagged as ambiguous and skipped rather than
 * guessed at.
 *
 * Usage:
 *   node backfill-item-categories.js            # dry run, writes report only
 *   node backfill-item-categories.js --apply    # applies overwrites
 *
 * Adjust require paths if this script lives outside src/scripts.
 */

const fs = require('fs');
const path = require('path');

const { getErpPool } = require('../erpDb');
const { getPool, sql } = require('../db');
const logger = require('../logger');

const APPLY = process.argv.includes('--apply');
const REPORT_PATH = path.join(__dirname, 'backfill-item-categories-report.json');

function normalizeItemName(name) {
    return String(name || '').trim();
}

async function backfillItemCategories() {

    logger.info(
        `[BackfillItemCategories] Starting ${APPLY ? 'APPLY' : 'DRY RUN'}...`
    );

    try {

        const [localPool, erpPool] = await Promise.all([
            getPool(),
            getErpPool()
        ]);

        //-------------------------------------------------------
        // Build authoritative itemName -> category map from Busy
        //-------------------------------------------------------

        const erpResult = await erpPool.request().query(`

            SELECT DISTINCT

                LTRIM(RTRIM([itemName]))  AS ItemName,
                LTRIM(RTRIM([category]))  AS Category

            FROM dbo.PurIndents

            WHERE [category] IS NOT NULL
              AND LTRIM(RTRIM([category])) <> ''

        `);

        const categoryByItemName = new Map();   // itemName -> category (only if unambiguous)
        const ambiguousItemNames = new Map();    // itemName -> Set of conflicting categories

        for (const row of erpResult.recordset) {

            const itemName = normalizeItemName(row.ItemName);
            const category = normalizeItemName(row.Category);

            if (!itemName || !category) continue;

            if (!categoryByItemName.has(itemName)) {
                categoryByItemName.set(itemName, category);
                continue;
            }

            if (categoryByItemName.get(itemName) !== category) {
                if (!ambiguousItemNames.has(itemName)) {
                    ambiguousItemNames.set(
                        itemName,
                        new Set([categoryByItemName.get(itemName)])
                    );
                }
                ambiguousItemNames.get(itemName).add(category);
            }

        }

        // Remove ambiguous item names from the confident map entirely —
        // never guess which of Busy's conflicting categories is "right".
        for (const itemName of ambiguousItemNames.keys()) {
            categoryByItemName.delete(itemName);
        }

        logger.info(
            `[BackfillItemCategories] ${categoryByItemName.size} unambiguous item->category mapping(s), ` +
            `${ambiguousItemNames.size} ambiguous item name(s) found in Busy ERP.`
        );

        //-------------------------------------------------------
        // Load existing local RequisitionItems
        //-------------------------------------------------------

        const localResult = await localPool.request().query(`

            SELECT

                RequisitionItemId,
                ItemName,
                Category

            FROM dbo.RequisitionItems

        `);

        const localItems = localResult.recordset;

        logger.info(
            `[BackfillItemCategories] ${localItems.length} local RequisitionItems row(s) loaded.`
        );

        const proposedUpdates = [];   // { RequisitionItemId, itemName, oldCategory, newCategory }
        const alreadyCorrect = [];
        const noErpMapping = [];      // item name not found in Busy at all
        const skippedAmbiguous = [];  // item name has conflicting categories in Busy

        for (const local of localItems) {

            const itemName = normalizeItemName(local.ItemName);

            if (ambiguousItemNames.has(itemName)) {
                skippedAmbiguous.push({
                    RequisitionItemId: local.RequisitionItemId,
                    itemName,
                    conflictingCategories: Array.from(ambiguousItemNames.get(itemName))
                });
                continue;
            }

            const erpCategory = categoryByItemName.get(itemName);

            if (!erpCategory) {
                noErpMapping.push({
                    RequisitionItemId: local.RequisitionItemId,
                    itemName,
                    currentCategory: local.Category
                });
                continue;
            }

            if (local.Category === erpCategory) {
                alreadyCorrect.push(local.RequisitionItemId);
                continue;
            }

            proposedUpdates.push({
                RequisitionItemId: local.RequisitionItemId,
                itemName,
                oldCategory: local.Category,
                newCategory: erpCategory
            });

        }

        //-------------------------------------------------------
        // Write report
        //-------------------------------------------------------

        const report = {
            generatedAt: new Date().toISOString(),
            mode: APPLY ? 'apply' : 'dry-run',
            summary: {
                totalLocalItems: localItems.length,
                alreadyCorrect: alreadyCorrect.length,
                proposedUpdates: proposedUpdates.length,
                noErpMapping: noErpMapping.length,
                skippedAmbiguous: skippedAmbiguous.length
            },
            proposedUpdates,
            noErpMapping,
            skippedAmbiguous
        };

        fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

        logger.info(
            `[BackfillItemCategories] Report written to ${REPORT_PATH}`
        );
        logger.info(
            `[BackfillItemCategories] Summary: ${proposedUpdates.length} update(s) needed, ` +
            `${alreadyCorrect.length} already correct, ${noErpMapping.length} with no Busy mapping, ` +
            `${skippedAmbiguous.length} skipped as ambiguous.`
        );

        if (!APPLY) {
            logger.info(
                '[BackfillItemCategories] Dry run complete. Review the report, then re-run with --apply.'
            );
            return report;
        }

        if (proposedUpdates.length === 0) {
            logger.info('[BackfillItemCategories] Nothing to apply.');
            return report;
        }

        //-------------------------------------------------------
        // Apply updates in a transaction
        //-------------------------------------------------------

        const transaction = new sql.Transaction(localPool);

        await transaction.begin();

        try {

            for (const update of proposedUpdates) {

                await new sql.Request(transaction)

                    .input('id', sql.Int, update.RequisitionItemId)
                    .input('category', sql.NVarChar(100), update.newCategory)

                    .query(`

                        UPDATE dbo.RequisitionItems
                        SET Category = @category
                        WHERE RequisitionItemId = @id

                    `);

            }

            await transaction.commit();

            logger.info(
                `[BackfillItemCategories] Applied ${proposedUpdates.length} update(s) successfully.`
            );

        }
        catch (err) {

            await transaction.rollback().catch(() => {});

            throw err;

        }

        return report;

    }
    catch (err) {

        logger.error('[BackfillItemCategories] Failed:', err);

        throw err;

    }

}

if (require.main === module) {

    backfillItemCategories()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));

}

module.exports = { backfillItemCategories };