-- ============================================================
-- Migration: allow more than one QA inspection per delivery entry
--
-- dbo.QAInspections.EntryId had a UNIQUE constraint from day one — every
-- entry could only ever have exactly one inspection, forever. That was
-- fine until Ops Manager rejections started sending entries back to QA
-- for re-inspection (opsmanager.routes.js PATCH /:entryNo and
-- GET /token/:token): QA's "start inspection" flow (qa.routes.js POST /)
-- tries to INSERT a fresh row for the entry, which violates this
-- constraint the moment an entry has already been through one inspection
-- cycle — "Violation of UNIQUE KEY constraint 'UQ_QAInspections_EntryId'.
-- Cannot insert duplicate key... The duplicate key value is (<EntryId>)."
--
-- Deliberately NOT reusing/overwriting the old (rejected) row instead —
-- that would silently mix the old inspection's QATestResults with the
-- new inspection's results under the same InspectionId, destroying the
-- audit trail of what was actually tested and found each time. A proper
-- non-unique index on EntryId already exists (IX_QAInspections_EntryId),
-- so per-entry lookups stay just as fast after this change; every query
-- that reads "the current inspection" already picks the latest row by
-- InspectionId (see opsmanager.routes.js's LATEST_INSPECTION_JOIN and the
-- equivalent subqueries in qa.routes.js / grn.routes.js / entries.routes.js
-- / reports.routes.js).
--
-- Safe to re-run.
-- ============================================================

SET NOCOUNT ON;

IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UQ_QAInspections_EntryId' AND object_id = OBJECT_ID('dbo.QAInspections')
)
BEGIN
  ALTER TABLE dbo.QAInspections DROP CONSTRAINT UQ_QAInspections_EntryId;
END
GO

PRINT 'UQ_QAInspections_EntryId dropped — an entry can now have more than one QA inspection over its lifetime.';
GO
