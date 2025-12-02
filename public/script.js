// Load saved connection on page load
window.addEventListener('DOMContentLoaded', () => {
  loadSavedConnection();
});

function loadSavedConnection() {
  const saved = localStorage.getItem('sqlServerConnection');
  if (saved) {
    try {
      const conn = JSON.parse(saved);
      document.getElementById('server').value = conn.server || '';
      document.getElementById('database').value = conn.database || '';
      document.getElementById('username').value = conn.username || '';
      document.getElementById('password').value = conn.password || '';
      document.getElementById('port').value = conn.port || '1433';
      
      const statusDiv = document.getElementById('connectionStatus');
      statusDiv.textContent = '✓ Connection loaded from saved settings';
      statusDiv.className = 'status-message success';
    } catch (e) {
      console.error('Error loading saved connection:', e);
    }
  }
}

function saveConnection() {
  const server = document.getElementById('server').value;
  const database = document.getElementById('database').value;
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const port = document.getElementById('port').value;

  const connection = { server, database, username, password, port };
  localStorage.setItem('sqlServerConnection', JSON.stringify(connection));

  const statusDiv = document.getElementById('connectionStatus');
  statusDiv.textContent = '✓ Connection settings saved!';
  statusDiv.className = 'status-message success';
}

function clearConnection() {
  localStorage.removeItem('sqlServerConnection');
  document.getElementById('server').value = '';
  document.getElementById('database').value = '';
  document.getElementById('username').value = '';
  document.getElementById('password').value = '';
  document.getElementById('port').value = '1433';

  const statusDiv = document.getElementById('connectionStatus');
  statusDiv.textContent = '✓ Connection settings cleared';
  statusDiv.className = 'status-message info';
}

async function testConnection() {
  const server = document.getElementById('server').value;
  const database = document.getElementById('database').value;
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const port = document.getElementById('port').value;

  const statusDiv = document.getElementById('connectionStatus');
  statusDiv.textContent = 'Testing connection...';
  statusDiv.className = 'status-message info';

  try {
    const response = await fetch('/api/test-connection', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ server, database, username, password, port })
    });

    const result = await response.json();

    if (result.success) {
      statusDiv.textContent = '✓ ' + result.message;
      statusDiv.className = 'status-message success';
      
      // Auto-save on successful connection
      saveConnection();
    } else {
      statusDiv.textContent = '✗ ' + result.message;
      statusDiv.className = 'status-message error';
    }
  } catch (error) {
    statusDiv.textContent = '✗ Error: ' + error.message;
    statusDiv.className = 'status-message error';
  }
}

document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const server = document.getElementById('server').value;
  const database = document.getElementById('database').value;
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const port = document.getElementById('port').value;
  const csvFile = document.getElementById('csvFile').files[0];

  if (!csvFile) {
    alert('Please select a CSV or XLSX file');
    return;
  }

  // Validate file extension
  const fileName = csvFile.name.toLowerCase();
  if (!fileName.endsWith('.csv') && !fileName.endsWith('.xlsx')) {
    alert('Please select a valid CSV or XLSX file');
    return;
  }

  const statusDiv = document.getElementById('uploadStatus');
  const progressBar = document.getElementById('progressBar');
  const resultsDiv = document.getElementById('results');

  statusDiv.textContent = 'Uploading and processing...';
  statusDiv.className = 'status-message info';
  progressBar.style.display = 'block';
  resultsDiv.style.display = 'none';

  const formData = new FormData();
  formData.append('csvFile', csvFile);
  formData.append('server', server);
  formData.append('database', database);
  formData.append('username', username);
  formData.append('password', password);
  formData.append('port', port);

  try {
    const response = await fetch('/api/upload-csv', {
      method: 'POST',
      body: formData
    });

    const result = await response.json();
    progressBar.style.display = 'none';

    if (result.success) {
      statusDiv.textContent = '✓ Upload completed successfully!';
      statusDiv.className = 'status-message success';

      // Show results
      resultsDiv.style.display = 'block';
      let resultsHTML = `
        <p><strong>Date Range:</strong> ${result.dateRange || 'N/A'}</p>
        <p><strong>Total Rows:</strong> ${result.totalRows}</p>
        <p><strong>Successfully Inserted:</strong> ${result.successCount}</p>
        <p><strong>Errors:</strong> ${result.errorCount}</p>
      `;

      if (result.errors && result.errors.length > 0) {
        resultsHTML += '<div class="error-list"><strong>Error Details (first 10):</strong>';
        result.errors.forEach(err => {
          resultsHTML += `<div class="error-item">Row ${err.row}: ${err.error}</div>`;
        });
        resultsHTML += '</div>';
      }

      document.getElementById('resultsContent').innerHTML = resultsHTML;
    } else {
      statusDiv.textContent = '✗ ' + result.message;
      statusDiv.className = 'status-message error';
    }
  } catch (error) {
    progressBar.style.display = 'none';
    statusDiv.textContent = '✗ Error: ' + error.message;
    statusDiv.className = 'status-message error';
  }
});
