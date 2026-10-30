# HomeCloud
Lightweight personal cloud storage for small Linux devices.

## Stack
- Node.js native HTTP server (no backend framework)
- HTML5, CSS3 and Vanilla JavaScript
- No React, Vue, Vite, Express or Fastify
- No npm dependencies and no build step

## Requirements
Node.js 18+ and systemd for the installer.

## Install on Raspberry Pi
From the repository root:
```bash
sudo bash scripts/install.sh
```
The installer copies the application and enables the systemd service. It intentionally does not run `npm install` or compile anything. Open `http://<raspberry-pi-ip>:6944` and create an administrator account (password minimum 12 characters).

## Run manually
```bash
npm start
```

## Features
- Responsive Dropbox-inspired file manager
- Streamed uploads (100 MB per file), downloads, folders and deletion
- Administrator login with scrypt password hashing
- HTTP-only session cookies
- Host metrics for CPU, RAM, disk and temperature

Installed data: `/var/lib/homecloud`. Put HomeCloud behind HTTPS before exposing it to the internet. Set `HOMECloud_SECURE_COOKIE=1` in `/etc/homecloud/homecloud.env` when HTTPS is configured.
