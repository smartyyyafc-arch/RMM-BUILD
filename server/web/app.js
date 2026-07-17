/* BasicRMM Operator Console */

const API = window.location.origin + '/api';
let token = localStorage.getItem('rmm_token') || '';
let currentPage = 'dashboard';
let selectedDeviceId = null;
let terminalWs = null;
let terminalWsDevice = null;
let terminalWsMode = null;
let pollTimer = null;
let currentDevice = null;
let charts = {};
let devicePage = 0;
const deviceLimit = 25;
let deviceSearch = '';
let connectPendingId = null;
let agentToken = 'agent-secret-change-me';
let editingScriptId = null;

function $(sel) { return document.querySelector(sel); }

// ---- Core API helper ----

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  if (res.status === 401) { logout(); return null; }
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = j.detail || detail; } catch(e) {}
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---- Toast notifications ----

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3200);
}

// ---- XSS-safe HTML escaping ----

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString();
}

// ---- Page routing ----

function showPage(id) {
  document.querySelectorAll('.page-section').forEach(e => e.classList.remove('active'));
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.remove('active'));
  $(`#${id}`)?.classList.add('active');
  const nav = document.querySelector(`.sidebar nav a[data-page="${id}"]`);
  if (nav) nav.classList.add('active');
  const label = currentDevice && id === 'device-detail' ? currentDevice.hostname : id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  $('#page-title').textContent = label;
  currentPage = id;
  if (id !== 'device-detail') closeWs();
  if (id === 'dashboard') loadDashboard();
  else if (id === 'devices') loadDevices();
  else if (id === 'scripts') loadScripts();
  else if (id === 'automations') loadAutomations();
  else if (id === 'audit') loadAudit();
  else if (id === 'users') loadUsers();
  else if (id === 'software') loadSoftware();
  else if (id === 'patches') loadPatches();
  else if (id === 'toolbox') loadToolbox();
  else if (id === 'alerts') loadAlerts();
  else if (id === 'reports') loadReports();
  else if (id === 'settings') loadSettings();
}

document.querySelectorAll('.sidebar nav a').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); showPage(a.dataset.page); });
});

// ---- Auth ----

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const params = new URLSearchParams();
    params.append('username', $('#username').value);
    params.append('password', $('#password').value);
    const res = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Login failed');
    token = data.access_token;
    localStorage.setItem('rmm_token', token);
    await initApp();
  } catch(err) {
    $('#login-error').textContent = err.message;
  }
});

async function initApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const me = await api('GET', '/auth/me');
  if (!me) return;
  $('#current-user').textContent = me.username;
  try {
    const s = await api('GET', '/settings');
    if (s) agentToken = s.agent_token || agentToken;
  } catch(e) {}
  showPage('dashboard');
  startPolling();
}

function logout() {
  token = '';
  localStorage.removeItem('rmm_token');
  location.reload();
}
$('#logout').addEventListener('click', logout);

// ---- Polling ----

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (currentPage === 'dashboard') loadDashboard();
    else if (currentPage === 'devices') loadDevices();
    else if (currentPage === 'device-detail') loadDeviceDetail(selectedDeviceId, false);
    else if (currentPage === 'alerts') loadAlerts();
    else if (currentPage === 'reports') loadReports();
  }, 8000);
}

// ---- Dashboard ----

async function loadDashboard() {
  try {
    const [dash, settings] = await Promise.all([api('GET', '/dashboard'), api('GET', '/settings')]);
    if (!dash) return;
    $('#stat-total').textContent = dash.total;
    $('#stat-online').textContent = dash.online;
    $('#stat-offline').textContent = dash.offline;
    $('#stat-attention').textContent = dash.needs_attention;
    $('#stat-healthy').textContent = dash.healthy_pct + '%';
    renderPie('statusChart', 'Device Status', ['Online', 'Offline'], [dash.online, dash.offline], ['#22c55e', '#ef4444']);
    const plats = Object.keys(dash.by_platform);
    renderBar('platformChart', 'By Platform', plats,
      plats.map(p => dash.by_platform[p].total),
      plats.map(p => dash.by_platform[p].online));
    if (settings) agentToken = settings.agent_token || agentToken;
    refreshInstallCommands();
  } catch(e) { console.error('loadDashboard', e); }
}

