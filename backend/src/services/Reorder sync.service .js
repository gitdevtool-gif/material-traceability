/**
 * Reorder Sync Service
 *
 * Synchronizes reorder-level status from Busy ERP's dbo.reorder view into
 * the local dbo.ReorderStatus table.
 *
 * dbo.reorder is a rolling 3-month time series (one row per item per
 * month, company-wide — the view carries no Factory column) — this sync
 * selects only the latest row per Name, not the full history.
 *
 * All figures (Live_Stock, MaximumStockLevel, EOQ, etc.) are used exactly
 * as Busy provides them, including negative Live_Stock — confirmed by the
 * business as a legitimate state (production can run ahead of recorded
 * stock receipts), not a data error. No sign reinterpretation is applied
 * anywhere in this service EXCEPT StockValue, below, which has a
 * confirmed/required sign flip on Amount specifically.
 *
 * NeedsReorder = LiveStock <= ReorderLevel
 * RequiredQty  = MaxStockLevel - LiveStock, floored at 0
 *   (straight subtraction is valid here regardless of the sign
 *   convention, since both figures share the same underlying units/scale
 *   in Busy's own accounting — this closes the gap to the configured
 *   max stock level either way.)
 *
 * Overstocked: read directly from Busy's own dbo.reorder.[Overstocked]
 * column — Busy already computes this, so it is passed through as-is,
 * same pattern as the other raw figures. Not recomputed here.
 *
 * StockValue (added 2026-08-12, formula corrected 2026-08-12): current
 * value of live stock for this item, derived from Busy's own item-level
 * Amount/TotalQty. Amount is stored by Busy in credit-sign convention
 * (negative for what is, economically, a positive stock value), so it
 * must be sign-flipped before use — confirmed against the working SSMS
 * query for this figure:
 *
 *   StockValue = ((Amount * -1) / TotalQty) * LiveStock
 *
 * Computed here in JS, same pattern as RequiredQty — Busy doesn't expose
 * this ratio directly, so it's derived once at sync time and stored,
 * rather than recomputed on every page load. NULL (not 0) when TotalQty
 * is missing/zero, since a unit cost of "0" would silently understate
 * stock value rather than flag that it's genuinely unknown.
 *
 * AvgMonthlyConsumption / MonthsOfSupply (added 2026-08-12): Busy's
 * dbo.reorder view already computes AvgQty (average monthly consumption,
 * derived from monthly-grouped transaction history — see reorder view
 * definition, section 8 "CONSUMPTION STATISTICS"). It is pulled through
 * as-is, same pattern as the other raw figures.
 *
 * MonthsOfSupply is derived here in JS (RequiredQty / AvgMonthlyConsumption),
 * same pattern as RequiredQty/StockValue — Busy doesn't expose this ratio
 * directly. NULL (not 0) when AvgMonthlyConsumption is missing/zero: a
 * missing consumption rate must not silently read as "infinite supply"
 * (0 months) or otherwise mislead — it's genuinely unknown, so it's left
 * unknown. This is the figure the "Acknowledge" flow snapshots at
 * click-time (see AcknowledgedRequiredQty/AcknowledgedMonthsCoverage in
 * reorder.routes.js) so that a later resync doesn't retroactively change
 * what a past acknowledgement said.
 *
 * Acknowledgement fields (AcknowledgedByUserId/At/Notes/RequiredQty/
 * MonthsCoverage) are never touched by this sync — same pattern as never
 * overwriting a supplier's manually-entered Address/WhatsApp during
 * supplier sync.
 *
 * This service is read-only against Busy ERP — no order/requisition data
 * is ever written back to Busy from here.
 *
 * Safe to run multiple times.
 */

const { getErpPool } = require('../erpDb');
const { getPool, sql } = require('../db');
const logger = require('../logger');

const SYNC_INTERVAL_MS =
    parseInt(process.env.REORDER_SYNC_INTERVAL_MS, 10) ||
    60 * 60 * 1000; // once per hour by default

