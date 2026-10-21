-- ============================================================
-- Material Traceability System - Database Schema
-- Migration 001: Initial Schema
-- ============================================================

-- ============================================================
-- DROP ALL FOREIGN KEY CONSTRAINTS FIRST
-- (prevents FK errors when dropping tables)
-- ============================================================
DECLARE @dropFKs NVARCHAR(MAX) = N'';
SELECT @dropFKs += N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(fk.parent_object_id))
    + N'.' + QUOTENAME(OBJECT_NAME(fk.parent_object_id))
    + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';' + CHAR(13)
FROM sys.foreign_keys fk
WHERE OBJECT_SCHEMA_NAME(fk.parent_object_id) = 'dbo';
IF LEN(@dropFKs) > 0 EXEC sp_executesql @dropFKs;
GO

-- ============================================================
-- DROP ALL TABLES (safe now - no FK constraints remain)
-- ============================================================
IF OBJECT_ID('dbo.AuditLogs', 'U') IS NOT NULL DROP TABLE dbo.AuditLogs;
IF OBJECT_ID('dbo.StatusHistory', 'U') IS NOT NULL DROP TABLE dbo.StatusHistory;
IF OBJECT_ID('dbo.GRNItems', 'U') IS NOT NULL DROP TABLE dbo.GRNItems;
IF OBJECT_ID('dbo.GoodsReceiptNotes', 'U') IS NOT NULL DROP TABLE dbo.GoodsReceiptNotes;
IF OBJECT_ID('dbo.WeighbridgeRecords', 'U') IS NOT NULL DROP TABLE dbo.WeighbridgeRecords;
IF OBJECT_ID('dbo.DeliveryEntryItems', 'U') IS NOT NULL DROP TABLE dbo.DeliveryEntryItems;
IF OBJECT_ID('dbo.DeliveryEntries', 'U') IS NOT NULL DROP TABLE dbo.DeliveryEntries;
IF OBJECT_ID('dbo.StockLocations', 'U') IS NOT NULL DROP TABLE dbo.StockLocations;
IF OBJECT_ID('dbo.Materials', 'U') IS NOT NULL DROP TABLE dbo.Materials;
IF OBJECT_ID('dbo.Suppliers', 'U') IS NOT NULL DROP TABLE dbo.Suppliers;
IF OBJECT_ID('dbo.NumberSequences', 'U') IS NOT NULL DROP TABLE dbo.NumberSequences;
-- NOTE: Do NOT drop dbo.Migrations - it's managed by the migration runner
IF OBJECT_ID('dbo.Users', 'U') IS NOT NULL DROP TABLE dbo.Users;
GO

PRINT 'All existing tables dropped.';
GO

-- ============================================================
-- 1. USERS
-- ============================================================
CREATE TABLE dbo.Users (
    UserId          INT PRIMARY KEY IDENTITY(1,1),
    Username        VARCHAR(50)   NOT NULL,
    PasswordHash    VARCHAR(255)  NOT NULL,
    FullName        NVARCHAR(150) NOT NULL,
    Email           VARCHAR(100),
    Role            VARCHAR(30)   NOT NULL
        CHECK (Role IN ('Admin','GateSecurity','Weighbridge','StoreReceiving','FactoryReceiving','Supervisor','Auditor')),
    Department      VARCHAR(100),
    IsActive        BIT           DEFAULT 1,
    LastLoginAt     DATETIME2,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_Users_Username UNIQUE (Username)
);
GO

-- ============================================================
-- 2. SUPPLIERS
-- ============================================================
CREATE TABLE dbo.Suppliers (
    SupplierId      INT PRIMARY KEY IDENTITY(1,1),
    SupplierCode    VARCHAR(20)   NOT NULL,
    SupplierName    NVARCHAR(200) NOT NULL,
    ContactPerson   NVARCHAR(100),
    Phone           VARCHAR(30),
    Email           VARCHAR(100),
    Address         NVARCHAR(500),
    IsActive        BIT           DEFAULT 1,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_Suppliers_Code UNIQUE (SupplierCode)
);
GO

