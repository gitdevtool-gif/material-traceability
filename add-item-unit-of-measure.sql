-- ============================================================
-- Migration: Unit of Measure on requested items
--
-- Data clerks raising a requisition can now specify the unit the
-- quantity is in (Kgs, Pcs, Metres, Litres) — previously Qty was a bare
-- number with no unit, ambiguous for anything not counted in pieces.
-- Nullable/free-text so historical rows and any future unit stay valid
-- without another migration; the create-requisition form constrains the
-- picklist client + server side to the four known units.
--
-- Safe to re-run.
-- ============================================================

SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.RequisitionItems') AND name = 'Unit')
  ALTER TABLE dbo.RequisitionItems ADD Unit NVARCHAR(20) NULL;
GO

PRINT 'Migration complete — RequisitionItems.Unit added.';
GO
