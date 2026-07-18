/* BasicRMM Operator Console – v4 */

const API = window.location.origin + '/api';
let token = localStorage.getItem('rmm_token') || '';
let currentUser = null;
let currentPage = 'dashboard';
let currentDeviceId = null;
let agentToken = '';
let serverUrl = '';
let pollTimer = null;
let alertPollTimer = null;
let rdpWs = null;
let rdpTimerInterval = null;
let rdpSeconds = 0;
let rdpInputEnabled = true;
let rdpFitMode = true;
let rdpRemoteW = 1920, rdpRemoteH = 1080;
let devicePage = 0;
const devicePageSize = 50;
let deviceFilter = 'all';
let deviceStatusFilter = '';
let deviceTypeFilter = '';
let deviceGroupFilter = '';
let deviceSearch = '';
let devicesCache = [];
let selectedDevices = new Set();

// ── HELPERS ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function timeAgo(isoStr) {
  if (!isoStr) return 'never';
  const d = new Date(isoStr);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  return Math.floor(hr / 24) + 'd ago';
}

function fmtDate(isoStr) {
  if (!isoStr) return '-';
  return new Date(isoStr).toLocaleString();
}

function progColor(pct) {
  if (pct >= 90) return 'red';
  if (pct >= 70) return 'yellow';
  return 'green';
}

function progCell(pct) {
  const p = Math.round(pct || 0);
  const c = progColor(p);
  return `<div class="prog-cell"><div class="prog-track"><div class="prog-fill ${c}" style="width:${Math.min(p,100)}%"></div></div><span class="prog-pct">${p}%</span></div>`;
}

function statusBadge(s) {
  const cls = s === 'online' ? 'badge-online' : 'badge-offline';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').prepend(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  if (r.status === 401) { logout(); throw new Error('Unauthorized'); }
  if (!r.ok) {
    let msg = 'Error ' + r.status;
    try { const j = await r.json(); msg = j.detail || msg; } catch(e) {}
    throw new Error(msg);
  }
  if (r.status === 204) return null;
  return r.json();
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

// ── AUTH ─────────────────────────────────────────────────────────────────────

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const u = document.getElementById('login-user').value.trim();
  const p = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-err');
  errEl.classList.add('hidden');
  try {
    const fd = new FormData();
    fd.append('username', u); fd.append('password', p);
    const r = await fetch(API + '/auth/login', { method: 'POST', body: fd });
    if (!r.ok) { const j = await r.json(); throw new Error(j.detail || 'Login failed'); }
    const j = await r.json();
    token = j.access_token;
    localStorage.setItem('rmm_token', token);
    await bootApp();
  } catch(e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

async function bootApp() {
  try {
    currentUser = await api('GET', '/auth/me');
  } catch(e) { logout(); return; }

  // Load settings for agentToken
  try {
    const s = await api('GET', '/settings');
    agentToken = s.agent_token || '';
    serverUrl = s.server_url || window.location.origin;
    if (!serverUrl) serverUrl = window.location.origin;
  } catch(e) {}

  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Set user info
  const initials = currentUser.username.slice(0,2).toUpperCase();
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-name').textContent = currentUser.username;
  document.getElementById('user-role').textContent = currentUser.is_admin ? 'admin' : 'operator';

  // Wire sidebar clicks
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.page));
  });

  // Wire topbar
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('notif-btn').addEventListener('click', () => navigate('alerts'));

  // Search: "/" shortcut
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      document.getElementById('global-search').focus();
    }
  });
  document.getElementById('global-search').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.target.blur(); e.target.value = ''; }
    if (e.key === 'Enter') {
      const v = e.target.value.trim();
      if (v) { deviceSearch = v; navigate('devices'); }
    }
  });

  startAlertPoll();
  navigate('dashboard');
}

function logout() {
  token = '';
  localStorage.removeItem('rmm_token');
  location.reload();
}

// ── ROUTING ──────────────────────────────────────────────────────────────────

function navigate(page, deviceId) {
  // Tear down RDP if switching away
  if (rdpWs && page !== 'device-detail') closeRdp();

  currentPage = page;
  clearInterval(pollTimer);

  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  const pageNames = {
    dashboard: 'Dashboard', devices: 'Devices', alerts: 'Alerts',
    software: 'Software', patches: 'Patches', scripts: 'Scripts',
    automations: 'Automations', toolbox: 'Toolbox', reports: 'Reports',
    audit: 'Audit', users: 'Users', settings: 'Settings',
    'device-detail': 'Device'
  };
  document.getElementById('breadcrumb-page').textContent = pageNames[page] || page;

  if (page === 'device-detail' && deviceId) {
    currentDeviceId = deviceId;
    renderDeviceDetail(deviceId);
    return;
  }

  const renders = {
    dashboard: renderDashboard,
    devices: renderDevices,
    alerts: renderAlerts,
    software: renderSoftwarePage,
    patches: renderPatchesPage,
    scripts: renderScripts,
    automations: renderAutomations,
    toolbox: renderToolbox,
    reports: renderReports,
    audit: renderAudit,
    users: renderUsers,
    settings: renderSettings
  };
  if (renders[page]) renders[page]();
}

// ── ALERT POLLING ─────────────────────────────────────────────────────────────

function startAlertPoll() {
  updateAlertBadge();
  setInterval(updateAlertBadge, 10000);
}

async function updateAlertBadge() {
  try {
    const alerts = await api('GET', '/alerts?dismissed=0');
    const count = Array.isArray(alerts) ? alerts.length : 0;
    const badge = document.getElementById('alert-badge');
    const topBadge = document.getElementById('topbar-badge');
    const onlineCount = document.getElementById('sidebar-online-count');
    badge.textContent = count;
    topBadge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
    topBadge.classList.toggle('hidden', count === 0);

    // Also update online count
    const devs = await api('GET', '/devices?status=online&limit=1');
    if (devs && devs.total !== undefined) {
      onlineCount.textContent = devs.total + ' agent' + (devs.total !== 1 ? 's' : '') + ' online';
    }
  } catch(e) {}
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

async function renderDashboard() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;
  let data;
  try { data = await api('GET', '/dashboard'); } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Failed to load dashboard</p></div>`; return;
  }

  const installCmds = {
    ps1: `# PowerShell Installer\n$url = "${serverUrl}"\n$token = "${agentToken}"\nInvoke-WebRequest -Uri "$url/agent/install.ps1" -OutFile install.ps1\n& .\\install.ps1 -Url $url -Token $token`,
    batch: `@echo off\nset URL=${serverUrl}\nset TOKEN=${agentToken}\npowershell -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%URL%/agent/install.ps1' -OutFile install.ps1; .\\install.ps1 -Url '%URL%' -Token '%TOKEN%'"`,
    vbscript: `Set oShell = CreateObject("WScript.Shell")\noShell.Run "powershell -ExecutionPolicy Bypass -Command ""Invoke-WebRequest -Uri '${serverUrl}/agent/install.ps1' -OutFile install.ps1; .\\install.ps1 -Url '${serverUrl}' -Token '${agentToken}'"" ", 0, False`,
    setup: `# Linux/macOS\ncurl -fsSL ${serverUrl}/agent/install.sh | sudo bash -s -- --url ${serverUrl} --token ${agentToken}`,
    msi: `# MSI (coming soon)\nmsiexec /i BasicRMM-Agent.msi SERVER_URL=${serverUrl} AGENT_TOKEN=${agentToken} /qn`
  };

  let activeFmt = 'ps1';
  const healthy = data.healthy_pct || 0;

  el.innerHTML = `
  <div class="page-header">
    <div class="page-header-left">
      <h1>Fleet Overview</h1>
      <p><span class="live-dot"></span> Live data · auto-refreshes every 10s</p>
    </div>
    <div class="page-header-right">
      <label class="rdp-toggle" style="gap:7px">
        <span style="font-size:12px;color:var(--muted)">Auto-refresh</span>
        <label class="toggle-sw"><input type="checkbox" id="dash-autorefresh" checked><span class="toggle-slider"></span></label>
      </label>
      <button class="btn btn-primary btn-sm" onclick="navigate('devices')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Agent
      </button>
    </div>
  </div>

  <div class="install-card" id="install-card">
    <div class="install-card-header">
      <span style="font-weight:600;font-size:14px">Deploy Agent</span>
      <button class="btn btn-secondary btn-sm" onclick="document.getElementById('install-card').style.display='none'">Hide</button>
    </div>
    <div class="install-steps">
      <div class="install-step"><div class="step-num">1</div><div class="step-text">Copy the install command for your target OS</div></div>
      <div class="install-step"><div class="step-num">2</div><div class="step-text">Run it as Administrator / root on the target machine</div></div>
      <div class="install-step"><div class="step-num">3</div><div class="step-text">The agent will appear in the Devices list within 30 seconds</div></div>
    </div>
    <div class="format-tabs" id="fmt-tabs">
      ${['ps1','batch','vbscript','setup','msi'].map(f => `<button class="fmt-tab${f===activeFmt?' active':''}" data-fmt="${f}">${f.toUpperCase()}</button>`).join('')}
    </div>
    <div class="code-block" id="install-cmd-block">
      <pre id="install-cmd-text">${esc(installCmds.ps1)}</pre>
      <button class="copy-btn" id="copy-install-btn">Copy</button>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-icon" style="background:rgba(59,130,246,.15)">
        <svg viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 20h8M12 18v2"/></svg>
      </div>
      <div class="stat-body">
        <div class="stat-value">${data.total}</div>
        <div class="stat-label">Total Devices</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:rgba(34,197,94,.15)">
        <svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      </div>
      <div class="stat-body">
        <div class="stat-value text-success">${data.online}</div>
        <div class="stat-label">Online</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:rgba(239,68,68,.15)">
        <svg viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      </div>
      <div class="stat-body">
        <div class="stat-value text-danger">${data.offline}</div>
        <div class="stat-label">Offline</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:rgba(245,158,11,.15)">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </div>
      <div class="stat-body">
        <div class="stat-value text-warning">${data.needs_attention}</div>
        <div class="stat-label">Needs Attention</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:rgba(34,197,94,.1)">
        <svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      </div>
      <div class="stat-body">
        <div class="stat-value text-success">${healthy}%</div>
        <div class="stat-label">Fleet Healthy</div>
      </div>
    </div>
  </div>

  <div class="charts-row">
    <div class="chart-card">
      <div class="card-title">Status Breakdown</div>
      <div class="pie-wrap">
        <svg id="pie-chart" viewBox="0 0 100 100" width="110" height="110"></svg>
        <div class="pie-legend">
          <div class="pie-leg-item"><div class="pie-leg-dot" style="background:var(--success)"></div><span>Online (${data.online})</span></div>
          <div class="pie-leg-item"><div class="pie-leg-dot" style="background:var(--danger)"></div><span>Offline (${data.offline})</span></div>
          <div class="pie-leg-item"><div class="pie-leg-dot" style="background:var(--warning)"></div><span>Attention (${data.needs_attention})</span></div>
        </div>
      </div>
    </div>
    <div class="chart-card">
      <div class="card-title">Devices by Platform</div>
      <div class="bar-chart-inner" id="platform-bars"></div>
    </div>
  </div>`;

  // Draw pie
  drawPie(data);
  // Draw bars
  drawPlatformBars(data.by_platform || {});

  // Format tabs
  document.getElementById('fmt-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.fmt-tab');
    if (!btn) return;
    activeFmt = btn.dataset.fmt;
    document.querySelectorAll('.fmt-tab').forEach(b => b.classList.toggle('active', b.dataset.fmt === activeFmt));
    document.getElementById('install-cmd-text').textContent = installCmds[activeFmt];
  });

  document.getElementById('copy-install-btn').addEventListener('click', function() {
    copyText(installCmds[activeFmt], this);
  });

  // Auto-refresh
  const ar = document.getElementById('dash-autorefresh');
  if (ar.checked) {
    pollTimer = setInterval(renderDashboard, 10000);
  }
  ar.addEventListener('change', () => {
    clearInterval(pollTimer);
    if (ar.checked) pollTimer = setInterval(renderDashboard, 10000);
  });
}