-- ============================================================
-- 3. MATERIALS (Master)
-- ============================================================
CREATE TABLE dbo.Materials (
    MaterialId      INT PRIMARY KEY IDENTITY(1,1),
    MaterialCode    VARCHAR(30)   NOT NULL,
    MaterialName    NVARCHAR(200) NOT NULL,
    Category        VARCHAR(50),           -- RawMaterial, Ingredient, Packaging, etc.
    UOM             VARCHAR(20)   NOT NULL, -- kg, litres, units, etc.
    MinStock        DECIMAL(12,2),
    MaxStock        DECIMAL(12,2),
    IsActive        BIT           DEFAULT 1,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_Materials_Code UNIQUE (MaterialCode)
);
GO

-- ============================================================
-- 4. STOCK LOCATIONS
-- ============================================================
CREATE TABLE dbo.StockLocations (
    LocationId      INT PRIMARY KEY IDENTITY(1,1),
    LocationName    NVARCHAR(100) NOT NULL,
    LocationType    VARCHAR(20)   NOT NULL
        CHECK (LocationType IN ('Factory','CentralStore','Department')),
    Description     NVARCHAR(300),
    IsActive        BIT           DEFAULT 1,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE()
);
GO

-- ============================================================
-- 5. DELIVERY ENTRIES (Gate Entry)
-- ============================================================
CREATE TABLE dbo.DeliveryEntries (
    EntryId         INT PRIMARY KEY IDENTITY(1,1),
    EntryNo         VARCHAR(20)   NOT NULL,  -- e.g. ENT-20260330-0001
    SupplierId      INT           NOT NULL,
    ConsignmentNo   VARCHAR(50)   NOT NULL,
    DeliveryDate    DATE          NOT NULL,
    DeliveryTime    TIME          NOT NULL,
    VehicleRegNo    VARCHAR(20)   NOT NULL,
    DriverName      NVARCHAR(100),
    DriverIdNo      VARCHAR(30),
    FirstWeight     DECIMAL(10,2) NOT NULL CHECK (FirstWeight >= 0),
    SecondWeight    DECIMAL(10,2) NOT NULL CHECK (SecondWeight >= 0),
    NetWeight       DECIMAL(10,2) NOT NULL CHECK (NetWeight >= 0),
    PurchaseOrderNo VARCHAR(30),             -- NULL allowed for non-PO
    NonPOReason     NVARCHAR(300),           -- Required when PurchaseOrderNo is NULL
    Status          VARCHAR(30)   NOT NULL DEFAULT 'GateReceived'
        CHECK (Status IN ('GateReceived','WeighbridgePending','WeighbridgeCompleted',
                           'RoutingPending','GRNCreated','Closed','Cancelled')),
    Notes           NVARCHAR(500),
    CreatedBy       INT           NOT NULL,
    VersionNo       INT           NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_DeliveryEntries_EntryNo UNIQUE (EntryNo),
    CONSTRAINT FK_DeliveryEntries_Supplier FOREIGN KEY (SupplierId) REFERENCES dbo.Suppliers(SupplierId),
    CONSTRAINT FK_DeliveryEntries_CreatedBy FOREIGN KEY (CreatedBy) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_DeliveryEntries_Status ON dbo.DeliveryEntries(Status);
CREATE INDEX IX_DeliveryEntries_DeliveryDate ON dbo.DeliveryEntries(DeliveryDate);
CREATE INDEX IX_DeliveryEntries_SupplierId ON dbo.DeliveryEntries(SupplierId);
CREATE INDEX IX_DeliveryEntries_ConsignmentNo ON dbo.DeliveryEntries(ConsignmentNo);
GO

-- ============================================================
-- 6. DELIVERY ENTRY ITEMS (Line items per entry)
-- ============================================================
CREATE TABLE dbo.DeliveryEntryItems (
    EntryItemId     BIGINT PRIMARY KEY IDENTITY(1,1),
    EntryId         INT           NOT NULL,
    MaterialId      INT           NOT NULL,
    Quantity        DECIMAL(12,2) NOT NULL CHECK (Quantity > 0),
    UOM             VARCHAR(20)   NOT NULL,
    Description     NVARCHAR(300),
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT FK_DeliveryEntryItems_Entry FOREIGN KEY (EntryId) REFERENCES dbo.DeliveryEntries(EntryId),
    CONSTRAINT FK_DeliveryEntryItems_Material FOREIGN KEY (MaterialId) REFERENCES dbo.Materials(MaterialId)
);
GO

CREATE INDEX IX_DeliveryEntryItems_EntryId ON dbo.DeliveryEntryItems(EntryId);
GO

-- ============================================================
-- 7. WEIGHBRIDGE RECORDS
-- ============================================================
CREATE TABLE dbo.WeighbridgeRecords (
    WeighbridgeId   BIGINT PRIMARY KEY IDENTITY(1,1),
    EntryId         INT           NOT NULL,
    FirstWeight     DECIMAL(10,2) NOT NULL CHECK (FirstWeight >= 0),
    SecondWeight    DECIMAL(10,2) NOT NULL CHECK (SecondWeight >= 0),
    NetWeight       DECIMAL(10,2) NOT NULL CHECK (NetWeight >= 0),
    WeighmentDate   DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
    WeightVariance  DECIMAL(10,2),           -- difference vs gate weight
    OperatorId      INT           NOT NULL,
    Remarks         NVARCHAR(500),
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_WeighbridgeRecords_EntryId UNIQUE (EntryId),  -- 1:1
    CONSTRAINT FK_WeighbridgeRecords_Entry FOREIGN KEY (EntryId) REFERENCES dbo.DeliveryEntries(EntryId),
    CONSTRAINT FK_WeighbridgeRecords_Operator FOREIGN KEY (OperatorId) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_WeighbridgeRecords_Date ON dbo.WeighbridgeRecords(WeighmentDate);
GO

-- ============================================================
-- 8. GOODS RECEIPT NOTES (GRN)
-- ============================================================
CREATE TABLE dbo.GoodsReceiptNotes (
    GRNId           INT PRIMARY KEY IDENTITY(1,1),
    GRNNo           VARCHAR(20)   NOT NULL,  -- e.g. GRN-20260330-0001
    EntryId         INT           NOT NULL,
    ReceivingDept   VARCHAR(30)   NOT NULL
        CHECK (ReceivingDept IN ('Factory','CentralStore')),
    LocationId      INT,
    GRNStatus       VARCHAR(30)   NOT NULL DEFAULT 'Created'
        CHECK (GRNStatus IN ('Created','FullyReceived','PartiallyReceived','Reversed')),
    ReceivedBy      INT           NOT NULL,
    ReceivedAt      DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
    ReversalOf      INT,                      -- if this GRN is a replacement, points to reversed GRN
    ReversalReason  NVARCHAR(500),
    ReversedBy      INT,
    ReversedAt      DATETIME2,
    Notes           NVARCHAR(500),
    VersionNo       INT           NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_GRN_GRNNo UNIQUE (GRNNo),
    CONSTRAINT UQ_GRN_EntryId UNIQUE (EntryId),   -- One GRN per entry
    CONSTRAINT FK_GRN_Entry FOREIGN KEY (EntryId) REFERENCES dbo.DeliveryEntries(EntryId),
    CONSTRAINT FK_GRN_Location FOREIGN KEY (LocationId) REFERENCES dbo.StockLocations(LocationId),
    CONSTRAINT FK_GRN_ReceivedBy FOREIGN KEY (ReceivedBy) REFERENCES dbo.Users(UserId),
    CONSTRAINT FK_GRN_ReversalOf FOREIGN KEY (ReversalOf) REFERENCES dbo.GoodsReceiptNotes(GRNId),
    CONSTRAINT FK_GRN_ReversedBy FOREIGN KEY (ReversedBy) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_GRN_Status ON dbo.GoodsReceiptNotes(GRNStatus);
CREATE INDEX IX_GRN_ReceivedAt ON dbo.GoodsReceiptNotes(ReceivedAt);
CREATE INDEX IX_GRN_ReceivingDept ON dbo.GoodsReceiptNotes(ReceivingDept);
GO

-- ============================================================
-- 9. GRN LINE ITEMS
-- ============================================================
CREATE TABLE dbo.GRNItems (
    GRNItemId       BIGINT PRIMARY KEY IDENTITY(1,1),
    GRNId           INT           NOT NULL,
    MaterialId      INT           NOT NULL,
    ExpectedQty     DECIMAL(12,2) NOT NULL,
    ReceivedQty     DECIMAL(12,2) NOT NULL CHECK (ReceivedQty >= 0),
    AcceptedQty     DECIMAL(12,2) NOT NULL CHECK (AcceptedQty >= 0),
    RejectedQty     DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (RejectedQty >= 0),
    RejectionReason NVARCHAR(500),
    UOM             VARCHAR(20)   NOT NULL,
    Remarks         NVARCHAR(500),
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT FK_GRNItems_GRN FOREIGN KEY (GRNId) REFERENCES dbo.GoodsReceiptNotes(GRNId),
    CONSTRAINT FK_GRNItems_Material FOREIGN KEY (MaterialId) REFERENCES dbo.Materials(MaterialId)
);
GO

CREATE INDEX IX_GRNItems_GRNId ON dbo.GRNItems(GRNId);
GO

-- ============================================================
-- 10. STATUS HISTORY (Append-only)
-- ============================================================
CREATE TABLE dbo.StatusHistory (
    HistoryId       BIGINT PRIMARY KEY IDENTITY(1,1),
    EntityType      VARCHAR(30)   NOT NULL,  -- DeliveryEntry, GRN
    EntityId        INT           NOT NULL,
    FromStatus      VARCHAR(30),
    ToStatus        VARCHAR(30)   NOT NULL,
    ChangedBy       INT           NOT NULL,
    ChangedAt       DATETIME2     DEFAULT GETUTCDATE(),
    Remarks         NVARCHAR(500),
    CONSTRAINT FK_StatusHistory_User FOREIGN KEY (ChangedBy) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_StatusHistory_Entity ON dbo.StatusHistory(EntityType, EntityId);
CREATE INDEX IX_StatusHistory_ChangedAt ON dbo.StatusHistory(ChangedAt);
GO

-- ============================================================
-- 11. AUDIT LOG (Append-only, immutable)
-- ============================================================
CREATE TABLE dbo.AuditLogs (
    LogId           BIGINT IDENTITY(1,1) NOT NULL,
    EntityType      VARCHAR(30)   NOT NULL,
    EntityId        VARCHAR(50)   NOT NULL,
    Action          VARCHAR(30)   NOT NULL
        CHECK (Action IN ('Create','Update','StatusChange','Lock','Reverse','Delete','Login','Logout')),
    UserId          INT           NOT NULL,
    OldValues       NVARCHAR(MAX),           -- JSON
    NewValues       NVARCHAR(MAX),           -- JSON
    IPAddress       VARCHAR(45),
    UserAgent       VARCHAR(300),
    Timestamp       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT PK_AuditLogs PRIMARY KEY NONCLUSTERED (LogId),
    CONSTRAINT FK_AuditLogs_User FOREIGN KEY (UserId) REFERENCES dbo.Users(UserId)
);
GO

CREATE CLUSTERED INDEX CIX_AuditLogs_Timestamp ON dbo.AuditLogs(Timestamp DESC);
CREATE NONCLUSTERED INDEX IX_AuditLogs_Entity ON dbo.AuditLogs(EntityType, EntityId);
CREATE NONCLUSTERED INDEX IX_AuditLogs_User ON dbo.AuditLogs(UserId);
GO

-- ============================================================
-- 12. ENTRY NUMBER SEQUENCE TABLE
-- ============================================================
CREATE TABLE dbo.NumberSequences (
    SequenceType    VARCHAR(20)   NOT NULL,  -- ENTRY, GRN
    SequenceDate    DATE          NOT NULL,
    LastNumber      INT           NOT NULL DEFAULT 0,
    CONSTRAINT PK_NumberSequences PRIMARY KEY (SequenceType, SequenceDate)
);
GO

PRINT 'Migration 001 complete.';
