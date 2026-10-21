-- ============================================================
-- Migration: link each user to their Busy login (2026-10-18)
--
-- POs raised in Busy from the Awarded Suppliers page are saved through
-- Busy's integration API, which always logs in as "Supervisor". Busy's
-- "Added by" comes from its user log (BusyUserLog), so after the save the
-- system rewrites that entry with the Busy login stored here.
--
-- Users.BusyUserName must match a Busy user name (UserPreferences.Name
-- in the Busy company database). NULL = not linked, the PO shows as
-- added by Supervisor.
--
-- Safe to re-run.
-- ============================================================
SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Users') AND name = 'BusyUserName')
  ALTER TABLE dbo.Users ADD BusyUserName NVARCHAR(50) NULL;
GO

PRINT '>> Users.BusyUserName ready. Set it per user in User Management.';
GO