function refreshInstallCommands() {
  const srv = location.origin;
  const domain = location.hostname;
  const t = agentToken;
  const ps = `$ServerUrl="${srv}"; $EnrollToken="${t}"; Invoke-WebRequest -UseBasicParsing -Uri "${srv}/agent/install.ps1" -OutFile "$env:TEMP\\rmm-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\rmm-install.ps1" -ServerUrl $ServerUrl -EnrollToken $EnrollToken`;
  $('#agent-install-ps').textContent = ps;
  $('#agent-install-setup').textContent = `# Download from: ${srv}/agent/setup.exe\nBasicRMM-Setup.exe /server="${srv}" /token="${t}"`;
  $('#agent-install-msi').textContent = `msiexec /i BasicRMM-Agent.msi RMM_SERVER="${srv}" RMM_AGENT_TOKEN="${t}" /qn /norestart`;
  $('#agent-install-gpo').textContent = `# Save to NETLOGON and deploy as GPO startup script:\n$ServerUrl="${srv}"; $EnrollToken="${t}";\nInvoke-WebRequest -UseBasicParsing -Uri "${srv}/agent/install.ps1" -OutFile "\\\\${domain}\\netlogon\\rmm-agent.ps1";\npowershell -NoProfile -ExecutionPolicy Bypass -File "\\\\${domain}\\netlogon\\rmm-agent.ps1" -ServerUrl $ServerUrl -EnrollToken $EnrollToken`;
}

document.querySelectorAll('.copy-install').forEach(btn => {
  btn.addEventListener('click', () => {
    const code = btn.closest('.code-wrap')?.querySelector('code');
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    }).catch(() => toast('Copy failed — select text manually', 'error'));
  });
});

document.querySelectorAll('.install-tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.install-tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.install-pane').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelector(`.install-pane[data-install="${t.dataset.install}"]`).classList.add('active');
  });
});

// ---- Charts ----

function renderPie(id, label, labels, data, colors) {
  const ctx = $('#' + id)?.getContext('2d');
  if (!ctx) return;
  if (charts[id]) {
    charts[id].data.labels = labels;
    charts[id].data.datasets[0].data = data;
    charts[id].update('none');
    return;
  }
  charts[id] = new Chart(ctx, {
    type: 'pie',
    data: { labels, datasets: [{ data, backgroundColor: colors }] },
    options: { responsive: true, plugins: { title: { display: true, text: label, color: '#e2e8f0' }, legend: { labels: { color: '#e2e8f0' } } } }
  });
}

function renderBar(id, label, labels, total, online) {
  const ctx = $('#' + id)?.getContext('2d');
  if (!ctx) return;
  if (charts[id]) {
    charts[id].data.labels = labels;
    charts[id].data.datasets[0].data = total;
    charts[id].data.datasets[1].data = online;
    charts[id].update('none');
    return;
  }
  charts[id] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Total', data: total, backgroundColor: '#3b82f6' },
      { label: 'Online', data: online, backgroundColor: '#22c55e' }
    ]},
    options: { responsive: true, plugins: { title: { display: true, text: label, color: '#e2e8f0' } }, scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } } }
  });
}

function renderLine(id, label) {
  const ctx = $('#' + id)?.getContext('2d');
  if (!ctx) return;
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  charts[id] = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ label, data: [], borderColor: '#3b82f6', tension: 0.3, fill: false, pointRadius: 2 }] },
    options: { responsive: true, plugins: { title: { display: true, text: label, color: '#e2e8f0' } }, scales: { x: { display: false }, y: { min: 0, max: 100, ticks: { color: '#94a3b8' } } } }
  });
}

function addPoint(id, label, value) {
  const c = charts[id];
  if (!c) return;
  if (c.data.labels.length > 20) { c.data.labels.shift(); c.data.datasets[0].data.shift(); }
  c.data.labels.push(label);
  c.data.datasets[0].data.push(value);
  c.update('none');
}

// ---- Devices list ----