function drawPie(data) {
  const total = data.total || 1;
  const onPct = data.online / total;
  const offPct = data.offline / total;
  const warnPct = Math.min(data.needs_attention / total, onPct);
  const svg = document.getElementById('pie-chart');
  if (!svg) return;

  function arc(cx, cy, r, start, end, color) {
    if (end - start < 0.001) return '';
    const s = polarToCart(cx, cy, r, start);
    const e2 = polarToCart(cx, cy, r, end);
    const big = end - start > 0.5 ? 1 : 0;
    return `<path d="M${cx},${cy} L${s.x},${s.y} A${r},${r} 0 ${big},1 ${e2.x},${e2.y} Z" fill="${color}" opacity="0.9"/>`;
  }
  function polarToCart(cx, cy, r, pct) {
    const a = (pct * 2 * Math.PI) - Math.PI/2;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }

  let html = '';
  const cx = 50, cy = 50, r = 42;
  if (total === 0) {
    html = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--elevated)"/>`;
  } else {
    let start = 0;
    const segs = [
      { pct: onPct - warnPct, color: 'var(--success)' },
      { pct: warnPct, color: 'var(--warning)' },
      { pct: offPct, color: 'var(--danger)' },
      { pct: Math.max(0, 1 - onPct - offPct), color: 'var(--border)' }
    ];
    for (const seg of segs) {
      if (seg.pct > 0) {
        html += arc(cx, cy, r, start, start + seg.pct, seg.color);
        start += seg.pct;
      }
    }
    // center hole
    html += `<circle cx="${cx}" cy="${cy}" r="22" fill="var(--panel)"/>`;
    html += `<text x="${cx}" y="${cy+4}" text-anchor="middle" fill="var(--text)" font-size="10" font-weight="700">${Math.round(onPct*100)}%</text>`;
  }
  svg.innerHTML = html;
}

function drawPlatformBars(byPlatform) {
  const el = document.getElementById('platform-bars');
  if (!el) return;
  const entries = Object.entries(byPlatform);
  if (!entries.length) { el.innerHTML = '<div class="text-muted" style="font-size:12px">No data</div>'; return; }
  const max = Math.max(...entries.map(([,v]) => v.total)) || 1;
  el.innerHTML = entries.map(([plat, v]) => `
    <div class="bar-row">
      <div class="bar-label">${esc(plat)}</div>
      <div class="bar-track"><div class="bar-fill" style="background:var(--accent);width:${v.total/max*100}%"></div></div>
      <div class="bar-count">${v.total}</div>
    </div>
  `).join('');
}

// ── DEVICES ───────────────────────────────────────────────────────────────────

async function renderDevices() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="empty-state"><p>Loading devices…</p></div>`;
  try {
    const all = await api('GET', '/devices?limit=500');
    devicesCache = all.items || [];
    renderDevicesUI();
    pollTimer = setInterval(async () => {
      const r = await api('GET', '/devices?limit=500');
      devicesCache = r.items || [];
      renderDevicesTableOnly();
    }, 10000);
  } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Failed to load devices</p></div>`;
  }
}

function getFilteredDevices() {
  let list = devicesCache;
  if (deviceSearch) {
    const q = deviceSearch.toLowerCase();
    list = list.filter(d => (d.hostname||'').toLowerCase().includes(q) || (d.agent_id||'').toLowerCase().includes(q));
  }
  if (deviceFilter === 'servers') list = list.filter(d => (d.platform||'').toLowerCase().includes('windows server') || (d.os||'').toLowerCase().includes('server'));
  else if (deviceFilter === 'endpoints') list = list.filter(d => !(d.platform||'').toLowerCase().includes('server'));
  else if (deviceFilter === 'attention') list = list.filter(d => (d.cpu_percent||0)>90||(d.memory_percent||0)>90||(d.disk_percent||0)>90);
  else if (deviceFilter === 'offline') list = list.filter(d => d.status === 'offline');
  if (deviceStatusFilter) list = list.filter(d => d.status === deviceStatusFilter);
  if (deviceGroupFilter) list = list.filter(d => (d.group||'') === deviceGroupFilter);
  return list;
}

function countFilter(f) {
  const saved = deviceFilter;
  deviceFilter = f;
  const n = getFilteredDevices().length;
  deviceFilter = saved;
  return n;
}

function renderDevicesUI() {
  const el = document.getElementById('page-content');
  const all = devicesCache;
  const groups = [...new Set(all.map(d => d.group||'default'))].sort();
  const servers = all.filter(d=>(d.platform||'').toLowerCase().includes('server')||(d.os||'').toLowerCase().includes('server')).length;
  const endpoints = all.length - servers;
  const attention = all.filter(d=>(d.cpu_percent||0)>90||(d.memory_percent||0)>90||(d.disk_percent||0)>90).length;
  const offline = all.filter(d=>d.status==='offline').length;

  el.innerHTML = `
  <div class="page-header">
    <div class="page-header-left">
      <h1>Devices</h1>
    </div>
    <div class="page-header-right">
      <button class="btn btn-secondary btn-sm" id="dev-update-all">Update All</button>
      <button class="btn btn-secondary btn-sm" id="dev-cleanup">Clean Up</button>
      <button class="btn btn-primary btn-sm" onclick="navigate('dashboard')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Device
      </button>
    </div>
  </div>

  <div class="filter-chips">
    <button class="chip ${deviceFilter==='all'?'active':''}" data-filter="all">All Devices <span class="chip-count">${all.length}</span></button>
    <button class="chip ${deviceFilter==='servers'?'active':''}" data-filter="servers">Servers <span class="chip-count">${servers}</span></button>
    <button class="chip ${deviceFilter==='endpoints'?'active':''}" data-filter="endpoints">Endpoints <span class="chip-count">${endpoints}</span></button>
    <button class="chip ${deviceFilter==='attention'?'active':''}" data-filter="attention">Needs Attention <span class="chip-count">${attention}</span></button>
    <button class="chip ${deviceFilter==='offline'?'active':''}" data-filter="offline">Offline <span class="chip-count">${offline}</span></button>
  </div>

  <div class="table-wrap">
    <div class="tbl-toolbar">
      <div class="tbl-filters">
        <select class="filter-select" id="dev-status-filter">
          <option value="">All status</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
        </select>
        <select class="filter-select" id="dev-group-filter">
          <option value="">All groups</option>
          ${groups.map(g=>`<option value="${esc(g)}">${esc(g)}</option>`).join('')}
        </select>
        <input class="filter-select" id="dev-search" placeholder="Search…" style="width:160px" value="${esc(deviceSearch)}"/>
      </div>
      <span class="tbl-info" id="dev-count-label"></span>
    </div>
    <div id="devices-table-wrap">
      <table>
        <thead><tr>
          <th style="width:32px"><input type="checkbox" id="select-all-chk"/></th>
          <th>DEVICE</th>
          <th>STATUS</th>
          <th>OS</th>
          <th>CPU</th>
          <th>RAM</th>
          <th>DISK</th>
          <th>LAST SEEN</th>
          <th>AGENT</th>
          <th>GROUP / TAGS</th>
          <th>ACTIONS</th>
        </tr></thead>
        <tbody id="devices-tbody"></tbody>
      </table>
    </div>
    <div class="pagination-row">
      <div class="live-indicator">
        <span class="live-dot"></span> Live · auto-refresh 10s
      </div>
      <div class="pg-btns" id="pg-btns"></div>
    </div>
  </div>`;

  renderDevicesTableOnly();

  // Filter chips
  el.querySelectorAll('.chip[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      deviceFilter = btn.dataset.filter;
      devicePage = 0;
      renderDevicesUI();
    });
  });

  document.getElementById('dev-status-filter').value = deviceStatusFilter;
  document.getElementById('dev-status-filter').addEventListener('change', e => {
    deviceStatusFilter = e.target.value; devicePage = 0; renderDevicesTableOnly();
  });
  document.getElementById('dev-group-filter').value = deviceGroupFilter;
  document.getElementById('dev-group-filter').addEventListener('change', e => {
    deviceGroupFilter = e.target.value; devicePage = 0; renderDevicesTableOnly();
  });
  document.getElementById('dev-search').addEventListener('input', e => {
    deviceSearch = e.target.value; devicePage = 0; renderDevicesTableOnly();
  });

  document.getElementById('select-all-chk').addEventListener('change', e => {
    const chks = document.querySelectorAll('.dev-chk');
    chks.forEach(c => { c.checked = e.target.checked; if(e.target.checked) selectedDevices.add(+c.dataset.id); else selectedDevices.delete(+c.dataset.id); });
  });

  document.getElementById('dev-cleanup').addEventListener('click', async () => {
    const offline = devicesCache.filter(d=>d.status==='offline');
    if (!offline.length) { toast('No offline devices', 'info'); return; }
    if (!confirm(`Delete ${offline.length} offline device(s)?`)) return;
    for (const d of offline) {
      try { await api('DELETE', `/devices/${d.id}`); } catch(e) {}
    }
    toast('Cleaned up offline devices', 'success');
    renderDevices();
  });

  document.getElementById('dev-update-all').addEventListener('click', async () => {
    const online = devicesCache.filter(d=>d.status==='online');
    if (!online.length) { toast('No online devices', 'info'); return; }
    for (const d of online) {
      try { await api('POST', `/devices/${d.id}/command`, {shell:'powershell', command:'Write-Host "Update check"'}); } catch(e) {}
    }
    toast(`Sent update command to ${online.length} device(s)`, 'success');
  });
}

