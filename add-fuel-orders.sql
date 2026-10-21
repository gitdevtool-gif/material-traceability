-- Transport fuel orders (2026-10-19)
-- Transport raises fuel per vehicle (a Busy "Transport" cost centre); a fuel
-- order skips Central Stores / Ops review and Procurement raises the Busy PO
-- straight from the requisition. Litres are often unknown (0) but the clerk
-- gives the unit price. All columns nullable — existing rows are unaffected.

IF COL_LENGTH('dbo.Requisitions', 'OrderType') IS NULL
  ALTER TABLE dbo.Requisitions ADD OrderType VARCHAR(20) NULL;   -- 'Fuel' or NULL (normal order)
GO
IF COL_LENGTH('dbo.Requisitions', 'Vehicle') IS NULL
  ALTER TABLE dbo.Requisitions ADD Vehicle NVARCHAR(40) NULL;    -- Busy cost centre name, e.g. 'KDL 783Y'
GO
IF COL_LENGTH('dbo.RequisitionItems', 'UnitPrice') IS NULL
  ALTER TABLE dbo.RequisitionItems ADD UnitPrice DECIMAL(14, 4) NULL; -- price given by the requester (fuel: KES per litre, VAT incl.)
GO