async function loadDevices() {
  try {
    const params = new URLSearchParams({ skip: devicePage * deviceLimit, limit: deviceLimit });
    if (deviceSearch) params.set('q', deviceSearch);
    const res = await api('GET', `/devices?${params}`);
    if (!res) return;
    const devices = res.items || [];
    const total = res.total || 0;
    const tbody = $('#devices-table tbody');
    tbody.innerHTML = '';
    if (!devices.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-row">No devices yet. Install an agent to get started.</td></tr>';
    } else {
      devices.forEach(d => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${esc(d.hostname)}</strong><br><small class="muted">${esc(d.ip || '')}</small></td>
          <td><span class="badge badge-${d.status}">${d.status}</span></td>
          <td>${esc(d.os)}</td>
          <td>${gaugeCell(d.cpu_percent)}</td>
          <td>${gaugeCell(d.memory_percent)}</td>
          <td>${gaugeCell(d.disk_percent)}</td>
          <td><small>${formatDate(d.last_seen)}</small></td>
          <td>${esc(d.group || 'default')}</td>
          <td class="actions-cell">
            <button class="btn-sm btn-primary connect-btn" data-id="${d.id}">Connect</button>
            <button class="btn-sm btn-danger delete-dev-btn" data-id="${d.id}" data-name="${esc(d.hostname)}">Delete</button>
          </td>`;
        tr.querySelector('.connect-btn').addEventListener('click', () => showConnectModal(d.id, d.hostname));
        tr.querySelector('.delete-dev-btn').addEventListener('click', () => deleteDevice(d.id, d.hostname));
        tbody.appendChild(tr);
      });
    }
    const pages = Math.ceil(total / deviceLimit) || 1;
    $('#device-page-info').textContent = `Page ${devicePage + 1} of ${pages} (${total})`;
    $('#device-prev').disabled = devicePage === 0;
    $('#device-next').disabled = devicePage >= pages - 1;
  } catch(e) { console.error('loadDevices', e); toast('Failed to load devices', 'error'); }
}

function gaugeCell(val) {
  const v = (val ?? 0).toFixed(1);
  const cls = val > 90 ? 'gauge-red' : val > 70 ? 'gauge-yellow' : 'gauge-green';
  return `<span class="gauge ${cls}">${v}%</span>`;
}

async function deleteDevice(id, hostname) {
  if (!confirm(`Delete device "${hostname}"?\n\nThis will permanently remove the device and all its data.`)) return;
  try {
    await api('DELETE', `/devices/${id}`);
    toast(`Device "${hostname}" deleted`, 'success');
    loadDevices();
  } catch(e) { toast('Delete failed: ' + e.message, 'error'); }
}

$('#add-device').addEventListener('click', () => {
  showPage('dashboard');
  setTimeout(() => $('#install-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
});
$('#refresh-devices').addEventListener('click', loadDevices);
$('#device-prev').addEventListener('click', () => { devicePage--; loadDevices(); });
$('#device-next').addEventListener('click', () => { devicePage++; loadDevices(); });
$('#device-search').addEventListener('input', () => { deviceSearch = $('#device-search').value.trim(); devicePage = 0; loadDevices(); });

// ---- Device Detail ----

async function openDevice(id, tab = 'overview') {
  selectedDeviceId = id;
  // Destroy per-device charts so they start fresh for the new device
  ['cpuChart', 'memoryChart'].forEach(cid => {
    if (charts[cid]) { charts[cid].destroy(); delete charts[cid]; }
  });
  document.querySelectorAll('.page-section').forEach(e => e.classList.remove('active'));
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.remove('active'));
  $('#device-detail').classList.add('active');
  currentPage = 'device-detail';
  await loadDeviceDetail(id, true);
  switchTab(tab);
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const tabEl = document.querySelector(`.tab[data-tab="${tab}"]`);
  const contentEl = $(`#tab-${tab}`);
  if (tabEl && contentEl) {
    tabEl.classList.add('active');
    contentEl.classList.add('active');
  } else {
    document.querySelector('.tab[data-tab="overview"]').classList.add('active');
    $('#tab-overview').classList.add('active');
    tab = 'overview';
  }
  if (tab === 'terminal') connectTerminal();
  else if (tab === 'remote') connectRemote();
  else if (tab !== 'terminal' && tab !== 'remote') closeWs();
}

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

$('#back-to-devices').addEventListener('click', () => { closeWs(); showPage('devices'); });

async function loadDeviceDetail(id, full = false) {
  if (!id) return;
  try {
    const d = await api('GET', `/devices/${id}`);
    if (!d) return;
    currentDevice = d;
    $('#device-detail-name').textContent = `${d.hostname} — ${d.os}`;
    $('#page-title').textContent = d.hostname;
    $('#device-status-badge').innerHTML = `<span class="badge badge-${d.status}">${d.status}</span>`;
    updateDeviceCharts(d);

    if (full || document.querySelector('.tab.active')?.dataset.tab === 'history') {
      const cmds = await api('GET', `/devices/${id}/commands`);
      if (!cmds) return;
      const tbody = $('#history-table tbody');
      tbody.innerHTML = '';
      if (!cmds.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No commands yet</td></tr>';
      } else {
        cmds.forEach(c => {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${formatDate(c.created_at)}</td><td><span class="lang-badge">${esc(c.shell)}</span></td><td class="cmd-text">${esc(c.command)}</td><td class="status-${c.status}">${c.status}</td><td>${c.exit_code ?? '—'}</td><td><pre class="output-pre">${esc(c.output || '')}</pre></td>`;
          tbody.appendChild(tr);
        });
      }
    }
  } catch(e) { console.error('loadDeviceDetail', e); }
}

function updateDeviceCharts(d) {
  const now = new Date().toLocaleTimeString();
  if (!charts.cpuChart) renderLine('cpuChart', 'CPU %');
  if (!charts.memoryChart) renderLine('memoryChart', 'Memory %');
  addPoint('cpuChart', now, d.cpu_percent ?? 0);
  addPoint('memoryChart', now, d.memory_percent ?? 0);
}

// ---- Command Console ----

$('#run-console').addEventListener('click', runConsoleCommand);
$('#console-command').addEventListener('keydown', e => { if (e.key === 'Enter') runConsoleCommand(); });

async function runConsoleCommand() {
  if (!selectedDeviceId) return;
  const shell = $('#console-shell').value;
  const command = $('#console-command').value.trim();
  if (!command) return;
  $('#console-output').textContent = 'Sending...';
  try {
    const res = await api('POST', `/devices/${selectedDeviceId}/command`, { shell, command });
    if (!res) return;
    $('#console-output').textContent = `Waiting for agent... (cmd #${res.id})`;
    const c = await pollCommand(res.id);
    if (c) {
      $('#console-output').textContent = `Exit: ${c.exit_code ?? '?'}\n\n${c.output || '(no output)'}`;
      loadDeviceDetail(selectedDeviceId, false);
    } else {
      $('#console-output').textContent = 'Timeout — agent did not respond within 30s.';
    }
  } catch(e) { $('#console-output').textContent = 'Error: ' + e.message; }
}

async function pollCommand(id, maxMs = 30000, intervalMs = 1500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const c = await api('GET', `/commands/${id}`);
      if (c && c.status !== 'queued') return c;
    } catch(e) {}
  }
  return null;
}

// ---- Connect Modal ----

function showConnectModal(id, hostname) {
  connectPendingId = id;
  $('#connect-hostname').textContent = hostname;
  $('#connect-type').value = 'terminal';
  $('#connect-curtain').value = '';
  $('#connect-curtain-path').value = '';
  $('#modal-curtain-path-label').style.display = 'none';
  $('#connect-modal').classList.remove('hidden');
}

function closeConnectModal() {
  connectPendingId = null;
  $('#connect-modal').classList.add('hidden');
}

$('#connect-curtain').addEventListener('change', () => {
  $('#modal-curtain-path-label').style.display = $('#connect-curtain').value === 'custom' ? '' : 'none';
});

async function queueCurtainFromModal() {
  const action = $('#connect-curtain').value;
  if (!action || !connectPendingId) return;
  let command = action;
  if (action === 'custom') {
    const path = $('#connect-curtain-path').value.trim();
    if (!path) { toast('Enter the image path on the agent', 'error'); return; }
    command = `custom:${path}`;
  }
  await api('POST', `/devices/${connectPendingId}/command`, { shell: 'curtain', command });
}

$('#connect-go').addEventListener('click', async () => {
  if (!connectPendingId) return;
  const deviceId = connectPendingId;
  const tab = $('#connect-type').value;
  try { await queueCurtainFromModal(); } catch(e) {}
  closeConnectModal();
  openDevice(deviceId, tab);
});

$('#connect-curtain-only').addEventListener('click', async () => {
  if (!connectPendingId) return;
  const deviceId = connectPendingId;
  try { await queueCurtainFromModal(); } catch(e) {}
  closeConnectModal();
  openDevice(deviceId, 'curtain');
});

$('#connect-cancel').addEventListener('click', closeConnectModal);
$('#connect-modal').addEventListener('click', e => { if (e.target === $('#connect-modal')) closeConnectModal(); });

// ---- Curtain ----

$('#curtain-action').addEventListener('change', () => {
  $('#curtain-path-label').style.display = $('#curtain-action').value === 'custom' ? '' : 'none';
});

$('#show-curtain').addEventListener('click', async () => {
  if (!selectedDeviceId) return;
  const action = $('#curtain-action').value;
  let command = action;
  if (action === 'custom') {
    const path = $('#curtain-path').value.trim();
    if (!path) { toast('Enter the image path on the agent', 'error'); return; }
    command = `custom:${path}`;
  }
  $('#curtain-output').textContent = 'Sending...';
  try {
    const res = await api('POST', `/devices/${selectedDeviceId}/command`, { shell: 'curtain', command });
    if (!res) return;
    const c = await pollCommand(res.id);
    $('#curtain-output').textContent = c ? `Status: ${c.status}\n${c.output || ''}` : 'Timeout';
  } catch(e) { $('#curtain-output').textContent = 'Error: ' + e.message; }
});

// ---- WebSocket: Terminal ----

function closeWs() {
  if (!terminalWs) return;
  if (terminalWsMode === 'remote') {
    try { terminalWs.send(JSON.stringify({ type: 'remote_stop' })); } catch(e) {}
  }
  terminalWs.close();
  terminalWs = null;
  terminalWsMode = null;
  terminalWsDevice = null;
}

function connectTerminal() {
  if (terminalWs && terminalWsMode === 'terminal' && terminalWsDevice === selectedDeviceId) return;
  closeWs();
  if (!selectedDeviceId) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${selectedDeviceId}?token=${token}`);
  terminalWs = ws;
  terminalWsMode = 'terminal';
  terminalWsDevice = selectedDeviceId;
  const term = $('#terminal');
  term.textContent = '';
  ws.onopen = () => { appendTerminal('Connected. Type a command and press Enter.\n'); };
  ws.onmessage = ev => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'terminal_output') appendTerminal(msg.data);
      if (msg.type === 'error') appendTerminal('\n[Error] ' + msg.text + '\n');
    } catch(e) {}
  };
  ws.onclose = () => {
    appendTerminal('\n[Disconnected]\n');
    if (terminalWs === ws) { terminalWs = null; terminalWsMode = null; terminalWsDevice = null; }
  };
  ws.onerror = () => appendTerminal('\n[Connection error]\n');
}

function appendTerminal(text) {
  const term = $('#terminal');
  if (!term) return;
  term.textContent += text;
  term.scrollTop = term.scrollHeight;
}

$('#terminal-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (!terminalWs || terminalWs.readyState !== 1) { toast('Terminal not connected', 'error'); return; }
  const data = $('#terminal-input').value + '\n';
  try {
    terminalWs.send(JSON.stringify({ type: 'terminal_input', data }));
    appendTerminal('> ' + data);
    $('#terminal-input').value = '';
  } catch(ex) { toast('Send failed: ' + ex.message, 'error'); }
});

// ---- WebSocket: Remote Desktop ----

function connectRemote() {
  if (terminalWs && terminalWsMode === 'remote' && terminalWsDevice === selectedDeviceId) return;
  closeWs();
  if (!selectedDeviceId) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${selectedDeviceId}?token=${token}`);
  terminalWs = ws;
  terminalWsMode = 'remote';
  terminalWsDevice = selectedDeviceId;
  const img = $('#remote-screen');
  const hint = $('#remote-hint');
  img.style.display = 'none';
  hint.textContent = 'Connecting to remote desktop...';
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'remote_start' }));
    hint.textContent = 'Waiting for first frame from agent...';
  };
  ws.onmessage = ev => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'frame') {
        img.src = msg.data;
        img.style.display = 'block';
        hint.textContent = '';
      }
      if (msg.type === 'error') hint.textContent = 'Agent error: ' + msg.text;
    } catch(e) {}
  };
  ws.onclose = () => {
    hint.textContent = 'Disconnected.';
    if (terminalWs === ws) { terminalWs = null; terminalWsMode = null; terminalWsDevice = null; }
  };
  ws.onerror = () => { hint.textContent = 'WebSocket connection error.'; };
}

