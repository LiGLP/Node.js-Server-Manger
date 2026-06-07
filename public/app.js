const MID = '·', DASH = '—', ARR = '→';
const STATE_MAP = {
  online:   { cls: 'online', txt: 'RUNNING' },
  crash:    { cls: 'crash',  txt: 'CRASHED' },
  warn:     { cls: 'warn',   txt: 'DEGRADED' },
  stopping: { cls: 'warn',   txt: 'STOPPING' },
  idle:     { cls: 'idle',   txt: 'STOPPED' },
};

let SERVERS = [];
let current = null;
let mode = 'server';
let CFG = { port: 8800, version: '1.0' };
let ME = null;
let logSince = 0;
let pollTimer = null;
let logTimer = null;
let dashTimer = null;
let dashRange = 'today';
let createType = 'server';

async function api(path, opts) {
  const r = await fetch('/api' + path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
  }, opts));
  let data = null;
  try { data = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
  return data;
}

function fmtUp(s) {
  if (!s) return DASH;
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600),
        m = Math.floor(s % 3600 / 60), sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  return d + 'd ' + p(h) + ':' + p(m) + ':' + p(sec);
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function srv(id) { return SERVERS.find(s => s.id === id); }

async function boot() {
  const st = await api('/state');
  CFG.port = st.port; CFG.version = st.version;
  if (st.authed) {
    ME = st.user;
    enterApp();
  } else {
    showAuth(st.hasUsers);
  }
}

function showAuth(hasUsers) {
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth').style.display = 'flex';
  document.getElementById('loginForm').style.display = hasUsers ? '' : 'none';
  document.getElementById('setupForm').style.display = hasUsers ? 'none' : '';
  (hasUsers ? document.getElementById('loginUser') : document.getElementById('setupUser')).focus();
}

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('loginErr'); err.textContent = '';
  try {
    const r = await api('/login', { method: 'POST', body: JSON.stringify({
      username: document.getElementById('loginUser').value,
      password: document.getElementById('loginPass').value,
    })});
    ME = r.user; enterApp();
  } catch (ex) { err.textContent = ex.message; }
});

document.getElementById('setupForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('setupErr'); err.textContent = '';
  const p1 = document.getElementById('setupPass').value, p2 = document.getElementById('setupPass2').value;
  if (p1 !== p2) { err.textContent = 'passwords do not match'; return; }
  try {
    const r = await api('/setup', { method: 'POST', body: JSON.stringify({
      username: document.getElementById('setupUser').value, password: p1,
    })});
    ME = r.user; enterApp();
  } catch (ex) { err.textContent = ex.message; }
});

async function doLogout() {
  await api('/logout', { method: 'POST' });
  clearInterval(pollTimer); clearInterval(logTimer);
  location.reload();
}

function enterApp() {
  document.getElementById('auth').style.display = 'none';
  document.getElementById('app').style.display = '';
  document.getElementById('suName').textContent = ME.name + (ME.role === 'admin' ? ' · admin' : '');
  refresh().then(() => {
    if (SERVERS.length) showServer(SERVERS[0].id);
    else { renderTree(); showEmpty(); }
  });
  pollTimer = setInterval(tick, 2000);
}

async function refresh() {
  SERVERS = await api('/servers');
  renderTree();
}

async function tick() {
  try { SERVERS = await api('/servers'); } catch (e) { return; }
  renderTree();
  if (mode === 'server' && current) {
    const s = srv(current);
    if (s) paintLive(s);
  }
}

function folders() {
  const map = {};
  SERVERS.forEach(s => { (map[s.folder] = map[s.folder] || []).push(s); });
  return Object.keys(map).sort().map(k => ({ name: k, kids: map[k] }));
}

function renderTree() {
  const t = document.getElementById('tree');
  let h = '<div class="tree-label">Servers<span class="n">' + SERVERS.length + '</span></div>';
  folders().forEach(f => {
    h += '<div class="folder" data-name="' + esc(f.name) + '"><div class="row" onclick="this.parentNode.classList.toggle(\'collapsed\')">' +
      '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m9 6 6 6-6 6"/></svg>' +
      '<svg class="fi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>' +
      '<span>' + esc(f.name) + '</span><span class="cnt">' + f.kids.length + '</span></div><div class="kids">';
    f.kids.forEach(s => {
      const sm = STATE_MAP[s.state] || STATE_MAP.idle;
      const active = (mode === 'server' && s.id === current) ? ' active' : '';
      h += '<div class="srv' + active + '" data-name="' + esc(s.name) + '" onclick="showServer(\'' + s.id + '\')">' +
        '<span class="dot ' + sm.cls + '"></span><span class="lbl">' + esc(s.name) + '</span>' +
        '<span class="pr">' + (s.port ? ':' + s.port : '') + '</span></div>';
    });
    h += '</div></div>';
  });
  t.innerHTML = h;
}

