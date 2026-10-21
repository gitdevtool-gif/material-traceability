-- ============================================================
-- Migration 016: Multi-Requisition RFQs
--
-- Business context: procurement is centralized — "all items are
-- raised from one source" regardless of which factory/warehouse
-- originally created the requisition in Busy. Previously an RFQ
-- was locked 1:1 to a single Requisition (and therefore to a
-- single factory, since Warehouse is a voucher-header field on
-- Busy's PurIndents). This migration lets one RFQ bundle items
-- from several requisitions/factories and be sent to suppliers
-- as a single combined request — with one combined evaluation
-- and one combined LPOReconciliation record downstream, per
-- business confirmation.
--
-- DESIGN: the relationship direction flips from
--   RFQs.RequisitionId (1 RFQ -> 1 Requisition)
-- to
--   Requisitions.RFQId  (many Requisitions -> 1 RFQ)
-- This is a strict generalization — every existing 1:1 RFQ simply
-- becomes "an RFQ with exactly one linked requisition." No existing
-- data is deleted. RFQs.RequisitionId is kept on historical rows for
-- reference but is no longer written to by new code, and its UNIQUE
-- constraint is dropped since it would otherwise incorrectly block
-- linking a requisition to a combined RFQ.
--
-- Safe to re-run: every step is guarded with an existence check.
-- ============================================================

SET NOCOUNT ON;

-- 1. Add Requisitions.RFQId (nullable FK to RFQs) — this is the new
--    source of truth for "which RFQ is this requisition part of".
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Requisitions') AND name = 'RFQId'
)
BEGIN
  ALTER TABLE dbo.Requisitions ADD RFQId INT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Requisitions_RFQId')
BEGIN
  ALTER TABLE dbo.Requisitions
    ADD CONSTRAINT FK_Requisitions_RFQId FOREIGN KEY (RFQId) REFERENCES dbo.RFQs(RFQId);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Requisitions_RFQId')
BEGIN
  CREATE INDEX IX_Requisitions_RFQId ON dbo.Requisitions(RFQId);
END
GO

-- 2. Backfill Requisitions.RFQId from the existing 1:1 relation, so every
--    historical RFQ's single requisition is correctly linked under the
--    new model before the old column stops being used.
UPDATE r
SET r.RFQId = rfq.RFQId
FROM dbo.Requisitions r
JOIN dbo.RFQs rfq ON rfq.RequisitionId = r.RequisitionId
WHERE r.RFQId IS NULL;
GO

-- 3. Drop the old 1:1 UNIQUE constraint on RFQs.RequisitionId — it would
--    otherwise prevent ever linking more than one requisition to an RFQ.
IF EXISTS (
  SELECT 1 FROM sys.key_constraints
  WHERE parent_object_id = OBJECT_ID('dbo.RFQs') AND name = 'UQ_RFQs_RequisitionId'
)
BEGIN
  ALTER TABLE dbo.RFQs DROP CONSTRAINT UQ_RFQs_RequisitionId;
END
GO

-- 4. Make RFQs.RequisitionId nullable — new RFQ rows no longer supply a
--    value (the relation now lives on Requisitions.RFQId). Existing rows'
--    values are left untouched for historical reference/back-compat.
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.RFQs') AND name = 'RequisitionId' AND is_nullable = 0
)
BEGIN
  ALTER TABLE dbo.RFQs ALTER COLUMN RequisitionId INT NULL;
END
GO

-- 5. Add LPOReconciliation.RFQId — reconciliation now matches at the RFQ
--    level (one combined LPO record per RFQ, per business decision).
--    RequisitionId is kept for legacy single-requisition reconciliations
--    created before this migration, and remains valid for any future
--    manual match against a single requisition outside the RFQ flow.
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.LPOReconciliation') AND name = 'RFQId'
)
BEGIN
  ALTER TABLE dbo.LPOReconciliation ADD RFQId INT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_LPOReconciliation_RFQId')
BEGIN
  ALTER TABLE dbo.LPOReconciliation
    ADD CONSTRAINT FK_LPOReconciliation_RFQId FOREIGN KEY (RFQId) REFERENCES dbo.RFQs(RFQId);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_LPOReconciliation_RFQId')
BEGIN
  CREATE INDEX IX_LPOReconciliation_RFQId ON dbo.LPOReconciliation(RFQId);
END
GO

-- 6. Backfill LPOReconciliation.RFQId for existing rows that went through
--    a formal evaluation (QuoteEvaluations.RFQId is unaffected by this
--    migration — it was always keyed by RFQId, never RequisitionId).
UPDATE rec
SET rec.RFQId = ev.RFQId
FROM dbo.LPOReconciliation rec
JOIN dbo.QuoteEvaluations ev ON ev.QuoteEvaluationId = rec.QuoteEvaluationId
WHERE rec.RFQId IS NULL AND rec.QuoteEvaluationId IS NOT NULL;
GO

PRINT 'Migration 016 complete — multi-requisition RFQs enabled.';
GO