// ---- Alerts ----

async function loadAlerts() {
  try {
    const filter = $('#alert-filter').value;
    const alerts = await api('GET', `/alerts?dismissed=${filter}`);
    if (!alerts) return;
    const tbody = $('#alerts-table tbody');
    tbody.innerHTML = '';
    if (!alerts.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No alerts</td></tr>';
      return;
    }
    alerts.forEach(a => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${formatDate(a.created_at)}</td><td>${esc(a.device_hostname)}</td><td class="sev-${a.severity}">${a.severity}</td><td>${esc(a.category)}</td><td>${esc(a.message)}</td><td>${
        a.dismissed ? '<span class="muted">Dismissed</span>' : `<button class="btn-sm btn-secondary dismiss-btn" data-id="${a.id}">Dismiss</button>`
      }</td>`;
      if (!a.dismissed) {
        tr.querySelector('.dismiss-btn').addEventListener('click', async () => {
          await api('POST', `/alerts/${a.id}/dismiss`);
          toast('Alert dismissed', 'success');
          loadAlerts();
        });
      }
      tbody.appendChild(tr);
    });
  } catch(e) { console.error('loadAlerts', e); }
}

$('#alert-filter').addEventListener('change', loadAlerts);
$('#refresh-alerts').addEventListener('click', loadAlerts);

// ---- Software / Patches ----

async function populateDeviceSelect(selId, placeholder) {
  const res = await api('GET', '/devices?limit=1000');
  const devices = res?.items || [];
  const sel = $('#' + selId);
  if (!sel) return devices;
  const prev = sel.value;
  sel.innerHTML = `<option value="">${placeholder}</option>`;
  devices.forEach(d => sel.add(new Option(d.hostname, d.id)));
  if (prev && [...sel.options].some(o => o.value === String(prev))) sel.value = prev;
  return devices;
}

async function loadSoftware() {
  await populateDeviceSelect('software-device', '— Select a device —');
  const deviceId = $('#software-device').value;
  const tbody = $('#software-table tbody');
  tbody.innerHTML = '';
  if (!deviceId) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-row">Select a device to view software</td></tr>';
    return;
  }
  try {
    const rows = await api('GET', `/devices/${deviceId}/software`);
    if (!rows?.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No software data — agent inventory runs every 5 minutes</td></tr>';
      return;
    }
    rows.forEach(s => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(s.device)}</td><td>${esc(s.name)}</td><td>${esc(s.version)}</td><td>${esc(s.publisher)}</td><td>${esc(s.install_date)}</td><td>${esc(s.source)}</td>`;
      tbody.appendChild(tr);
    });
  } catch(e) { tbody.innerHTML = `<tr><td colspan="6" class="empty-row">Error: ${esc(e.message)}</td></tr>`; }
}

