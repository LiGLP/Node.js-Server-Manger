const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let DATA_DIR = path.join(__dirname, '..', 'data');
let FILE = path.join(DATA_DIR, 'data.json');

let db = { servers: [], users: [], config: { port: 8800 } };

function load() {
  try {
    if (fs.existsSync(FILE)) {
      db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      db.servers = db.servers || [];
      db.users = db.users || [];
      db.config = db.config || { port: 8800 };
      if (!db.config.port) db.config.port = 8800;
    } else {
      db = { servers: [], users: [], config: { port: 8800 } };
    }

    if (!db.config.sessionSecret) {
      db.config.sessionSecret = crypto.randomBytes(32).toString('hex');
      save();
    }
  } catch (e) {
    console.error('[store] failed to load, starting fresh:', e.message);
    db = { servers: [], users: [], config: { port: 8800, sessionSecret: crypto.randomBytes(32).toString('hex') } };
    save();
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('[store] failed to save:', e.message);
  }
}

function init(dir) {
  const targetDir = dir || process.env.NSM_DATA_DIR;
  if (targetDir) {
    DATA_DIR = path.resolve(targetDir);
    FILE = path.join(DATA_DIR, 'data.json');
  }
  load();
  return db;
}

const id = () => crypto.randomBytes(6).toString('hex');

function getServers() { return db.servers; }
function getServer(sid) { return db.servers.find(s => s.id === sid); }
function addServer(s) {
  const type = s.type === 'tunnel' ? 'tunnel' : 'server';
  const srv = {
    id: id(),
    type,
    name: s.name,
    folder: s.folder || (type === 'tunnel' ? 'Tunnels' : 'Default'),
    cwd: s.cwd || '',
    cmd: s.cmd || 'npm start',
    port: s.port || '',
    node: process.version,
    autoRestart: s.autoRestart !== false,
    startOnBoot: !!s.startOnBoot,
    backoff: s.backoff || 5,
    env: s.env || {},
    tunnel: type === 'tunnel' ? (s.tunnel || null) : null,
    createdAt: Date.now(),
  };
  db.servers.push(srv);
  save();
  return srv;
}
function updateServer(sid, patch) {
  const s = getServer(sid);
  if (!s) return null;
  Object.assign(s, patch);
  save();
  return s;
}
function removeServer(sid) {
  const i = db.servers.findIndex(s => s.id === sid);
  if (i === -1) return false;
  db.servers.splice(i, 1);
  save();
  return true;
}

function getUsers() { return db.users; }
function getUserByName(name) {
  return db.users.find(u => u.username.toLowerCase() === String(name).toLowerCase());
}
function addUser(u) {
  const user = {
    id: id(),
    username: u.username,
    passhash: u.passhash,
    role: u.role || 'user',
    createdAt: Date.now(),
  };
  db.users.push(user);
  save();
  return user;
}
function removeUser(uid) {
  const i = db.users.findIndex(u => u.id === uid);
  if (i === -1) return false;
  db.users.splice(i, 1);
  save();
  return true;
}

function getConfig() { return db.config; }
function setConfig(patch) { Object.assign(db.config, patch); save(); return db.config; }

module.exports = {
  init, save,
  getServers, getServer, addServer, updateServer, removeServer,
  getUsers, getUserByName, addUser, removeUser,
  getConfig, setConfig,
};
