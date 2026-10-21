require('dotenv').config();
const sql = require('mssql');
const config = {
  server: process.env.DB_SERVER, port: parseInt(process.env.DB_PORT, 10) || 1433, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
};

(async () => {
  const pool = await sql.connect(config);
  console.log('Connected to database');

  // 1. Drop tables in dependency order
  const drops = [
    "IF OBJECT_ID('dbo.GoodsRejectionItems','U') IS NOT NULL DROP TABLE dbo.GoodsRejectionItems",
    "IF OBJECT_ID('dbo.GoodsRejectionNotes','U') IS NOT NULL DROP TABLE dbo.GoodsRejectionNotes",
    "IF OBJECT_ID('dbo.QATestResults','U') IS NOT NULL DROP TABLE dbo.QATestResults",
    "IF OBJECT_ID('dbo.QAInspections','U') IS NOT NULL DROP TABLE dbo.QAInspections",
  ];
  for (const q of drops) {
    await pool.request().query(q);
    console.log('DROP OK');
  }

  // 2. Drop and re-add DeliveryEntries status constraint
  const ck = await pool.request().query(
    "SELECT dc.name FROM sys.check_constraints dc " +
    "JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id " +
    "WHERE OBJECT_NAME(dc.parent_object_id) = 'DeliveryEntries' AND c.name = 'Status'"
  );
  if (ck.recordset.length > 0) {
    await pool.request().query('ALTER TABLE dbo.DeliveryEntries DROP CONSTRAINT [' + ck.recordset[0].name + ']');
    console.log('Dropped DeliveryEntries status constraint:', ck.recordset[0].name);
  }
  await pool.request().query(
    "ALTER TABLE dbo.DeliveryEntries ADD CONSTRAINT CK_DeliveryEntries_Status CHECK (" +
    "Status IN ('GateReceived','WeighbridgePending','WeighbridgeCompleted'," +
    "'QAPending','QAInProgress','QAAccepted','QARejected','Quarantine'," +
    "'RoutingPending','GRNCreated','Closed','Cancelled','Rejected'))"
  );
  console.log('DeliveryEntries status constraint updated');

  // 3. Add BatchNo columns
  await pool.request().query(
    "IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.GRNItems') AND name = 'BatchNo') " +
    "ALTER TABLE dbo.GRNItems ADD BatchNo VARCHAR(30) NULL"
  );
  await pool.request().query(
    "IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.GoodsReceiptNotes') AND name = 'BatchNo') " +
    "ALTER TABLE dbo.GoodsReceiptNotes ADD BatchNo VARCHAR(30) NULL"
  );
  console.log('BatchNo columns ensured');

  // 4. Drop and re-add Users role constraint
  const ckU = await pool.request().query(
    "SELECT dc.name FROM sys.check_constraints dc " +
    "JOIN sys.columns c ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id " +
    "WHERE OBJECT_NAME(dc.parent_object_id) = 'Users' AND c.name = 'Role'"
  );
  if (ckU.recordset.length > 0) {
    await pool.request().query('ALTER TABLE dbo.Users DROP CONSTRAINT [' + ckU.recordset[0].name + ']');
    console.log('Dropped Users role constraint:', ckU.recordset[0].name);
  }
  await pool.request().query(
    "ALTER TABLE dbo.Users ADD CONSTRAINT CK_Users_Role CHECK (" +
    "Role IN ('Admin','GateSecurity','Weighbridge','StoreReceiving','FactoryReceiving'," +
    "'Supervisor','Auditor','QAInspector','QAManager','ProductionClerk'))"
  );
  console.log('Users role constraint updated');

  // 5. Create QAInspections
  await pool.request().query(`
    CREATE TABLE dbo.QAInspections (
      InspectionId INT PRIMARY KEY IDENTITY(1,1),
      InspectionNo VARCHAR(20) NOT NULL,
      EntryId INT NOT NULL,
      InspectionDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
      InspectorId INT NOT NULL,
      OverallStatus VARCHAR(20) NOT NULL DEFAULT 'Pending'
        CHECK (OverallStatus IN ('Pending','InProgress','Accepted','Rejected','Quarantine','Conditional')),
      COAProvided BIT DEFAULT 0,
      COAReference VARCHAR(100),
      COAFilePath NVARCHAR(500),
      SamplesTaken BIT DEFAULT 0,
      PhysicalCheckDone BIT DEFAULT 0,
      OverallRemarks NVARCHAR(1000),
      AcceptedQty DECIMAL(12,2),
      RejectedQty DECIMAL(12,2),
      ApprovedBy INT,
      ApprovedAt DATETIME2,
      VersionNo INT NOT NULL DEFAULT 1,
      CreatedAt DATETIME2 DEFAULT GETUTCDATE(),
      UpdatedAt DATETIME2 DEFAULT GETUTCDATE(),
      CONSTRAINT UQ_QAInspections_InspectionNo UNIQUE (InspectionNo),
      CONSTRAINT UQ_QAInspections_EntryId UNIQUE (EntryId),
      CONSTRAINT FK_QAInspections_Entry FOREIGN KEY (EntryId) REFERENCES dbo.DeliveryEntries(EntryId),
      CONSTRAINT FK_QAInspections_Inspector FOREIGN KEY (InspectorId) REFERENCES dbo.Users(UserId),
      CONSTRAINT FK_QAInspections_Approver FOREIGN KEY (ApprovedBy) REFERENCES dbo.Users(UserId)
    )
  `);
  await pool.request().query('CREATE INDEX IX_QAInspections_Status ON dbo.QAInspections(OverallStatus)');
  await pool.request().query('CREATE INDEX IX_QAInspections_Date ON dbo.QAInspections(InspectionDate)');
  console.log('QAInspections table created');

  // 6. Create QATestResults
  await pool.request().query(`
    CREATE TABLE dbo.QATestResults (
      TestResultId BIGINT PRIMARY KEY IDENTITY(1,1),
      InspectionId INT NOT NULL,
      MaterialId INT NOT NULL,
      TestName NVARCHAR(100) NOT NULL,
      TestMethod NVARCHAR(200),
      ExpectedValue NVARCHAR(100),
      ActualValue NVARCHAR(100),
      Result VARCHAR(20) NOT NULL DEFAULT 'Pending'
        CHECK (Result IN ('Pending','Pass','Fail','Conditional')),
      Remarks NVARCHAR(500),
      TestedBy INT NOT NULL,
      TestedAt DATETIME2 DEFAULT GETUTCDATE(),
      CONSTRAINT FK_QATestResults_Inspection FOREIGN KEY (InspectionId) REFERENCES dbo.QAInspections(InspectionId),
      CONSTRAINT FK_QATestResults_Material FOREIGN KEY (MaterialId) REFERENCES dbo.Materials(MaterialId),
      CONSTRAINT FK_QATestResults_TestedBy FOREIGN KEY (TestedBy) REFERENCES dbo.Users(UserId)
    )
  `);
  await pool.request().query('CREATE INDEX IX_QATestResults_InspectionId ON dbo.QATestResults(InspectionId)');
  console.log('QATestResults table created');

  // 7. Create GoodsRejectionNotes
  await pool.request().query(`
    CREATE TABLE dbo.GoodsRejectionNotes (
      RejectionId INT PRIMARY KEY IDENTITY(1,1),
      RejectionNo VARCHAR(20) NOT NULL,
      EntryId INT NOT NULL,
      InspectionId INT,
      RejectionDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
      RejectedBy INT NOT NULL,
      RejectionReason NVARCHAR(1000) NOT NULL,
      SupplierNotified BIT DEFAULT 0,
      ReturnDate DATE,
      ReturnVehicleRegNo VARCHAR(20),
      ReturnWeighbridgeRef VARCHAR(50),
      ApprovedBy INT,
      ApprovedAt DATETIME2,
      Notes NVARCHAR(500),
      VersionNo INT NOT NULL DEFAULT 1,
      CreatedAt DATETIME2 DEFAULT GETUTCDATE(),
      UpdatedAt DATETIME2 DEFAULT GETUTCDATE(),
      CONSTRAINT UQ_GoodsRejection_RejectionNo UNIQUE (RejectionNo),
      CONSTRAINT UQ_GoodsRejection_EntryId UNIQUE (EntryId),
      CONSTRAINT FK_GoodsRejection_Entry FOREIGN KEY (EntryId) REFERENCES dbo.DeliveryEntries(EntryId),
      CONSTRAINT FK_GoodsRejection_Inspection FOREIGN KEY (InspectionId) REFERENCES dbo.QAInspections(InspectionId),
      CONSTRAINT FK_GoodsRejection_RejectedBy FOREIGN KEY (RejectedBy) REFERENCES dbo.Users(UserId),
      CONSTRAINT FK_GoodsRejection_ApprovedBy FOREIGN KEY (ApprovedBy) REFERENCES dbo.Users(UserId)
    )
  `);
  await pool.request().query('CREATE INDEX IX_GoodsRejection_Date ON dbo.GoodsRejectionNotes(RejectionDate)');
  console.log('GoodsRejectionNotes table created');

  // 8. Create GoodsRejectionItems
  await pool.request().query(`
    CREATE TABLE dbo.GoodsRejectionItems (
      RejectionItemId BIGINT PRIMARY KEY IDENTITY(1,1),
      RejectionId INT NOT NULL,
      MaterialId INT NOT NULL,
      RejectedQty DECIMAL(12,2) NOT NULL CHECK (RejectedQty > 0),
      UOM VARCHAR(20) NOT NULL,
      RejectionReason NVARCHAR(500),
      Remarks NVARCHAR(500),
      CreatedAt DATETIME2 DEFAULT GETUTCDATE(),
      CONSTRAINT FK_GoodsRejectionItems_Rejection FOREIGN KEY (RejectionId) REFERENCES dbo.GoodsRejectionNotes(RejectionId),
      CONSTRAINT FK_GoodsRejectionItems_Material FOREIGN KEY (MaterialId) REFERENCES dbo.Materials(MaterialId)
    )
  `);
  await pool.request().query('CREATE INDEX IX_GoodsRejectionItems_RejId ON dbo.GoodsRejectionItems(RejectionId)');
  console.log('GoodsRejectionItems table created');

  console.log('\n=== Migration 002 COMPLETE ===');
  await pool.close();
  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
