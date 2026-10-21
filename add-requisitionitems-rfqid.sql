-- ============================================================
-- Migration: per-item RFQ linkage
--
-- Until now, the RFQ<->Requisition relationship lived entirely on
-- dbo.Requisitions.RFQId — creating an RFQ from a requisition claimed
-- EVERY item on it at once, with no way to send only some items now and
-- hold the rest back for a separate, later RFQ.
--
-- dbo.RequisitionItems.RFQId (this migration) is the new authoritative
-- per-item link: NULL means "not yet sent in any RFQ, still available to
-- pick for a new one"; set means "already part of that RFQ's item list."
-- A requisition can now have some items linked to RFQ #1 and others still
-- unlinked (or later linked to RFQ #2) at the same time.
--
-- dbo.Requisitions.RFQId is NOT removed — every place that already reads
-- it for display (RFQNumber columns, etc.) keeps working — but it is no
-- longer the gate for "can this requisition be RFQ'd again." It's updated
-- to the most recently created RFQ touching the requisition, informational
-- only from here on. The real per-item state lives in RequisitionItems.
--
-- Safe to re-run.
-- ============================================================

SET NOCOUNT ON;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.RequisitionItems') AND name = 'RFQId'
)
BEGIN
  ALTER TABLE dbo.RequisitionItems ADD RFQId INT NULL REFERENCES dbo.RFQs(RFQId);
END
GO

-- Backfill: every item on a requisition that already has Requisitions.RFQId
-- set inherits that same RFQId — preserves exactly the current state (all
-- items of an already-RFQ'd requisition are "in" that RFQ) as of this
-- migration running, so nothing already sent gets silently un-linked.
UPDATE ri
SET ri.RFQId = r.RFQId
FROM dbo.RequisitionItems ri
JOIN dbo.Requisitions r ON r.RequisitionId = ri.RequisitionId
WHERE r.RFQId IS NOT NULL AND ri.RFQId IS NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_RequisitionItems_RFQId' AND object_id = OBJECT_ID('dbo.RequisitionItems'))
  CREATE INDEX IX_RequisitionItems_RFQId ON dbo.RequisitionItems(RFQId);
GO

PRINT 'RequisitionItems.RFQId added and backfilled from Requisitions.RFQId.';
GO