function filterTree(q) {
  q = q.toLowerCase().trim();
  document.querySelectorAll('#tree .srv').forEach(el => {
    const n = el.getAttribute('data-name').toLowerCase();
    el.style.display = (!q || n.includes(q)) ? '' : 'none';
  });
}

function clearNav() {
  document.getElementById('raNav').classList.remove('active');
  document.getElementById('dashNav').classList.remove('active');
}

function showServer(id) {
  mode = 'server'; current = id;
  clearInterval(dashTimer);
  document.getElementById('hdrServer').style.display = '';
  document.getElementById('hdrRemote').style.display = 'none';
  document.getElementById('hdrDashboard').style.display = 'none';
  document.getElementById('serverTabs').style.display = '';
  clearNav();
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('overviewBody').style.display = '';
  goTab('overview');
  renderTree();
  paintServer(id);
}

function showDashboard() {
  mode = 'dashboard';
  document.getElementById('hdrServer').style.display = 'none';
  document.getElementById('hdrRemote').style.display = 'none';
  document.getElementById('hdrDashboard').style.display = '';
  document.getElementById('serverTabs').style.display = 'none';
  clearNav();
  document.getElementById('dashNav').classList.add('active');
  document.querySelectorAll('.srv').forEach(e => e.classList.remove('active'));
  goPage('dashboard');
  loadDashboard();
  clearInterval(dashTimer);
  dashTimer = setInterval(loadDashboard, 3000);
}

async function loadDashboard() {
  let d;
  try { d = await api('/dashboard?range=' + dashRange); } catch (e) { return; }
  const s = d.summary;
  document.getElementById('dashCount').textContent = s.servers + (s.servers === 1 ? ' SERVICE' : ' SERVICES');
  document.getElementById('dUptime').innerHTML = s.uptimePct + '<small>%</small>';
  document.getElementById('dUptimeSub').textContent = s.points ? 'across ' + s.servers + ' service' + (s.servers === 1 ? '' : 's') : 'no samples yet';
  document.getElementById('dCpu').innerHTML = s.avgCpu + '<small>%</small>';
  document.getElementById('dCpuSub').textContent = 'now ' + s.cpu + '% · avg in range';
  document.getElementById('dMem').innerHTML = s.avgMem + '<small>MB</small>';
  document.getElementById('dMemSub').textContent = 'now ' + s.mem + ' MB · peak ' + s.peakMem;
  document.getElementById('dOnline').innerHTML = s.online + '<small>/' + s.servers + '</small>';
  document.getElementById('dRangeLbl').textContent = { today: 'today', week: 'last week', month: 'last month' }[d.range];

  drawChart(d.series);
  renderDashList();
}

function drawChart(series) {
  const svg = document.getElementById('dChart');
  const empty = document.getElementById('dChartEmpty');
  if (!series || series.length < 2) { svg.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  const W = 600, H = 160;
  const n = series.length;
  const maxCpu = Math.max(1, ...series.map(p => p.cpu));
  const maxMem = Math.max(1, ...series.map(p => p.mem));
  const x = i => (i / (n - 1)) * W;
  const line = (key, max) => series.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + (H - (p[key] / max) * (H - 12) - 4).toFixed(1)).join(' ');
  const area = (key, max) => 'M0 ' + H + ' ' + series.map((p, i) => 'L' + x(i).toFixed(1) + ' ' + (H - (p[key] / max) * (H - 12) - 4).toFixed(1)).join(' ') + ' L' + W + ' ' + H + ' Z';
  svg.innerHTML =
    '<defs><linearGradient id="cpuG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5eead4" stop-opacity=".25"/><stop offset="1" stop-color="#5eead4" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="' + area('cpu', maxCpu) + '" fill="url(#cpuG)"/>' +
    '<path d="' + line('cpu', maxCpu) + '" fill="none" stroke="#5eead4" stroke-width="2" vector-effect="non-scaling-stroke"/>' +
    '<path d="' + line('mem', maxMem) + '" fill="none" stroke="#a78bfa" stroke-width="2" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>';
}

