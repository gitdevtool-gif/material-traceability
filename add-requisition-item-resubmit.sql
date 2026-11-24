-- ============================================================
-- Resubmitting REJECTED ITEMS of a partly-approved requisition (2026-10-26)
--
-- When the Ops Manager / Workshop HOD (or Central Stores) rejects only some
-- items, the approved ones carry on to Procurement. The clerk can now
-- resubmit the rejected ones: they go into a NEW follow-up requisition
-- (new REQ number) that goes back to whoever rejected them.
--
--   RequisitionItemApprovals.ResubmittedInRequisitionId   Ops/HOD-rejected item → the follow-up
--   CentralStoresItemDecisions.ResubmittedInRequisitionId Central-Stores-rejected item → the follow-up
--   Requisitions.ResubmittedFromRequisitionId             follow-up → the original
--
-- Only adds nullable columns; safe to re-run.
-- ============================================================
SET NOCOUNT ON;

IF COL_LENGTH('dbo.RequisitionItemApprovals', 'ResubmittedInRequisitionId') IS NULL
  ALTER TABLE dbo.RequisitionItemApprovals ADD ResubmittedInRequisitionId INT NULL;
GO
IF COL_LENGTH('dbo.CentralStoresItemDecisions', 'ResubmittedInRequisitionId') IS NULL
  ALTER TABLE dbo.CentralStoresItemDecisions ADD ResubmittedInRequisitionId INT NULL;
GO
IF COL_LENGTH('dbo.Requisitions', 'ResubmittedFromRequisitionId') IS NULL
  ALTER TABLE dbo.Requisitions ADD ResubmittedFromRequisitionId INT NULL;
GO

PRINT 'Requisition item resubmit columns added.';
GO
