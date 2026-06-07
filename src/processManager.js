const { spawn } = require('child_process');
const pidusage = require('pidusage');

const MAX_LOG = 500;
const MAX_HISTORY = 5760;
const MAX_GLOBAL = 8000;

const RT = new Map();
const GLOBAL_HISTORY = [];

function rt(id) {
  if (!RT.has(id)) {
    RT.set(id, {
      child: null,
      pid: null,
      state: 'idle',
      startedAt: 0,
      restarts: 0,
      logs: [],
      stats: { cpu: 0, mem: 0 },
      manualStop: false,
      backoffCount: 0,
      history: [],
      tunnelConnected: false,
      tunnelUrl: '',
    });
  }
  return RT.get(id);
}

const TRY_RE = /(https?:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;
const HOST_RE = /\|\s+(https?:\/\/[^\s|]+)/i;

function detectTunnelUrl(id, text) {
  const r = rt(id);
  if (r.tunnelUrl) return;
  let m = text.match(TRY_RE);
  if (!m) m = text.match(HOST_RE);
  if (m) {
    r.tunnelUrl = m[1];
    r.tunnelConnected = true;
    pushLog(id, 'ok', 'tunnel live · ' + r.tunnelUrl);
  }
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
  detectTunnelUrl(id, text);
  text.split(/\r?\n/).forEach(l => { if (l.trim() !== '') pushLog(id, lv, l); });
}

function start(server) {
  const r = rt(server.id);
  if (r.state === 'online' && r.child) return { ok: false, error: 'already running' };

  r.manualStop = false;
  r.tunnelConnected = false;
  r.tunnelUrl = '';
  const cwd = server.cwd && server.cwd.trim() ? server.cwd : process.cwd();
  const env = Object.assign({}, process.env, server.env || {});
  if (server.port) env.PORT = String(server.port);

  let child;
  try {
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
      rt(id).stats = { cpu: 0, mem: 0 };
    }
  }));
  sample();
}

function sample() {
  const now = Date.now();
  let cpu = 0, mem = 0, online = 0;
  for (const [, r] of RT) {
    const up = r.state === 'online';
    const c = up ? r.stats.cpu : 0;
    const m = up ? r.stats.mem : 0;
    r.history.push({ t: now, cpu: c, mem: m, up: up ? 1 : 0 });
    if (r.history.length > MAX_HISTORY) r.history.shift();
    if (up) { cpu += c; mem += m; online++; }
  }
  GLOBAL_HISTORY.push({ t: now, cpu: +cpu.toFixed(1), mem, online });
  if (GLOBAL_HISTORY.length > MAX_GLOBAL) GLOBAL_HISTORY.shift();
}

function write(serverId, text) {
  const r = rt(serverId);
  if (!r.child || !r.child.stdin || !r.child.stdin.writable)
    return { ok: false, error: 'process not accepting input' };
  try {
    r.child.stdin.write(String(text).replace(/\r?\n$/, '') + '\n');
    pushLog(serverId, 'info', '> ' + text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function markConnected(serverId) {
  rt(serverId).tunnelConnected = true;
  pushLog(serverId, 'ok', 'marked as connected — console input locked');
  return { ok: true };
}

function rangeStart(range) {
  const now = new Date();
  if (range === 'today') { now.setHours(0, 0, 0, 0); return now.getTime(); }
  if (range === 'month') return Date.now() - 30 * 86400000;
  return Date.now() - 7 * 86400000;
}

function dashboard(range, totalServers) {
  const from = rangeStart(range);
  const win = GLOBAL_HISTORY.filter(p => p.t >= from);
  let cpu = 0, mem = 0, online = 0;
  for (const [, r] of RT) if (r.state === 'online') { cpu += r.stats.cpu; mem += r.stats.mem; online++; }

  let upSum = 0;
  win.forEach(p => { upSum += p.online; });
  const uptimePct = win.length ? Math.round((upSum / (win.length * Math.max(totalServers, 1))) * 100) : 0;
  const avgCpu = win.length ? +(win.reduce((a, p) => a + p.cpu, 0) / win.length).toFixed(1) : 0;
  const avgMem = win.length ? Math.round(win.reduce((a, p) => a + p.mem, 0) / win.length) : 0;
  const peakMem = win.reduce((a, p) => Math.max(a, p.mem), 0);

  const buckets = 60;
  let series = win;
  if (win.length > buckets) {
    const size = Math.ceil(win.length / buckets);
    series = [];
    for (let i = 0; i < win.length; i += size) {
      const slice = win.slice(i, i + size);
      series.push({
        t: slice[slice.length - 1].t,
        cpu: +(slice.reduce((a, p) => a + p.cpu, 0) / slice.length).toFixed(1),
        mem: Math.round(slice.reduce((a, p) => a + p.mem, 0) / slice.length),
        online: Math.round(slice.reduce((a, p) => a + p.online, 0) / slice.length),
      });
    }
  }

  return {
    range,
    summary: {
      servers: totalServers,
      online,
      cpu: +cpu.toFixed(1),
      mem,
      avgCpu, avgMem, peakMem, uptimePct,
      points: win.length,
    },
    series,
  };
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
    tunnelConnected: r.tunnelConnected,
    tunnelUrl: r.tunnelUrl,
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

module.exports = { start, stop, restart, status, logs, clearLogs, refreshStats, stopAll, write, markConnected, dashboard, sample };
