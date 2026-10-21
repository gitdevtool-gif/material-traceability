-- ============================================================
-- COMBINED MIGRATION SCRIPT — Run in SSMS
-- Database: Material traceability
-- Server:   File-Server-Ncf\SQLEXPRESS
-- ============================================================
-- Make sure you select the correct database before running!
USE [Material traceability];
GO

-- ============================================================
-- STEP 0: Drop ALL foreign key constraints in dbo schema
-- (prevents FK errors when dropping/recreating tables)
-- ============================================================
DECLARE @dropFKs NVARCHAR(MAX) = N'';
SELECT @dropFKs += N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(fk.parent_object_id))
    + N'.' + QUOTENAME(OBJECT_NAME(fk.parent_object_id))
    + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';' + CHAR(13)
FROM sys.foreign_keys fk
WHERE OBJECT_SCHEMA_NAME(fk.parent_object_id) = 'dbo';
IF LEN(@dropFKs) > 0 EXEC sp_executesql @dropFKs;
GO

PRINT '>> All foreign key constraints dropped.';
GO

-- ============================================================
-- STEP 1: DROP ALL TABLES (safe now - no FK constraints)
-- ============================================================
IF OBJECT_ID('dbo.AuditLogs', 'U') IS NOT NULL DROP TABLE dbo.AuditLogs;
IF OBJECT_ID('dbo.StatusHistory', 'U') IS NOT NULL DROP TABLE dbo.StatusHistory;
IF OBJECT_ID('dbo.GoodsRejectionItems', 'U') IS NOT NULL DROP TABLE dbo.GoodsRejectionItems;
IF OBJECT_ID('dbo.GoodsRejectionNotes', 'U') IS NOT NULL DROP TABLE dbo.GoodsRejectionNotes;
IF OBJECT_ID('dbo.QATestResults', 'U') IS NOT NULL DROP TABLE dbo.QATestResults;
IF OBJECT_ID('dbo.QAInspections', 'U') IS NOT NULL DROP TABLE dbo.QAInspections;
IF OBJECT_ID('dbo.GRNItems', 'U') IS NOT NULL DROP TABLE dbo.GRNItems;
IF OBJECT_ID('dbo.GoodsReceiptNotes', 'U') IS NOT NULL DROP TABLE dbo.GoodsReceiptNotes;
IF OBJECT_ID('dbo.WeighbridgeRecords', 'U') IS NOT NULL DROP TABLE dbo.WeighbridgeRecords;
IF OBJECT_ID('dbo.DeliveryEntryItems', 'U') IS NOT NULL DROP TABLE dbo.DeliveryEntryItems;
IF OBJECT_ID('dbo.DeliveryEntries', 'U') IS NOT NULL DROP TABLE dbo.DeliveryEntries;
IF OBJECT_ID('dbo.StockLocations', 'U') IS NOT NULL DROP TABLE dbo.StockLocations;
IF OBJECT_ID('dbo.Materials', 'U') IS NOT NULL DROP TABLE dbo.Materials;
IF OBJECT_ID('dbo.Suppliers', 'U') IS NOT NULL DROP TABLE dbo.Suppliers;
IF OBJECT_ID('dbo.NumberSequences', 'U') IS NOT NULL DROP TABLE dbo.NumberSequences;
IF OBJECT_ID('dbo.Migrations', 'U') IS NOT NULL DROP TABLE dbo.Migrations;
IF OBJECT_ID('dbo.Users', 'U') IS NOT NULL DROP TABLE dbo.Users;
GO

PRINT '>> All tables dropped.';
GO

-- ============================================================
-- STEP 2: Migration tracking table
-- ============================================================
CREATE TABLE dbo.Migrations (
    MigrationId   INT PRIMARY KEY IDENTITY(1,1),
    FileName      VARCHAR(200) NOT NULL UNIQUE,
    AppliedAt     DATETIME2 DEFAULT GETUTCDATE()
);
GO

-- ============================================================
-- STEP 3: MIGRATION 001 — Core tables
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

CREATE TABLE dbo.Materials (
    MaterialId      INT PRIMARY KEY IDENTITY(1,1),
    MaterialCode    VARCHAR(30)   NOT NULL,
    MaterialName    NVARCHAR(200) NOT NULL,
    Category        VARCHAR(50),
    UOM             VARCHAR(20)   NOT NULL,
    MinStock        DECIMAL(12,2),
    MaxStock        DECIMAL(12,2),
    IsActive        BIT           DEFAULT 1,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_Materials_Code UNIQUE (MaterialCode)
);
GO

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

