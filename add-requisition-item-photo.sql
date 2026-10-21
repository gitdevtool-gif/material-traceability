-- ============================================================
-- Migration: Add procurement-attached reference photo to RequisitionItems
--
-- ReferencePhotoUrl: NVARCHAR(500), path to a photo Procurement attaches
--                     to a specific requisition item (e.g. sample,
--                     packaging, spec sheet) BEFORE dispatching the RFQ.
--                     Shown to suppliers both in the RFQ email and on
--                     their tokenized web quote link, so they know
--                     exactly what's being requested. This is separate
--                     from QuotationLineItems.PhotoUrl, which is the
--                     photo the SUPPLIER attaches when they quote back.
-- ============================================================

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.RequisitionItems') AND name = 'ReferencePhotoUrl'
)
BEGIN
    ALTER TABLE dbo.RequisitionItems
    ADD ReferencePhotoUrl NVARCHAR(500) NULL;

    PRINT 'Added ReferencePhotoUrl to dbo.RequisitionItems';
END
ELSE
BEGIN
    PRINT 'ReferencePhotoUrl already exists — skipping';
END
