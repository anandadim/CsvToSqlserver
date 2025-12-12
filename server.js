const express = require('express');
const multer = require('multer');
const sql = require('mssql');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { startWatcher } = require('./fileWatcher-ini');

// Load config for multi-database support
let appConfig;
function loadConfig() {
  try {
    const configData = fs.readFileSync('./config.json', 'utf8');
    appConfig = JSON.parse(configData);
    return appConfig;
  } catch (err) {
    console.error('Error loading config.json:', err.message);
    // Fallback to single database mode
    appConfig = null;
    return null;
  }
}

// Load config on startup
loadConfig();

const app = express();
const PORT = 3000;

// Start file watcher
startWatcher();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Configure multer for file upload
const upload = multer({ dest: 'uploads/' });

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Test database connection (now supports config-based connections)
app.post('/api/test-connection', async (req, res) => {
  const { server, database, username, password, port } = req.body;

  // If using config-based connections, test all enabled connections
  if (appConfig && appConfig.connections) {
    const results = [];
    
    for (const conn of appConfig.connections) {
      if (!conn.enabled) continue;
      
      const config = {
        server: conn.server,
        database: conn.database,
        user: conn.username,
        password: conn.password,
        port: parseInt(conn.port) || 1433,
        options: {
          encrypt: true,
          trustServerCertificate: true,
          enableArithAbort: true
        }
      };

      try {
        const pool = await sql.connect(config);
        await pool.close();
        results.push({ name: conn.name, success: true, message: 'Connection successful!' });
      } catch (err) {
        results.push({ name: conn.name, success: false, message: err.message });
      }
    }
    
    const allSuccess = results.every(r => r.success);
    res.json({ 
      success: allSuccess, 
      message: allSuccess ? 'All connections successful!' : 'Some connections failed',
      connections: results
    });
  } else {
    // Fallback to manual connection
    const config = {
      server: server,
      database: database,
      user: username,
      password: password,
      port: parseInt(port) || 1433,
      options: {
        encrypt: true,
        trustServerCertificate: true,
        enableArithAbort: true
      }
    };

    try {
      const pool = await sql.connect(config);
      await pool.close();
      res.json({ success: true, message: 'Connection successful!' });
    } catch (err) {
      console.error('Connection error:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
});

// Detect table name from filename or data (same as fileWatcher)
function detectTableName(fileName, data) {
  const lowerFileName = fileName.toLowerCase();
  
  if (lowerFileName.includes('accurate') || lowerFileName.includes('invoice')) {
    return 'SALES_INVOICE_ACCURATE_ONLINE';
  }
  
  if (lowerFileName.includes('snj') || lowerFileName.includes('srp')) {
    return 'SNJ_SRP_DETAIL';
  }
  
  if (data.length > 0) {
    const firstRow = data[0];
    const columns = Object.keys(firstRow);
    
    if (columns.includes('No. Faktur') || columns.includes('Tanggal')) {
      return 'SALES_INVOICE_ACCURATE_ONLINE';
    }
    
    if (columns.includes('BILL_NO') || columns.includes('SALES_DATE')) {
      return 'SNJ_SRP_DETAIL';
    }
  }
  
  return 'SNJ_SRP_DETAIL';
}

// Connect with retry (same as fileWatcher)
async function connectWithRetry(connConfig, retries = 3) {
  const sqlConfig = {
    server: connConfig.server,
    database: connConfig.database,
    user: connConfig.username,
    password: connConfig.password,
    port: parseInt(connConfig.port) || 1433,
    options: {
      encrypt: true,
      trustServerCertificate: true,
      enableArithAbort: true
    }
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Connecting to ${connConfig.name} (attempt ${attempt}/${retries})...`);
      const pool = await sql.connect(sqlConfig);
      console.log(`Connected to ${connConfig.name} successfully`);
      return pool;
    } catch (err) {
      console.error(`Connection attempt ${attempt} failed: ${err.message}`);
      
      if (attempt === retries) {
        throw new Error(`Failed to connect after ${retries} attempts: ${err.message}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Upload data to database (same logic as fileWatcher)
async function uploadToDatabase(connConfig, data, tableName) {
  let pool;
  
  try {
    // Connect with retry
    pool = await connectWithRetry(connConfig, 3);

    // Get table schema
    const schemaQuery = `
      SELECT COLUMN_NAME, DATA_TYPE 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = @tableName
    `;
    const schemaRequest = pool.request();
    schemaRequest.input('tableName', sql.NVarChar, tableName);
    const schemaResult = await schemaRequest.query(schemaQuery);
    const columnTypes = {};
    schemaResult.recordset.forEach(col => {
      columnTypes[col.COLUMN_NAME] = col.DATA_TYPE;
    });

    // Find date range and stores
    let minDate = null;
    let maxDate = null;
    const stores = new Set();
    
    data.forEach(row => {
      if (row.SALES_DATE || row.Tanggal) {
        let dateStr = (row.SALES_DATE || row.Tanggal).toString();
        
        // Fix date format: convert DD-MM-YYYY to YYYY-MM-DD
        if (dateStr.match(/^\d{2}-\d{2}-\d{4}$/)) {
          const parts = dateStr.split('-');
          dateStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        
        if (!minDate || dateStr < minDate) minDate = dateStr;
        if (!maxDate || dateStr > maxDate) maxDate = dateStr;
      }
      
      // Collect unique stores
      if (tableName === 'SNJ_SRP_DETAIL' && row.ORG_CODE_NAME) {
        stores.add(row.ORG_CODE_NAME);
      } else if (tableName === 'SALES_INVOICE_ACCURATE_ONLINE' && row.Gudang) {
        stores.add(row.Gudang);
      }
    });

    const storeList = Array.from(stores);
    console.log(`Date range: ${minDate || 'N/A'} to ${maxDate || 'N/A'}`);
    console.log(`Stores: ${storeList.length > 0 ? storeList.join(', ') : 'N/A'}`);

    // Start transaction
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      // Delete existing data by date AND store
      if (minDate && maxDate) {
        const dateColumn = tableName === 'SALES_INVOICE_ACCURATE_ONLINE' ? 'Tanggal' : 'SALES_DATE';
        const storeColumn = tableName === 'SALES_INVOICE_ACCURATE_ONLINE' ? 'Gudang' : 'ORG_CODE_NAME';
        
        let deleteQuery;
        const deleteRequest = new sql.Request(transaction);
        deleteRequest.input('minDate', sql.Date, minDate);
        deleteRequest.input('maxDate', sql.Date, maxDate);
        
        if (storeList.length > 0) {
          const storePlaceholders = storeList.map((_, idx) => `@store${idx}`).join(', ');
          deleteQuery = `
            DELETE FROM [${tableName}]
            WHERE [${dateColumn}] BETWEEN @minDate AND @maxDate
              AND [${storeColumn}] IN (${storePlaceholders})
          `;
          
          storeList.forEach((store, idx) => {
            deleteRequest.input(`store${idx}`, sql.NVarChar, store);
          });
          
          console.log(`Deleting data for stores: ${storeList.join(', ')}`);
        } else {
          deleteQuery = `
            DELETE FROM [${tableName}]
            WHERE [${dateColumn}] BETWEEN @minDate AND @maxDate
          `;
          console.log(`Deleting data by date only (no store filter)`);
        }
        
        const deleteResult = await deleteRequest.query(deleteQuery);
        console.log(`Deleted ${deleteResult.rowsAffected[0]} existing rows`);
      }

      // Insert new data
      let successCount = 0;
      let errorCount = 0;
      const errors = [];

      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        
        try {
          const allColumns = Object.keys(row);
          const allValues = Object.values(row);

          // Filter only columns that exist in database
          const validColumns = [];
          const validValues = [];
          
          allColumns.forEach((col, idx) => {
            if (columnTypes[col]) {
              validColumns.push(col);
              validValues.push(allValues[idx]);
            } else if (i === 0) {
              console.log(`Skipping unknown column: ${col}`);
            }
          });

          if (validColumns.length === 0) {
            console.log(`Row ${i + 1}: No valid columns found, skipping`);
            continue;
          }

          const columnNames = validColumns.map(col => `[${col}]`).join(', ');
          const placeholders = validColumns.map((_, idx) => `@param${idx}`).join(', ');
          
          const query = `INSERT INTO [${tableName}] (${columnNames}) VALUES (${placeholders})`;
          const request = new sql.Request(transaction);
          
          validColumns.forEach((col, idx) => {
            let value = validValues[idx];
            const sqlType = columnTypes[col];
            
            if (value === null || value === undefined || value === '') {
              request.input(`param${idx}`, sql.NVarChar, null);
              return;
            }
            
            if (sqlType && (sqlType.includes('int') || sqlType.includes('numeric') || sqlType.includes('decimal') || sqlType.includes('float'))) {
              let numValue;
              if (typeof value === 'number' || /[eE][+-]?\d+/.test(value.toString())) {
                numValue = Number(value);
              } else {
                numValue = parseFloat(value.toString().replace(/[^0-9.-]/g, ''));
              }
              request.input(`param${idx}`, sql.Numeric, isNaN(numValue) ? null : numValue);
            } else {
              let stringValue = value.toString();
              if (typeof value === 'number' || /[eE][+-]?\d+/.test(stringValue)) {
                const num = Number(value);
                if (!isNaN(num)) {
                  stringValue = num.toFixed(0);
                }
              }
              request.input(`param${idx}`, sql.NVarChar, stringValue);
            }
          });

          await request.query(query);
          successCount++;
        } catch (err) {
          errorCount++;
          errors.push({ row: i + 1, error: err.message, data: row });
          console.error(`Row ${i + 1} error: ${err.message}`);
        }
      }

      await transaction.commit();
      console.log(`Upload completed: ${successCount} success, ${errorCount} errors`);

      return { 
        success: true, 
        successCount, 
        errorCount, 
        dateRange: `${minDate || 'N/A'} to ${maxDate || 'N/A'}`,
        stores: storeList,
        errors: errors.slice(0, 10)
      };

    } catch (err) {
      await transaction.rollback();
      throw err;
    }

  } finally {
    if (pool) {
      await pool.close();
    }
  }
}

// Upload and process CSV (now with multi-database support)
app.post('/api/upload-csv', upload.single('csvFile'), async (req, res) => {
  const filePath = req.file.path;
  const fileName = req.file.originalname;

  let totalSuccessCount = 0;
  let totalErrorCount = 0;
  const allErrors = [];
  const uploadResults = [];

  try {
    // Parse file first
    const fileExtension = path.extname(fileName).toLowerCase();
    let csvData = [];

    if (fileExtension === '.xlsx') {
      console.log('Parsing XLSX file...');
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      csvData = xlsx.utils.sheet_to_json(worksheet);
    } else {
      console.log('Parsing CSV file...');
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (row) => csvData.push(row))
          .on('end', resolve)
          .on('error', reject);
      });
    }

    console.log(`Parsed ${csvData.length} rows from file`);

    if (csvData.length === 0) {
      throw new Error('File is empty or has no data');
    }

    // Detect table name
    const tableName = detectTableName(fileName, csvData);
    console.log(`Detected table: ${tableName}`);

    // Determine target databases
    let targetConnections = [];
    
    if (appConfig && appConfig.connections) {
      // Config-based multi-database
      let enabledConnections = appConfig.connections.filter(conn => conn.enabled);
      
      // Route based on table name (same as fileWatcher)
      if (tableName === 'SALES_INVOICE_ACCURATE_ONLINE') {
        const db2 = appConfig.connections.find(conn => conn.name === 'Database 2');
        if (db2 && db2.enabled) {
          targetConnections = [db2];
          console.log(`Routing ${tableName} to Database 2 only`);
        } else {
          throw new Error('Database 2 is not enabled for SALES_INVOICE_ACCURATE_ONLINE');
        }
      } else {
        const db1 = appConfig.connections.find(conn => conn.name === 'Database 1');
        if (db1 && db1.enabled) {
          targetConnections = [db1];
          console.log(`Routing ${tableName} to Database 1 only`);
        } else {
          throw new Error('Database 1 is not enabled');
        }
      }
    } else {
      // Fallback to manual connection from form
      const { server, database, username, password, port } = req.body;
      targetConnections = [{
        name: 'Manual Connection',
        server, database, username, password, port: port || 1433
      }];
    }

    // Upload to each target database
    for (const conn of targetConnections) {
      console.log(`Uploading to ${conn.name}...`);
      
      try {
        const result = await uploadToDatabase(conn, csvData, tableName);
        uploadResults.push({
          database: conn.name,
          success: true,
          ...result
        });
        totalSuccessCount += result.successCount;
        totalErrorCount += result.errorCount;
        allErrors.push(...result.errors);
        
        console.log(`✓ ${conn.name}: ${result.successCount} rows inserted`);
      } catch (err) {
        console.error(`✗ ${conn.name} failed: ${err.message}`);
        uploadResults.push({
          database: conn.name,
          success: false,
          error: err.message
        });
        throw new Error(`Upload to ${conn.name} failed: ${err.message}`);
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      message: 'Upload completed',
      totalRows: csvData.length,
      totalSuccessCount,
      totalErrorCount,
      databases: uploadResults,
      errors: allErrors.slice(0, 10)
    });

  } catch (err) {
    console.error('Upload error:', err);
    
    // Clean up uploaded file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.status(500).json({
      success: false,
      message: err.message,
      totalSuccessCount,
      totalErrorCount,
      databases: uploadResults
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