async function syncReorderStatus() {

    logger.info('[ReorderSync] Starting reorder-level synchronization...');

    try {

        const [localPool, erpPool] = await Promise.all([
            getPool(),
            getErpPool()
        ]);

        //-------------------------------------------------------
        // Read latest snapshot per Name from Busy.
        //
        // Column names below match dbo.reorder exactly as it exists in
        // Busy today (SrNo, Date, MonthYear, Name, MinQty, AvgQty, MaxQty,
        // TotalQty, Amount, itemgrp, PackWht, LeadTime, Reorder_Level,
        // MinimumStockLevel, EOQ, MaximumStockLevel, Live_Stock,
        // StockStatus, SuggestedOrderQty, Overstocked). There is no
        // Factory column on this view — stock/consumption here are
        // already consolidated company-wide, same as dbo.ReorderStatus.
        //-------------------------------------------------------

        const busyResult = await erpPool.request().query(`

            SELECT
                ItemName, ItemGroup,
                LiveStock, ReorderLevel, MinimumStockLevel,
                MaxStockLevel, EOQ, LeadTimeDays,
                Amount, TotalQty, Overstocked,
                AvgMonthlyConsumption,
                BusyMonthYear, BusyDate

            FROM (

                SELECT
                    LTRIM(RTRIM([Name]))            AS ItemName,
                    LTRIM(RTRIM([itemgrp]))          AS ItemGroup,
                    [Live_Stock]                     AS LiveStock,
                    [Reorder_Level]                  AS ReorderLevel,
                    [MinimumStockLevel]               AS MinimumStockLevel,
                    [MaximumStockLevel]               AS MaxStockLevel,
                    [EOQ]                            AS EOQ,
                    [LeadTime]                       AS LeadTimeDays,
                    [Amount]                         AS Amount,
                    [TotalQty]                       AS TotalQty,
                    [Overstocked]                    AS Overstocked,
                    [AvgQty]                         AS AvgMonthlyConsumption,
                    [MonthYear]                      AS BusyMonthYear,
                    [Date]                           AS BusyDate,
                    ROW_NUMBER() OVER (
                        PARTITION BY LTRIM(RTRIM([Name]))
                        ORDER BY [Date] DESC
                    ) AS rn
                FROM dbo.reorder

            ) x

            WHERE rn = 1

        `);

        const items = busyResult.recordset;

        logger.info(
            `[ReorderSync] ${items.length} item snapshot(s) found in Busy ERP.`
        );

        //-------------------------------------------------------
        // Begin Transaction
        //-------------------------------------------------------

        const transaction = new sql.Transaction(localPool);

        await transaction.begin();

        try {

            //-------------------------------------------------------
            // Global temp table (local # temp tables are not reliably
            // visible across separate sql.Request calls on the same
            // transaction in this environment — see supplier-sync
            // service for the same fix).
            //-------------------------------------------------------

            await new sql.Request(transaction).query(`
                IF OBJECT_ID('tempdb..##ReorderBusy') IS NOT NULL
                    DROP TABLE ##ReorderBusy;
            `);

            await new sql.Request(transaction).query(`

                CREATE TABLE ##ReorderBusy
                (
                    ItemName               NVARCHAR(80),
                    ItemGroup              NVARCHAR(80),
                    LiveStock              FLOAT,
                    ReorderLevel           FLOAT,
                    MinimumStockLevel      FLOAT,
                    MaxStockLevel          FLOAT,
                    EOQ                    FLOAT,
                    LeadTimeDays           DECIMAL(9,2),
                    Overstocked            FLOAT,
                    AvgMonthlyConsumption  FLOAT,
                    BusyMonthYear          NVARCHAR(20),
                    BusyDate               DATETIME,
                    NeedsReorder           BIT,
                    RequiredQty            FLOAT,
                    StockValue             FLOAT,
                    MonthsOfSupply         FLOAT
                )

            `);

            //-------------------------------------------------------
            // Load temp table, computing NeedsReorder / RequiredQty /
            // StockValue / MonthsOfSupply in JS so each formula lives
            // in exactly one place.
            //-------------------------------------------------------

            for (const item of items) {

                const needsReorder =
                    item.LiveStock !== null &&
                    item.ReorderLevel !== null &&
                    item.LiveStock <= item.ReorderLevel;

                let requiredQty = null;
                if (item.MaxStockLevel !== null && item.LiveStock !== null) {
                    const gap = item.MaxStockLevel - item.LiveStock;
                    requiredQty = gap > 0 ? Math.round(gap * 100) / 100 : 0;
                }

                // Amount is stored by Busy in credit-sign convention, so
                // it is negated here before deriving unit cost — confirmed
                // against the working SSMS reference query for this figure.
                let stockValue = null;
                if (
                    item.Amount !== null &&
                    item.TotalQty !== null &&
                    item.TotalQty !== 0 &&
                    item.LiveStock !== null
                ) {
                    const unitCost = (item.Amount * -1) / item.TotalQty;
                    stockValue = Math.round(unitCost * item.LiveStock * 100) / 100;
                }

                // MonthsOfSupply: how long RequiredQty will last at current
                // average monthly consumption. NULL (not 0) when
                // AvgMonthlyConsumption is missing/zero — an unknown or
                // zero consumption rate must not silently read as
                // "infinite supply" (0 months); it's genuinely unknown.
                let monthsOfSupply = null;
                if (
                    requiredQty !== null &&
                    item.AvgMonthlyConsumption !== null &&
                    item.AvgMonthlyConsumption > 0
                ) {
                    monthsOfSupply = Math.round((requiredQty / item.AvgMonthlyConsumption) * 10) / 10;
                }

                await new sql.Request(transaction)

                    .input('ItemName',              sql.NVarChar(80),  item.ItemName)
                    .input('ItemGroup',              sql.NVarChar(80),  item.ItemGroup || null)
                    .input('LiveStock',              sql.Float,         item.LiveStock)
                    .input('ReorderLevel',           sql.Float,         item.ReorderLevel)
                    .input('MinimumStockLevel',      sql.Float,         item.MinimumStockLevel)
                    .input('MaxStockLevel',          sql.Float,         item.MaxStockLevel)
                    .input('EOQ',                    sql.Float,         item.EOQ)
                    .input('LeadTimeDays',           sql.Decimal(9, 2), item.LeadTimeDays)
                    .input('Overstocked',            sql.Float,         item.Overstocked)
                    .input('AvgMonthlyConsumption',  sql.Float,         item.AvgMonthlyConsumption)
                    .input('BusyMonthYear',          sql.NVarChar(20),  item.BusyMonthYear)
                    .input('BusyDate',               sql.DateTime,      item.BusyDate)
                    .input('NeedsReorder',           sql.Bit,           needsReorder ? 1 : 0)
                    .input('RequiredQty',            sql.Float,         requiredQty)
                    .input('StockValue',             sql.Float,         stockValue)
                    .input('MonthsOfSupply',         sql.Float,         monthsOfSupply)

                    .query(`

                        INSERT INTO ##ReorderBusy
                        (
                            ItemName, ItemGroup,
                            LiveStock, ReorderLevel, MinimumStockLevel,
                            MaxStockLevel, EOQ, LeadTimeDays, Overstocked,
                            AvgMonthlyConsumption,
                            BusyMonthYear, BusyDate,
                            NeedsReorder, RequiredQty, StockValue, MonthsOfSupply
                        )
                        VALUES
                        (
                            @ItemName, @ItemGroup,
                            @LiveStock, @ReorderLevel, @MinimumStockLevel,
                            @MaxStockLevel, @EOQ, @LeadTimeDays, @Overstocked,
                            @AvgMonthlyConsumption,
                            @BusyMonthYear, @BusyDate,
                            @NeedsReorder, @RequiredQty, @StockValue, @MonthsOfSupply
                        )

                    `);

            }

            //-------------------------------------------------------
            // Synchronize — keyed on ItemName only (dbo.ReorderStatus no
            // longer carries a Factory column; see reorder.routes.js).
            // Acknowledgement fields (including the AcknowledgedRequiredQty/
            // AcknowledgedMonthsCoverage snapshot) are never touched.
            //-------------------------------------------------------

            await new sql.Request(transaction).query(`

MERGE dbo.ReorderStatus AS TARGET

USING ##ReorderBusy AS SOURCE

ON TARGET.ItemName = SOURCE.ItemName

WHEN MATCHED THEN

UPDATE SET

    TARGET.ItemGroup              = SOURCE.ItemGroup,
    TARGET.LiveStock              = SOURCE.LiveStock,
    TARGET.ReorderLevel           = SOURCE.ReorderLevel,
    TARGET.MinimumStockLevel      = SOURCE.MinimumStockLevel,
    TARGET.MaxStockLevel          = SOURCE.MaxStockLevel,
    TARGET.EOQ                    = SOURCE.EOQ,
    TARGET.LeadTimeDays           = SOURCE.LeadTimeDays,
    TARGET.Overstocked            = SOURCE.Overstocked,
    TARGET.AvgMonthlyConsumption  = SOURCE.AvgMonthlyConsumption,
    TARGET.BusyMonthYear          = SOURCE.BusyMonthYear,
    TARGET.BusyDate               = SOURCE.BusyDate,
    TARGET.NeedsReorder           = SOURCE.NeedsReorder,
    TARGET.RequiredQty            = SOURCE.RequiredQty,
    TARGET.StockValue             = SOURCE.StockValue,
    TARGET.MonthsOfSupply         = SOURCE.MonthsOfSupply,
    TARGET.SyncedAt               = SYSUTCDATETIME()

WHEN NOT MATCHED THEN

INSERT
(
    ItemName, ItemGroup,
    LiveStock, ReorderLevel, MinimumStockLevel,
    MaxStockLevel, EOQ, LeadTimeDays, Overstocked,
    AvgMonthlyConsumption,
    BusyMonthYear, BusyDate,
    NeedsReorder, RequiredQty, StockValue, MonthsOfSupply
)

VALUES
(
    SOURCE.ItemName, SOURCE.ItemGroup,
    SOURCE.LiveStock, SOURCE.ReorderLevel, SOURCE.MinimumStockLevel,
    SOURCE.MaxStockLevel, SOURCE.EOQ, SOURCE.LeadTimeDays, SOURCE.Overstocked,
    SOURCE.AvgMonthlyConsumption,
    SOURCE.BusyMonthYear, SOURCE.BusyDate,
    SOURCE.NeedsReorder, SOURCE.RequiredQty, SOURCE.StockValue, SOURCE.MonthsOfSupply
);

            `);

            await new sql.Request(transaction).query(`
                DROP TABLE ##ReorderBusy;
            `);

            await transaction.commit();

            const needsReorderCount = items.filter(
                i => i.LiveStock !== null && i.ReorderLevel !== null && i.LiveStock <= i.ReorderLevel
            ).length;

            logger.info(
                `[ReorderSync] Synchronization complete. ${items.length} item(s) processed, ` +
                `${needsReorderCount} currently at/below reorder level.`
            );

            return {
                success: true,
                synced: items.length,
                needsReorder: needsReorderCount
            };

        }
        catch (err) {

            await transaction.rollback().catch(() => {});

            throw err;

        }

    }
    catch (err) {

        logger.error('[ReorderSync] Synchronization failed:', err);

        throw err;

    }

}

let timer = null;

function startSyncJob() {

    if (timer) return;

    logger.info(
        `[ReorderSync] Scheduler started. Interval = ${SYNC_INTERVAL_MS / 1000}s`
    );

    syncReorderStatus().catch(err => {

        logger.error(err);

    });

    timer = setInterval(() => {

        syncReorderStatus().catch(err => {

            logger.error(err);

        });

    }, SYNC_INTERVAL_MS);

}

function stopSyncJob() {

    if (!timer) return;

    clearInterval(timer);

    timer = null;

    logger.info('[ReorderSync] Scheduler stopped.');

}

module.exports = {

    syncReorderStatus,
    startSyncJob,
    stopSyncJob

};