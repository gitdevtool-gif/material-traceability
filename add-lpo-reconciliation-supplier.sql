-- ============================================================
-- Adds LPOReconciliation.SupplierId.
--
-- Bug fixed: evaluation.routes.js's GET /api/procurement/evaluation/awarded
-- (split-award query) already joined
--   LEFT JOIN dbo.LPOReconciliation rec
--     ON rec.RFQId = rfq.RFQId AND rec.SupplierId = s.SupplierId
-- but dbo.LPOReconciliation never actually had a SupplierId column, so
-- that query threw "Invalid column name 'SupplierId'" any time a
-- split-awarded RFQ existed — breaking the WHOLE /awarded endpoint (not
-- just split rows), which is why Procurement's Awarded Suppliers page
-- could come back empty/erroring even for ordinary full awards.
--
-- With this column in place, a split-awarded RFQ (several suppliers each
-- winning different items) can have each supplier's LPO reconciled
-- independently — reconciling one supplier's PurOrder no longer hides
-- the other still-pending suppliers on the same RFQ.
--
-- Safe to re-run.
-- ============================================================

SET NOCOUNT ON;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.LPOReconciliation') AND name = 'SupplierId'
)
BEGIN
  ALTER TABLE dbo.LPOReconciliation ADD SupplierId INT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_LPOReconciliation_SupplierId')
BEGIN
  ALTER TABLE dbo.LPOReconciliation
    ADD CONSTRAINT FK_LPOReconciliation_SupplierId FOREIGN KEY (SupplierId) REFERENCES dbo.Suppliers(SupplierId);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_LPOReconciliation_RFQId_SupplierId')
BEGIN
  CREATE INDEX IX_LPOReconciliation_RFQId_SupplierId ON dbo.LPOReconciliation(RFQId, SupplierId);
END
GO

PRINT 'SupplierId added to dbo.LPOReconciliation.';
GO
