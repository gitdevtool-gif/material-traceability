-- ============================================================
-- Migration: Multiple unit prices per quoted line item
--
-- AlternateUnitPrices: NVARCHAR(500), a comma-separated list of extra
--                       price options a supplier (or procurement, when
--                       manually capturing a quote) wants to record for
--                       the SAME item — e.g. they quoted 150 but also
--                       offered 165 for a premium grade, or gave a
--                       couple of negotiable price points.
--
-- This is purely supplementary/display data. The existing UnitPrice
-- column remains the single price used for LineTotal, TotalAmount,
-- benchmark comparison, scoring and awarding — nothing about that
-- logic changes. AlternateUnitPrices is just shown alongside it (same
-- pattern as the existing Brand column, which is also a comma-
-- separated list of free-form values).
-- ============================================================

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.QuotationLineItems') AND name = 'AlternateUnitPrices'
)
BEGIN
    ALTER TABLE dbo.QuotationLineItems
    ADD AlternateUnitPrices NVARCHAR(500) NULL;

    PRINT 'Added AlternateUnitPrices to dbo.QuotationLineItems';
END
ELSE
BEGIN
    PRINT 'AlternateUnitPrices already exists — skipping';
END
