/* ============================================================
   processManager.js — spawn & supervise real Node processes
   ============================================================ */
const { spawn } = require('child_process');
const pidusage = require('pidusage');

const MAX_LOG = 500;

/* runtime state, keyed by server id (not persisted) */
const RT = new Map();

function rt(id) {
  if (!RT.has(id)) {
    RT.set(id, {
      child: null,
      pid: null,
      state: 'idle',      // idle | online | crash | stopping
      startedAt: 0,
      restarts: 0,
      logs: [],           // {t, lv, msg}
      stats: { cpu: 0, mem: 0 },
      manualStop: false,
      backoffCount: 0,
    });
  }
  return RT.get(id);
}

function pushLog(id, lv, msg) {
  const r = rt(id);
  const line = { t: stamp(), lv, msg: String(msg).replace(/\s+$/, '') };
  r.logs.push(line);
  if (r.logs.length > MAX_LOG) r.logs.shift();
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function feedLines(id, lv, chunk) {
  const text = chunk.toString();
  text.split(/\r?\n/).forEach(l => { if (l.trim() !== '') pushLog(id, lv, l); });
}

function start(server) {
  const r = rt(server.id);
  if (r.state === 'online' && r.child) return { ok: false, error: 'already running' };

  r.manualStop = false;
  const cwd = server.cwd && server.cwd.trim() ? server.cwd : process.cwd();
  const env = Object.assign({}, process.env, server.env || {});
  if (server.port) env.PORT = String(server.port);

  let child;
  try {
    // shell:true lets us run "npm start", "node x.js", etc. cross-platform
    child = spawn(server.cmd, {
      cwd,
      env,
      shell: true,
      windowsHide: true,
    });
  } catch (e) {
    pushLog(server.id, 'err', 'failed to spawn: ' + e.message);
    r.state = 'crash';
    return { ok: false, error: e.message };
  }

  r.child = child;
  r.pid = child.pid;
  r.state = 'online';
  r.startedAt = Date.now();
  pushLog(server.id, 'ok', 'process started · pid ' + child.pid + ' · ' + server.cmd);
  if (server.port) pushLog(server.id, 'info', 'PORT=' + server.port + ' · cwd ' + cwd);

  child.stdout.on('data', d => feedLines(server.id, 'info', d));
  child.stderr.on('data', d => feedLines(server.id, 'err', d));

  child.on('error', err => {
    pushLog(server.id, 'err', 'spawn error: ' + err.message);
  });

  child.on('exit', (code, signal) => {
    r.child = null;
    r.pid = null;
    const wasManual = r.manualStop;
    if (wasManual) {
      r.state = 'idle';
      pushLog(server.id, 'warn', 'process stopped');
      return;
    }
    if (code === 0) {
      r.state = 'idle';
      pushLog(server.id, 'ok', 'process exited cleanly (code 0)');
      return;
    }
    r.state = 'crash';
    pushLog(server.id, 'err', 'process exited with code ' + code + (signal ? ' · ' + signal : ''));

    // auto-restart with backoff
    if (server.autoRestart) {
      const limit = server.backoff === '∞' ? Infinity : (parseInt(server.backoff, 10) || 5);
      if (r.backoffCount < limit) {
        r.backoffCount++;
        r.restarts++;
        const delay = Math.min(1000 * r.backoffCount, 8000);
        pushLog(server.id, 'warn', 'auto-restart ' + r.backoffCount + '/' + (limit === Infinity ? '∞' : limit) + ' in ' + (delay / 1000) + 's');
        setTimeout(() => { if (!r.manualStop) start(server); }, delay);
      } else {
        pushLog(server.id, 'err', 'backoff limit reached — holding in failed state');
      }
    }
  });

  return { ok: true, pid: child.pid };
}

function stop(serverId) {
  const r = rt(serverId);
  if (!r.child) { r.state = 'idle'; return { ok: true, note: 'not running' }; }
  r.manualStop = true;
  r.backoffCount = 0;
  r.state = 'stopping';
  pushLog(serverId, 'warn', 'stopping process · pid ' + r.pid);
  const pid = r.pid;
  try {
    if (process.platform === 'win32') {
      // kill the whole process tree (shell + child)
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      r.child.kill('SIGTERM');
      setTimeout(() => { if (r.child) try { r.child.kill('SIGKILL'); } catch (e) {} }, 4000);
    }
  } catch (e) {
    pushLog(serverId, 'err', 'failed to stop: ' + e.message);
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

function restart(server) {
  const r = rt(server.id);
  r.backoffCount = 0;
  if (r.child) {
    r.manualStop = true;
    const pid = r.pid;
    pushLog(server.id, 'warn', 'restarting…');
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      else r.child.kill('SIGTERM');
    } catch (e) {}
    // wait for exit then start
    const wait = setInterval(() => {
      if (!r.child) { clearInterval(wait); start(server); }
    }, 200);
    setTimeout(() => clearInterval(wait), 6000);
    return { ok: true };
  }
  return start(server);
}

async function refreshStats() {
  const live = [];
  for (const [id, r] of RT) if (r.pid) live.push([id, r.pid]);
  await Promise.all(live.map(async ([id, pid]) => {
    try {
      const s = await pidusage(pid);
      const r = rt(id);
      r.stats = { cpu: +s.cpu.toFixed(1), mem: Math.round(s.memory / 1048576) };
    } catch (e) {
      // process likely gone between checks
      rt(id).stats = { cpu: 0, mem: 0 };
    }
  }));
}

function status(serverId) {
  const r = rt(serverId);
  return {
    state: r.state,
    pid: r.pid,
    uptime: r.startedAt && r.state === 'online' ? Math.floor((Date.now() - r.startedAt) / 1000) : 0,
    restarts: r.restarts,
    cpu: r.stats.cpu,
    mem: r.stats.mem,
  };
}

function logs(serverId, since = 0) {
  const r = rt(serverId);
  return { total: r.logs.length, lines: r.logs.slice(since) };
}

function clearLogs(serverId) { rt(serverId).logs = []; }

function stopAll() {
  for (const [id, r] of RT) if (r.child) stop(id);
}

module.exports = { start, stop, restart, status, logs, clearLogs, refreshStats, stopAll };