async function loadPatches() {
  await populateDeviceSelect('patches-device', '— Select a device —');
  const deviceId = $('#patches-device').value;
  const tbody = $('#patches-table tbody');
  tbody.innerHTML = '';
  if (!deviceId) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-row">Select a device to view patches</td></tr>';
    return;
  }
  try {
    const rows = await api('GET', `/devices/${deviceId}/patches`);
    if (!rows?.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No patch data</td></tr>';
      return;
    }
    rows.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(p.device)}</td><td>${esc(p.hotfix_id)}</td><td>${esc(p.description)}</td><td>${esc(p.installed_on)}</td><td>${esc(p.installed_by)}</td>`;
      tbody.appendChild(tr);
    });
  } catch(e) { tbody.innerHTML = `<tr><td colspan="5" class="empty-row">Error: ${esc(e.message)}</td></tr>`; }
}

$('#software-device').addEventListener('change', loadSoftware);
$('#patches-device').addEventListener('change', loadPatches);
$('#refresh-software').addEventListener('click', loadSoftware);
$('#refresh-patches').addEventListener('click', loadPatches);

// ---- Scripts ----

async function loadScripts() {
  try {
    const [scripts, devRes] = await Promise.all([api('GET', '/scripts'), api('GET', '/devices?limit=1000')]);
    if (!scripts) return;
    const devices = devRes?.items || [];
    const tbody = $('#scripts-table tbody');
    tbody.innerHTML = '';
    if (!scripts.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No scripts yet. Click "+ New Script" to create one.</td></tr>';
      return;
    }
    scripts.forEach(s => {
      const devOpts = devices.map(d => `<option value="${d.id}">${esc(d.hostname)}</option>`).join('');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${esc(s.name)}</strong></td>
        <td><span class="lang-badge lang-${s.language}">${esc(s.language)}</span></td>
        <td>${esc(s.description || '')}</td>
        <td>
          <select class="run-script-dev select-inline" data-script="${s.id}">
            <option value="">Select device...</option>${devOpts}
          </select>
          <button class="btn-sm btn-primary run-btn" data-id="${s.id}">Run</button>
        </td>
        <td class="actions-cell">
          <button class="btn-sm btn-secondary edit-btn">Edit</button>
          <button class="btn-sm btn-danger del-btn">Delete</button>
        </td>`;
      tr.querySelector('.run-btn').addEventListener('click', async () => {
        const deviceId = tr.querySelector('.run-script-dev').value;
        if (!deviceId) { toast('Select a device first', 'error'); return; }
        const btn = tr.querySelector('.run-btn');
        btn.disabled = true; btn.textContent = '...';
        try {
          const res = await api('POST', `/devices/${deviceId}/run-script/${s.id}`);
          toast(`Script queued (cmd #${res.id})`, 'success');
        } catch(e) { toast('Run failed: ' + e.message, 'error'); }
        finally { btn.disabled = false; btn.textContent = 'Run'; }
      });
      tr.querySelector('.edit-btn').addEventListener('click', () => openScriptEditor(s));
      tr.querySelector('.del-btn').addEventListener('click', async () => {
        if (!confirm(`Delete script "${s.name}"?`)) return;
        try {
          await api('DELETE', `/scripts/${s.id}`);
          toast('Script deleted', 'success');
          loadScripts();
        } catch(e) { toast('Delete failed: ' + e.message, 'error'); }
      });
      tbody.appendChild(tr);
    });
  } catch(e) { console.error('loadScripts', e); toast('Failed to load scripts', 'error'); }
}