function renderDevicesTableOnly() {
  const filtered = getFilteredDevices();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / devicePageSize));
  if (devicePage >= totalPages) devicePage = 0;
  const page = filtered.slice(devicePage * devicePageSize, (devicePage + 1) * devicePageSize);

  const countEl = document.getElementById('dev-count-label');
  if (countEl) countEl.textContent = `${total} device${total!==1?'s':''}`;

  const tbody = document.getElementById('devices-tbody');
  if (!tbody) return;
  if (!page.length) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><p>No devices found</p></div></td></tr>`;
  } else {
    tbody.innerHTML = page.map(d => {
      const tags = (d.tags||'').split(',').filter(Boolean);
      return `<tr data-id="${d.id}">
        <td><input type="checkbox" class="dev-chk" data-id="${d.id}" ${selectedDevices.has(d.id)?'checked':''}></td>
        <td>
          <div class="cell-hostname">${esc(d.hostname||'—')}</div>
          <div class="cell-agent-id">${esc(d.agent_id)}</div>
        </td>
        <td>${statusBadge(d.status)}</td>
        <td>
          <div style="font-size:12px">${esc(d.os||'—')}</div>
          ${d.platform?`<span class="os-chip">${esc(d.platform)}</span>`:''}
        </td>
        <td>${progCell(d.cpu_percent)}</td>
        <td>${progCell(d.memory_percent)}</td>
        <td>${progCell(d.disk_percent)}</td>
        <td style="white-space:nowrap">${timeAgo(d.last_seen)}</td>
        <td class="mono" style="font-size:11px">${esc(d.version||'—')}</td>
        <td>
          <span style="font-size:11px">${esc(d.group||'default')}</span>
          ${tags.map(t=>`<span class="tag-chip">${esc(t)}</span>`).join('')}
        </td>
        <td class="actions-cell">
          <button class="btn btn-secondary btn-sm btn-icon dev-connect" data-id="${d.id}" title="Remote Terminal">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          </button>
          <button class="btn btn-danger btn-sm btn-icon dev-delete" data-id="${d.id}" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.dev-connect').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); navigate('device-detail', +btn.dataset.id); });
    });
    tbody.querySelectorAll('.dev-delete').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const id = +btn.dataset.id;
        const d = devicesCache.find(x=>x.id===id);
        if (!confirm(`Delete device "${d?.hostname}"?`)) return;
        try { await api('DELETE', `/devices/${id}`); toast('Device deleted', 'success'); devicesCache = devicesCache.filter(x=>x.id!==id); renderDevicesTableOnly(); } catch(e) { toast(e.message, 'error'); }
      });
    });
    tbody.querySelectorAll('tr[data-id]').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('button,input')) return;
        navigate('device-detail', +row.dataset.id);
      });
    });
    tbody.querySelectorAll('.dev-chk').forEach(c => {
      c.addEventListener('change', e => {
        if(e.target.checked) selectedDevices.add(+c.dataset.id); else selectedDevices.delete(+c.dataset.id);
      });
    });
  }

  // Pagination
  const pgEl = document.getElementById('pg-btns');
  if (pgEl) {
    const pages = [];
    for (let i = 0; i < totalPages; i++) pages.push(i);
    pgEl.innerHTML = `
      <button class="pg-btn" ${devicePage===0?'disabled':''} onclick="devicePage--;renderDevicesTableOnly()">‹</button>
      ${pages.slice(Math.max(0,devicePage-2), Math.min(totalPages, devicePage+5)).map(i =>
        `<button class="pg-btn ${i===devicePage?'active':''}" onclick="devicePage=${i};renderDevicesTableOnly()">${i+1}</button>`
      ).join('')}
      <button class="pg-btn" ${devicePage>=totalPages-1?'disabled':''} onclick="devicePage++;renderDevicesTableOnly()">›</button>`;
  }
}

// ── DEVICE DETAIL ─────────────────────────────────────────────────────────────

async function renderDeviceDetail(deviceId) {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;
  let device;
  try { device = await api('GET', `/devices/${deviceId}`); } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Device not found</p></div>`; return;
  }

  document.getElementById('breadcrumb-page').textContent = device.hostname || 'Device';

  el.innerHTML = `
  <div class="detail-back" id="detail-back">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
    Back to Devices
  </div>
  <div class="detail-header">
    <h1>${esc(device.hostname||device.agent_id)}</h1>
    ${statusBadge(device.status)}
  </div>
  <div class="tabs" id="device-tabs">
    <button class="tab-btn active" data-tab="overview">Overview</button>
    <button class="tab-btn" data-tab="terminal">Live Terminal</button>
    <button class="tab-btn" data-tab="rdp">Remote Desktop</button>
    <button class="tab-btn" data-tab="curtain">Curtain</button>
    <button class="tab-btn" data-tab="software">Software</button>
    <button class="tab-btn" data-tab="patches">Patches</button>
    <button class="tab-btn" data-tab="history">Command History</button>
  </div>
  <div id="tab-content"></div>`;

  document.getElementById('detail-back').addEventListener('click', () => navigate('devices'));

  document.querySelectorAll('#device-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#device-tabs .tab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      loadDeviceTab(btn.dataset.tab, device);
    });
  });

  loadDeviceTab('overview', device);
}

async function loadDeviceTab(tab, device) {
  const el = document.getElementById('tab-content');
  el.innerHTML = '';
  if (tab === 'overview') renderOverviewTab(el, device);
  else if (tab === 'terminal') renderTerminalTab(el, device);
  else if (tab === 'rdp') renderRdpTab(el, device);
  else if (tab === 'curtain') renderCurtainTab(el, device);
  else if (tab === 'software') await renderSoftwareTab(el, device.id);
  else if (tab === 'patches') await renderPatchesTab(el, device.id);
  else if (tab === 'history') await renderHistoryTab(el, device.id);
}

function renderOverviewTab(el, device) {
  el.innerHTML = `
  <div class="overview-grid">
    <div class="card">
      <div class="card-title">Device Info</div>
      <div class="info-list">
        <div class="info-row"><span class="info-key">IP Address</span><span class="info-val">${esc(device.ip||'—')}</span></div>
        <div class="info-row"><span class="info-key">OS</span><span class="info-val">${esc(device.os||'—')}</span></div>
        <div class="info-row"><span class="info-key">Platform</span><span class="info-val">${esc(device.platform||'—')}</span></div>
        <div class="info-row"><span class="info-key">Logged User</span><span class="info-val">${esc(device.user||'—')}</span></div>
        <div class="info-row"><span class="info-key">Group</span><span class="info-val">${esc(device.group||'—')}</span></div>
        <div class="info-row"><span class="info-key">Agent Version</span><span class="info-val">${esc(device.version||'—')}</span></div>
        <div class="info-row"><span class="info-key">Last Seen</span><span class="info-val">${timeAgo(device.last_seen)}</span></div>
        <div class="info-row"><span class="info-key">Agent ID</span><span class="info-val mono" style="font-size:10px">${esc(device.agent_id)}</span></div>
      </div>
    </div>
    <div>
      <div class="metrics-grid">
        ${['cpu','memory','disk'].map(m => {
          const pct = Math.round(device[m+'_percent']||0);
          const c = progColor(pct);
          const colors = {green:'var(--success)',yellow:'var(--warning)',red:'var(--danger)'};
          return `<div class="metric-card">
            <div class="metric-label">${m.toUpperCase()}</div>
            <div class="metric-value" style="color:${colors[c]}">${pct}%</div>
            <div class="metric-bar"><div class="metric-bar-fill" style="width:${pct}%;background:${colors[c]}"></div></div>
            <svg class="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none">
              <polyline fill="none" stroke="${colors[c]}" stroke-width="1.5" points="${genSparkline(pct)}"/>
            </svg>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>

  <div class="card cmd-console">
    <div class="cmd-console-header">
      <span class="cmd-console-label">Command Console</span>
    </div>
    <div class="cmd-row">
      <select class="cmd-shell-select" id="cmd-shell">
        <option value="powershell">PowerShell</option>
        <option value="cmd">CMD</option>
        <option value="bash">Bash</option>
        <option value="python">Python</option>
      </select>
      <input class="cmd-input" id="cmd-input" placeholder="Enter command…"/>
      <button class="btn btn-primary btn-sm" id="cmd-run">Run</button>
    </div>
    <div class="cmd-output" id="cmd-output">Ready.</div>
  </div>`;

  const runBtn = document.getElementById('cmd-run');
  const cmdInput = document.getElementById('cmd-input');
  const cmdOutput = document.getElementById('cmd-output');
  const shellSel = document.getElementById('cmd-shell');

  async function runCmd() {
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    cmdOutput.textContent = 'Queuing…';
    try {
      const r = await api('POST', `/devices/${device.id}/command`, {shell: shellSel.value, command: cmd});
      cmdOutput.textContent = 'Command queued (id=' + r.id + '). Polling…';
      pollCmdResult(r.id, cmdOutput);
    } catch(e) { cmdOutput.textContent = 'Error: ' + e.message; }
  }

  runBtn.addEventListener('click', runCmd);
  cmdInput.addEventListener('keydown', e => { if (e.key === 'Enter') runCmd(); });
}

function genSparkline(pct) {
  // Generate fake sparkline points that end at pct
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const x = i * 10;
    const noise = (Math.sin(i * 2.3 + pct) + Math.sin(i * 1.1)) * 5;
    const y = 32 - Math.min(32, Math.max(2, (pct + noise) / 100 * 28));
    pts.push(x + ',' + y.toFixed(1));
  }
  return pts.join(' ');
}

async function pollCmdResult(cmdId, outputEl) {
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    if (attempts > 30) { clearInterval(interval); outputEl.textContent += '\n[Timeout waiting for result]'; return; }
    try {
      const c = await api('GET', `/commands/${cmdId}`);
      if (c.status !== 'queued') {
        clearInterval(interval);
        outputEl.textContent = c.output || '(no output)';
      }
    } catch(e) { clearInterval(interval); }
  }, 2000);
}

