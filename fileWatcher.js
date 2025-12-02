const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const { ensureTable, mapColumns, parseNumeric, parseDate, getColumnType } = require('./tableManager');

let config;

// Load config
function loadConfig() {
  try {
    const configData = fs.readFileSync('./config.json', 'utf8');
    config = JSON.parse(configData);
    return config;
  } catch (err) {
    console.error('Error loading config.json:', err.message);
    process.exit(1);
  }
}

// Ensure directories exist
function ensureDirectories() {
  const dirs = [
    config.autoUpload.watchFolder,
    config.autoUpload.processedFolder,
    config.autoUpload.failedFolder,
    './logs'
  ];

  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    }
  });
}

// Log to file
function logToFile(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}\n`;
  
  console.log(logMessage.trim());
  
  const logFile = `./logs/upload-${new Date().toISOString().split('T')[0]}.log`;
  fs.appendFileSync(logFile, logMessage);
}

// Check if file is locked/being written
function isFileLocked(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (err) {
    return true;
  }
}

// Wait for file to be ready
async function waitForFile(filePath, maxWaitMs = 10000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    if (!isFileLocked(filePath)) {
      // Wait a bit more to ensure file is fully written
      await new Promise(resolve => setTimeout(resolve, 1000));
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  throw new Error('File is locked or still being written');
}

// Detect file type by magic bytes (file signature)
function detectFileType(filePath) {
  const buffer = Buffer.alloc(4);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buffer, 0, 4, 0);
  fs.closeSync(fd);

  // XLSX/ZIP signature: 50 4B 03 04 (PK..)
  if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return 'xlsx';
  }
  
  // CSV is plain text, no specific signature
  // Check if it's readable text
  const sample = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).substring(0, 100);
  if (/^[\x20-\x7E\r\n\t]+/.test(sample)) {
    return 'csv';
  }

  return 'unknown';
}

// Parse file based on actual content
async function parseFile(filePath) {
  let data = [];

  // Wait for file to be ready
  await waitForFile(filePath);

  // Detect actual file type
  const fileType = detectFileType(filePath);
  logToFile(`Detected file type: ${fileType}`);

  try {
    if (fileType === 'xlsx') {
      logToFile(`Parsing XLSX file: ${filePath}`);
      
      // Read file as buffer
      const buffer = fs.readFileSync(filePath);
      const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
      
      if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        throw new Error('XLSX file has no sheets');
      }
      
      const sheetName = workbook.SheetNames[0];
      logToFile(`Reading sheet: ${sheetName}`);
      const worksheet = workbook.Sheets[sheetName];
      data = xlsx.utils.sheet_to_json(worksheet, { raw: false, defval: '' });
      
    } else if (fileType === 'csv') {
      logToFile(`Parsing CSV file: ${filePath}`);
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath, { encoding: 'utf8' })
          .pipe(csv())
          .on('data', (row) => data.push(row))
          .on('end', resolve)
          .on('error', reject);
      });
    } else {
      throw new Error(`Unsupported or corrupted file format`);
    }
  } catch (err) {
    throw new Error(`Failed to parse file: ${err.message}`);
  }

  if (data.length === 0) {
    throw new Error('File is empty or has no data rows');
  }

  return data;
}

// Connect to database with retry
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
      logToFile(`Connecting to ${connConfig.name} (attempt ${attempt}/${retries})...`);
      const pool = await sql.connect(sqlConfig);
      logToFile(`Connected to ${connConfig.name} successfully`);
      return pool;
    } catch (err) {
      logToFile(`Connection attempt ${attempt} failed: ${err.message}`, 'ERROR');
      
      if (attempt === retries) {
        throw new Error(`Failed to connect after ${retries} attempts: ${err.message}`);
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, config.autoUpload.retryDelayMs));
    }
  }
}

// Detect table name from filename or data
function detectTableName(fileName, data) {
  // Check if filename contains table name hint
  const lowerFileName = fileName.toLowerCase();
  
  if (lowerFileName.includes('accurate') || lowerFileName.includes('invoice')) {
    return 'SALES_INVOICE_ACCURATE_ONLINE';
  }
  
  if (lowerFileName.includes('snj') || lowerFileName.includes('srp')) {
    return 'SNJ_SRP_DETAIL';
  }
  
  // Check by column headers
  if (data.length > 0) {
    const firstRow = data[0];
    const columns = Object.keys(firstRow);
    
    // Check for Accurate Online columns
    if (columns.includes('No. Faktur') || columns.includes('Tanggal')) {
      return 'SALES_INVOICE_ACCURATE_ONLINE';
    }
    
    // Check for SNJ columns
    if (columns.includes('BILL_NO') || columns.includes('SALES_DATE')) {
      return 'SNJ_SRP_DETAIL';
    }
  }
  
  // Default
  return 'SNJ_SRP_DETAIL';
}

// Upload data to database
async function uploadToDatabase(connConfig, data, fileName) {
  let pool;
  
  try {
    // Connect with retry
    pool = await connectWithRetry(connConfig, config.autoUpload.maxRetries);

    // Table name already detected in processFile
    const tableName = detectTableName(fileName, data);

    // Ensure table exists (create if not)
    const wasCreated = await ensureTable(pool, tableName);
    if (wasCreated) {
      logToFile(`Table ${tableName} was created`, 'SUCCESS');
    }

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

    // Map CSV columns to SQL columns
    const mappedData = data.map(row => mapColumns(row, tableName));

    // Find date range and stores/branches
    let minDate = null;
    let maxDate = null;
    const stores = new Set();
    
    mappedData.forEach(row => {
      // Get date
      const dateValue = row.SALES_DATE || row.Tanggal;
      if (dateValue) {
        const parsedDate = parseDate(dateValue);
        if (parsedDate) {
          if (!minDate || parsedDate < minDate) minDate = parsedDate;
          if (!maxDate || parsedDate > maxDate) maxDate = parsedDate;
        }
      }
      
      // Get store/branch identifier
      if (tableName === 'SNJ_SRP_DETAIL' && row.ORG_CODE_NAME) {
        stores.add(row.ORG_CODE_NAME);
      } else if (tableName === 'SALES_INVOICE_ACCURATE_ONLINE' && row.Gudang) {
        stores.add(row.Gudang);
      }
    });

    const storeList = Array.from(stores);
    logToFile(`Date range: ${minDate || 'N/A'} to ${maxDate || 'N/A'}`);
    logToFile(`Stores/Branches: ${storeList.length > 0 ? storeList.join(', ') : 'N/A'}`);

    // Start transaction
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      // Delete existing data by date range and store/branch
      if (minDate && maxDate) {
        const dateColumn = tableName === 'SALES_INVOICE_ACCURATE_ONLINE' ? 'Tanggal' : 'SALES_DATE';
        const storeColumn = tableName === 'SALES_INVOICE_ACCURATE_ONLINE' ? 'Gudang' : 'ORG_CODE_NAME';
        
        let deleteQuery;
        const deleteRequest = new sql.Request(transaction);
        deleteRequest.input('minDate', sql.Date, minDate);
        deleteRequest.input('maxDate', sql.Date, maxDate);
        
        if (storeList.length > 0) {
          // Delete by date AND store (safer for multi-store)
          const storePlaceholders = storeList.map((_, idx) => `@store${idx}`).join(', ');
          deleteQuery = `
            DELETE FROM [${tableName}]
            WHERE [${dateColumn}] BETWEEN @minDate AND @maxDate
              AND [${storeColumn}] IN (${storePlaceholders})
          `;
          
          storeList.forEach((store, idx) => {
            deleteRequest.input(`store${idx}`, sql.NVarChar, store);
          });
          
          logToFile(`Deleting data for stores: ${storeList.join(', ')}`);
        } else {
          // Fallback: delete by date only
          deleteQuery = `
            DELETE FROM [${tableName}]
            WHERE [${dateColumn}] BETWEEN @minDate AND @maxDate
          `;
          logToFile(`Deleting data by date only (no store filter)`);
        }
        
        const deleteResult = await deleteRequest.query(deleteQuery);
        logToFile(`Deleted ${deleteResult.rowsAffected[0]} existing rows`);
      }

      // Insert new data
      let successCount = 0;
      let errorCount = 0;

      for (let i = 0; i < mappedData.length; i++) {
        const row = mappedData[i];
        
        try {
          const columns = Object.keys(row);
          const values = Object.values(row);

          const columnNames = columns.map(col => `[${col}]`).join(', ');
          const placeholders = columns.map((_, idx) => `@param${idx}`).join(', ');
          
          const query = `INSERT INTO [${tableName}] (${columnNames}) VALUES (${placeholders})`;
          const request = new sql.Request(transaction);
          
          columns.forEach((col, idx) => {
            let value = values[idx];
            const colType = getColumnType(tableName, col);
            const sqlType = columnTypes[col];
            
            if (value === null || value === undefined || value === '') {
              request.input(`param${idx}`, sql.NVarChar, null);
              return;
            }
            
            // Handle by column type from schema
            if (colType === 'numeric') {
              const numValue = parseNumeric(value);
              request.input(`param${idx}`, sql.Numeric, numValue);
            } else if (colType === 'date') {
              const dateValue = parseDate(value);
              request.input(`param${idx}`, sql.Date, dateValue);
            } else if (sqlType && (sqlType.includes('int') || sqlType.includes('numeric') || sqlType.includes('decimal') || sqlType.includes('float'))) {
              // Fallback: check SQL type
              const numValue = parseNumeric(value);
              request.input(`param${idx}`, sql.Numeric, numValue);
            } else {
              // String column
              let stringValue = value.toString();
              
              // Handle scientific notation for string columns
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
          logToFile(`Row ${i + 1} error: ${err.message}`, 'ERROR');
        }
      }

      await transaction.commit();
      logToFile(`Upload to ${connConfig.name} completed: ${successCount} success, ${errorCount} errors`, 'SUCCESS');

      return { 
        success: true, 
        successCount, 
        errorCount, 
        dateRange: `${minDate} to ${maxDate}`,
        stores: storeList
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

// Process single file
async function processFile(filePath) {
  const fileName = path.basename(filePath);
  logToFile(`========================================`);
  logToFile(`Processing file: ${fileName}`);

  try {
    // Parse file
    const data = await parseFile(filePath);
    logToFile(`Parsed ${data.length} rows from file`);

    if (data.length === 0) {
      throw new Error('File is empty or has no data');
    }

    // Detect table name first to determine target database
    const tableName = detectTableName(fileName, data);
    logToFile(`Detected table: ${tableName}`);

    // Get enabled connections
    let enabledConnections = config.connections.filter(conn => conn.enabled);
    
    if (enabledConnections.length === 0) {
      throw new Error('No enabled database connections in config.json');
    }

    // Route based on table name
    if (tableName === 'SALES_INVOICE_ACCURATE_ONLINE') {
      // Accurate Online files only go to Database 2
      const db2 = config.connections.find(conn => conn.name === 'Database 2');
      if (db2 && db2.enabled) {
        enabledConnections = [db2];
        logToFile(`Routing ${tableName} to Database 2 only`);
      } else {
        throw new Error('Database 2 is not enabled for SALES_INVOICE_ACCURATE_ONLINE');
      }
    } else {
      // Other files go to Database 1
      const db1 = config.connections.find(conn => conn.name === 'Database 1');
      if (db1 && db1.enabled) {
        enabledConnections = [db1];
        logToFile(`Routing ${tableName} to Database 1 only`);
      } else {
        throw new Error('Database 1 is not enabled');
      }
    }

    // Upload to target database(s) sequentially
    for (const conn of enabledConnections) {
      logToFile(`Uploading to ${conn.name}...`);
      
      try {
        const result = await uploadToDatabase(conn, data, fileName);
        const storeInfo = result.stores && result.stores.length > 0 ? ` (${result.stores.join(', ')})` : '';
        logToFile(`✓ ${conn.name}: ${result.successCount} rows inserted${storeInfo}`, 'SUCCESS');
      } catch (err) {
        logToFile(`✗ ${conn.name} failed: ${err.message}`, 'ERROR');
        throw new Error(`Upload to ${conn.name} failed after ${config.autoUpload.maxRetries} retries: ${err.message}`);
      }
    }

    // Move to processed folder
    const processedPath = path.join(config.autoUpload.processedFolder, fileName);
    fs.renameSync(filePath, processedPath);
    logToFile(`File moved to processed folder: ${processedPath}`, 'SUCCESS');

  } catch (err) {
    logToFile(`Failed to process file: ${err.message}`, 'ERROR');
    
    // Move to failed folder
    const failedPath = path.join(config.autoUpload.failedFolder, fileName);
    fs.renameSync(filePath, failedPath);
    logToFile(`File moved to failed folder: ${failedPath}`, 'ERROR');
  }
}

// Start file watcher
function startWatcher() {
  loadConfig();
  ensureDirectories();

  if (!config.autoUpload.enabled) {
    console.log('Auto-upload is disabled in config.json');
    return;
  }

  logToFile('File watcher started', 'INFO');
  logToFile(`Watching folder: ${config.autoUpload.watchFolder}`);

  const watcher = chokidar.watch(config.autoUpload.watchFolder, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 3000, // Wait 3 seconds after last change
      pollInterval: 500
    }
  });

  watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.csv' || ext === '.xlsx') {
      logToFile(`New file detected: ${path.basename(filePath)}`);
      processFile(filePath);
    }
  });

  watcher.on('error', (error) => {
    logToFile(`Watcher error: ${error}`, 'ERROR');
  });

  console.log(`\n✓ File watcher is running`);
  console.log(`✓ Drop CSV/XLSX files into: ${config.autoUpload.watchFolder}`);
  console.log(`✓ Logs are saved in: ./logs/\n`);
}

module.exports = { startWatcher };
