#!/bin/bash
# Quick update — pull latest code and restart
# Run as: ssh root@YOUR_IP 'bash /home/agx/app/deploy/update.sh'

set -e
echo "→ Pulling latest..."
su - agx -c "cd ~/app && git pull && npm install --production"
echo "→ Restarting..."
su - agx -c "cd ~/app && pm2 restart agx-wip"
echo "✓ Updated and restarted"
