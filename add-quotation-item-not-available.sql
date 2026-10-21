-- ============================================================
-- Migration: Supplier can mark a requested item as "Not Available"
--
-- IsNotAvailable: BIT, defaults to 0. Lets a supplier explicitly say
-- "I don't carry / can't supply this item" instead of just leaving the
-- price blank, which the system already treats as "not quoted" but
-- which is ambiguous to Procurement/Director (did the supplier see it
-- and decline, or just not get to it yet?). When set, UnitPrice/Qty for
-- that line are stored as NULL — same as any other unpriced line — this
-- column is purely an explicit signal layered on top.
--
-- Safe to re-run.
-- ============================================================

SET NOCOUNT ON;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.QuotationLineItems') AND name = 'IsNotAvailable'
)
BEGIN
  ALTER TABLE dbo.QuotationLineItems ADD IsNotAvailable BIT NOT NULL DEFAULT 0;
END
GO

PRINT 'IsNotAvailable added to dbo.QuotationLineItems.';
GO
