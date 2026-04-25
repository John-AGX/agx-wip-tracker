#!/bin/bash
# ============================================================
# AGX WIP Tracker — DigitalOcean Droplet Setup
# Run this ONCE on a fresh Ubuntu 22.04+ droplet
#
# Usage:
#   1. Create a $6/mo droplet (Ubuntu 22.04, 1GB RAM)
#   2. SSH in: ssh root@YOUR_IP
#   3. Run: bash setup.sh YOUR_DOMAIN.com
# ============================================================

set -e

DOMAIN=${1:-""}

echo "=== AGX WIP Tracker Setup ==="

# 1. System updates
echo "→ Updating system..."
apt-get update -y && apt-get upgrade -y

# 2. Install Node.js 20
echo "→ Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. Install nginx
echo "→ Installing nginx..."
apt-get install -y nginx

# 4. Install PM2 globally
echo "→ Installing PM2..."
npm install -g pm2

# 5. Create app user
echo "→ Creating app user..."
id -u agx &>/dev/null || useradd -m -s /bin/bash agx

# 6. Clone repo
echo "→ Cloning repo..."
su - agx -c "
  git clone https://github.com/John-AGX/agx-wip-tracker.git ~/app || (cd ~/app && git pull)
  cd ~/app
  npm install --production
"

# 7. Generate .env
echo "→ Generating .env..."
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
cat > /home/agx/app/.env << EOF
JWT_SECRET=${JWT_SECRET}
PORT=3000
NODE_ENV=production
EOF
chown agx:agx /home/agx/app/.env

# 8. Create data directory
mkdir -p /home/agx/app/data
chown agx:agx /home/agx/app/data

# 9. Start with PM2
echo "→ Starting app with PM2..."
su - agx -c "
  cd ~/app
  pm2 start ecosystem.config.js
  pm2 save
"
pm2 startup systemd -u agx --hp /home/agx

# 10. Configure nginx
echo "→ Configuring nginx..."
if [ -n "$DOMAIN" ]; then
  sed "s/YOUR_DOMAIN.com/$DOMAIN/g" /home/agx/app/deploy/nginx.conf > /etc/nginx/sites-available/agx-wip
else
  sed "s/server_name YOUR_DOMAIN.com;/server_name _;/" /home/agx/app/deploy/nginx.conf > /etc/nginx/sites-available/agx-wip
fi
ln -sf /etc/nginx/sites-available/agx-wip /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# 11. SSL (if domain provided)
if [ -n "$DOMAIN" ]; then
  echo "→ Setting up SSL..."
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@${DOMAIN} || echo "SSL setup failed — run manually: certbot --nginx -d $DOMAIN"
fi

# 12. Setup daily backup cron
echo "→ Setting up daily backups..."
mkdir -p /home/agx/backups
cat > /etc/cron.daily/agx-backup << 'CRON'
#!/bin/bash
cp /home/agx/app/data/agx.db /home/agx/backups/agx-$(date +%Y%m%d).db
find /home/agx/backups -name "agx-*.db" -mtime +30 -delete
CRON
chmod +x /etc/cron.daily/agx-backup

# 13. Configure firewall
echo "→ Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo ""
echo "============================================"
echo "  AGX WIP Tracker is running!"
echo "============================================"
if [ -n "$DOMAIN" ]; then
  echo "  URL: https://$DOMAIN"
else
  echo "  URL: http://$(curl -s ifconfig.me)"
fi
echo "  Login: admin@agx.com / admin123"
echo ""
echo "  IMPORTANT: Change the admin password after"
echo "  first login!"
echo ""
echo "  Useful commands:"
echo "    pm2 logs agx-wip     — view logs"
echo "    pm2 restart agx-wip  — restart app"
echo "    pm2 monit             — monitor"
echo "============================================"
