-- ============================================================
-- Migration: dbo.QuoteEvaluationItems (per-item Director awards)
--
-- evaluation.routes.js has referenced this table throughout (POST /
-- inserts into it, GET /by-rfq and GET /awarded read from it, DELETE
-- /:rfqId relies on it cascading) since the per-item award feature
-- ("migration 020" in that file's comments) — but the table itself was
-- never actually created in this database. Every approval attempt was
-- silently rolling back with "Invalid object name 'dbo.QuoteEvaluationItems'",
-- and QuoteEvaluations ended up with zero rows as a result — which is
-- also why the Procurement Awarded Suppliers page always came back empty
-- even after a Director clicked Approve.
--
-- One row per (QuoteEvaluationId, RequisitionItemId): which supplier won
-- that item, and the UnitPrice/Qty snapshotted at award time (never
-- re-derived from the live quotation afterwards, so a later quotation
-- edit can't silently change history of what was actually awarded).
--
-- Safe to re-run.
-- ============================================================

SET NOCOUNT ON;

-- QuoteEvaluations.WinningQuotationId was created NOT NULL back when
-- every evaluation was a single full-RFQ winner. The per-item POST /
-- route never sets it any more (RequisitionId, DirectorUserId, Notes
-- only) — that INSERT was ALSO failing, before even reaching the
-- QuoteEvaluationItems insert below, on "Cannot insert the value NULL
-- into column 'WinningQuotationId'". Legacy pre-020 rows (if any exist
-- later) keep using it; new per-item evaluations just leave it NULL.
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.QuoteEvaluations') AND name = 'WinningQuotationId' AND is_nullable = 0
)
BEGIN
  ALTER TABLE dbo.QuoteEvaluations ALTER COLUMN WinningQuotationId INT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'QuoteEvaluationItems')
CREATE TABLE dbo.QuoteEvaluationItems (
  QuoteEvaluationItemId INT            PRIMARY KEY IDENTITY(1,1),
  QuoteEvaluationId      INT            NOT NULL
                           REFERENCES dbo.QuoteEvaluations(QuoteEvaluationId) ON DELETE CASCADE,
  RequisitionItemId      INT            NOT NULL REFERENCES dbo.RequisitionItems(RequisitionItemId),
  QuotationLineItemId    INT            NOT NULL REFERENCES dbo.QuotationLineItems(QuotationLineItemId),
  SupplierId              INT           NOT NULL REFERENCES dbo.Suppliers(SupplierId),
  UnitPrice               DECIMAL(12,4) NOT NULL,
  Qty                     DECIMAL(12,2) NOT NULL,
  CreatedAt               DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
  CONSTRAINT UQ_QuoteEvaluationItems_EvalItem UNIQUE (QuoteEvaluationId, RequisitionItemId)
);
GO

PRINT 'QuoteEvaluationItems table created.';
GO
