#!/usr/bin/env bash
set -euo pipefail
APP_DIR=/opt/homecloud; DATA_DIR=/var/lib/homecloud; CONFIG_DIR=/etc/homecloud; SERVICE_USER=homecloud
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo bash scripts/install.sh"; exit 1; }
command -v node >/dev/null || { echo "Node.js 18+ required"; exit 1; }
MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"; (( MAJOR >= 18 )) || { echo "Node.js 18+ required"; exit 1; }
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -o root -g root -m 0755 "$APP_DIR" "$CONFIG_DIR"; install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA_DIR"
tar -C "$ROOT" --exclude='./.git' --exclude='./node_modules' --exclude='./frontend' --exclude='./backend/src' --exclude='./vite.config.js' --exclude='./data' -cf - . | tar -C "$APP_DIR" -xf -
chown -R root:root "$APP_DIR"
cat > "$CONFIG_DIR/homecloud.env" <<'ENV'
HOMECloud_HOST=0.0.0.0
HOMECloud_PORT=6944
HOMECloud_DATA_DIR=/var/lib/homecloud
HOMECloud_SECURE_COOKIE=0
ENV
chmod 0640 "$CONFIG_DIR/homecloud.env"; chown root:"$SERVICE_USER" "$CONFIG_DIR/homecloud.env"
install -m 0644 "$APP_DIR/systemd/homecloud.service" /etc/systemd/system/homecloud.service
systemctl daemon-reload; systemctl enable --now homecloud
echo "Installed without npm install or build. Open http://<pi-ip>:6944"
