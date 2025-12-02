const sql = require('mssql');
const fs = require('fs');

// Load table schemas
function loadSchemas() {
  try {
    const schemaData = fs.readFileSync('./tableSchemas.json', 'utf8');
    return JSON.parse(schemaData);
  } catch (err) {
    console.error('Error loading tableSchemas.json:', err.message);
    return {};
  }
}

// Check if table exists
async function tableExists(pool, tableName) {
  const query = `
    SELECT COUNT(*) as count
    FROM INFORMATION_SCHEMA.TABLES 
    WHERE TABLE_NAME = @tableName
  `;
  
  const request = pool.request();
  request.input('tableName', sql.NVarChar, tableName);
  const result = await request.query(query);
  
  return result.recordset[0].count > 0;
}

// Create table from schema
async function createTable(pool, tableName, schema) {
  console.log(`Creating table: ${tableName}`);
  
  // Build column definitions
  const columnDefs = Object.entries(schema.columns)
    .map(([name, type]) => `[${name}] ${type}`)
    .join(',\n  ');
  
  // Build primary key
  let primaryKeyDef = '';
  if (schema.primaryKey && schema.primaryKey.length > 0) {
    const pkColumns = schema.primaryKey.map(col => `[${col}]`).join(', ');
    primaryKeyDef = `,\n  PRIMARY KEY (${pkColumns})`;
  }
  
  // Create table query
  const createQuery = `
    CREATE TABLE [${tableName}] (
      ${columnDefs}${primaryKeyDef}
    )
  `;
  
  await pool.request().query(createQuery);
  console.log(`✓ Table ${tableName} created successfully`);
  
  // Create indexes
  if (schema.indexes && schema.indexes.length > 0) {
    for (const indexCol of schema.indexes) {
      const indexName = `idx_${indexCol.toLowerCase()}`;
      const indexQuery = `
        CREATE INDEX [${indexName}] 
        ON [${tableName}] ([${indexCol}])
      `;
      
      try {
        await pool.request().query(indexQuery);
        console.log(`✓ Index ${indexName} created on ${indexCol}`);
      } catch (err) {
        console.log(`Warning: Could not create index ${indexName}: ${err.message}`);
      }
    }
  }
}

// Ensure table exists (create if not)
async function ensureTable(pool, tableName) {
  const schemas = loadSchemas();
  const schema = schemas[tableName];
  
  if (!schema) {
    throw new Error(`No schema defined for table: ${tableName}`);
  }
  
  const exists = await tableExists(pool, tableName);
  
  if (!exists) {
    await createTable(pool, tableName, schema);
    return true; // Table was created
  }
  
  return false; // Table already exists
}

// Map CSV columns to SQL columns using schema mapping
function mapColumns(csvRow, tableName) {
  const schemas = loadSchemas();
  const schema = schemas[tableName];
  
  if (!schema || !schema.columnMapping) {
    return csvRow; // No mapping, return as-is
  }
  
  const mappedRow = {};
  
  for (const [csvCol, sqlCol] of Object.entries(schema.columnMapping)) {
    if (csvRow.hasOwnProperty(csvCol)) {
      mappedRow[sqlCol] = csvRow[csvCol];
    }
  }
  
  return mappedRow;
}

// Parse numeric value (handle comma as thousand separator)
function parseNumeric(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  
  // Convert to string
  let strValue = value.toString().trim();
  
  // Remove thousand separators (comma or dot depending on locale)
  // Assume format: 55,000. or 55.000,00
  // For Indonesian format: 55.000,00 (dot = thousand, comma = decimal)
  // For US format: 55,000.00 (comma = thousand, dot = decimal)
  
  // Remove all dots and commas except the last one
  const lastDot = strValue.lastIndexOf('.');
  const lastComma = strValue.lastIndexOf(',');
  
  if (lastDot > lastComma) {
    // US format: 55,000.50 → remove commas
    strValue = strValue.replace(/,/g, '');
  } else if (lastComma > lastDot) {
    // Indonesian format: 55.000,50 → remove dots, replace comma with dot
    strValue = strValue.replace(/\./g, '').replace(',', '.');
  } else {
    // No decimal separator, just remove all commas and dots
    strValue = strValue.replace(/[,.]/g, '');
  }
  
  const numValue = parseFloat(strValue);
  return isNaN(numValue) ? null : numValue;
}

// Parse date value
function parseDate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  
  // Try to parse various date formats
  const strValue = value.toString().trim();
  
  // Format: "25 Nov 2025" or "25-Nov-2025"
  const monthMap = {
    'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
    'may': '05', 'mei': '05', 'jun': '06', 'jul': '07',
    'aug': '08', 'agu': '08', 'sep': '09', 'oct': '10',
    'okt': '10', 'nov': '11', 'dec': '12', 'des': '12'
  };
  
  // Try to match: "25 Nov 2025"
  const match = strValue.match(/(\d{1,2})\s*([a-z]+)\s*(\d{4})/i);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = monthMap[match[2].toLowerCase().substring(0, 3)];
    const year = match[3];
    
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }
  
  // Return as-is and let SQL Server try to parse
  return strValue;
}

// Get column type from schema
function getColumnType(tableName, columnName) {
  const schemas = loadSchemas();
  const schema = schemas[tableName];
  
  if (!schema) return 'string';
  
  if (schema.numericColumns && schema.numericColumns.includes(columnName)) {
    return 'numeric';
  }
  
  if (schema.dateColumns && schema.dateColumns.includes(columnName)) {
    return 'date';
  }
  
  return 'string';
}

module.exports = {
  ensureTable,
  mapColumns,
  parseNumeric,
  parseDate,
  getColumnType
};