function renderDashList() {
  document.getElementById('dSvcCount').textContent = SERVERS.length;
  const rows = SERVERS.map(s => {
    const sm = STATE_MAP[s.state] || STATE_MAP.idle;
    const isTun = s.type === 'tunnel';
    const sub = isTun ? (s.tunnelUrl || (s.tunnel && s.tunnel.domain) || 'tunnel') : (s.port ? 'localhost:' + s.port : s.cmd);
    return '<div class="trow urow" style="cursor:pointer" onclick="showServer(\'' + s.id + '\')">' +
      '<span class="dot ' + sm.cls + '" style="margin:0 2px"></span>' +
      '<div class="url"><b style="color:var(--ink)">' + esc(s.name) + '</b>' +
        (isTun ? '<span class="tag-mini">tunnel</span>' : '') +
        '<span style="font-family:var(--mono);font-size:11.5px;color:var(--ink-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(sub) + '</span></div>' +
      '<div class="stat-tag" style="color:var(--' + (s.state === 'online' ? 'online' : s.state === 'crash' ? 'crash' : 'ink-3') + ')">' + sm.txt.toLowerCase() + '</div>' +
      '<div class="reqs">' + (s.state === 'online' ? fmtUp(s.uptime) : DASH) + '</div>' +
      '<div class="reqs" style="width:54px">' + (s.cpu || 0) + '%</div>' +
      '<div class="reqs" style="width:64px">' + (s.mem || 0) + 'MB</div>' +
      '</div>';
  }).join('');
  document.getElementById('dashList').innerHTML = rows || '<div style="padding:20px;text-align:center;color:var(--ink-4);font-size:13px">No services yet.</div>';
}

document.getElementById('dashRange').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#dashRange button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  dashRange = b.dataset.r;
  loadDashboard();
});

function backToServer() {
  if (current) showServer(current);
  else { mode = 'server'; document.getElementById('hdrRemote').style.display = 'none'; document.getElementById('hdrDashboard').style.display = 'none'; document.getElementById('hdrServer').style.display = ''; document.getElementById('serverTabs').style.display = ''; showEmpty(); }
}

function showEmpty() {
  clearInterval(dashTimer);
  document.getElementById('hdrServer').style.display = '';
  document.getElementById('hdrRemote').style.display = 'none';
  document.getElementById('hdrDashboard').style.display = 'none';
  document.getElementById('serverTabs').style.display = 'none';
  document.getElementById('srvName').textContent = 'No server selected';
  document.getElementById('srvCrumb').textContent = '';
  document.getElementById('srvPill').style.display = 'none';
  document.getElementById('overviewBody').style.display = 'none';
  document.getElementById('emptyState').style.display = '';
  goPage('overview');
}

function showRemote() {
  mode = 'remote';
  clearInterval(dashTimer);
  document.getElementById('hdrServer').style.display = 'none';
  document.getElementById('hdrRemote').style.display = '';
  document.getElementById('hdrDashboard').style.display = 'none';
  document.getElementById('serverTabs').style.display = 'none';
  clearNav();
  document.getElementById('raNav').classList.add('active');
  document.querySelectorAll('.srv').forEach(e => e.classList.remove('active'));
  goPage('remote');
  paintRemote();
}

function paintServer(id) {
  const s = srv(id); if (!s) return;
  document.getElementById('srvPill').style.display = '';
  document.getElementById('srvName').textContent = s.name;
  document.getElementById('srvCrumb').textContent = s.folder + (s.cwd ? ' ' + MID + ' ' + s.cwd : '');
  document.getElementById('procPort').textContent = s.port ? 'localhost:' + s.port : 'no port';
  document.getElementById('procCmd').textContent = s.cmd;
  document.getElementById('procCwd').textContent = s.cwd || '(app dir)';
  document.getElementById('procNode').textContent = s.node || '';
  document.getElementById('termTitle').textContent = s.name + ' ' + MID + ' stdout/stderr';
  document.getElementById('termPmt').textContent = s.name + ' $';

  document.getElementById('setCmd').value = s.cmd || '';
  document.getElementById('setCwd').value = s.cwd || '';
  document.getElementById('setPort').value = s.port || '';
  document.getElementById('setFolder').value = s.folder || '';
  document.getElementById('setAuto').classList.toggle('on', s.autoRestart !== false);
  document.getElementById('setBoot').classList.toggle('on', !!s.startOnBoot);
  document.querySelectorAll('#setBackoff button').forEach(b => b.classList.toggle('on', b.dataset.v == String(s.backoff)));
  renderEnv(s.env || {});

  paintLive(s);
  renderActivity(s);
  logSince = 0; document.getElementById('term').innerHTML = '';
  loadLogs();
}

