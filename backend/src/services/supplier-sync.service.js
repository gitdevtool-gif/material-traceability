/**
 * Supplier Sync Service
 *
 * Synchronizes suppliers from Busy ERP into the local database.
 *
 * Behaviour
 * ----------
 * • Inserts new suppliers
 * • Updates existing suppliers
 * • Marks deleted Busy suppliers as inactive (only Busy ones — suppliers
 *   created here with an "NCF-…" code are never deactivated by the sync)
 * • Never overwrites manually-entered Address
 * • A blank contact/phone in Busy keeps the one entered here
 * • Email: the one entered here always wins; Busy's only fills a blank, and
 *   a different Busy email is added to SupplierEmails ("From Busy")
 * • A party Busy renumbered keeps its local row (re-keyed by name)
 * • Only populates WhatsApp from Phone when WhatsApp is currently NULL/empty
 * • Never deactivates suppliers flagged IsLocalOnly = 1 (internal ledger
 *   entries that have no corresponding row in Busy ERP, e.g. TRAINING LEVY,
 *   LOCAL FARMERS, CASH ACCOUNT SUNDRY VENDORS)
 *
 * Safe to run multiple times.
 */

const { getErpPool } = require('../erpDb');
const { getPool, sql } = require('../db');
const logger = require('../logger');

const SYNC_INTERVAL_MS =
    parseInt(process.env.SUPPLIER_SYNC_INTERVAL_MS, 10) ||
    24 * 60 * 60 * 1000; // once per day

