# Quick Start - Deployment ke Ubuntu Server

Panduan singkat untuk deploy aplikasi CSV Uploader ke Ubuntu Server dengan Nginx.

## Prerequisites
- Ubuntu Server (Proxmox VM)
- RAM: 4GB, HDD: 200GB
- Nginx sudah terinstall
- Akses SSH ke server

---

## Step 1: Install Node.js & PM2

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version
npm --version

# Install PM2 (Process Manager)
sudo npm install -g pm2
```

---

## Step 2: Upload Project ke Server

**Pilih salah satu:**

### Option A: Via Git
```bash
cd /var/www
sudo git clone <your-repo-url> csv-uploader
cd csv-uploader
```

### Option B: Via SCP/SFTP
Upload folder project ke: `/var/www/csv-uploader`

---

## Step 3: Setup Project

```bash
cd /var/www/csv-uploader

# Install dependencies
npm install

# Copy dan edit config
cp config.example.json config.json
nano config.json
# Edit connection string, save dengan Ctrl+X, Y, Enter

# Create folders
mkdir -p auto-upload processed failed logs

# Set permissions
sudo chown -R $USER:$USER /var/www/csv-uploader
chmod -R 755 /var/www/csv-uploader
```

---

## Step 4: Start dengan PM2

```bash
# Start application
pm2 start server.js --name csv-uploader

# Save PM2 process list
pm2 save

# Setup auto-start on boot
pm2 startup
# Copy dan jalankan command yang muncul

# Check status
pm2 status
pm2 logs csv-uploader
```

---

## Step 5: Configure Nginx

```bash
# Create Nginx config
sudo nano /etc/nginx/sites-available/csv-uploader
```

**Paste konfigurasi ini:**

```nginx
server {
    listen 80;
    server_name your-domain.com;  # Ganti dengan domain atau IP server

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

**Enable site:**

```bash
# Create symbolic link
sudo ln -s /etc/nginx/sites-available/csv-uploader /etc/nginx/sites-enabled/

# Test Nginx config
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

---

## Step 6: Configure Firewall (Optional)

```bash
# Allow HTTP
sudo ufw allow 80/tcp

# Allow HTTPS (untuk SSL nanti)
sudo ufw allow 443/tcp

# Check status
sudo ufw status
```

---

## Step 7: Access Application

Buka browser dan akses:
```
http://your-server-ip
```
atau
```
http://your-domain.com
```

---

## Useful Commands

### PM2 Commands
```bash
# View logs
pm2 logs csv-uploader

# Restart app
pm2 restart csv-uploader

# Stop app
pm2 stop csv-uploader

# Monitor
pm2 monit

# Status
pm2 status
```

### View Application Logs
```bash
# Real-time logs
tail -f /var/www/csv-uploader/logs/upload-*.log

# View all logs
ls -lh /var/www/csv-uploader/logs/
```

### Nginx Commands
```bash
# Test config
sudo nginx -t

# Reload
sudo systemctl reload nginx

# Restart
sudo systemctl restart nginx

# View logs
sudo tail -f /var/log/nginx/error.log
```

---

## File Upload via SFTP

Users dapat upload file via SFTP ke folder:
```
/var/www/csv-uploader/auto-upload/
```

**SFTP Details:**
- Host: `your-server-ip`
- Port: `22`
- Username: `your-ssh-username`
- Path: `/var/www/csv-uploader/auto-upload/`

---

## Troubleshooting

### App tidak jalan
```bash
pm2 logs csv-uploader
# Check error di logs
```

### Nginx 502 Bad Gateway
```bash
# Check app status
pm2 status

# Check Nginx logs
sudo tail -f /var/log/nginx/error.log
```

### Permission issues
```bash
sudo chown -R $USER:$USER /var/www/csv-uploader
chmod -R 755 /var/www/csv-uploader
```

---

## Next Steps (Optional)

1. **Setup SSL/HTTPS** - Lihat `DEPLOYMENT.md` untuk panduan Let's Encrypt
2. **Setup Backup** - Automated backup untuk processed files dan logs
3. **Setup Samba Share** - Untuk upload file via Windows network share
4. **Monitoring** - Setup monitoring dan alerting

Untuk panduan lengkap, lihat file **DEPLOYMENT.md**

---

## Summary

✅ Node.js & PM2 installed
✅ Project uploaded & configured
✅ PM2 running with auto-start
✅ Nginx configured as reverse proxy
✅ Application accessible via browser
✅ File watcher monitoring `auto-upload/` folder

**Selesai!** Aplikasi sudah running di production. 🎉