function paintLive(s) {
  const sm = STATE_MAP[s.state] || STATE_MAP.idle;
  const pill = document.getElementById('srvPill');
  pill.className = 'pill ' + sm.cls;
  pill.innerHTML = '<span class="dot ' + sm.cls + '"></span><span>' + sm.txt + '</span>';

  document.getElementById('upBig').textContent = s.uptime ? fmtUp(s.uptime) : (s.state === 'online' ? '0d 00:00:00' : DASH);
  document.getElementById('upSince').textContent = s.state === 'online' ? 'running' : (s.state === 'crash' ? 'crashed' : 'not running');
  document.getElementById('cpuBig').innerHTML = (s.cpu || 0) + '<small>%</small>';
  document.getElementById('memBig').innerHTML = (s.mem || 0) + '<small>MB</small>';
  document.getElementById('reqBig').textContent = s.restarts || 0;
  document.getElementById('procPid').textContent = s.pid || DASH;

  document.getElementById('cpuM').textContent = (s.cpu || 0) + '%';
  document.getElementById('cpuBar').style.width = Math.min(100, (s.cpu || 0) * 4 + 2) + '%';
  document.getElementById('memM').textContent = (s.mem || 0) + ' MB';
  document.getElementById('memBar').style.width = Math.min(100, (s.mem || 0) / 5) + '%';
  document.getElementById('stateM').textContent = sm.txt.toLowerCase();
  document.getElementById('stateBar').style.width = s.state === 'online' ? '100%' : (s.state === 'crash' ? '100%' : '0%');
  document.getElementById('stateBar').parentElement.classList.toggle('mem', s.state === 'crash');

  const stop = document.getElementById('btnStop');
  if (s.state === 'idle' || s.state === 'crash') {
    stop.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3l16 9-16 9z"/></svg>Start';
    stop.classList.remove('stop'); stop.classList.add('go');
  } else {
    stop.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>Stop';
    stop.classList.add('stop'); stop.classList.remove('go');
  }

  if (s.type === 'tunnel' && s.tunnelUrl) {
    document.getElementById('procPort').textContent = s.tunnelUrl.replace(/^https?:\/\//, '');
  }
  paintConsole(s);
}

function renderActivity(s) {
  const ICO = {
    g: '<path d="M20 6 9 17l-5-5"/>',
    r: '<circle cx="12" cy="12" r="9"/><path d="M12 9v4M12 17h.01"/>',
    b: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/>',
    a: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  };
  const ev = [];
  if (s.state === 'online') ev.push(['g', 'Process running ' + MID + ' <b>pid ' + s.pid + '</b>', 'now']);
  if (s.state === 'crash') ev.push(['r', 'Process crashed ' + MID + ' non-zero exit', 'now']);
  if (s.restarts) ev.push(['a', 'Auto-restarted <b>' + s.restarts + '×</b>', '']);
  ev.push(['b', 'Added to manager', new Date(s.createdAt).toLocaleDateString()]);
  document.getElementById('activity').innerHTML = ev.map(e =>
    '<div class="evt"><div class="ic ' + e[0] + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + ICO[e[0]] + '</svg></div>' +
    '<div class="tx">' + e[1] + '</div><div class="ts">' + e[2] + '</div></div>').join('');
}

async function loadLogs() {
  if (!current) return;
  try {
    const r = await api('/servers/' + current + '/logs?since=' + logSince);
    logSince = r.total;
    const term = document.getElementById('term');
    if (r.lines.length) {
      term.insertAdjacentHTML('beforeend', r.lines.map(l =>
        '<div class="ln ' + l.lv + '"><span class="tt">' + l.t + '</span><span class="lv">' + lvLabel(l.lv) + '</span><span class="ms">' + esc(l.msg) + '</span></div>'
      ).join(''));
      term.scrollTop = term.scrollHeight;
    }
    if (term.innerHTML === '') term.innerHTML = '<div class="ln"><span class="tt">--</span><span class="lv"></span><span class="ms" style="color:var(--ink-4)">no output yet — start the server to see logs</span></div>';
  } catch (e) {}
}
function lvLabel(lv) {
  return { info: 'INFO', err: 'ERR', ok: 'OK', warn: 'WARN' }[lv] || lv.toUpperCase();
}

function paintConsole(s) {
  const input = document.getElementById('termIn');
  const bar = document.getElementById('connectBar');
  const cbText = document.getElementById('cbText');
  const isTun = s.type === 'tunnel';
  const live = s.state === 'online';
  const open = isTun && live && !s.tunnelConnected;

  if (open) {
    input.disabled = false;
    input.placeholder = 'type to send input to cloudflared, then press Enter…';
    bar.style.display = '';
    cbText.textContent = s.tunnelUrl ? 'Tunnel reachable at ' + s.tunnelUrl : 'Waiting for Cloudflare to connect…';
  } else {
    input.disabled = true;
    input.value = '';
    bar.style.display = 'none';
    if (isTun && s.tunnelConnected) {
      input.placeholder = 'cloudflare connected — console locked';
    } else {
      input.placeholder = 'console is read-only — stdout/stderr of the process';
    }
  }
}

async function termInput(e) {
  if (e.key !== 'Enter') return;
  const input = document.getElementById('termIn');
  const text = input.value;
  if (!text.trim() || !current) return;
  input.value = '';
  try { await api('/servers/' + current + '/input', { method: 'POST', body: JSON.stringify({ text }) }); }
  catch (ex) { toast(ex.message); }
  setTimeout(loadLogs, 200);
}

async function markConnected() {
  if (!current) return;
  await api('/servers/' + current + '/connected', { method: 'POST' });
  setTimeout(tick, 300);
}
async function clearConsole() {
  if (!current) return;
  await api('/servers/' + current + '/logs/clear', { method: 'POST' });
  logSince = 0; document.getElementById('term').innerHTML = '';
  loadLogs();
}

function goPage(name) {
  document.querySelectorAll('.panel-page').forEach(p => p.classList.toggle('show', p.dataset.page === name));
  if (name === 'console') {
    clearInterval(logTimer);
    logTimer = setInterval(loadLogs, 1500);
    loadLogs();
  } else {
    clearInterval(logTimer);
  }
}
function goTab(name) {
  document.querySelectorAll('#serverTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  goPage(name);
}
document.getElementById('serverTabs').addEventListener('click', e => {
  const t = e.target.closest('.tab'); if (t) goTab(t.dataset.tab);
});
document.getElementById('setBackoff').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#setBackoff button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
});

