# Deployment Guide - Ubuntu Server with Nginx

## Server Specs
- OS: Ubuntu Server (Proxmox VM)
- RAM: 4GB
- HDD: 200GB
- Web Server: Nginx (already installed)

## Prerequisites

### 1. Install Node.js (v18 LTS recommended)
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version
npm --version
```

### 2. Install PM2 (Process Manager)
```bash
sudo npm install -g pm2

# Verify
pm2 --version
```

## Deployment Steps

### 1. Upload Project to Server

**Option A: Using Git (Recommended)**
```bash
# Install git if not installed
sudo apt install git -y

# Clone or pull your project
cd /var/www
sudo git clone <your-repo-url> csv-uploader
cd csv-uploader
```

**Option B: Using SCP/SFTP**
```bash
# From your local machine (Windows)
# Use WinSCP or FileZilla to upload project folder to:
# /var/www/csv-uploader
```

### 2. Setup Project
```bash
cd /var/www/csv-uploader

# Install dependencies
npm install

# Copy and edit config
cp config.example.json config.json
nano config.json
# Edit connection strings, save with Ctrl+X, Y, Enter

# Create necessary folders
mkdir -p auto-upload processed failed logs

# Set permissions
sudo chown -R $USER:$USER /var/www/csv-uploader
chmod -R 755 /var/www/csv-uploader
```

### 3. Test Application
```bash
# Test run
npm start

# If successful, stop with Ctrl+C
```

### 4. Setup PM2 (Auto-start on boot)
```bash
# Start app with PM2
pm2 start server.js --name csv-uploader

# Save PM2 process list
pm2 save

# Setup PM2 to start on boot
pm2 startup
# Copy and run the command that PM2 outputs

# Check status
pm2 status
pm2 logs csv-uploader
```

### 5. Configure Nginx as Reverse Proxy

Create Nginx config:
```bash
sudo nano /etc/nginx/sites-available/csv-uploader
```

Paste this configuration:
```nginx
server {
    listen 80;
    server_name your-domain.com;  # Change this to your domain or IP

    # Increase upload size limit
    client_max_body_size 100M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeout settings for large file uploads
        proxy_connect_timeout 600;
        proxy_send_timeout 600;
        proxy_read_timeout 600;
        send_timeout 600;
    }
}
```

Enable the site:
```bash
# Create symbolic link
sudo ln -s /etc/nginx/sites-available/csv-uploader /etc/nginx/sites-enabled/

# Test Nginx config
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

### 6. Configure Firewall (if enabled)
```bash
# Allow HTTP
sudo ufw allow 80/tcp

# Allow HTTPS (for future SSL)
sudo ufw allow 443/tcp

# Check status
sudo ufw status
```

### 7. Setup File Upload via Samba/SFTP (Optional)

**Option A: SFTP (Recommended)**
Users can upload files via SFTP to `/var/www/csv-uploader/auto-upload/`

**Option B: Samba Share**
```bash
# Install Samba
sudo apt install samba -y

# Create Samba user
sudo smbpasswd -a $USER

# Edit Samba config
sudo nano /etc/samba/smb.conf
```

Add at the end:
```ini
[csv-upload]
    path = /var/www/csv-uploader/auto-upload
    browseable = yes
    writable = yes
    valid users = your-username
    create mask = 0644
    directory mask = 0755
```

Restart Samba:
```bash
sudo systemctl restart smbd
sudo ufw allow 445/tcp
```

Access from Windows: `\\server-ip\csv-upload`

## Post-Deployment

### Access Application
```
http://your-server-ip
or
http://your-domain.com
```

### Useful PM2 Commands
```bash
# View logs
pm2 logs csv-uploader

# Restart app
pm2 restart csv-uploader

# Stop app
pm2 stop csv-uploader

# Monitor
pm2 monit

# View process info
pm2 info csv-uploader
```

### Monitor Logs
```bash
# Application logs
tail -f /var/www/csv-uploader/logs/upload-*.log

# PM2 logs
pm2 logs csv-uploader --lines 100

# Nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Backup Strategy
```bash
# Create backup script
sudo nano /usr/local/bin/backup-csv-uploader.sh
```

Paste:
```bash
#!/bin/bash
BACKUP_DIR="/backup/csv-uploader"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Backup processed files
tar -czf $BACKUP_DIR/processed_$DATE.tar.gz /var/www/csv-uploader/processed/

# Backup logs
tar -czf $BACKUP_DIR/logs_$DATE.tar.gz /var/www/csv-uploader/logs/

# Keep only last 7 days
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete

echo "Backup completed: $DATE"
```

Make executable and schedule:
```bash
sudo chmod +x /usr/local/bin/backup-csv-uploader.sh

# Add to crontab (daily at 2 AM)
sudo crontab -e
# Add: 0 2 * * * /usr/local/bin/backup-csv-uploader.sh
```

## SSL/HTTPS Setup (Optional but Recommended)

### Using Let's Encrypt (Free SSL)
```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx -y

# Get SSL certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal is configured automatically
# Test renewal
sudo certbot renew --dry-run
```

## Troubleshooting

### App not starting
```bash
pm2 logs csv-uploader
# Check for errors in logs
```

### Cannot upload files
```bash
# Check permissions
ls -la /var/www/csv-uploader/auto-upload/

# Fix permissions
sudo chown -R $USER:$USER /var/www/csv-uploader
```

### Nginx 502 Bad Gateway
```bash
# Check if app is running
pm2 status

# Check Nginx error log
sudo tail -f /var/log/nginx/error.log
```

### Database connection issues
```bash
# Test connection from server
# Install SQL Server tools
curl https://packages.microsoft.com/keys/microsoft.asc | sudo apt-key add -
curl https://packages.microsoft.com/config/ubuntu/$(lsb_release -rs)/prod.list | sudo tee /etc/apt/sources.list.d/msprod.list
sudo apt update
sudo apt install mssql-tools unixodbc-dev -y

# Test connection
/opt/mssql-tools/bin/sqlcmd -S your-server -U username -P password -Q "SELECT @@VERSION"
```

## Performance Tuning

### Increase Node.js memory limit (if needed)
```bash
# Edit PM2 config
pm2 delete csv-uploader
pm2 start server.js --name csv-uploader --node-args="--max-old-space-size=2048"
pm2 save
```

### Monitor system resources
```bash
# Install htop
sudo apt install htop -y
htop

# Check disk usage
df -h

# Check memory
free -h
```

## Security Recommendations

1. **Change default passwords** in config.json
2. **Setup firewall** properly
3. **Use SSL/HTTPS** for production
4. **Restrict SSH access** (change port, use key-based auth)
5. **Regular updates**: `sudo apt update && sudo apt upgrade`
6. **Monitor logs** regularly
7. **Setup fail2ban** for brute-force protection:
```bash
sudo apt install fail2ban -y
sudo systemctl enable fail2ban
```

## Maintenance

### Weekly tasks
- Check logs for errors
- Monitor disk space
- Review processed/failed files

### Monthly tasks
- Update system packages
- Review and clean old logs
- Test backup restoration
- Update Node.js if needed

## Support

For issues, check:
1. PM2 logs: `pm2 logs csv-uploader`
2. Application logs: `./logs/upload-*.log`
3. Nginx logs: `/var/log/nginx/error.log`
