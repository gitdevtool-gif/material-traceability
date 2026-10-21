-- ============================================================
-- Busy receiving link (2026-10-17) — Phase 0/1 of the gate→GRN
-- integration with Busy ERP.
--
--  * Materials.BusyItemCode       : Busy item (Master1.Code, MasterType 6)
--                                   this material IS. Gate items now come
--                                   from Busy's item master / open PO lines.
--  * DeliveryEntryItems.BusyPO*   : the Busy PO line (Tran3 RefCode) the
--                                   truck is delivering against.
--  * DeliveryEntries.BusyGRN*     : the Busy GRN ("Mat. Rcvd. from Party",
--                                   VchType 4) this delivery was received
--                                   on. One Busy GRN per entry is also
--                                   enforced by GoodsReceiptNotes'
--                                   UQ_GRN_GRNNo / UQ_GRN_EntryId.
--  * Suppliers.MergedIntoSupplierId: gate-created local supplier ("NCF-0867")
--                                   merged into its real Busy supplier.
--
-- Additive only; safe to run more than once.
-- ============================================================

IF COL_LENGTH('dbo.Materials', 'BusyItemCode') IS NULL
    ALTER TABLE dbo.Materials ADD BusyItemCode INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Materials_BusyItemCode' AND object_id = OBJECT_ID('dbo.Materials'))
    CREATE UNIQUE INDEX UX_Materials_BusyItemCode ON dbo.Materials(BusyItemCode) WHERE BusyItemCode IS NOT NULL;
GO

IF COL_LENGTH('dbo.DeliveryEntryItems', 'BusyItemCode') IS NULL
    ALTER TABLE dbo.DeliveryEntryItems ADD
        BusyItemCode   INT            NULL,
        BusyPORefCode  INT            NULL,   -- Tran3.RefCode of the PO line
        BusyPOVchCode  INT            NULL,
        BusyPONo       NVARCHAR(40)   NULL,
        OrderedQty     DECIMAL(18, 3) NULL,   -- PO line qty
        PendingQty     DECIMAL(18, 3) NULL;   -- still pending on the PO when the truck arrived
GO

IF COL_LENGTH('dbo.DeliveryEntries', 'BusyGRNVchCode') IS NULL
    ALTER TABLE dbo.DeliveryEntries ADD
        BusyGRNVchCode    INT          NULL,
        BusyGRNNo         NVARCHAR(40) NULL,
        BusyGRNLinkedAt   DATETIME2    NULL,
        BusyGRNLinkedBy   INT          NULL,
        BusyGRNLinkMethod VARCHAR(20)  NULL;  -- 'Manual' | 'AutoVehicle' | 'Pushed'
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DeliveryEntries_BusyGRNVchCode' AND object_id = OBJECT_ID('dbo.DeliveryEntries'))
    CREATE INDEX IX_DeliveryEntries_BusyGRNVchCode ON dbo.DeliveryEntries(BusyGRNVchCode) WHERE BusyGRNVchCode IS NOT NULL;
GO

IF COL_LENGTH('dbo.Suppliers', 'MergedIntoSupplierId') IS NULL
    ALTER TABLE dbo.Suppliers ADD MergedIntoSupplierId INT NULL;
GO

PRINT 'Migration complete — Busy receiving link columns added.';