async function ctlToggle() {
  const s = srv(current); if (!s) return;
  const action = (s.state === 'idle' || s.state === 'crash') ? 'start' : 'stop';
  await api('/servers/' + current + '/' + action, { method: 'POST' });
  setTimeout(tick, 400);
  if (action === 'start') { goTab('console'); }
}
async function ctlRestart() {
  if (!current) return;
  await api('/servers/' + current + '/restart', { method: 'POST' });
  setTimeout(tick, 500);
}

function renderEnv(env) {
  const wrap = document.getElementById('envList');
  const keys = Object.keys(env);
  wrap.innerHTML = (keys.length ? keys : []).map(k => envRow(k, env[k])).join('');
}
function envRow(k, v) {
  return '<div class="env"><input class="inp k" value="' + esc(k) + '" placeholder="KEY"><input class="inp" value="' + esc(v) + '" placeholder="value">' +
    '<button class="del" onclick="this.parentNode.remove()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>';
}
function addEnvRow() {
  document.getElementById('envList').insertAdjacentHTML('beforeend', envRow('', ''));
}
function collectEnv() {
  const env = {};
  document.querySelectorAll('#envList .env').forEach(row => {
    const ins = row.querySelectorAll('input');
    const k = ins[0].value.trim();
    if (k) env[k] = ins[1].value;
  });
  return env;
}
async function saveSettings() {
  if (!current) return;
  const backoffBtn = document.querySelector('#setBackoff button.on');
  const patch = {
    cmd: document.getElementById('setCmd').value.trim(),
    cwd: document.getElementById('setCwd').value.trim(),
    port: document.getElementById('setPort').value.trim(),
    folder: document.getElementById('setFolder').value.trim() || 'Default',
    autoRestart: document.getElementById('setAuto').classList.contains('on'),
    startOnBoot: document.getElementById('setBoot').classList.contains('on'),
    backoff: backoffBtn ? backoffBtn.dataset.v : 5,
    env: collectEnv(),
  };
  await api('/servers/' + current + '', { method: 'PUT', body: JSON.stringify(patch) });
  await refresh();
  paintServer(current);
  toast('Settings saved');
}
async function deleteServer() {
  if (!current) return;
  const s = srv(current);
  if (!confirm('Delete "' + s.name + '"? This stops the process and removes it from the manager.')) return;
  await api('/servers/' + current, { method: 'DELETE' });
  current = null;
  await refresh();
  if (SERVERS.length) showServer(SERVERS[0].id); else showEmpty();
}

