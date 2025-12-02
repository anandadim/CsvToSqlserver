const express = require('express');
const multer = require('multer');
const sql = require('mssql');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { startWatcher } = require('./fileWatcher');

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

// Test database connection
app.post('/api/test-connection', async (req, res) => {
  const { server, database, username, password, port } = req.body;

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
});

// Upload and process CSV
app.post('/api/upload-csv', upload.single('csvFile'), async (req, res) => {
  const { server, database, username, password, port } = req.body;
  const filePath = req.file.path;

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

  let pool;
  const results = [];
  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  try {
    // Connect to SQL Server
    pool = await sql.connect(config);

    // Detect file type and parse accordingly
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    let csvData = [];

    if (fileExtension === '.xlsx') {
      // Parse XLSX file
      console.log('Parsing XLSX file...');
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0]; // Use first sheet
      const worksheet = workbook.Sheets[sheetName];
      csvData = xlsx.utils.sheet_to_json(worksheet);
    } else {
      // Parse CSV file
      console.log('Parsing CSV file...');
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (row) => {
            csvData.push(row);
          })
          .on('end', resolve)
          .on('error', reject);
      });
    }

    console.log(`Processing ${csvData.length} rows...`);

    // Get table schema to determine column types
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

    console.log('Table schema:', columnTypes);

    // Find min and max SALES_DATE from CSV data
    let minDate = null;
    let maxDate = null;
    
    csvData.forEach(row => {
      if (row.SALES_DATE) {
        const dateStr = row.SALES_DATE.toString();
        if (!minDate || dateStr < minDate) minDate = dateStr;
        if (!maxDate || dateStr > maxDate) maxDate = dateStr;
      }
    });

    console.log(`Date range in CSV: ${minDate} to ${maxDate}`);

    // Start transaction
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      // Delete existing data in the date range
      if (minDate && maxDate) {
        const deleteQuery = `
          DELETE FROM SNJ_SRP_DETAIL 
          WHERE SALES_DATE BETWEEN @minDate AND @maxDate
        `;
        const deleteRequest = new sql.Request(transaction);
        deleteRequest.input('minDate', sql.Date, minDate);
        deleteRequest.input('maxDate', sql.Date, maxDate);
        
        const deleteResult = await deleteRequest.query(deleteQuery);
        console.log(`Deleted ${deleteResult.rowsAffected[0]} existing rows for date range ${minDate} to ${maxDate}`);
      }

      // Process each row
      for (let i = 0; i < csvData.length; i++) {
      const row = csvData[i];
      
      try {
        // Get column names from CSV
        const columns = Object.keys(row);
        const values = Object.values(row);

        // Build dynamic INSERT query with brackets to handle reserved keywords
        const columnNames = columns.map(col => `[${col}]`).join(', ');
        const placeholders = columns.map((_, idx) => `@param${idx}`).join(', ');
        
        const query = `INSERT INTO SNJ_SRP_DETAIL (${columnNames}) VALUES (${placeholders})`;
        
        const request = new sql.Request(transaction);
        
        // Add parameters with type conversion based on SQL Server schema
        columns.forEach((col, idx) => {
          let value = values[idx];
          const sqlType = columnTypes[col];
          
          // Handle null/undefined/empty values
          if (value === null || value === undefined || value === '') {
            request.input(`param${idx}`, sql.NVarChar, null);
            return;
          }
          
          // Determine SQL type based on column data type
          if (sqlType && (sqlType.includes('int') || sqlType.includes('numeric') || sqlType.includes('decimal') || sqlType.includes('float'))) {
            // Numeric column - convert value
            let numValue;
            
            // Check if it's in scientific notation (e.g., 8.13E+10)
            if (typeof value === 'number' || /[eE][+-]?\d+/.test(value.toString())) {
              numValue = Number(value);
            } else {
              numValue = parseFloat(value.toString().replace(/[^0-9.-]/g, ''));
            }
            
            request.input(`param${idx}`, sql.Numeric, isNaN(numValue) ? null : numValue);
          } else {
            // String column - keep as string
            // Handle scientific notation for string columns (like phone numbers stored as varchar)
            let stringValue = value.toString();
            
            // If it looks like scientific notation, convert to full number string
            if (typeof value === 'number' || /[eE][+-]?\d+/.test(stringValue)) {
              const num = Number(value);
              if (!isNaN(num)) {
                stringValue = num.toFixed(0); // Convert to string without decimals
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
        console.error(`Error on row ${i + 1}:`, err.message);
      }
    }

      // Commit transaction if successful
      await transaction.commit();
      console.log('Transaction committed successfully');

    } catch (err) {
      // Rollback transaction on error
      await transaction.rollback();
      console.error('Transaction rolled back due to error:', err.message);
      throw err;
    }

    // Clean up uploaded file
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      message: 'Upload completed',
      dateRange: minDate && maxDate ? `${minDate} to ${maxDate}` : 'N/A',
      totalRows: csvData.length,
      successCount,
      errorCount,
      errors: errors.slice(0, 10) // Return first 10 errors only
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
      successCount,
      errorCount
    });
  } finally {
    if (pool) {
      await pool.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
