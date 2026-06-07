# Node Server Manager

A desktop app (Electron) to manage local Node.js servers, with a login-protected web panel for remote access.

Start, stop and restart your local servers, watch their live logs, send input to running
processes, expose them through Cloudflare tunnels, and keep an eye on resource usage — all from a
single dashboard. The same panel runs as a web server, so you can reach it from another machine on
your network.

## Features

- **Process management** — start / stop / restart any local server or command
- **Live logs** — stream stdout/stderr per server and send input to the running process
- **Auto-start** — launch selected servers on boot and start the app at login
- **Cloudflare tunnels** — generate `cloudflared` commands to expose a local URL (optionally with a custom hostname)
- **Login-protected panel** — bcrypt-hashed credentials, session cookies, admin/user roles
- **Dashboard** — per-day / week / month resource stats
- **Runs as desktop app or standalone server** — Electron window or a plain Express server you can reach over the network

## Tech stack

- [Electron](https://www.electronjs.org/) — desktop shell
- [Express](https://expressjs.com/) + [express-session](https://github.com/expressjs/session) — web panel & API
- [bcryptjs](https://github.com/dcodeIO/bcrypt.js) — password hashing
- [pidusage](https://github.com/soyuka/pidusage) — process resource stats
- Vanilla HTML/CSS/JS frontend (no build step)

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm

### Install

```bash
git clone https://github.com/LiGLP/Node.js-Server-Manger.git
cd Node.js-Server-Manger
npm install
```

### Run as a desktop app

```bash
npm start
```

This opens the Electron window, which loads the panel from `http://localhost:8800`.

### Run as a standalone web server

```bash
npm run server
```

Then open `http://localhost:8800` in your browser. On first launch you create an admin account.

## Configuration

Copy `.env.example` to `.env` and adjust as needed (all values are optional):

| Variable       | Description                                                                                       | Default |
| -------------- | ------------------------------------------------------------------------------------------------- | ------- |
| `PORT`         | Port for the web panel                                                                             | `8800`  |
| `NSM_SECRET`   | Secret used to sign session cookies. If blank, a secure random key is generated and saved on first start. | _(auto)_ |
| `NSM_DATA_DIR` | Directory for the servers/users/config database. Standalone defaults to `./data`; Electron uses the OS app-data folder. | _(auto)_ |

```bash
cp .env.example .env
```

## Build a Windows installer

```bash
npm run dist
```

The packaged installer is written to `dist/` (via [electron-builder](https://www.electron.build/)).

## Data & security notes

- User accounts, server definitions and config live in a local `data/` database (or the OS app-data
  folder in the desktop app). This folder is git-ignored and never committed.
- Passwords are stored as bcrypt hashes.
- The web panel has no transport encryption on its own — if you expose it beyond `localhost`, put it
  behind a tunnel/reverse proxy with TLS.

## License

[MIT](LICENSE) © LiGLP