async function syncSuppliers() {

    logger.info('[SupplierSync] Starting supplier synchronization...');

    try {

        const [localPool, erpPool] = await Promise.all([
            getPool(),
            getErpPool()
        ]);

        //-------------------------------------------------------
        // Read suppliers from Busy
        //-------------------------------------------------------

        const busyResult = await erpPool.request().query(`

            SELECT

                LTRIM(RTRIM(Code))      AS SupplierCode,
                LTRIM(RTRIM(Name))      AS SupplierName,
                LTRIM(RTRIM(Contact))   AS ContactPerson,
                LTRIM(RTRIM(TelNo))     AS Phone,
                LTRIM(RTRIM(Email))     AS Email

            FROM dbo.vw_CustomersAndSuppliers

            WHERE PartyType='Supplier'

            ORDER BY Name

        `);

        const suppliers = busyResult.recordset;

        logger.info(
            `[SupplierSync] ${suppliers.length} supplier(s) found in Busy ERP.`
        );

        //-------------------------------------------------------
        // Begin Transaction
        //-------------------------------------------------------

        const transaction = new sql.Transaction(localPool);

        await transaction.begin();

        try {

            //-------------------------------------------------------
            // Create Temp Table
            //
            // NOTE: Uses a GLOBAL temp table (##BusySuppliers) rather than
            // a local one (#BusySuppliers). The mssql/tedious driver does
            // not always guarantee that separate sql.Request(transaction)
            // calls land on the exact same server-side session, which can
            // make a local temp table invisible to a later request even
            // within the same transaction ("Invalid object name
            // '#BusySuppliers'"). A global temp table sidesteps that.
            //
            // Dropped defensively first in case a previous crashed run
            // left one behind, and dropped again in the finally block
            // below once this run is done.
            //-------------------------------------------------------

            await new sql.Request(transaction).query(`
                IF OBJECT_ID('tempdb..##BusySuppliers') IS NOT NULL
                    DROP TABLE ##BusySuppliers;
            `);

            await new sql.Request(transaction).query(`

                CREATE TABLE ##BusySuppliers
                (
                    SupplierCode VARCHAR(20) PRIMARY KEY,
                    SupplierName NVARCHAR(400),
                    ContactPerson NVARCHAR(200),
                    Phone VARCHAR(30),
                    Email VARCHAR(100)
                )

            `);

            //-------------------------------------------------------
            // Load Temp Table
            //-------------------------------------------------------

            for (const supplier of suppliers) {

                await new sql.Request(transaction)

                    .input('SupplierCode', sql.VarChar(20), supplier.SupplierCode)
                    .input('SupplierName', sql.NVarChar(400), supplier.SupplierName)
                    .input('ContactPerson', sql.NVarChar(200), supplier.ContactPerson || null)
                    .input('Phone', sql.VarChar(30), supplier.Phone || null)
                    .input('Email', sql.VarChar(100), supplier.Email || null)

                    .query(`

                        INSERT INTO ##BusySuppliers
                        (
                            SupplierCode,
                            SupplierName,
                            ContactPerson,
                            Phone,
                            Email
                        )
                        VALUES
                        (
                            @SupplierCode,
                            @SupplierName,
                            @ContactPerson,
                            @Phone,
                            @Email
                        )

                    `);

            }

            //-------------------------------------------------------
            // Busy renumbered a party (2026-11-03: BMK TECHNOLOGIES
            // 12886 → 14000, 106 suppliers in all). Matching on code alone
            // inserted a second, bare supplier and retired the old one with
            // its emails, categories and RFQ history. Re-key the existing
            // row instead, when the name pairs one-to-one: exactly one local
            // supplier whose Busy code has vanished, and exactly one new
            // Busy code, carry the same name.
            //-------------------------------------------------------

            const rekeyed = (await new sql.Request(transaction).query(`
                ;WITH busyNew AS (
                    SELECT b.SupplierCode,
                           UPPER(REPLACE(REPLACE(LTRIM(RTRIM(b.SupplierName)), '.', ''), ',', '')) AS nn
                    FROM ##BusySuppliers b
                    WHERE NOT EXISTS (SELECT 1 FROM dbo.Suppliers s WHERE s.SupplierCode = b.SupplierCode)
                ), gone AS (
                    SELECT s.SupplierId, s.SupplierCode,
                           UPPER(REPLACE(REPLACE(LTRIM(RTRIM(s.SupplierName)), '.', ''), ',', '')) AS nn
                    FROM dbo.Suppliers s
                    WHERE TRY_CAST(s.SupplierCode AS INT) IS NOT NULL AND s.IsLocalOnly = 0
                      AND s.MergedIntoSupplierId IS NULL
                      AND NOT EXISTS (SELECT 1 FROM ##BusySuppliers x WHERE x.SupplierCode = s.SupplierCode)
                )
                UPDATE s SET s.SupplierCode = n.SupplierCode, s.UpdatedAt = GETUTCDATE()
                OUTPUT INSERTED.SupplierId, DELETED.SupplierCode AS OldCode, INSERTED.SupplierCode AS NewCode, INSERTED.SupplierName
                FROM dbo.Suppliers s
                JOIN gone g ON g.SupplierId = s.SupplierId
                JOIN busyNew n ON n.nn = g.nn
                WHERE (SELECT COUNT(*) FROM gone g2 WHERE g2.nn = g.nn) = 1
                  AND (SELECT COUNT(*) FROM busyNew n2 WHERE n2.nn = n.nn) = 1;
            `)).recordset;

            //-------------------------------------------------------
            // Emails: the one Procurement entered here wins (2026-11-17).
            // Busy's email only fills a blank; a DIFFERENT Busy email is
            // kept as an additional address, so neither side's is lost.
            // (Busy used to win: Boilahit's "Michael omogi" address, set
            // here and used for RFQ-2026-0151, was replaced by Busy's old
            // one on the next sync.)
            //-------------------------------------------------------

            const busyExtra = (await new sql.Request(transaction).query(`
                INSERT INTO dbo.SupplierEmails (SupplierId, Email, Label)
                OUTPUT INSERTED.SupplierId, INSERTED.Email
                SELECT s.SupplierId, LOWER(b.Email), 'From Busy'
                FROM dbo.Suppliers s
                JOIN ##BusySuppliers b ON b.SupplierCode = s.SupplierCode
                WHERE NULLIF(b.Email, '') IS NOT NULL AND b.Email LIKE '%_@_%._%'
                  AND NULLIF(LTRIM(RTRIM(s.Email)), '') IS NOT NULL
                  AND CHARINDEX(LOWER(b.Email), LOWER(s.Email)) = 0
                  AND NOT EXISTS (SELECT 1 FROM dbo.SupplierEmails e
                                  WHERE e.SupplierId = s.SupplierId AND LOWER(e.Email) = LOWER(b.Email));
            `)).recordset;

            //-------------------------------------------------------
            // Synchronize
            //
            // Busy ERP owns: SupplierCode, SupplierName, ContactPerson,
            //                Phone (Email only when blank here)
            // Busy ERP does NOT own: Address, WhatsApp, SupplierCategories
            //
            // WhatsApp is only ever populated from Phone when it is
            // currently NULL or empty — an existing WhatsApp value is
            // never overwritten.
            //-------------------------------------------------------

            await new sql.Request(transaction).query(`

MERGE dbo.Suppliers AS TARGET

USING ##BusySuppliers AS SOURCE

ON TARGET.SupplierCode = SOURCE.SupplierCode

WHEN MATCHED THEN

UPDATE SET

    TARGET.SupplierName = SOURCE.SupplierName,
    -- A blank in Busy never wipes contact details entered here (2026-10-30:
    -- e.g. M.D. VAID LIMITED has no phone/email in Busy; its RFQ email lives here).
    TARGET.ContactPerson = COALESCE(NULLIF(SOURCE.ContactPerson, ''), TARGET.ContactPerson),
    TARGET.Phone = COALESCE(NULLIF(SOURCE.Phone, ''), TARGET.Phone),
    TARGET.WhatsApp = CASE
                          WHEN TARGET.WhatsApp IS NULL OR LTRIM(RTRIM(TARGET.WhatsApp)) = ''
                          THEN SOURCE.Phone
                          ELSE TARGET.WhatsApp
                      END,
    TARGET.Email = COALESCE(NULLIF(LTRIM(RTRIM(TARGET.Email)), ''), NULLIF(SOURCE.Email, '')),
    TARGET.IsActive = 1,
    TARGET.UpdatedAt = GETUTCDATE()

WHEN NOT MATCHED THEN

INSERT
(
    SupplierCode,
    SupplierName,
    ContactPerson,
    Phone,
    WhatsApp,
    Email,
    IsActive,
    CreatedAt,
    UpdatedAt
)

VALUES
(
    SOURCE.SupplierCode,
    SOURCE.SupplierName,
    SOURCE.ContactPerson,
    SOURCE.Phone,
    SOURCE.Phone,
    SOURCE.Email,
    1,
    GETUTCDATE(),
    GETUTCDATE()
)

-- Only Busy suppliers (numeric Busy party code) follow Busy. Suppliers
-- created here ("NCF-…", not in Busy yet) are left as Procurement set them —
-- the sync used to deactivate all of them on every run, dropping suppliers
-- that had just been sent RFQs (2026-10-30).
WHEN NOT MATCHED BY SOURCE AND TARGET.IsLocalOnly = 0 AND TRY_CAST(TARGET.SupplierCode AS INT) IS NOT NULL THEN

UPDATE SET

    TARGET.IsActive = 0,
    TARGET.UpdatedAt = GETUTCDATE();

            `);

            //-------------------------------------------------------
            // Cleanup — global temp tables outlive the transaction,
            // so drop it explicitly now that the MERGE is done.
            //-------------------------------------------------------

            await new sql.Request(transaction).query(`
                DROP TABLE ##BusySuppliers;
            `);

            await transaction.commit();

            if (rekeyed.length) {
                logger.info(`[SupplierSync] ${rekeyed.length} supplier(s) renumbered in Busy, kept with their history: `
                    + rekeyed.map((r) => `${r.SupplierName} ${r.OldCode}→${r.NewCode}`).join(', '));
                const { writeAuditLog } = require('./audit.service');
                const { systemUserId } = require('./entry-grn-link.service'); // AuditLogs.UserId is NOT NULL
                const auditUserId = await systemUserId(localPool);
                for (const r of rekeyed) {
                    writeAuditLog({ entityType: 'Supplier', entityId: r.SupplierId, action: 'BusyCodeChanged', userId: auditUserId,
                        oldValues: { supplierCode: r.OldCode }, newValues: { supplierCode: r.NewCode } });
                }
            }
            if (busyExtra.length) {
                logger.info(`[SupplierSync] ${busyExtra.length} different Busy email(s) kept as additional addresses (the one entered here stays primary).`);
            }

            logger.info(
                `[SupplierSync] Synchronization complete. ${suppliers.length} supplier(s) processed.`
            );

            return {

                success: true,
                synced: suppliers.length

            };

        }
        catch (err) {

            await transaction.rollback().catch(() => {});

            throw err;

        }

    }
    catch (err) {

        logger.error('[SupplierSync] Synchronization failed:', err);

        throw err;

    }

}

let timer = null;

function startSyncJob() {

    if (timer) return;

    logger.info(
        `[SupplierSync] Scheduler started. Interval = ${SYNC_INTERVAL_MS / 1000}s`
    );

    syncSuppliers().catch(err => {

        logger.error(err);

    });

    timer = setInterval(() => {

        syncSuppliers().catch(err => {

            logger.error(err);

        });

    }, SYNC_INTERVAL_MS);

}

function stopSyncJob() {

    if (!timer) return;

    clearInterval(timer);

    timer = null;

    logger.info('[SupplierSync] Scheduler stopped.');

}

module.exports = {

    syncSuppliers,
    startSyncJob,
    stopSyncJob

};