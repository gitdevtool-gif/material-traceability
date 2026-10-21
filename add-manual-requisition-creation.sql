-- ============================================================
-- Migration: In-system purchase indent creation
--
-- Replaces the Busy PurIndents sync as the way new requisitions enter
-- this system. FactoryReceiving clerks now raise requisitions directly
-- here; Central Stores (StoreReceiving role) reviews/adjusts before the
-- existing downstream flow (Ops Manager gate for factory MatCenters,
-- straight to Pending otherwise) takes over completely unchanged.
--
-- 1. Users.AssignedMatCenter — locks a FactoryReceiving clerk to exactly
--    one MatCenter they're allowed to raise requisitions for. Backfilled
--    for the existing f1/f2/f3 clerks from their email pattern (same
--    pattern already used by extractFactoryFromEmail() in
--    qa.routes.js / opsmanager.routes.js).
--
-- 2. Requisitions gains 'PendingCentralStoresApproval' and
--    'RejectedByCentralStores' statuses, plus Central-Stores decision
--    columns mirroring the existing Ops-side ones (OpsApprovedByUserId
--    etc.), and CreatedByUserId (Busy-synced rows never had a "creator"
--    in this system; manually-raised ones do).
--
-- 3. RequisitionItems gains per-item PreferredSupplierId/Name,
--    PreferredBrand, PreferredQuality — what the clerk suggests,
--    informational for Procurement.
--
-- 4. New table CentralStoresItemDecisions — a pure audit/history log of
--    Central Stores' per-item decisions. Deliberately NOT a new column
--    on the existing RequisitionItemApprovals table (that table is
--    joined, unfiltered by any "stage", in 8+ already-live RFQ/
--    evaluation query sites — adding a second kind of decision row
--    there would silently duplicate result rows everywhere). A
--    Central-Stores-rejected item is simply deleted from
--    RequisitionItems (safe: nothing downstream has referenced it yet,
--    unlike an Ops Manager rejection which must stay in place next to
--    approved sibling items already moving through RFQ).
--
-- Safe to re-run.
-- ============================================================

SET NOCOUNT ON;

-- 1. Users.AssignedMatCenter
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Users') AND name = 'AssignedMatCenter')
  ALTER TABLE dbo.Users ADD AssignedMatCenter NVARCHAR(100) NULL;
GO

UPDATE dbo.Users SET AssignedMatCenter = 'F1'
WHERE Role = 'FactoryReceiving' AND LOWER(Email) LIKE 'f1production@%' AND AssignedMatCenter IS NULL;
UPDATE dbo.Users SET AssignedMatCenter = 'F2'
WHERE Role = 'FactoryReceiving' AND LOWER(Email) LIKE 'f2production@%' AND AssignedMatCenter IS NULL;
UPDATE dbo.Users SET AssignedMatCenter = 'F3'
WHERE Role = 'FactoryReceiving' AND LOWER(Email) LIKE 'f3production@%' AND AssignedMatCenter IS NULL;
GO

-- 2. Requisitions — widen Status, add Central Stores + creator columns.
DECLARE @ckName NVARCHAR(200);
SELECT @ckName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'Requisitions' AND c.name = 'Status';

IF @ckName IS NOT NULL
  EXEC('ALTER TABLE dbo.Requisitions DROP CONSTRAINT [' + @ckName + ']');
GO

ALTER TABLE dbo.Requisitions
ADD CONSTRAINT CK_Requisitions_Status CHECK (
  Status IN (
    'PendingCentralStoresApproval','RejectedByCentralStores',
    'PendingOpsApproval','OnHold','RejectedByOps',
    'Pending','RFQSent','QuotesReceived','EvaluationPending',
    'Approved','Reconciled','Cancelled'
  )
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'CreatedByUserId')
  ALTER TABLE dbo.Requisitions ADD CreatedByUserId INT NULL REFERENCES dbo.Users(UserId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'CentralStoresApprovedByUserId')
  ALTER TABLE dbo.Requisitions ADD CentralStoresApprovedByUserId INT NULL REFERENCES dbo.Users(UserId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'CentralStoresApprovedAt')
  ALTER TABLE dbo.Requisitions ADD CentralStoresApprovedAt DATETIME2 NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'CentralStoresRejectionReason')
  ALTER TABLE dbo.Requisitions ADD CentralStoresRejectionReason NVARCHAR(1000) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'CentralStoresNotes')
  ALTER TABLE dbo.Requisitions ADD CentralStoresNotes NVARCHAR(1000) NULL;
GO

-- 2b. Requisitions.Source — pre-existing column (CHECK constrained to
--     'Busy'/'ProductionRequest', default 'Busy'), discovered while
--     verifying this migration: every requisition ever created defaults
--     to Source='Busy' unless explicitly overridden. Widen it so
--     requisition-create.routes.js can record 'Manual' instead — leaving
--     it at the default 'Busy' for an in-system-raised requisition would
--     misreport where it actually came from.
DECLARE @sourceCkName NVARCHAR(200);
SELECT @sourceCkName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'Requisitions' AND c.name = 'Source';

IF @sourceCkName IS NOT NULL
  EXEC('ALTER TABLE dbo.Requisitions DROP CONSTRAINT [' + @sourceCkName + ']');
GO

ALTER TABLE dbo.Requisitions
ADD CONSTRAINT CK_Requisitions_Source CHECK (Source IN ('Busy', 'ProductionRequest', 'Manual'));
GO

-- 3. RequisitionItems — clerk's supplier/brand/quality suggestions.
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.RequisitionItems') AND name = 'PreferredSupplierId')
  ALTER TABLE dbo.RequisitionItems ADD PreferredSupplierId INT NULL REFERENCES dbo.Suppliers(SupplierId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.RequisitionItems') AND name = 'PreferredSupplierName')
  ALTER TABLE dbo.RequisitionItems ADD PreferredSupplierName NVARCHAR(200) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.RequisitionItems') AND name = 'PreferredBrand')
  ALTER TABLE dbo.RequisitionItems ADD PreferredBrand NVARCHAR(150) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.RequisitionItems') AND name = 'PreferredQuality')
  ALTER TABLE dbo.RequisitionItems ADD PreferredQuality NVARCHAR(500) NULL;
GO

-- 4. Central Stores' own per-item decision log — never joined by any
--    RFQ/evaluation query, see header note above.
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'CentralStoresItemDecisions')
CREATE TABLE dbo.CentralStoresItemDecisions (
  CentralStoresItemDecisionId INT            PRIMARY KEY IDENTITY(1,1),
  RequisitionId               INT            NOT NULL REFERENCES dbo.Requisitions(RequisitionId),
  ItemName                    NVARCHAR(200)  NOT NULL,
  RequestedQty                DECIMAL(12,2)  NOT NULL,
  Decision                    VARCHAR(20)    NOT NULL CHECK (Decision IN ('Approved', 'Rejected')),
  ApprovedQty                 DECIMAL(12,2)  NULL,
  RejectionReason             NVARCHAR(500)  NULL,
  DecidedByUserId             INT            NULL REFERENCES dbo.Users(UserId),
  DecidedAt                   DATETIME2      NOT NULL DEFAULT GETUTCDATE()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CentralStoresItemDecisions_RequisitionId')
  CREATE INDEX IX_CentralStoresItemDecisions_RequisitionId ON dbo.CentralStoresItemDecisions(RequisitionId);
GO

PRINT 'Migration complete — in-system purchase indent creation schema added.';
GO
