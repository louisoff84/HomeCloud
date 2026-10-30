#!/usr/bin/env bash
set -euo pipefail
APP_DIR="/opt/homecloud"
DATA_DIR="/var/lib/homecloud"
LOG_DIR="/var/log/homecloud"
CONFIG_DIR="/etc/homecloud"
SERVICE_USER="homecloud"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then echo "Run with sudo: sudo bash scripts/install.sh"; exit 1; fi
if ! command -v node >/dev/null 2>&1; then echo "Node.js 22+ is required. Install Node.js 22 or 24 first."; exit 1; fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 22 )); then echo "Node.js 22+ required; found $(node --version)"; exit 1; fi
command -v npm >/dev/null 2>&1 || { echo "npm is required"; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required"; exit 1; }

id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -o root -g root -m 0755 "$APP_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$LOG_DIR"
install -d -o root -g root -m 0755 "$CONFIG_DIR"
tar -C "$ROOT" --exclude='./data' --exclude='./node_modules' --exclude='./.git' -cf - . | tar -C "$APP_DIR" -xf -
cd "$APP_DIR"
npm install
npm run build
chown -R root:root "$APP_DIR"
cat > "$CONFIG_DIR/homecloud.env" <<'ENV'
NODE_ENV=production
HOMECloud_HOST=0.0.0.0
HOMECloud_PORT=6944
HOMECloud_DATA_DIR=/var/lib/homecloud
HOMECloud_SERVICES=ssh.service,cron.service
# Set to 1 only when all browser access uses HTTPS.
HOMECloud_SECURE_COOKIE=0
ENV
chmod 0640 "$CONFIG_DIR/homecloud.env"
chown root:"$SERVICE_USER" "$CONFIG_DIR/homecloud.env"
install -m 0644 "$APP_DIR/systemd/homecloud.service" /etc/systemd/system/homecloud.service
systemctl daemon-reload
systemctl enable --now homecloud
echo
echo "HomeCloud installed. Open http://<raspberry-pi-ip>:6944"
echo "Create your administrator account on first visit."