CREATE TABLE dbo.DeliveryEntries (
    EntryId         INT PRIMARY KEY IDENTITY(1,1),
    EntryNo         VARCHAR(20)   NOT NULL,
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
    PurchaseOrderNo VARCHAR(30),
    NonPOReason     NVARCHAR(300),
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

CREATE TABLE dbo.WeighbridgeRecords (
    WeighbridgeId   BIGINT PRIMARY KEY IDENTITY(1,1),
    EntryId         INT           NOT NULL,
    FirstWeight     DECIMAL(10,2) NOT NULL CHECK (FirstWeight >= 0),
    SecondWeight    DECIMAL(10,2) NOT NULL CHECK (SecondWeight >= 0),
    NetWeight       DECIMAL(10,2) NOT NULL CHECK (NetWeight >= 0),
    WeighmentDate   DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
    WeightVariance  DECIMAL(10,2),
    OperatorId      INT           NOT NULL,
    Remarks         NVARCHAR(500),
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_WeighbridgeRecords_EntryId UNIQUE (EntryId),
    CONSTRAINT FK_WeighbridgeRecords_Entry FOREIGN KEY (EntryId) REFERENCES dbo.DeliveryEntries(EntryId),
    CONSTRAINT FK_WeighbridgeRecords_Operator FOREIGN KEY (OperatorId) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_WeighbridgeRecords_Date ON dbo.WeighbridgeRecords(WeighmentDate);
GO

CREATE TABLE dbo.GoodsReceiptNotes (
    GRNId           INT PRIMARY KEY IDENTITY(1,1),
    GRNNo           VARCHAR(20)   NOT NULL,
    EntryId         INT           NOT NULL,
    ReceivingDept   VARCHAR(30)   NOT NULL
        CHECK (ReceivingDept IN ('Factory','CentralStore')),
    LocationId      INT,
    GRNStatus       VARCHAR(30)   NOT NULL DEFAULT 'Created'
        CHECK (GRNStatus IN ('Created','FullyReceived','PartiallyReceived','Reversed')),
    ReceivedBy      INT           NOT NULL,
    ReceivedAt      DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
    ReversalOf      INT,
    ReversalReason  NVARCHAR(500),
    ReversedBy      INT,
    ReversedAt      DATETIME2,
    Notes           NVARCHAR(500),
    VersionNo       INT           NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_GRN_GRNNo UNIQUE (GRNNo),
    CONSTRAINT UQ_GRN_EntryId UNIQUE (EntryId),
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

CREATE TABLE dbo.StatusHistory (
    HistoryId       BIGINT PRIMARY KEY IDENTITY(1,1),
    EntityType      VARCHAR(30)   NOT NULL,
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

CREATE TABLE dbo.AuditLogs (
    LogId           BIGINT IDENTITY(1,1) NOT NULL,
    EntityType      VARCHAR(30)   NOT NULL,
    EntityId        VARCHAR(50)   NOT NULL,
    Action          VARCHAR(30)   NOT NULL
        CHECK (Action IN ('Create','Update','StatusChange','Lock','Reverse','Delete','Login','Logout')),
    UserId          INT           NOT NULL,
    OldValues       NVARCHAR(MAX),
    NewValues       NVARCHAR(MAX),
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

CREATE TABLE dbo.NumberSequences (
    SequenceType    VARCHAR(20)   NOT NULL,
    SequenceDate    DATE          NOT NULL,
    LastNumber      INT           NOT NULL DEFAULT 0,
    CONSTRAINT PK_NumberSequences PRIMARY KEY (SequenceType, SequenceDate)
);
GO

INSERT INTO dbo.Migrations (FileName) VALUES ('001_initial_schema.sql');
PRINT '>> Migration 001 complete.';
GO

-- ============================================================
-- STEP 4: MIGRATION 002 — QA, Rejection, Batch No
-- ============================================================

-- Expand DeliveryEntries Status constraint
DECLARE @ckName NVARCHAR(200);
SELECT @ckName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND c.name = 'Status';
IF @ckName IS NOT NULL
  EXEC('ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT [' + @ckName + ']');
GO

ALTER TABLE dbo.DeliveryEntries
ADD CONSTRAINT CK_DeliveryEntries_Status CHECK (
  Status IN (
    'GateReceived','WeighbridgePending','WeighbridgeCompleted',
    'QAPending','QAInProgress','QAAccepted','QARejected','Quarantine',
    'RoutingPending','GRNCreated','Closed','Cancelled','Rejected'
  )
);
GO

-- Add BatchNo columns
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.GRNItems') AND name = 'BatchNo')
  ALTER TABLE dbo.GRNItems ADD BatchNo VARCHAR(30) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.GoodsReceiptNotes') AND name = 'BatchNo')
  ALTER TABLE dbo.GoodsReceiptNotes ADD BatchNo VARCHAR(30) NULL;
GO

-- QA Inspections
CREATE TABLE dbo.QAInspections (
    InspectionId    INT PRIMARY KEY IDENTITY(1,1),
    InspectionNo    VARCHAR(20)   NOT NULL,
    EntryId         INT           NOT NULL,
    InspectionDate  DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
    InspectorId     INT           NOT NULL,
    OverallStatus   VARCHAR(20)   NOT NULL DEFAULT 'Pending'
        CHECK (OverallStatus IN ('Pending','InProgress','Accepted','Rejected','Quarantine','Conditional')),
    COAProvided     BIT           DEFAULT 0,
    COAReference    VARCHAR(100),
    COAFilePath     NVARCHAR(500),
    SamplesTaken    BIT           DEFAULT 0,
    PhysicalCheckDone BIT         DEFAULT 0,
    OverallRemarks  NVARCHAR(1000),
    AcceptedQty     DECIMAL(12,2),
    RejectedQty     DECIMAL(12,2),
    ApprovedBy      INT,
    ApprovedAt      DATETIME2,
    VersionNo       INT           NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_QAInspections_InspectionNo UNIQUE (InspectionNo),
    CONSTRAINT UQ_QAInspections_EntryId UNIQUE (EntryId),
    CONSTRAINT FK_QAInspections_Entry FOREIGN KEY (EntryId) REFERENCES dbo.DeliveryEntries(EntryId),
    CONSTRAINT FK_QAInspections_Inspector FOREIGN KEY (InspectorId) REFERENCES dbo.Users(UserId),
    CONSTRAINT FK_QAInspections_Approver FOREIGN KEY (ApprovedBy) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_QAInspections_Status ON dbo.QAInspections(OverallStatus);
CREATE INDEX IX_QAInspections_Date ON dbo.QAInspections(InspectionDate);
GO

-- QA Test Results
CREATE TABLE dbo.QATestResults (
    TestResultId    BIGINT PRIMARY KEY IDENTITY(1,1),
    InspectionId    INT           NOT NULL,
    MaterialId      INT           NOT NULL,
    TestName        NVARCHAR(100) NOT NULL,
    TestMethod      NVARCHAR(200),
    ExpectedValue   NVARCHAR(100),
    ActualValue     NVARCHAR(100),
    Result          VARCHAR(20)   NOT NULL DEFAULT 'Pending'
        CHECK (Result IN ('Pending','Pass','Fail','Conditional')),
    Remarks         NVARCHAR(500),
    TestedBy        INT           NOT NULL,
    TestedAt        DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT FK_QATestResults_Inspection FOREIGN KEY (InspectionId) REFERENCES dbo.QAInspections(InspectionId),
    CONSTRAINT FK_QATestResults_Material FOREIGN KEY (MaterialId) REFERENCES dbo.Materials(MaterialId),
    CONSTRAINT FK_QATestResults_TestedBy FOREIGN KEY (TestedBy) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_QATestResults_InspectionId ON dbo.QATestResults(InspectionId);
GO

-- Goods Rejection Notes
CREATE TABLE dbo.GoodsRejectionNotes (
    RejectionId     INT PRIMARY KEY IDENTITY(1,1),
    RejectionNo     VARCHAR(20)   NOT NULL,
    EntryId         INT           NOT NULL,
    InspectionId    INT,
    RejectionDate   DATETIME2     NOT NULL DEFAULT GETUTCDATE(),
    RejectedBy      INT           NOT NULL,
    RejectionReason NVARCHAR(1000) NOT NULL,
    SupplierNotified BIT          DEFAULT 0,
    ReturnDate      DATE,
    ReturnVehicleRegNo VARCHAR(20),
    ReturnWeighbridgeRef VARCHAR(50),
    ApprovedBy      INT,
    ApprovedAt      DATETIME2,
    Notes           NVARCHAR(500),
    VersionNo       INT           NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    UpdatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_GoodsRejection_RejectionNo UNIQUE (RejectionNo),
    CONSTRAINT UQ_GoodsRejection_EntryId UNIQUE (EntryId),
    CONSTRAINT FK_GoodsRejection_Entry FOREIGN KEY (EntryId) REFERENCES dbo.DeliveryEntries(EntryId),
    CONSTRAINT FK_GoodsRejection_Inspection FOREIGN KEY (InspectionId) REFERENCES dbo.QAInspections(InspectionId),
    CONSTRAINT FK_GoodsRejection_RejectedBy FOREIGN KEY (RejectedBy) REFERENCES dbo.Users(UserId),
    CONSTRAINT FK_GoodsRejection_ApprovedBy FOREIGN KEY (ApprovedBy) REFERENCES dbo.Users(UserId)
);
GO

CREATE INDEX IX_GoodsRejection_Date ON dbo.GoodsRejectionNotes(RejectionDate);
GO

-- Goods Rejection Items
CREATE TABLE dbo.GoodsRejectionItems (
    RejectionItemId BIGINT PRIMARY KEY IDENTITY(1,1),
    RejectionId     INT           NOT NULL,
    MaterialId      INT           NOT NULL,
    RejectedQty     DECIMAL(12,2) NOT NULL CHECK (RejectedQty > 0),
    UOM             VARCHAR(20)   NOT NULL,
    RejectionReason NVARCHAR(500),
    Remarks         NVARCHAR(500),
    CreatedAt       DATETIME2     DEFAULT GETUTCDATE(),
    CONSTRAINT FK_GoodsRejectionItems_Rejection FOREIGN KEY (RejectionId) REFERENCES dbo.GoodsRejectionNotes(RejectionId),
    CONSTRAINT FK_GoodsRejectionItems_Material FOREIGN KEY (MaterialId) REFERENCES dbo.Materials(MaterialId)
);
GO

CREATE INDEX IX_GoodsRejectionItems_RejId ON dbo.GoodsRejectionItems(RejectionId);
GO

-- Expand Users Role constraint for QA roles
DECLARE @ckNameUser NVARCHAR(200);
SELECT @ckNameUser = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'Users' AND c.name = 'Role';
IF @ckNameUser IS NOT NULL
  EXEC('ALTER TABLE dbo.Users DROP CONSTRAINT [' + @ckNameUser + ']');
GO

ALTER TABLE dbo.Users
ADD CONSTRAINT CK_Users_Role CHECK (
  Role IN ('Admin','GateSecurity','Weighbridge','StoreReceiving','FactoryReceiving',
           'Supervisor','Auditor','QAInspector','QAManager','ProductionClerk')
);
GO

INSERT INTO dbo.Migrations (FileName) VALUES ('002_qa_rejection_batch.sql');
PRINT '>> Migration 002 complete.';
GO

-- ============================================================
-- STEP 5: MIGRATION 003 — Make weights nullable on DeliveryEntries
-- ============================================================
DECLARE @constraintName NVARCHAR(200);

SELECT @constraintName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND c.name = 'FirstWeight';
IF @constraintName IS NOT NULL EXEC('ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT ' + @constraintName);

SET @constraintName = NULL;
SELECT @constraintName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND c.name = 'SecondWeight';
IF @constraintName IS NOT NULL EXEC('ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT ' + @constraintName);

SET @constraintName = NULL;
SELECT @constraintName = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND c.name = 'NetWeight';
IF @constraintName IS NOT NULL EXEC('ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT ' + @constraintName);
GO

ALTER TABLE dbo.DeliveryEntries ALTER COLUMN FirstWeight DECIMAL(10,2) NULL;
ALTER TABLE dbo.DeliveryEntries ALTER COLUMN SecondWeight DECIMAL(10,2) NULL;
ALTER TABLE dbo.DeliveryEntries ALTER COLUMN NetWeight DECIMAL(10,2) NULL;
GO

INSERT INTO dbo.Migrations (FileName) VALUES ('003_move_weights_to_weighbridge.sql');
PRINT '>> Migration 003 complete.';
GO

-- ============================================================
-- STEP 6: MIGRATION 004 — Destination routing
-- ============================================================
ALTER TABLE dbo.DeliveryEntries ADD Destination VARCHAR(20) NULL;
GO

DECLARE @statusConstraint NVARCHAR(200);
SELECT @statusConstraint = dc.name
FROM sys.check_constraints dc
JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND c.name = 'Status';
IF @statusConstraint IS NOT NULL
  EXEC('ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT ' + @statusConstraint);
GO

ALTER TABLE dbo.DeliveryEntries
  ADD CONSTRAINT CK_DeliveryEntries_Status CHECK (
    Status IN (
      'GateReceived','WeighbridgePending','WeighbridgeCompleted',
      'QAPending','QAInProgress','QAAccepted','QARejected','Quarantine',
      'CentralStoreReceived',
      'RoutingPending','GRNCreated','Closed','Cancelled','Rejected'
    )
  );
GO

INSERT INTO dbo.Migrations (FileName) VALUES ('004_add_destination_routing.sql');
PRINT '>> Migration 004 complete.';
GO

-- ============================================================
-- STEP 7: MIGRATION 005 — Performance indexes
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Materials_MaterialName' AND object_id = OBJECT_ID('dbo.Materials'))
    CREATE INDEX IX_Materials_MaterialName ON dbo.Materials(MaterialName);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DeliveryEntries_CreatedBy' AND object_id = OBJECT_ID('dbo.DeliveryEntries'))
    CREATE INDEX IX_DeliveryEntries_CreatedBy ON dbo.DeliveryEntries(CreatedBy);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DeliveryEntries_VehicleRegNo' AND object_id = OBJECT_ID('dbo.DeliveryEntries'))
    CREATE INDEX IX_DeliveryEntries_VehicleRegNo ON dbo.DeliveryEntries(VehicleRegNo);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AuditLogs_EntityType_Timestamp' AND object_id = OBJECT_ID('dbo.AuditLogs'))
    CREATE INDEX IX_AuditLogs_EntityType_Timestamp ON dbo.AuditLogs(EntityType, Timestamp DESC)
    INCLUDE (EntityId, Action, UserId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_QAInspections_EntryId' AND object_id = OBJECT_ID('dbo.QAInspections'))
    CREATE INDEX IX_QAInspections_EntryId ON dbo.QAInspections(EntryId);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_GoodsRejectionNotes_EntryId' AND object_id = OBJECT_ID('dbo.GoodsRejectionNotes'))
    CREATE INDEX IX_GoodsRejectionNotes_EntryId ON dbo.GoodsRejectionNotes(EntryId);
GO

INSERT INTO dbo.Migrations (FileName) VALUES ('005_performance_indexes.sql');
PRINT '>> Migration 005 complete.';
GO

-- ============================================================
-- STEP 8: Seed stock locations
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'CENTRAL STORES')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description)
  VALUES ('CENTRAL STORES', 'CentralStore', 'Main central stores');
GO

IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F7-STORE')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description)
  VALUES ('F7-STORE', 'Factory', 'Factory 7 store');
GO

PRINT '>> Stock locations seeded.';
GO

-- ============================================================
-- STEP 9: MIGRATION 006 — Add DriverPhone and TicketNo columns
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.DeliveryEntries') AND name = 'DriverPhone')
    ALTER TABLE dbo.DeliveryEntries ADD DriverPhone VARCHAR(20) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.WeighbridgeRecords') AND name = 'TicketNo')
    ALTER TABLE dbo.WeighbridgeRecords ADD TicketNo VARCHAR(50) NULL;
GO

INSERT INTO dbo.Migrations (FileName) VALUES ('006_add_driver_phone_and_ticket_no.sql');
PRINT '>> Migration 006 complete.';
GO

-- Seed factory locations F1-F9
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F1')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F1', 'Factory', 'Factory 1');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F2')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F2', 'Factory', 'Factory 2');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F3')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F3', 'Factory', 'Factory 3');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F4')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F4', 'Factory', 'Factory 4');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F5')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F5', 'Factory', 'Factory 5');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F6')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F6', 'Factory', 'Factory 6');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F7')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F7', 'Factory', 'Factory 7');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F8')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F8', 'Factory', 'Factory 8');
IF NOT EXISTS (SELECT 1 FROM dbo.StockLocations WHERE LocationName = 'F9')
  INSERT INTO dbo.StockLocations (LocationName, LocationType, Description) VALUES ('F9', 'Factory', 'Factory 9');
GO
PRINT '>> Factory locations F1-F9 seeded.';
GO

-- ============================================================
-- DONE! All migrations applied.
-- ============================================================
PRINT '';
PRINT '============================================================';
PRINT '  ALL MIGRATIONS COMPLETE';
PRINT '  Tables created, indexes applied, locations seeded.';
PRINT '  Now restart the API service and run seed if needed:';
PRINT '    node src/db/seed.js';
PRINT '============================================================';
GO
