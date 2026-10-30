# HomeCloud

HomeCloud is a self-hosted personal cloud that combines a Google Drive-style file manager with a Google Photos-style media library. It is designed to run on small Linux devices such as a Raspberry Pi.

## Features

### Drive
- Browse folders and files with breadcrumb navigation
- Create folders, upload multiple files, drag-and-drop uploads, download and delete
- Search filenames in the current folder
- Streamed uploads up to 100 MB per file

### Photos
- Automatically discovers images and videos stored anywhere under the HomeCloud files directory
- Date-grouped photo and video timeline
- Full-size image and video preview
- Favorites
- Select photos and videos to create albums

### Accounts and server
- First-run administrator setup and login
- Administrators can create up to 99 additional user accounts
- Each account has isolated files, photos, albums and favorites
- Scrypt password hashing and HTTP-only session cookies
- Optional Secure cookies for HTTPS deployments
- CPU, memory, disk and temperature overview

### Interface
- Responsive desktop and mobile layout
- Apple Liquid Glass-inspired navigation and floating controls
- Translucent blur surfaces, subtle highlights and motion
- Reduced-motion and reduced-transparency preferences respected

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

The installer copies the app and enables the systemd service. It does not run `npm install` or compile anything. Open `http://<raspberry-pi-ip>:6944` and create an administrator account. The initial password must contain at least 12 characters.

## Update an existing installation

Pull the latest repository version, then rerun the installer:

```bash
git pull
sudo bash scripts/install.sh
sudo systemctl restart homecloud
sudo systemctl status homecloud --no-pager
```

User files and metadata remain in `/var/lib/homecloud`; the installer updates the application in `/opt/homecloud`.

## Run manually

```bash
node backend/server.js
```

## Storage layout

- Files: `/var/lib/homecloud/files`
- Administrator account: `/var/lib/homecloud/users.json`
- Albums: `/var/lib/homecloud/albums.json`
- Favorites: `/var/lib/homecloud/favorites.json`

## Security

Keep HomeCloud behind WireGuard or a trusted HTTPS reverse proxy. Do not expose port 6944 directly to the public Internet. For HTTPS deployments, set `HOMECloud_SECURE_COOKIE=1` in `/etc/homecloud/homecloud.env` and restart the service.

## Account management

Sign in with the administrator account, open **Accounts** in the sidebar, and create a username plus a temporary password (minimum 12 characters). Share those credentials securely with the new user. Each account starts with its own empty storage area; users cannot browse other accounts' files.

Existing single-user files, albums and favorites are migrated into the first administrator account on service startup after updating.

## Current limitations

- Media timeline dates use file modification times; EXIF capture-date extraction is not implemented yet.
- Images are served at original resolution; thumbnail generation and background indexing are not implemented yet.
- Album membership is stored as file paths. Moving or deleting an original file can make an album entry unavailable.
- Upload limit is 100 MB per file.