function openScriptEditor(script = null) {
  editingScriptId = script?.id ?? null;
  $('#script-editor-title').textContent = script ? 'Edit Script' : 'New Script';
  $('#script-name').value = script?.name || '';
  $('#script-lang').value = script?.language || 'powershell';
  $('#script-code').value = script?.code || '';
  $('#script-desc').value = script?.description || '';
  $('#script-editor').classList.remove('hidden');
  $('#script-name').focus();
}

function closeScriptEditor() {
  editingScriptId = null;
  $('#script-editor').classList.add('hidden');
}

$('#add-script').addEventListener('click', () => openScriptEditor());
$('#cancel-script').addEventListener('click', closeScriptEditor);
$('#save-script').addEventListener('click', async () => {
  const payload = {
    name: $('#script-name').value.trim(),
    language: $('#script-lang').value,
    code: $('#script-code').value,
    description: $('#script-desc').value.trim()
  };
  if (!payload.name) { toast('Script name is required', 'error'); return; }
  if (!payload.code) { toast('Script code is required', 'error'); return; }
  try {
    if (editingScriptId) {
      await api('PUT', `/scripts/${editingScriptId}`, payload);
      toast('Script updated', 'success');
    } else {
      await api('POST', '/scripts', payload);
      toast('Script created', 'success');
    }
    closeScriptEditor();
    loadScripts();
  } catch(e) { toast('Error: ' + e.message, 'error'); }
});

// ---- Automations ----

