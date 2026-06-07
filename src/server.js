/* ============================================================
   server.js — Express app: serves the panel + login + REST API
   ============================================================ */
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const store = require('./store');
const pm = require('./processManager');

const PUBLIC = path.join(__dirname, '..', 'public');

function buildApp() {
  const app = express();
  app.use(express.json());

  const sessionSecret = process.env.NSM_SECRET || store.getConfig().sessionSecret || 'local-secret';
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
  }));

  /* ---------- auth helpers ---------- */
  const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) return next();
    return res.status(401).json({ error: 'not authenticated' });
  };
  const requireAdmin = (req, res, next) => {
    if (req.session && req.session.role === 'admin') return next();
    return res.status(403).json({ error: 'admin only' });
  };

  /* ---------- auth routes ---------- */
  app.get('/api/state', (req, res) => {
    res.json({
      hasUsers: store.getUsers().length > 0,
      authed: !!(req.session && req.session.userId),
      user: req.session && req.session.userId
        ? { name: req.session.username, role: req.session.role }
        : null,
      port: store.getConfig().port,
      version: '1.0',
    });
  });

  // first-run: create the first admin (only allowed when no users exist)
  app.post('/api/setup', async (req, res) => {
    if (store.getUsers().length > 0) return res.status(403).json({ error: 'already configured' });
    const { username, password } = req.body || {};
    if (!username || !password || password.length < 4)
      return res.status(400).json({ error: 'username and a password (min 4 chars) required' });
    const passhash = bcrypt.hashSync(password, 10);
    const user = store.addUser({ username: username.trim(), passhash, role: 'admin' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.json({ ok: true, user: { name: user.username, role: user.role } });
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = store.getUserByName(username || '');
    if (!user || !bcrypt.compareSync(password || '', user.passhash))
      return res.status(401).json({ error: 'invalid username or password' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.json({ ok: true, user: { name: user.username, role: user.role } });
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  /* ---------- users (admin) ---------- */
  app.get('/api/users', requireAuth, (req, res) => {
    res.json(store.getUsers().map(u => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt })));
  });
  app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
    const { username, password, role } = req.body || {};
    if (!username || !password || password.length < 4)
      return res.status(400).json({ error: 'username and a password (min 4 chars) required' });
    if (store.getUserByName(username)) return res.status(409).json({ error: 'username already exists' });
    const passhash = bcrypt.hashSync(password, 10);
    const u = store.addUser({ username: username.trim(), passhash, role: role === 'admin' ? 'admin' : 'user' });
    res.json({ id: u.id, username: u.username, role: u.role });
  });
  app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    if (req.params.id === req.session.userId) return res.status(400).json({ error: "can't delete yourself" });
    const admins = store.getUsers().filter(u => u.role === 'admin');
    const target = store.getUsers().find(u => u.id === req.params.id);
    if (target && target.role === 'admin' && admins.length <= 1)
      return res.status(400).json({ error: 'cannot delete the last admin' });
    store.removeUser(req.params.id);
    res.json({ ok: true });
  });

  /* ---------- config ---------- */
  app.get('/api/config', requireAuth, (req, res) => res.json(store.getConfig()));
  app.put('/api/config', requireAuth, requireAdmin, (req, res) => {
    const patch = {};
    if (req.body.port) patch.port = parseInt(req.body.port, 10) || store.getConfig().port;
    res.json(store.setConfig(patch));
  });

  /* ---------- servers ---------- */
  const withStatus = s => Object.assign({}, s, pm.status(s.id));

  app.get('/api/servers', requireAuth, (req, res) => {
    res.json(store.getServers().map(withStatus));
  });
  app.post('/api/servers', requireAuth, (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'server name required' });
    const srv = store.addServer(req.body);
    res.json(withStatus(srv));
  });
  app.put('/api/servers/:id', requireAuth, (req, res) => {
    const s = store.updateServer(req.params.id, req.body || {});
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(withStatus(s));
  });
  app.delete('/api/servers/:id', requireAuth, (req, res) => {
    pm.stop(req.params.id);
    store.removeServer(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/servers/:id/start', requireAuth, (req, res) => {
    const s = store.getServer(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(pm.start(s));
  });
  app.post('/api/servers/:id/stop', requireAuth, (req, res) => {
    res.json(pm.stop(req.params.id));
  });
  app.post('/api/servers/:id/restart', requireAuth, (req, res) => {
    const s = store.getServer(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(pm.restart(s));
  });
  app.get('/api/servers/:id/logs', requireAuth, (req, res) => {
    res.json(pm.logs(req.params.id, parseInt(req.query.since, 10) || 0));
  });
  app.post('/api/servers/:id/logs/clear', requireAuth, (req, res) => {
    pm.clearLogs(req.params.id);
    res.json({ ok: true });
  });

  /* ---------- static panel ---------- */
  app.use(express.static(PUBLIC));
  // SPA-ish fallback: any non-api route serves index.html (gate handled client-side)
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

  return app;
}

/* poll real process stats every 2s */
let statsTimer = null;
function startServer(port) {
  const app = buildApp();
  const p = port || store.getConfig().port || 8800;
  const server = app.listen(p, () => console.log('[panel] listening on http://localhost:' + p));
  if (!statsTimer) statsTimer = setInterval(() => pm.refreshStats(), 2000);
  return server;
}

module.exports = { buildApp, startServer };

/* allow running standalone: node src/server.js */
if (require.main === module) {
  store.init();
  startServer();
}
