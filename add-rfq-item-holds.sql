-- ============================================================
-- Migration: Per-item "Hold" on Director evaluation
--
-- dbo.RFQItemHolds — one row per (RFQId, RequisitionItemId) the Director
-- has explicitly put on hold instead of awarding, typically because no
-- supplier has quoted it yet. Lets the Director approve every OTHER item
-- on the RFQ now (those awards land in QuoteEvaluationItems immediately
-- and show up on Procurement's Awarded page right away) while this item
-- waits for a winner. A row here is removed the moment that item is
-- later awarded — the RFQ is "fully resolved" once zero hold rows remain
-- for it.
--
-- Safe to re-run.
-- ============================================================

SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'RFQItemHolds')
CREATE TABLE dbo.RFQItemHolds (
  RFQItemHoldId      INT            PRIMARY KEY IDENTITY(1,1),
  RFQId              INT            NOT NULL REFERENCES dbo.RFQs(RFQId) ON DELETE CASCADE,
  RequisitionItemId  INT            NOT NULL REFERENCES dbo.RequisitionItems(RequisitionItemId),
  Reason             NVARCHAR(500)  NULL,
  HeldByUserId       INT            NULL REFERENCES dbo.Users(UserId),
  HeldAt             DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
  CONSTRAINT UQ_RFQItemHolds_RFQItem UNIQUE (RFQId, RequisitionItemId)
);
GO

PRINT 'RFQItemHolds table created.';
GO