function renderTerminalTab(el, device) {
  el.innerHTML = `
  <div class="terminal-box">
    <div class="terminal-output" id="term-output">Connecting to ${esc(device.hostname)}…\n</div>
    <div class="terminal-input-row">
      <span class="terminal-prompt">PS ›</span>
      <input class="terminal-input" id="term-input" autocomplete="off" spellcheck="false" placeholder="Type command and press Enter"/>
    </div>
  </div>`;

  const output = document.getElementById('term-output');
  const input = document.getElementById('term-input');
  let ws = null;

  function appendOutput(text) {
    output.textContent += text;
    output.scrollTop = output.scrollHeight;
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/terminal/${device.id}?token=${encodeURIComponent(token)}`;
    ws = new WebSocket(url);
    ws.onopen = () => appendOutput('[Connected]\n');
    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output' || msg.type === 'result') appendOutput(msg.text || msg.output || '');
        else if (msg.type === 'error') appendOutput('[Error] ' + (msg.text||'') + '\n');
      } catch(_) { appendOutput(e.data); }
    };
    ws.onclose = () => appendOutput('[Disconnected]\n');
    ws.onerror = () => appendOutput('[WebSocket error]\n');
  }

  connectWs();

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const cmd = input.value;
      if (!cmd.trim()) return;
      appendOutput('PS > ' + cmd + '\n');
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({type:'terminal_input', text: cmd + '\n'}));
      } else {
        // Fallback: REST API
        api('POST', `/devices/${device.id}/command`, {shell:'powershell', command: cmd})
          .then(r => pollCmdResult(r.id, {set textContent(t){ appendOutput(t+'\n'); }} ))
          .catch(err => appendOutput('[Error] ' + err.message + '\n'));
      }
      input.value = '';
    }
  });

  // Clean up on navigate
  const origNavigate = window._termCleanup;
  window._termCleanup = () => { if (ws) ws.close(); };
}

function renderRdpTab(el, device) {
  el.innerHTML = `
  <div class="rdp-wrap">
    <div class="rdp-ctrl-bar">
      <div class="rdp-ctrl-group">
        <span class="rdp-ctrl-label">CONNECTED</span>
        <span class="rdp-timer" id="rdp-timer">00:00</span>
      </div>
      <div class="rdp-ctrl-sep ctrl-sep"></div>
      <div class="rdp-ctrl-group">
        <span class="rdp-ctrl-label">INPUT</span>
        <label class="rdp-toggle">
          <label class="toggle-sw"><input type="checkbox" id="rdp-input-toggle" checked><span class="toggle-slider"></span></label>
          <span style="font-size:11px;color:var(--muted)" id="rdp-input-label">My-control</span>
        </label>
      </div>
      <div class="ctrl-sep"></div>
      <div class="rdp-ctrl-group">
        <span class="rdp-ctrl-label">DISPLAY</span>
        <button class="rdp-btn ${rdpFitMode?'active':''}" id="rdp-fit-btn">Fit</button>
        <button class="rdp-btn" id="rdp-1x-btn">1:1</button>
      </div>
      <div class="ctrl-sep"></div>
      <div class="rdp-ctrl-group">
        <span class="rdp-ctrl-label">PRIVACY</span>
        <select class="rdp-select" id="rdp-curtain-sel">
          <option value="">Blank-dropdown</option>
          <option value="blank">Blank screen</option>
          <option value="lock">Lock</option>
          <option value="blanklok">Blank + Lock</option>
          <option value="unblank">Restore screen</option>
        </select>
        <button class="rdp-btn" id="rdp-lock-btn">Lock</button>
        <button class="rdp-btn" id="rdp-blanklok-btn">Blank+Lock</button>
        <label class="rdp-toggle">
          <label class="toggle-sw"><input type="checkbox" id="rdp-keepawake"><span class="toggle-slider"></span></label>
          <span style="font-size:11px;color:var(--muted)">Keep-awake</span>
        </label>
      </div>
      <div class="ctrl-sep"></div>
      <div class="rdp-ctrl-group">
        <span class="rdp-ctrl-label">KEYS</span>
        <button class="rdp-btn" id="rdp-cad-btn">Ctrl+Alt+Del</button>
      </div>
      <div class="ctrl-sep"></div>
      <button class="rdp-btn" id="rdp-fullscreen-btn">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        Full screen
      </button>
    </div>
    <div class="rdp-screen-wrap" id="rdp-screen-wrap">
      <div id="rdp-placeholder">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1" style="opacity:.3;margin-bottom:10px"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 20h8M12 18v2"/></svg>
        <p>Connecting to remote desktop…</p>
      </div>
      <img id="rdp-img" style="display:none" alt="Remote screen"/>
    </div>
  </div>`;

  startRdp(device);

  document.getElementById('rdp-input-toggle').addEventListener('change', e => {
    rdpInputEnabled = e.target.checked;
    document.getElementById('rdp-input-label').textContent = rdpInputEnabled ? 'My-control' : 'View only';
  });
  document.getElementById('rdp-fit-btn').addEventListener('click', () => {
    rdpFitMode = true;
    const img = document.getElementById('rdp-img');
    if (img) { img.style.maxWidth='100%'; img.style.maxHeight='100%'; img.style.width=''; img.style.height=''; }
  });
  document.getElementById('rdp-1x-btn').addEventListener('click', () => {
    rdpFitMode = false;
    const img = document.getElementById('rdp-img');
    if (img) { img.style.width = rdpRemoteW+'px'; img.style.height = rdpRemoteH+'px'; img.style.maxWidth='none'; img.style.maxHeight='none'; }
  });
  document.getElementById('rdp-fullscreen-btn').addEventListener('click', () => {
    const wrap = document.getElementById('rdp-screen-wrap');
    if (wrap) wrap.requestFullscreen?.();
  });
  document.getElementById('rdp-cad-btn').addEventListener('click', () => sendRdpMsg({type:'key', keys:['ctrl','alt','del']}));
  document.getElementById('rdp-lock-btn').addEventListener('click', () => sendRdpMsg({type:'curtain', action:'lock'}));
  document.getElementById('rdp-blanklok-btn').addEventListener('click', () => sendRdpMsg({type:'curtain', action:'blanklok'}));
  document.getElementById('rdp-curtain-sel').addEventListener('change', e => {
    if (e.target.value) sendRdpMsg({type:'curtain', action: e.target.value});
    e.target.value = '';
  });
  document.getElementById('rdp-keepawake').addEventListener('change', e => {
    sendRdpMsg({type:'keepawake', enabled: e.target.checked});
  });
  const screenWrap = document.getElementById('rdp-screen-wrap');

  function rdpImgCoords(e) {
    const img = document.getElementById('rdp-img');
    if (!img || img.style.display === 'none') return null;
    const r = img.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) * (rdpRemoteW / r.width)),
      y: Math.round((e.clientY - r.top)  * (rdpRemoteH / r.height)),
    };
  }

  screenWrap.addEventListener('click', e => {
    if (!rdpInputEnabled) return;
    const c = rdpImgCoords(e);
    if (!c) return;
    sendRdpMsg({type:'remote_input', event:'click', x:c.x, y:c.y, button:0});
  });
  screenWrap.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!rdpInputEnabled) return;
    const c = rdpImgCoords(e);
    if (!c) return;
    sendRdpMsg({type:'remote_input', event:'click', x:c.x, y:c.y, button:1});
  });

  let _rdpLastMove = 0;
  screenWrap.addEventListener('mousemove', e => {
    if (!rdpInputEnabled) return;
    const now = Date.now();
    if (now - _rdpLastMove < 40) return; // cap at ~25fps
    _rdpLastMove = now;
    const c = rdpImgCoords(e);
    if (!c) return;
    sendRdpMsg({type:'remote_input', event:'move', x:c.x, y:c.y});
  });
  screenWrap.addEventListener('wheel', e => {
    e.preventDefault();
    if (!rdpInputEnabled) return;
    sendRdpMsg({type:'remote_input', event:'scroll', dx: Math.round(-e.deltaX/3), dy: Math.round(-e.deltaY/3)});
  }, {passive: false});

  // Keyboard forwarding — only when RDP screen is focused
  screenWrap.setAttribute('tabindex', '0');
  screenWrap.addEventListener('keydown', e => {
    if (!rdpInputEnabled) return;
    // Don't swallow browser-critical combos
    if ((e.ctrlKey && e.key === 'w') || (e.ctrlKey && e.key === 't') || e.key === 'F12') return;
    e.preventDefault();
    sendRdpMsg({type:'remote_input', event:'key', key: e.key});
  });
}

function startRdp(device) {
  closeRdp();
  rdpSeconds = 0;
  rdpTimerInterval = setInterval(() => {
    rdpSeconds++;
    const m = String(Math.floor(rdpSeconds/60)).padStart(2,'0');
    const s = String(rdpSeconds%60).padStart(2,'0');
    const t = document.getElementById('rdp-timer');
    if (t) t.textContent = m+':'+s;
  }, 1000);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/terminal/${device.id}?token=${encodeURIComponent(token)}`;
  rdpWs = new WebSocket(url);

  rdpWs.onopen = () => {
    rdpWs.send(JSON.stringify({type:'remote_start'}));
  };
  rdpWs.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'frame') {
        const img = document.getElementById('rdp-img');
        const ph = document.getElementById('rdp-placeholder');
        if (img) {
          // agent sends raw base64; prefix it for the data URL
          img.src = 'data:image/jpeg;base64,' + msg.data;
          img.style.display = 'block';
          if (ph) ph.style.display = 'none';
          if (msg.w) rdpRemoteW = msg.w;
          if (msg.h) rdpRemoteH = msg.h;
        }
      }
    } catch(_) {}
  };
  rdpWs.onclose = () => {};
  rdpWs.onerror = () => {};
}

