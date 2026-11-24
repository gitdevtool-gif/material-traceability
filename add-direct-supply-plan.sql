-- ============================================================
-- Direct-supply delivery plan (2026-11-24)
--
-- Sawdust for F8 (and any item in AppSettings 'directSupply.items') is bought
-- from standing suppliers at their standing Busy price: Procurement raises a
-- Busy PO of 50-100 t per supplier straight from the requisition, no RFQ.
-- Production then decides, day by day, which of those suppliers delivers.
--
--   DirectSupplyPlan  one row per day + item + supplier the production side
--                     has told to deliver, with the tonnes / trucks expected
--                     and optionally the Busy PO it delivers against.
--                     What actually arrived is read live (gate entries and
--                     Busy GRNs), never stored here.
--
-- Safe to re-run.
-- ============================================================
SET NOCOUNT ON;

IF OBJECT_ID('dbo.DirectSupplyPlan', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.DirectSupplyPlan (
    PlanId          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DirectSupplyPlan PRIMARY KEY,
    PlanDate        DATE           NOT NULL,
    ItemName        NVARCHAR(100)  NOT NULL,   -- Busy item name, e.g. SAW DUST IN TONNES
    SupplierId      INT            NOT NULL CONSTRAINT FK_DirectSupplyPlan_Supplier REFERENCES dbo.Suppliers(SupplierId),
    BusyPurOrdNo    VARCHAR(50)    NULL,       -- the PO it delivers against (optional)
    PlannedQty      DECIMAL(12,3)  NULL,       -- in the item's Busy unit (tonnes for sawdust)
    Trucks          INT            NULL,
    Notes           NVARCHAR(300)  NULL,
    CreatedByUserId INT            NOT NULL,
    CreatedAt       DATETIME2      NOT NULL CONSTRAINT DF_DirectSupplyPlan_CreatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedByUserId INT            NULL,
    UpdatedAt       DATETIME2      NULL,
    CONSTRAINT UQ_DirectSupplyPlan_Day UNIQUE (PlanDate, ItemName, SupplierId)
  );
  CREATE INDEX IX_DirectSupplyPlan_Date ON dbo.DirectSupplyPlan (ItemName, PlanDate);
  PRINT 'Created dbo.DirectSupplyPlan';
END
GO

-- A requisition line ordered straight from a standing supplier (no RFQ).
-- F8 requisitions mix direct items (sawdust, offcuts) with others (firewood):
-- the direct lines are closed here so they never go out on an RFQ, while the
-- rest of the requisition carries on through the RFQ path.
IF COL_LENGTH('dbo.RequisitionItems', 'DirectOrderedAt') IS NULL
  ALTER TABLE dbo.RequisitionItems ADD DirectOrderedAt DATETIME2 NULL, DirectPurOrdNos NVARCHAR(200) NULL;
GO
