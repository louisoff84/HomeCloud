# HomeCloud

Lightweight self-hosted home server dashboard for low-memory ARM64 devices such as Raspberry Pi 3 A+.

## Features (v0.1)
- Minimal dark dashboard (CPU load, memory, disk, uptime, temperature)
- First-run administrator setup and login
- HTTP-only signed session cookie, password hashing with Node.js scrypt
- Read-only systemd service status for an explicit allowlist
- Fastify API and static production frontend
- systemd deployment on Debian 12/13

> HomeCloud v0.1 intentionally does not expose a web shell or arbitrary command execution. Remote access should be provided through a private VPN or an HTTPS tunnel with access controls.

## Requirements
- Debian 12/13, ARM64 or AMD64
- Node.js 22 or newer (Node 24 recommended)
- npm
- 150 MB free disk space for installation/build

## Install
```bash
git clone https://github.com/louisoff84/HomeCloud.git
cd HomeCloud
sudo bash scripts/install.sh
```
Open `http://<raspberry-pi-ip>:6944`. On first visit, create the administrator account.

## Configuration
Environment variables:
- `HOMECloud_HOST` (default `127.0.0.1`; installer sets `0.0.0.0`)
- `HOMECloud_PORT` (default `6944`)
- `HOMECloud_DATA_DIR` (default `/var/lib/homecloud`)
- `HOMECloud_SERVICES` comma-separated systemd unit allowlist (default: `ssh.service,cron.service`)

For remote access, prefer Tailscale/WireGuard or a Cloudflare Tunnel protected by Access. Do not expose port 6944 directly to the public Internet.

## Development
```bash
npm install
npm run dev
```
Frontend: Vite on 5173, API on 6944. Configure `VITE_API_URL=http://127.0.0.1:6944` if needed.

## Security notes
- Passwords are stored as scrypt hashes; plaintext passwords are never written to disk.
- Sessions are signed, HTTP-only cookies and are invalidated on server restart.
- Setup is disabled after the first administrator is created.
- Service monitoring is read-only in this release.
- Keep the host patched and restrict remote access at the VPN/tunnel layer.

## License
CC0-1.0. See [LICENSE](LICENSE).