function closeRdp() {
  clearInterval(rdpTimerInterval);
  rdpTimerInterval = null;
  if (rdpWs) { try { rdpWs.close(); } catch(_) {} rdpWs = null; }
}

function sendRdpMsg(msg) {
  if (rdpWs && rdpWs.readyState === WebSocket.OPEN) rdpWs.send(JSON.stringify(msg));
}

function renderCurtainTab(el, device) {
  el.innerHTML = `
  <div style="display:flex;flex-direction:column;gap:16px;max-width:640px">

    <div class="card">
      <div class="card-title">Screen Overlay (tkinter)</div>
      <p style="font-size:12px;color:var(--muted);margin-bottom:12px">Fullscreen overlays — covers the agent's screen, blocks user interaction</p>
      <div class="curtain-grid" id="curtain-grid">
        <button class="curtain-tile" data-action="black">
          <div class="curtain-tile-preview" style="background:#000"></div>
          <span>Black Screen</span>
        </button>
        <button class="curtain-tile" data-action="update">
          <div class="curtain-tile-preview" style="background:#1a1a1a;display:flex;align-items:center;justify-content:center">
            <span style="color:#fff;font-size:9px;text-align:center;line-height:1.4">Working<br>on updates</span>
          </div>
          <span>Fake Update</span>
        </button>
        <button class="curtain-tile" data-action="config">
          <div class="curtain-tile-preview" style="background:#1a1a1a;display:flex;align-items:center;justify-content:center">
            <span style="color:#ccc;font-size:9px;text-align:center;line-height:1.4">Configuring<br>Updates</span>
          </div>
          <span>Config Update</span>
        </button>
        <button class="curtain-tile" data-action="bsod">
          <div class="curtain-tile-preview" style="background:#0078D7;display:flex;align-items:flex-start;padding:4px">
            <span style="color:#fff;font-size:18px;line-height:1">:(</span>
          </div>
          <span>Fake BSOD</span>
        </button>
        <button class="curtain-tile curtain-tile-remove" data-action="remove">
          <div class="curtain-tile-preview" style="background:var(--elevated);display:flex;align-items:center;justify-content:center">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </div>
          <span>Remove Overlay</span>
        </button>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <input class="form-control" id="curtain-custom-path" placeholder="Custom image path on agent (e.g. C:\\img.jpg)" style="flex:1"/>
        <button class="btn btn-secondary btn-sm" id="curtain-custom-btn">Custom Image</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Session Control</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" id="curtain-lock-btn">Lock Workstation</button>
        <button class="btn btn-secondary btn-sm" id="curtain-blanklok-btn">Blank + Lock</button>
        <button class="btn btn-danger btn-sm" id="curtain-logoff-btn">Log Off User</button>
      </div>
    </div>

    <div class="cmd-output hidden" id="curtain-out"></div>
  </div>`;

  const out = document.getElementById('curtain-out');

  async function sendCurtainCmd(shell, command) {
    out.classList.remove('hidden');
    out.textContent = 'Sending…';
    try {
      const r = await api('POST', `/devices/${device.id}/command`, {shell, command});
      out.textContent = 'Queued (cmd #' + r.id + '). Polling…';
      pollCmdResult(r.id, out);
    } catch(e) { out.textContent = 'Error: ' + e.message; }
  }

  // Overlay tiles
  document.getElementById('curtain-grid').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    sendCurtainCmd('curtain', btn.dataset.action);
  });

  // Custom image
  document.getElementById('curtain-custom-btn').addEventListener('click', () => {
    const p = document.getElementById('curtain-custom-path').value.trim();
    if (!p) { out.classList.remove('hidden'); out.textContent = 'Enter a path first'; return; }
    sendCurtainCmd('curtain', 'custom:' + p);
  });

  // Session control buttons
  document.getElementById('curtain-lock-btn').addEventListener('click', () =>
    sendCurtainCmd('powershell', 'rundll32 user32.dll,LockWorkStation'));
  document.getElementById('curtain-blanklok-btn').addEventListener('click', async () => {
    await sendCurtainCmd('curtain', 'black');
    await sendCurtainCmd('powershell', 'rundll32 user32.dll,LockWorkStation');
  });
  document.getElementById('curtain-logoff-btn').addEventListener('click', () =>
    sendCurtainCmd('powershell', 'logoff'));
}