async function loadAutomations() {
  try {
    const [scripts, automations] = await Promise.all([api('GET', '/scripts'), api('GET', '/automations')]);
    if (!automations) return;
    const tbody = $('#automations-table tbody');
    tbody.innerHTML = '';
    if (!automations.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No automations. Click "+ New Automation" to create one.</td></tr>';
    } else {
      automations.forEach(a => {
        const script = scripts?.find(s => s.id === a.script_id);
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${esc(a.name)}</td><td><code class="cron">${esc(a.schedule)}</code></td><td>${esc(script?.name || String(a.script_id))}</td><td>${esc(a.target_group)}</td>
          <td><span class="badge ${a.enabled ? 'badge-online' : 'badge-offline'}">${a.enabled ? 'enabled' : 'disabled'}</span></td>
          <td class="actions-cell"><button class="btn-sm btn-danger del-auto-btn">Delete</button></td>`;
        tr.querySelector('.del-auto-btn').addEventListener('click', async () => {
          if (!confirm(`Delete automation "${a.name}"?`)) return;
          try {
            await api('DELETE', `/automations/${a.id}`);
            toast('Automation deleted', 'success');
            loadAutomations();
          } catch(e) { toast('Delete failed: ' + e.message, 'error'); }
        });
        tbody.appendChild(tr);
      });
    }
    // Populate script dropdown in new-automation form
    const sel = $('#auto-script-id');
    if (sel) {
      sel.innerHTML = scripts?.length
        ? scripts.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
        : '<option value="">No scripts — create one first</option>';
    }
  } catch(e) { console.error('loadAutomations', e); }
}

$('#add-automation').addEventListener('click', () => {
  loadAutomations(); // refresh script dropdown
  $('#automation-form').classList.toggle('hidden');
});
$('#cancel-automation').addEventListener('click', () => $('#automation-form').classList.add('hidden'));
$('#save-automation').addEventListener('click', async () => {
  const name = $('#auto-name').value.trim();
  const schedule = $('#auto-schedule').value.trim();
  const scriptId = parseInt($('#auto-script-id').value, 10);
  const targetGroup = $('#auto-target-group').value.trim() || 'default';
  if (!name) { toast('Name is required', 'error'); return; }
  if (!schedule) { toast('Cron schedule is required', 'error'); return; }
  if (!scriptId) { toast('Select a script', 'error'); return; }
  try {
    await api('POST', '/automations', { name, schedule, script_id: scriptId, target_group: targetGroup, enabled: true });
    toast('Automation created', 'success');
    $('#automation-form').classList.add('hidden');
    $('#auto-name').value = ''; $('#auto-schedule').value = ''; $('#auto-target-group').value = '';
    loadAutomations();
  } catch(e) { toast('Error: ' + e.message, 'error'); }
});

// ---- Toolbox ----

async function loadToolbox() {
  await populateDeviceSelect('toolbox-device', '— Select a device —');
}

const TOOLBOX_COMMANDS = {
  'services':              ['powershell', 'Get-Service | Select-Object Name, Status, StartType | Sort-Object Status, Name | Format-Table -AutoSize | Out-String -Width 200'],
  'processes':             ['powershell', 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 30 Name, Id, @{n="CPU(s)";e={[math]::Round($_.CPU,1)}}, @{n="RAM(MB)";e={[math]::Round($_.WS/1MB,1)}} | Format-Table -AutoSize | Out-String -Width 200'],
  'eventlog-system':       ['powershell', 'Get-EventLog -LogName System -Newest 20 | Select-Object TimeGenerated, EntryType, Source, Message | Format-Table -Wrap -AutoSize | Out-String -Width 300'],
  'eventlog-application':  ['powershell', 'Get-EventLog -LogName Application -Newest 20 | Select-Object TimeGenerated, EntryType, Source, Message | Format-Table -Wrap -AutoSize | Out-String -Width 300'],
  'registry-run':          ['powershell', "Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' | Format-List | Out-String -Width 200"],
  'users':                 ['powershell', 'Get-LocalUser | Select-Object Name, Enabled, PasswordRequired, LastLogon | Format-Table -AutoSize | Out-String -Width 200'],
  'firewall':              ['powershell', 'Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction | Format-Table -AutoSize | Out-String -Width 200'],
  'network':               ['powershell', 'Get-NetIPAddress | Select-Object InterfaceAlias, AddressFamily, IPAddress, PrefixLength | Where-Object { $_.AddressFamily -eq "IPv4" } | Format-Table -AutoSize | Out-String -Width 200'],
  'disk':                  ['powershell', 'Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{n="Used(GB)";e={[math]::Round($_.Used/1GB,2)}}, @{n="Free(GB)";e={[math]::Round($_.Free/1GB,2)}} | Format-Table -AutoSize | Out-String -Width 200'],
};

$('#run-toolbox').addEventListener('click', async () => {
  const deviceId = $('#toolbox-device').value;
  if (!deviceId) { toast('Select a device first', 'error'); return; }
  const action = $('#toolbox-action').value;
  const [shell, command] = TOOLBOX_COMMANDS[action];
  const btn = $('#run-toolbox');
  btn.disabled = true; btn.textContent = 'Running...';
  $('#toolbox-output').textContent = 'Waiting for agent...';
  try {
    const res = await api('POST', `/devices/${deviceId}/command`, { shell, command });
    if (!res) return;
    const c = await pollCommand(res.id);
    $('#toolbox-output').textContent = c ? (c.output || '(no output)') : 'Timeout — agent did not respond within 30s.';
  } catch(e) { $('#toolbox-output').textContent = 'Error: ' + e.message; }
  finally { btn.disabled = false; btn.textContent = 'Run'; }
});

// ---- Reports ----

async function loadReports() {
  try {
    const r = await api('GET', '/reports/summary');
    if (!r) return;
    $('#report-summary').innerHTML = `
      <div class="stat stat-blue"><h3>${r.total_devices}</h3><p>Total Devices</p></div>
      <div class="stat stat-green"><h3>${r.online}</h3><p>Online</p></div>
      <div class="stat stat-red"><h3>${r.offline}</h3><p>Offline</p></div>
      <div class="stat stat-yellow"><h3>${r.needs_attention}</h3><p>Needs Attention</p></div>
      <div class="stat stat-red"><h3>${r.open_alerts}</h3><p>Open Alerts</p></div>`;
    const tbody = $('#report-audit-table tbody');
    tbody.innerHTML = '';
    (r.recent_audit || []).forEach(a => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${formatDate(a.time)}</td><td>${esc(a.user)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td>`;
      tbody.appendChild(tr);
    });
  } catch(e) { console.error('loadReports', e); }
}

$('#refresh-reports').addEventListener('click', loadReports);

// ---- Audit ----

async function loadAudit() {
  try {
    const logs = await api('GET', '/audit');
    if (!logs) return;
    const tbody = $('#audit-table tbody');
    tbody.innerHTML = '';
    logs.forEach(a => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${formatDate(a.created_at)}</td><td>${esc(a.username)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td>`;
      tbody.appendChild(tr);
    });
  } catch(e) { console.error('loadAudit', e); }
}

// ---- Users ----

async function loadUsers() {
  try {
    const users = await api('GET', '/auth/users');
    if (!users) return;
    const tbody = $('#users-table tbody');
    tbody.innerHTML = '';
    users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(u.username)}</td><td>${esc(u.email || '')}</td><td>${u.is_admin ? 'Yes' : 'No'}</td>
        <td><button class="btn-sm btn-danger del-user-btn" data-id="${u.id}" data-name="${esc(u.username)}">Delete</button></td>`;
      tr.querySelector('.del-user-btn').addEventListener('click', async () => {
        if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
        try {
          await api('DELETE', `/auth/users/${u.id}`);
          toast('User deleted', 'success');
          loadUsers();
        } catch(e) { toast('Error: ' + e.message, 'error'); }
      });
      tbody.appendChild(tr);
    });
  } catch(e) { console.error('loadUsers', e); }
}

$('#add-user').addEventListener('click', () => $('#user-form').classList.toggle('hidden'));
$('#cancel-user').addEventListener('click', () => $('#user-form').classList.add('hidden'));
$('#save-user').addEventListener('click', async () => {
  const username = $('#user-username').value.trim();
  const password = $('#user-password').value;
  const email = $('#user-email').value.trim();
  const is_admin = $('#user-is-admin').checked;
  if (!username) { toast('Username is required', 'error'); return; }
  if (!password) { toast('Password is required', 'error'); return; }
  try {
    await api('POST', '/auth/users', { username, password, email, is_admin });
    toast(`User "${username}" created`, 'success');
    $('#user-form').classList.add('hidden');
    $('#user-username').value = ''; $('#user-password').value = ''; $('#user-email').value = ''; $('#user-is-admin').checked = false;
    loadUsers();
  } catch(e) { toast('Error: ' + e.message, 'error'); }
});

// ---- Settings ----

async function loadSettings() {
  try {
    const s = await api('GET', '/settings');
    if (!s) return;
    agentToken = s.agent_token || agentToken;
    $('#setting-cpu').value = s.threshold_cpu;
    $('#setting-memory').value = s.threshold_memory;
    $('#setting-disk').value = s.threshold_disk;
    $('#setting-agent-token').textContent = s.agent_token;
    $('#setting-server-url').textContent = s.server_url || location.origin;
  } catch(e) { console.error('loadSettings', e); }
}

$('#save-settings').addEventListener('click', async () => {
  try {
    await api('PUT', '/settings', {
      threshold_cpu: parseFloat($('#setting-cpu').value),
      threshold_memory: parseFloat($('#setting-memory').value),
      threshold_disk: parseFloat($('#setting-disk').value)
    });
    toast('Settings saved', 'success');
  } catch(e) { toast('Error: ' + e.message, 'error'); }
});

// ---- Auto-login on reload ----

if (token) {
  api('GET', '/auth/me').then(async me => {
    if (!me) return;
    await initApp();
  }).catch(logout);
}
