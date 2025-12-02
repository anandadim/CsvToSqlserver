# Deployment Guide - CSV to SQL Server Uploader

## Files to Upload

Upload these files to your production server:
- server.js
- fileWatcher.js
- tableManager.js
- tableSchemas.json
- package.json
- config.example.json
- README.md
- public/ (entire folder)

## DO NOT Upload

- node_modules/
- config.json (create manually on server)
- auto-upload/, processed/, failed/, logs/ (auto-created)
- uploads/

## Deployment Steps

### 1. Upload Files
Use FTP/SFTP or Git to upload files to server

### 2. Install Node.js
Ensure Node.js v14+ is installed on server:
```bash
node --version
```

### 3. Install Dependencies
```bash
cd csv-uploader
npm install
```

### 4. Create Configuration
```bash
copy config.example.json config.json
```

Edit config.json with your production database credentials:
- Database 1: For SNJ_SRP_DETAIL
- Database 2: For SALES_INVOICE_ACCURATE_ONLINE

### 5. Test Run
```bash
npm start
```

Access: http://your-server-ip:3000

### 6. Setup as Windows Service (Recommended)

#### Option A: Using PM2
```bash
npm install -g pm2
pm2 start server.js --name csv-uploader
pm2 save
pm2 startup
```

#### Option B: Using NSSM
1. Download NSSM: https://nssm.cc/download
2. Install service:
```bash
nssm install CSVUploader "C:\Program Files\nodejs\node.exe"
nssm set CSVUploader AppDirectory "C:\path\to\csv-uploader"
nssm set CSVUploader AppParameters "server.js"
nssm start CSVUploader
```

### 7. Configure Firewall
```bash
netsh advfirewall firewall add rule name="CSV Uploader" dir=in action=allow protocol=TCP localport=3000
```

### 8. Setup Auto-Upload Folder
Create shared folder for auto-upload:
```bash
mkdir auto-upload
```

Share this folder so users can drop files remotely.

## Security Checklist

- [ ] Change default database passwords
- [ ] Restrict port 3000 to internal network only
- [ ] Do not commit config.json to version control
- [ ] Backup database before first production run
- [ ] Test with sample data first
- [ ] Monitor logs folder regularly

## Monitoring

Check logs:
```bash
cd logs
type upload-2025-12-02.log
```

Check running processes:
```bash
pm2 status
# or
sc query CSVUploader
```

## Troubleshooting

### Server won't start
- Check Node.js is installed
- Check port 3000 is not in use
- Check config.json syntax

### Connection failed
- Verify database credentials in config.json
- Check SQL Server allows remote connections
- Check firewall allows SQL Server port (1433)

### Files not processing
- Check auto-upload folder permissions
- Check logs for errors
- Verify file format (CSV or XLSX)

## Maintenance

### Update Application
1. Stop service
2. Upload new files
3. Run `npm install` (if package.json changed)
4. Start service

### Backup
Regularly backup:
- config.json
- logs/ folder
- Database

## Support

Check README.md for detailed usage instructions.