function openModal() {
  document.getElementById('mErr').textContent = '';
  setCreateType('server');
  document.getElementById('scrim').classList.add('show');
  document.getElementById('mName').focus();
}
function closeModal() { document.getElementById('scrim').classList.remove('show'); }
document.getElementById('scrim').addEventListener('click', e => { if (e.target.id === 'scrim') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function setCreateType(t) {
  createType = t;
  document.querySelectorAll('#mType button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  const tun = t === 'tunnel';
  document.getElementById('serverFields').style.display = tun ? 'none' : '';
  document.getElementById('tunnelFields').style.display = tun ? '' : 'none';
  document.getElementById('mTitle').textContent = tun ? 'Add a Cloudflare tunnel' : 'Add a Node server';
  document.getElementById('mLead').textContent = tun ? 'Expose a local port to the internet.' : 'Point the manager at a project directory and start command.';
  document.getElementById('mNameLbl').textContent = tun ? 'Tunnel name' : 'Server name';
  document.getElementById('mName').placeholder = tun ? 'my-tunnel' : 'my-service';
  document.getElementById('mCreateBtn').textContent = tun ? 'Create tunnel' : 'Create server';
  document.getElementById('mStartDesc').textContent = tun ? 'Open the tunnel as soon as it\'s added.' : 'Boot the process as soon as it\'s added.';
  if (tun) updateTunPreview();
}

function pickProvider(el) {
  if (el.classList.contains('soon')) return;
  document.querySelectorAll('.prov').forEach(p => p.classList.remove('on'));
  el.classList.add('on');
}

function toggleTunDomain(el) {
  el.classList.toggle('on');
  document.getElementById('mTunDomainField').style.display = el.classList.contains('on') ? '' : 'none';
  updateTunPreview();
}

function tunnelBody() {
  const domEl = document.getElementById('mTunDomainTog');
  return {
    provider: 'cloudflare',
    url: document.getElementById('mTunUrl').value.trim(),
    domainEnabled: domEl.classList.contains('on'),
    domain: document.getElementById('mTunDomain').value.trim(),
  };
}

function buildTunPreview(t) {
  const url = t.url || 'http://localhost:3000';
  let cmd = 'cloudflared tunnel --no-autoupdate --url ' + url;
  if (t.domainEnabled && t.domain) cmd += ' --hostname ' + t.domain;
  return cmd;
}
function updateTunPreview() {
  document.getElementById('mTunPreview').textContent = buildTunPreview(tunnelBody());
}

async function createServer() {
  const err = document.getElementById('mErr'); err.textContent = '';
  const name = document.getElementById('mName').value.trim();
  if (!name) { err.textContent = (createType === 'tunnel' ? 'tunnel' : 'server') + ' name required'; return; }

  let body;
  if (createType === 'tunnel') {
    const t = tunnelBody();
    if (t.domainEnabled && !t.domain) { err.textContent = 'enter a domain or turn off custom domain'; return; }
    body = {
      type: 'tunnel',
      name,
      folder: 'Tunnels',
      autoRestart: document.getElementById('mAuto').classList.contains('on'),
      tunnel: t,
    };
  } else {
    body = {
      type: 'server',
      name,
      folder: document.getElementById('mFolder').value.trim() || 'Default',
      port: document.getElementById('mPort').value.trim(),
      cwd: document.getElementById('mCwd').value.trim(),
      cmd: document.getElementById('mCmd').value.trim() || 'npm start',
      autoRestart: document.getElementById('mAuto').classList.contains('on'),
    };
  }

  try {
    const s = await api('/servers', { method: 'POST', body: JSON.stringify(body) });
    if (document.getElementById('mStart').classList.contains('on')) {
      await api('/servers/' + s.id + '/start', { method: 'POST' });
    }
    closeModal();
    ['mName', 'mPort', 'mCwd', 'mTunUrl', 'mTunDomain'].forEach(i => document.getElementById(i).value = '');
    await refresh();
    showServer(s.id);
    if (document.getElementById('mStart').classList.contains('on')) goTab('console');
  } catch (ex) { err.textContent = ex.message; }
}

function paintRemote() {
  document.getElementById('raPort').textContent = CFG.port;
  document.getElementById('raMetaPort').textContent = CFG.port;
  document.getElementById('cfgPort').value = CFG.port;
  document.getElementById('fwCmd').textContent =
    'netsh advfirewall firewall add rule name="ServerManager" dir=in action=allow protocol=TCP localport=' + CFG.port;
  const isAdmin = ME && ME.role === 'admin';
  document.getElementById('addUserRow').style.display = isAdmin ? '' : 'none';
  loadUsers();
  api('/config').then(cfg => {
    document.getElementById('cfgAutoLaunch').classList.toggle('on', !!cfg.autoLaunch);
  }).catch(() => {});
}

async function toggleAutoLaunch(el) {
  if (!(ME && ME.role === 'admin')) { toast('Admin only'); return; }
  const next = !el.classList.contains('on');
  el.classList.toggle('on', next);
  try { await api('/config', { method: 'PUT', body: JSON.stringify({ autoLaunch: next }) });
    toast(next ? 'Launch on system start enabled' : 'Launch on system start disabled');
  } catch (ex) { el.classList.toggle('on', !next); toast(ex.message); }
}

async function loadUsers() {
  const users = await api('/users');
  document.getElementById('userCount').textContent = users.length;
  document.getElementById('raMetaUsers').textContent = users.length;
  const isAdmin = ME && ME.role === 'admin';
  document.getElementById('userList').innerHTML = users.map(u =>
    '<div class="trow urow"><div class="uavatar">' + esc(u.username[0].toUpperCase()) + '</div>' +
    '<div class="url"><b style="color:var(--ink)">' + esc(u.username) + '</b></div>' +
    '<div class="stat-tag">' + (u.role === 'admin' ? '<span class="dot online"></span>admin' : 'user') + '</div>' +
    '<div class="reqs">added ' + new Date(u.createdAt).toLocaleDateString() + '</div>' +
    (isAdmin && u.username !== ME.name ? '<button class="kill" onclick="delUser(\'' + u.id + '\',\'' + esc(u.username) + '\')">Remove</button>' : '<div style="width:64px"></div>') +
    '</div>').join('');
}

async function addUser() {
  const err = document.getElementById('userErr'); err.textContent = '';
  try {
    await api('/users', { method: 'POST', body: JSON.stringify({
      username: document.getElementById('newUser').value.trim(),
      password: document.getElementById('newPass').value,
      role: document.getElementById('newRole').value,
    })});
    document.getElementById('newUser').value = '';
    document.getElementById('newPass').value = '';
    loadUsers();
    toast('User added');
  } catch (ex) { err.textContent = ex.message; }
}
async function delUser(id, name) {
  if (!confirm('Remove user "' + name + '"?')) return;
  try { await api('/users/' + id, { method: 'DELETE' }); loadUsers(); }
  catch (ex) { document.getElementById('userErr').textContent = ex.message; }
}

function copyUrl() {
  navigator.clipboard.writeText('http://localhost:' + CFG.port).then(() => toast('Copied'));
}
async function savePort() {
  const p = parseInt(document.getElementById('cfgPort').value, 10);
  if (!p || p < 1 || p > 65535) { toast('Invalid port'); return; }
  await api('/config', { method: 'PUT', body: JSON.stringify({ port: p }) });
  toast('Saved — restart the app to apply port ' + p);
}

let toastTimer = null;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

boot().catch(e => {
  document.getElementById('auth').style.display = 'flex';
  document.getElementById('loginErr').textContent = 'Cannot reach panel server: ' + e.message;
});