async function renderSoftwareTab(el, deviceId) {
  el.innerHTML = `<div class="empty-state"><p>Loading software…</p></div>`;
  try {
    const rows = await api('GET', `/devices/${deviceId}/software`);
    if (!rows.length) { el.innerHTML = `<div class="empty-state"><p>No software inventory. Agent must report inventory.</p></div>`; return; }
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>NAME</th><th>VERSION</th><th>PUBLISHER</th><th>INSTALLED</th><th>SOURCE</th></tr></thead>
      <tbody>${rows.map(s=>`<tr><td>${esc(s.name)}</td><td class="mono">${esc(s.version)}</td><td>${esc(s.publisher)}</td><td>${esc(s.install_date)}</td><td>${esc(s.source)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  } catch(e) { el.innerHTML = `<div class="empty-state"><p>Failed to load software</p></div>`; }
}

async function renderPatchesTab(el, deviceId) {
  el.innerHTML = `<div class="empty-state"><p>Loading patches…</p></div>`;
  try {
    const rows = await api('GET', `/devices/${deviceId}/patches`);
    if (!rows.length) { el.innerHTML = `<div class="empty-state"><p>No patch inventory.</p></div>`; return; }
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>HOTFIX ID</th><th>DESCRIPTION</th><th>INSTALLED ON</th><th>INSTALLED BY</th></tr></thead>
      <tbody>${rows.map(p=>`<tr><td class="mono">${esc(p.hotfix_id)}</td><td>${esc(p.description)}</td><td>${esc(p.installed_on)}</td><td>${esc(p.installed_by)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  } catch(e) { el.innerHTML = `<div class="empty-state"><p>Failed to load patches</p></div>`; }
}

async function renderHistoryTab(el, deviceId) {
  el.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;
  try {
    const rows = await api('GET', `/devices/${deviceId}/commands`);
    if (!rows.length) { el.innerHTML = `<div class="empty-state"><p>No command history</p></div>`; return; }
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>SHELL</th><th>COMMAND</th><th>STATUS</th><th>EXIT</th><th>OUTPUT</th><th>CREATED</th><th>COMPLETED</th></tr></thead>
      <tbody>${rows.map(c=>`<tr>
        <td class="mono">${c.id}</td>
        <td><span class="os-chip">${esc(c.shell)}</span></td>
        <td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.command)}">${esc(c.command)}</td>
        <td>${c.status==='done'?'<span class="badge badge-online">done</span>':c.status==='queued'?'<span class="badge badge-info">queued</span>':'<span class="badge badge-offline">'+esc(c.status)+'</span>'}</td>
        <td class="mono">${c.exit_code??'—'}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-family:monospace" title="${esc(c.output||'')}">${esc((c.output||'').slice(0,80))}</td>
        <td style="white-space:nowrap;font-size:11px">${timeAgo(c.created_at)}</td>
        <td style="white-space:nowrap;font-size:11px">${c.completed_at?timeAgo(c.completed_at):'—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  } catch(e) { el.innerHTML = `<div class="empty-state"><p>Failed to load history</p></div>`; }
}

// ── ALERTS ────────────────────────────────────────────────────────────────────

async function renderAlerts() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;
  let alerts;
  try { alerts = await api('GET', '/alerts?dismissed=0'); } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Failed to load alerts</p></div>`; return;
  }
  if (!alerts.length) {
    el.innerHTML = `<div class="page-header"><div class="page-header-left"><h1>Alerts</h1></div></div><div class="empty-state"><p>No active alerts</p></div>`;
    return;
  }
  el.innerHTML = `
  <div class="page-header">
    <div class="page-header-left"><h1>Alerts</h1><p><span class="live-dot"></span> ${alerts.length} active alert${alerts.length!==1?'s':''}</p></div>
    <div class="page-header-right">
      <button class="btn btn-secondary btn-sm" id="dismiss-all-btn">Dismiss All</button>
    </div>
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>SEVERITY</th><th>DEVICE</th><th>CATEGORY</th><th>MESSAGE</th><th>CREATED</th><th>ACTION</th></tr></thead>
    <tbody id="alerts-tbody">
      ${alerts.map(a=>`<tr>
        <td><span class="badge badge-${a.severity==='critical'?'critical':'warning'}">${esc(a.severity)}</span></td>
        <td><a style="color:var(--accent);cursor:pointer" class="alert-dev-link" data-id="${a.device_id}">${esc(a.device_hostname||'—')}</a></td>
        <td><span class="os-chip">${esc(a.category)}</span></td>
        <td>${esc(a.message)}</td>
        <td style="white-space:nowrap;font-size:11px">${timeAgo(a.created_at)}</td>
        <td><button class="btn btn-secondary btn-sm dismiss-btn" data-id="${a.id}">Dismiss</button></td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;

  el.querySelectorAll('.dismiss-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await api('POST', `/alerts/${btn.dataset.id}/dismiss`); toast('Alert dismissed','success'); renderAlerts(); } catch(e) { toast(e.message,'error'); }
    });
  });
  el.querySelectorAll('.alert-dev-link').forEach(link => {
    link.addEventListener('click', () => navigate('device-detail', +link.dataset.id));
  });
  document.getElementById('dismiss-all-btn').addEventListener('click', async () => {
    for (const a of alerts) { try { await api('POST', `/alerts/${a.id}/dismiss`); } catch(e) {} }
    toast('All alerts dismissed','success'); renderAlerts();
  });

  pollTimer = setInterval(renderAlerts, 10000);
}

// ── SOFTWARE PAGE ─────────────────────────────────────────────────────────────

async function renderSoftwarePage() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="page-header"><div class="page-header-left"><h1>Software</h1><p>Aggregated software inventory across all devices</p></div></div><div class="empty-state"><p>Select a device to view software</p></div>`;
  // Load all devices and show a dropdown
  try {
    const devs = await api('GET', '/devices?limit=200');
    el.innerHTML = `
    <div class="page-header"><div class="page-header-left"><h1>Software</h1></div></div>
    <div class="card" style="margin-bottom:16px;display:flex;align-items:center;gap:10px">
      <label style="color:var(--muted);font-size:12px">Device:</label>
      <select class="filter-select" id="sw-dev-select" style="width:280px">
        <option value="">— Select a device —</option>
        ${(devs.items||[]).map(d=>`<option value="${d.id}">${esc(d.hostname)} (${esc(d.status)})</option>`).join('')}
      </select>
    </div>
    <div id="sw-table-area"></div>`;
    document.getElementById('sw-dev-select').addEventListener('change', async e => {
      const id = e.target.value;
      if (!id) return;
      await renderSoftwareTab(document.getElementById('sw-table-area'), id);
    });
  } catch(err) {}
}

// ── PATCHES PAGE ──────────────────────────────────────────────────────────────

async function renderPatchesPage() {
  const el = document.getElementById('page-content');
  try {
    const devs = await api('GET', '/devices?limit=200');
    el.innerHTML = `
    <div class="page-header"><div class="page-header-left"><h1>Patches</h1></div></div>
    <div class="card" style="margin-bottom:16px;display:flex;align-items:center;gap:10px">
      <label style="color:var(--muted);font-size:12px">Device:</label>
      <select class="filter-select" id="patch-dev-select" style="width:280px">
        <option value="">— Select a device —</option>
        ${(devs.items||[]).map(d=>`<option value="${d.id}">${esc(d.hostname)} (${esc(d.status)})</option>`).join('')}
      </select>
    </div>
    <div id="patch-table-area"></div>`;
    document.getElementById('patch-dev-select').addEventListener('change', async e => {
      const id = e.target.value;
      if (!id) return;
      await renderPatchesTab(document.getElementById('patch-table-area'), id);
    });
  } catch(err) {}
}

// ── SCRIPTS ───────────────────────────────────────────────────────────────────

let editingScriptId = null;

async function renderScripts() {
  const el = document.getElementById('page-content');
  let scripts, devices;
  try {
    [scripts, devices] = await Promise.all([api('GET','/scripts'), api('GET','/devices?limit=200')]);
  } catch(e) { el.innerHTML=`<div class="empty-state"><p>Failed</p></div>`; return; }

  const devList = devices.items || [];

  el.innerHTML = `
  <div class="page-header">
    <div class="page-header-left"><h1>Scripts</h1></div>
    <div class="page-header-right">
      <button class="btn btn-primary btn-sm" id="new-script-btn">+ New Script</button>
    </div>
  </div>

  <div class="inline-form hidden" id="script-form">
    <h3 id="script-form-title">New Script</h3>
    <div class="form-grid-2">
      <div class="form-row">
        <label>Name</label>
        <input class="form-control" id="sc-name" placeholder="My Script"/>
      </div>
      <div class="form-row">
        <label>Language</label>
        <select class="form-control" id="sc-lang">
          <option value="powershell">PowerShell</option>
          <option value="cmd">CMD</option>
          <option value="bash">Bash</option>
          <option value="python">Python</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <label>Description</label>
      <input class="form-control" id="sc-desc" placeholder="Optional description"/>
    </div>
    <div class="form-row">
      <label>Code</label>
      <textarea class="form-control" id="sc-code" style="min-height:150px" placeholder="# Your script here"></textarea>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="sc-cancel">Cancel</button>
      <button class="btn btn-primary" id="sc-save">Save Script</button>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr><th>NAME</th><th>LANGUAGE</th><th>DESCRIPTION</th><th>CREATED</th><th>ACTIONS</th></tr></thead>
      <tbody id="scripts-tbody">
        ${scripts.length ? scripts.map(s=>`<tr>
          <td style="font-weight:600">${esc(s.name)}</td>
          <td><span class="os-chip">${esc(s.language)}</span></td>
          <td>${esc(s.description||'—')}</td>
          <td style="font-size:11px">${timeAgo(s.created_at)}</td>
          <td class="actions-cell">
            <button class="btn btn-secondary btn-sm sc-run-btn" data-id="${s.id}" data-name="${esc(s.name)}">Run</button>
            <button class="btn btn-secondary btn-sm sc-edit-btn" data-id="${s.id}">Edit</button>
            <button class="btn btn-danger btn-sm sc-del-btn" data-id="${s.id}">Delete</button>
          </td>
        </tr>`).join('') : '<tr><td colspan="5"><div class="empty-state"><p>No scripts</p></div></td></tr>'}
      </tbody>
    </table>
  </div>

  <div class="inline-form hidden" id="run-script-form" style="margin-top:16px">
    <h3 id="run-script-title">Run Script</h3>
    <div class="form-row">
      <label>Target Device</label>
      <select class="form-control" id="run-script-dev">
        <option value="">— All online devices —</option>
        ${devList.filter(d=>d.status==='online').map(d=>`<option value="${d.id}">${esc(d.hostname)}</option>`).join('')}
      </select>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="run-sc-cancel">Cancel</button>
      <button class="btn btn-success" id="run-sc-go">Run Now</button>
    </div>
    <div class="cmd-output hidden" id="run-sc-out"></div>
  </div>`;

  let runScriptId = null;
  document.getElementById('new-script-btn').addEventListener('click', () => {
    editingScriptId = null;
    document.getElementById('script-form-title').textContent = 'New Script';
    document.getElementById('sc-name').value = '';
    document.getElementById('sc-lang').value = 'powershell';
    document.getElementById('sc-desc').value = '';
    document.getElementById('sc-code').value = '';
    document.getElementById('script-form').classList.remove('hidden');
  });
  document.getElementById('sc-cancel').addEventListener('click', () => document.getElementById('script-form').classList.add('hidden'));
  document.getElementById('sc-save').addEventListener('click', async () => {
    const payload = {
      name: document.getElementById('sc-name').value.trim(),
      language: document.getElementById('sc-lang').value,
      description: document.getElementById('sc-desc').value.trim(),
      code: document.getElementById('sc-code').value
    };
    if (!payload.name || !payload.code) { toast('Name and code required','error'); return; }
    try {
      if (editingScriptId) await api('PUT', `/scripts/${editingScriptId}`, payload);
      else await api('POST', '/scripts', payload);
      toast('Script saved','success'); renderScripts();
    } catch(e) { toast(e.message,'error'); }
  });
  document.getElementById('run-sc-cancel').addEventListener('click', () => document.getElementById('run-script-form').classList.add('hidden'));
  document.getElementById('run-sc-go').addEventListener('click', async () => {
    const devId = document.getElementById('run-script-dev').value;
    const out = document.getElementById('run-sc-out');
    out.classList.remove('hidden');
    out.textContent = 'Running…';
    try {
      if (devId) {
        const r = await api('POST', `/devices/${devId}/run-script/${runScriptId}`);
        out.textContent = 'Queued (id='+r.id+'). ';
        pollCmdResult(r.id, out);
      } else {
        const online = devList.filter(d=>d.status==='online');
        for (const d of online) { await api('POST', `/devices/${d.id}/run-script/${runScriptId}`); }
        out.textContent = `Sent to ${online.length} device(s)`;
      }
      toast('Script dispatched','success');
    } catch(e) { out.textContent = 'Error: '+e.message; toast(e.message,'error'); }
  });

  el.querySelectorAll('.sc-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this script?')) return;
      try { await api('DELETE', `/scripts/${btn.dataset.id}`); toast('Deleted','success'); renderScripts(); } catch(e) { toast(e.message,'error'); }
    });
  });
  el.querySelectorAll('.sc-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = scripts.find(x=>x.id==btn.dataset.id);
      if (!s) return;
      editingScriptId = s.id;
      document.getElementById('script-form-title').textContent = 'Edit Script';
      document.getElementById('sc-name').value = s.name;
      document.getElementById('sc-lang').value = s.language;
      document.getElementById('sc-desc').value = s.description||'';
      document.getElementById('sc-code').value = '';
      document.getElementById('script-form').classList.remove('hidden');
      // Fetch full code
      api('GET',`/scripts`).then(all => {
        const full = all.find(x=>x.id==s.id);
        // code not returned from list, just leave blank for user to re-enter
      });
    });
  });
  el.querySelectorAll('.sc-run-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      runScriptId = btn.dataset.id;
      document.getElementById('run-script-title').textContent = 'Run: ' + btn.dataset.name;
      document.getElementById('run-sc-out').classList.add('hidden');
      document.getElementById('run-script-form').classList.remove('hidden');
    });
  });
}

// ── AUTOMATIONS ───────────────────────────────────────────────────────────────

async function renderAutomations() {
  const el = document.getElementById('page-content');
  let automations, scripts;
  try {
    [automations, scripts] = await Promise.all([api('GET','/automations'), api('GET','/scripts')]);
  } catch(e) { el.innerHTML=`<div class="empty-state"><p>Failed</p></div>`; return; }

  el.innerHTML = `
  <div class="page-header">
    <div class="page-header-left"><h1>Automations</h1></div>
    <div class="page-header-right">
      <button class="btn btn-primary btn-sm" id="new-auto-btn">+ New Automation</button>
    </div>
  </div>

  <div class="inline-form hidden" id="auto-form">
    <h3>New Automation</h3>
    <div class="form-grid-2">
      <div class="form-row">
        <label>Name</label>
        <input class="form-control" id="auto-name" placeholder="Daily Reboot"/>
      </div>
      <div class="form-row">
        <label>Cron Schedule</label>
        <input class="form-control" id="auto-sched" placeholder="0 3 * * *"/>
      </div>
    </div>
    <div class="form-grid-2">
      <div class="form-row">
        <label>Script</label>
        <select class="form-control" id="auto-script">
          <option value="">— Select script —</option>
          ${scripts.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label>Target Group</label>
        <input class="form-control" id="auto-group" value="default" placeholder="default"/>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="auto-cancel">Cancel</button>
      <button class="btn btn-primary" id="auto-save">Save</button>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr><th>NAME</th><th>SCHEDULE</th><th>SCRIPT</th><th>TARGET GROUP</th><th>STATUS</th><th>ACTIONS</th></tr></thead>
      <tbody>
        ${automations.length ? automations.map(a => {
          const sname = scripts.find(s=>s.id===a.script_id)?.name || 'Unknown';
          return `<tr>
            <td style="font-weight:600">${esc(a.name)}</td>
            <td class="mono">${esc(a.schedule)}</td>
            <td>${esc(sname)}</td>
            <td>${esc(a.target_group||'all')}</td>
            <td><span class="badge ${a.enabled?'badge-online':'badge-offline'}">${a.enabled?'enabled':'disabled'}</span></td>
            <td><button class="btn btn-danger btn-sm auto-del-btn" data-id="${a.id}">Delete</button></td>
          </tr>`;
        }).join('') : '<tr><td colspan="6"><div class="empty-state"><p>No automations</p></div></td></tr>'}
      </tbody>
    </table>
  </div>`;

  document.getElementById('new-auto-btn').addEventListener('click', () => document.getElementById('auto-form').classList.remove('hidden'));
  document.getElementById('auto-cancel').addEventListener('click', () => document.getElementById('auto-form').classList.add('hidden'));
  document.getElementById('auto-save').addEventListener('click', async () => {
    const payload = {
      name: document.getElementById('auto-name').value.trim(),
      schedule: document.getElementById('auto-sched').value.trim(),
      script_id: parseInt(document.getElementById('auto-script').value),
      target_group: document.getElementById('auto-group').value.trim() || 'default',
      enabled: true
    };
    if (!payload.name || !payload.schedule || !payload.script_id) { toast('All fields required','error'); return; }
    try { await api('POST', '/automations', payload); toast('Automation created','success'); renderAutomations(); } catch(e) { toast(e.message,'error'); }
  });
  el.querySelectorAll('.auto-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete automation?')) return;
      try { await api('DELETE', `/automations/${btn.dataset.id}`); toast('Deleted','success'); renderAutomations(); } catch(e) { toast(e.message,'error'); }
    });
  });
}

// ── TOOLBOX ───────────────────────────────────────────────────────────────────

async function renderToolbox() {
  const el = document.getElementById('page-content');
  let devices;
  try { devices = await api('GET', '/devices?limit=200'); } catch(e) { devices = {items:[]}; }
  const online = (devices.items||[]).filter(d=>d.status==='online');

  el.innerHTML = `
  <div class="page-header"><div class="page-header-left"><h1>Toolbox</h1><p>Run ad-hoc commands across devices</p></div></div>

  <div class="inline-form">
    <h3>Bulk Command</h3>
    <div class="form-row">
      <label>Target</label>
      <select class="form-control" id="tool-target">
        <option value="all">All Online Devices (${online.length})</option>
        ${online.map(d=>`<option value="${d.id}">${esc(d.hostname)}</option>`).join('')}
      </select>
    </div>
    <div class="form-grid-2">
      <div class="form-row">
        <label>Shell</label>
        <select class="form-control" id="tool-shell">
          <option value="powershell">PowerShell</option>
          <option value="cmd">CMD</option>
          <option value="bash">Bash</option>
          <option value="python">Python</option>
        </select>
      </div>
      <div class="form-row">
        <label>&nbsp;</label>
        <button class="btn btn-primary" id="tool-run">Run Command</button>
      </div>
    </div>
    <div class="form-row">
      <label>Command</label>
      <textarea class="form-control" id="tool-cmd" placeholder="Get-ComputerInfo | Select-Object CsName,OsName"></textarea>
    </div>
    <div class="cmd-output hidden" id="tool-out"></div>
  </div>

  <div class="inline-form" style="margin-top:16px">
    <h3>Quick Actions</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-secondary" data-quick="restart">Restart Device</button>
      <button class="btn btn-secondary" data-quick="info">System Info</button>
      <button class="btn btn-secondary" data-quick="netstat">Network Status</button>
      <button class="btn btn-secondary" data-quick="processes">Running Processes</button>
      <button class="btn btn-secondary" data-quick="disk">Disk Usage</button>
      <button class="btn btn-secondary" data-quick="updates">Check Updates</button>
    </div>
  </div>`;

  const quickCmds = {
    restart: 'Restart-Computer -Force',
    info: 'Get-ComputerInfo | Select-Object CsName,OsName,OsArchitecture,TotalPhysicalMemory',
    netstat: 'netstat -an | Select-Object -First 30',
    processes: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name,CPU,WorkingSet',
    disk: 'Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free',
    updates: 'Get-WindowsUpdate -MicrosoftUpdate -AcceptAll -IgnoreReboot 2>&1'
  };

  el.querySelectorAll('[data-quick]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('tool-cmd').value = quickCmds[btn.dataset.quick] || '';
    });
  });

  document.getElementById('tool-run').addEventListener('click', async () => {
    const cmd = document.getElementById('tool-cmd').value.trim();
    const shell = document.getElementById('tool-shell').value;
    const target = document.getElementById('tool-target').value;
    const out = document.getElementById('tool-out');
    if (!cmd) { toast('Enter a command','error'); return; }
    out.classList.remove('hidden');
    out.textContent = 'Sending…';
    try {
      if (target === 'all') {
        let sent = 0;
        for (const d of online) { await api('POST', `/devices/${d.id}/command`, {shell, command: cmd}); sent++; }
        out.textContent = `Sent to ${sent} device(s). Results will appear in Command History per device.`;
      } else {
        const r = await api('POST', `/devices/${target}/command`, {shell, command: cmd});
        out.textContent = 'Queued. Waiting for result…';
        pollCmdResult(r.id, out);
      }
    } catch(e) { out.textContent = 'Error: '+e.message; }
  });
}

// ── REPORTS ───────────────────────────────────────────────────────────────────

async function renderReports() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="empty-state"><p>Loading report…</p></div>`;
  let data;
  try { data = await api('GET', '/reports/summary'); } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Failed to load report</p></div>`; return;
  }
  el.innerHTML = `
  <div class="page-header"><div class="page-header-left"><h1>Reports</h1><p>Fleet summary report</p></div></div>

  <div class="stats-grid" style="margin-bottom:20px">
    <div class="stat-card"><div class="stat-body"><div class="stat-value">${data.total_devices}</div><div class="stat-label">Total Devices</div></div></div>
    <div class="stat-card"><div class="stat-body"><div class="stat-value text-success">${data.online}</div><div class="stat-label">Online</div></div></div>
    <div class="stat-card"><div class="stat-body"><div class="stat-value text-danger">${data.offline}</div><div class="stat-label">Offline</div></div></div>
    <div class="stat-card"><div class="stat-body"><div class="stat-value text-warning">${data.needs_attention}</div><div class="stat-label">Needs Attention</div></div></div>
    <div class="stat-card"><div class="stat-body"><div class="stat-value text-danger">${data.open_alerts}</div><div class="stat-label">Open Alerts</div></div></div>
  </div>

  <div class="charts-row">
    <div class="chart-card">
      <div class="card-title">By Platform</div>
      <div class="bar-chart-inner">
        ${Object.entries(data.by_platform||{}).map(([p,v])=>`
          <div class="bar-row">
            <div class="bar-label">${esc(p)}</div>
            <div class="bar-track"><div class="bar-fill" style="background:var(--accent);width:${Math.min(100,(v.total/(data.total_devices||1))*100)}%"></div></div>
            <div class="bar-count">${v.total}</div>
          </div>`).join('')||'<div class="text-muted">No data</div>'}
      </div>
    </div>
    <div class="chart-card">
      <div class="card-title">Recent Activity</div>
      <div class="table-wrap" style="margin-top:0;border:none">
        <table>
          <thead><tr><th>TIME</th><th>USER</th><th>ACTION</th><th>DETAIL</th></tr></thead>
          <tbody>
            ${(data.recent_audit||[]).map(a=>`<tr>
              <td style="font-size:11px;white-space:nowrap">${timeAgo(a.time)}</td>
              <td>${esc(a.user)}</td>
              <td><span class="os-chip">${esc(a.action)}</span></td>
              <td style="font-size:11px">${esc(a.detail)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

// ── AUDIT ─────────────────────────────────────────────────────────────────────

async function renderAudit() {
  const el = document.getElementById('page-content');
  el.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;
  let rows;
  try { rows = await api('GET', '/audit'); } catch(e) {
    el.innerHTML = `<div class="empty-state"><p>Failed</p></div>`; return;
  }
  el.innerHTML = `
  <div class="page-header"><div class="page-header-left"><h1>Audit Log</h1></div></div>
  <div class="table-wrap"><table>
    <thead><tr><th>TIME</th><th>USER</th><th>ACTION</th><th>DETAIL</th></tr></thead>
    <tbody>
      ${rows.length ? rows.map(a=>`<tr>
        <td style="font-size:11px;white-space:nowrap">${fmtDate(a.created_at)}</td>
        <td style="font-weight:600">${esc(a.username)}</td>
        <td><span class="os-chip">${esc(a.action)}</span></td>
        <td style="font-size:12px">${esc(a.detail)}</td>
      </tr>`).join('') : '<tr><td colspan="4"><div class="empty-state"><p>No audit records</p></div></td></tr>'}
    </tbody>
  </table></div>`;

  pollTimer = setInterval(renderAudit, 30000);
}

// ── USERS ─────────────────────────────────────────────────────────────────────

async function renderUsers() {
  const el = document.getElementById('page-content');
  let users;
  try { users = await api('GET', '/auth/users'); } catch(e) {
    el.innerHTML=`<div class="empty-state"><p>Access denied or failed</p></div>`; return;
  }
  el.innerHTML = `
  <div class="page-header">
    <div class="page-header-left"><h1>Users</h1></div>
    <div class="page-header-right">
      <button class="btn btn-primary btn-sm" id="new-user-btn">+ New User</button>
    </div>
  </div>

  <div class="inline-form hidden" id="user-form">
    <h3>Create User</h3>
    <div class="form-grid-2">
      <div class="form-row">
        <label>Username</label>
        <input class="form-control" id="u-name" placeholder="operator2"/>
      </div>
      <div class="form-row">
        <label>Password</label>
        <input class="form-control" type="password" id="u-pass" placeholder="••••••••"/>
      </div>
    </div>
    <div class="form-grid-2">
      <div class="form-row">
        <label>Email</label>
        <input class="form-control" id="u-email" placeholder="user@example.com"/>
      </div>
      <div class="form-row">
        <label>Role</label>
        <select class="form-control" id="u-admin">
          <option value="0">Operator</option>
          <option value="1">Admin</option>
        </select>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="u-cancel">Cancel</button>
      <button class="btn btn-primary" id="u-save">Create User</button>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr><th>USERNAME</th><th>EMAIL</th><th>ROLE</th><th>ACTIONS</th></tr></thead>
      <tbody>
        ${users.map(u=>`<tr>
          <td style="font-weight:600">${esc(u.username)}</td>
          <td>${esc(u.email||'—')}</td>
          <td><span class="badge ${u.is_admin?'badge-warning':'badge-info'}">${u.is_admin?'admin':'operator'}</span></td>
          <td>${u.username !== currentUser?.username ? `<button class="btn btn-danger btn-sm user-del-btn" data-id="${u.id}" data-name="${esc(u.username)}">Delete</button>` : '<span class="text-muted" style="font-size:11px">current</span>'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;

  document.getElementById('new-user-btn').addEventListener('click', () => document.getElementById('user-form').classList.remove('hidden'));
  document.getElementById('u-cancel').addEventListener('click', () => document.getElementById('user-form').classList.add('hidden'));
  document.getElementById('u-save').addEventListener('click', async () => {
    const payload = {
      username: document.getElementById('u-name').value.trim(),
      password: document.getElementById('u-pass').value,
      email: document.getElementById('u-email').value.trim() || null,
      is_admin: document.getElementById('u-admin').value === '1'
    };
    if (!payload.username || !payload.password) { toast('Username and password required','error'); return; }
    try { await api('POST', '/auth/users', payload); toast('User created','success'); renderUsers(); } catch(e) { toast(e.message,'error'); }
  });
  el.querySelectorAll('.user-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete user "${btn.dataset.name}"?`)) return;
      try { await api('DELETE', `/auth/users/${btn.dataset.id}`); toast('User deleted','success'); renderUsers(); } catch(e) { toast(e.message,'error'); }
    });
  });
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────

async function renderSettings() {
  const el = document.getElementById('page-content');
  let s;
  try { s = await api('GET', '/settings'); } catch(e) { el.innerHTML=`<div class="empty-state"><p>Failed</p></div>`; return; }

  el.innerHTML = `
  <div class="page-header"><div class="page-header-left"><h1>Settings</h1></div></div>

  <div class="card" style="max-width:600px;margin-bottom:16px">
    <div class="card-title">Alert Thresholds</div>
    <div class="form-grid-2">
      <div class="form-row">
        <label>CPU Threshold (%)</label>
        <input class="form-control" type="number" id="thr-cpu" value="${esc(s.threshold_cpu)}" min="1" max="100"/>
      </div>
      <div class="form-row">
        <label>Memory Threshold (%)</label>
        <input class="form-control" type="number" id="thr-mem" value="${esc(s.threshold_memory)}" min="1" max="100"/>
      </div>
      <div class="form-row">
        <label>Disk Threshold (%)</label>
        <input class="form-control" type="number" id="thr-disk" value="${esc(s.threshold_disk)}" min="1" max="100"/>
      </div>
      <div class="form-row">
        <label>Server URL</label>
        <input class="form-control" id="srv-url" value="${esc(s.server_url||window.location.origin)}"/>
      </div>
    </div>
    <div class="form-actions" style="justify-content:flex-start;margin-top:4px">
      <button class="btn btn-primary" id="save-settings">Save Settings</button>
    </div>
  </div>

  <div class="card" style="max-width:600px">
    <div class="card-title">Agent Token</div>
    <div class="code-block" style="position:relative">
      <pre id="agent-token-text">${esc(s.agent_token)}</pre>
      <button class="copy-btn" id="copy-token-btn">Copy</button>
    </div>
    <p style="margin-top:10px;color:var(--muted);font-size:12px">This token is required for agents to authenticate. Keep it secret.</p>
  </div>`;

  document.getElementById('save-settings').addEventListener('click', async () => {
    const payload = {
      threshold_cpu: parseFloat(document.getElementById('thr-cpu').value),
      threshold_memory: parseFloat(document.getElementById('thr-mem').value),
      threshold_disk: parseFloat(document.getElementById('thr-disk').value),
      server_url: document.getElementById('srv-url').value.trim()
    };
    try { await api('PUT', '/settings', payload); toast('Settings saved','success'); serverUrl = payload.server_url; } catch(e) { toast(e.message,'error'); }
  });
  document.getElementById('copy-token-btn').addEventListener('click', function() {
    copyText(s.agent_token, this);
  });
}

// ── INIT ──────────────────────────────────────────────────────────────────────

if (token) {
  bootApp();
} else {
  document.getElementById('login-screen').classList.remove('hidden');
}
