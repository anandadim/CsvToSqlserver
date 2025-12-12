const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const csv = require('csv-parser');
const xlsx = require('xlsx');

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

// Parse file based on extension
async function parseFile(filePath) {
  const fileExtension = path.extname(filePath).toLowerCase();
  let data = [];

  if (fileExtension === '.xlsx') {
    logToFile(`Parsing XLSX file: ${filePath}`);
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    data = xlsx.utils.sheet_to_json(worksheet);
  } else if (fileExtension === '.csv') {
    logToFile(`Parsing CSV file: ${filePath}`);
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => data.push(row))
        .on('end', resolve)
        .on('error', reject);
    });
  } else {
    throw new Error(`Unsupported file format: ${fileExtension}`);
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

// Upload data to database
async function uploadToDatabase(connConfig, data, fileName) {
  let pool;
  
  try {
    // Connect with retry
    pool = await connectWithRetry(connConfig, config.autoUpload.maxRetries);

    // Get table schema
    const schemaQuery = `
      SELECT COLUMN_NAME, DATA_TYPE 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'SNJ_SRP_DETAIL'
    `;
    const schemaResult = await pool.request().query(schemaQuery);
    const columnTypes = {};
    schemaResult.recordset.forEach(col => {
      columnTypes[col.COLUMN_NAME] = col.DATA_TYPE;
    });

    // Find date range and stores
    let minDate = null;
    let maxDate = null;
    const stores = new Set();
    
    data.forEach(row => {
      if (row.SALES_DATE) {
        let dateStr = row.SALES_DATE.toString();
        
        // Fix date format: convert DD-MM-YYYY to YYYY-MM-DD
        if (dateStr.match(/^\d{2}-\d{2}-\d{4}$/)) {
          const parts = dateStr.split('-');
          dateStr = `${parts[2]}-${parts[1]}-${parts[0]}`; // YYYY-MM-DD
          logToFile(`Date converted: ${row.SALES_DATE} → ${dateStr}`, 'DEBUG');
        }
        
        if (!minDate || dateStr < minDate) minDate = dateStr;
        if (!maxDate || dateStr > maxDate) maxDate = dateStr;
      }
      
      // Collect unique stores
      if (row.ORG_CODE_NAME) {
        stores.add(row.ORG_CODE_NAME);
      }
    });

    const storeList = Array.from(stores);
    logToFile(`Date range: ${minDate} to ${maxDate}`);
    logToFile(`Stores: ${storeList.length > 0 ? storeList.join(', ') : 'N/A'}`);

    // Start transaction
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      // Check existing data before delete
      if (minDate && maxDate) {
        // Count existing data first
        let countQuery;
        const countRequest = new sql.Request(transaction);
        countRequest.input('minDate', sql.Date, minDate);
        countRequest.input('maxDate', sql.Date, maxDate);
        
        if (storeList.length > 0) {
          const storePlaceholders = storeList.map((_, idx) => `@store${idx}`).join(', ');
          countQuery = `
            SELECT COUNT(*) as count FROM SNJ_SRP_DETAIL 
            WHERE SALES_DATE BETWEEN @minDate AND @maxDate
              AND ORG_CODE_NAME IN (${storePlaceholders})
          `;
          storeList.forEach((store, idx) => {
            countRequest.input(`store${idx}`, sql.NVarChar, store);
          });
        } else {
          countQuery = `
            SELECT COUNT(*) as count FROM SNJ_SRP_DETAIL 
            WHERE SALES_DATE BETWEEN @minDate AND @maxDate
          `;
        }
        
        logToFile(`COUNT QUERY: ${countQuery}`, 'INFO');
        const countResult = await countRequest.query(countQuery);
        const existingCount = countResult.recordset[0].count;
        logToFile(`Found ${existingCount} existing rows before delete`, 'INFO');
        
        // Show sample of existing data
        if (existingCount > 0) {
          logToFile(`MYSTERY: Database says ${existingCount} rows exist, but you say it's empty!`, 'ERROR');
          try {
            const sampleQuery = `SELECT TOP 3 BILL_NO, ORG_CODE_NAME, SALES_DATE FROM SNJ_SRP_DETAIL WHERE SALES_DATE BETWEEN @minDate AND @maxDate AND ORG_CODE_NAME IN (@store0)`;
            const sampleRequest = new sql.Request(transaction);
            sampleRequest.input('minDate', sql.Date, minDate);
            sampleRequest.input('maxDate', sql.Date, maxDate);
            sampleRequest.input('store0', sql.NVarChar, storeList[0]);
            const sampleResult = await sampleRequest.query(sampleQuery);
            logToFile(`SAMPLE DATA: ${JSON.stringify(sampleResult.recordset)}`, 'ERROR');
          } catch (sampleErr) {
            logToFile(`Error getting sample: ${sampleErr.message}`, 'ERROR');
          }
        } else {
          logToFile(`Good: No existing data found, as expected`, 'INFO');
        }

      // Delete existing data by date AND store
        let deleteQuery;
        const deleteRequest = new sql.Request(transaction);
        deleteRequest.input('minDate', sql.Date, minDate);
        deleteRequest.input('maxDate', sql.Date, maxDate);
        
        if (storeList.length > 0) {
          // Delete by date AND store (safer for multi-store)
          const storePlaceholders = storeList.map((_, idx) => `@store${idx}`).join(', ');
          deleteQuery = `
            DELETE FROM SNJ_SRP_DETAIL 
            WHERE SALES_DATE BETWEEN @minDate AND @maxDate
              AND ORG_CODE_NAME IN (${storePlaceholders})
          `;
          
          storeList.forEach((store, idx) => {
            deleteRequest.input(`store${idx}`, sql.NVarChar, store);
          });
          
          logToFile(`DEBUG: Store count: ${storeList.length}`, 'DEBUG');
          logToFile(`DEBUG: Delete query: ${deleteQuery}`, 'DEBUG');
          logToFile(`Deleting data for stores: ${storeList.join(', ')}`);
        } else {
          // Fallback: delete by date only
          deleteQuery = `
            DELETE FROM SNJ_SRP_DETAIL 
            WHERE SALES_DATE BETWEEN @minDate AND @maxDate
          `;
          logToFile(`WARNING: No stores detected, deleting by date only!`, 'WARN');
          logToFile(`DEBUG: Delete query: ${deleteQuery}`, 'DEBUG');
        }
        
        const deleteResult = await deleteRequest.query(deleteQuery);
        logToFile(`Deleted ${deleteResult.rowsAffected[0]} existing rows`);
      }

      // Insert new data
      let successCount = 0;
      let errorCount = 0;

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
            } else {
              // Log unknown columns (only once)
              if (i === 0) {
                logToFile(`Skipping unknown column: ${col}`, 'WARN');
              }
            }
          });

          if (validColumns.length === 0) {
            logToFile(`Row ${i + 1}: No valid columns found, skipping`, 'WARN');
            continue;
          }

          const columnNames = validColumns.map(col => `[${col}]`).join(', ');
          const placeholders = validColumns.map((_, idx) => `@param${idx}`).join(', ');
          
          const query = `INSERT INTO SNJ_SRP_DETAIL (${columnNames}) VALUES (${placeholders})`;
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

    // Get enabled connections
    const enabledConnections = config.connections.filter(conn => conn.enabled);
    
    if (enabledConnections.length === 0) {
      throw new Error('No enabled database connections in config.json');
    }

    // Upload to each database sequentially
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
      stabilityThreshold: 2000,
      pollInterval: 100
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
