/**
 * Supplier Sync Service
 *
 * Synchronizes suppliers from Busy ERP into the local database.
 *
 * Behaviour
 * ----------
 * • Inserts new suppliers
 * • Updates existing suppliers
 * • Marks deleted Busy suppliers as inactive
 * • Never overwrites manually-entered Address
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
            // Synchronize
            //
            // Busy ERP owns: SupplierCode, SupplierName, ContactPerson,
            //                Phone, Email
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
    TARGET.ContactPerson = SOURCE.ContactPerson,
    TARGET.Phone = SOURCE.Phone,
    TARGET.WhatsApp = CASE
                          WHEN TARGET.WhatsApp IS NULL OR LTRIM(RTRIM(TARGET.WhatsApp)) = ''
                          THEN SOURCE.Phone
                          ELSE TARGET.WhatsApp
                      END,
    TARGET.Email = SOURCE.Email,
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

WHEN NOT MATCHED BY SOURCE AND TARGET.IsLocalOnly = 0 THEN

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