-- Verified Busy login per user (2026-10-19)
-- Set when a user proves their own Busy username + password (checked by Busy
-- itself through the COM bridge; the password is never stored). Raising a PO
-- in Busy requires it, so Busy never records a pushed PO as "Supervisor".
-- Cleared whenever Admin changes the user's Busy user name.

IF COL_LENGTH('dbo.Users', 'BusyUserVerifiedAt') IS NULL
  ALTER TABLE dbo.Users ADD BusyUserVerifiedAt DATETIME2 NULL;
GO
