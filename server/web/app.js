const API = window.location.origin + '/api';
let token = localStorage.getItem('rmm_token') || '';
let currentPage = 'dashboard';
let selectedDeviceId = null;
let terminalWs = null;
let dashboardInterval = null;
let currentDevice = null;
let charts = {};

function $(sel) { return document.querySelector(sel); }

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  if (res.status === 401) { logout(); return; }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function showPage(id) {
  document.querySelectorAll('.page-section').forEach(e => e.classList.remove('active'));
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.remove('active'));
  $(`#${id}`)?.classList.add('active');
  const nav = document.querySelector(`.sidebar nav a[data-page="${id}"]`);
  if (nav) nav.classList.add('active');
  const titles = {
    'device-detail': 'Device Detail'
  };
  $('#page-title').textContent = titles[id] || id.charAt(0).toUpperCase() + id.slice(1);
  currentPage = id;
  if (id === 'dashboard') loadDashboard();
  if (id === 'devices') loadDevices();
  if (id === 'scripts') loadScripts();
  if (id === 'automations') loadAutomations();
  if (id === 'audit') loadAudit();
  if (id === 'users') loadUsers();
  if (id === 'software') loadSoftware();
  if (id === 'patches') loadPatches();
  if (id === 'toolbox') loadToolbox();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const params = new URLSearchParams();
    params.append('username', $('#username').value);
    params.append('password', $('#password').value);
    const res = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail);
    token = data.access_token;
    localStorage.setItem('rmm_token', token);
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    const me = await api('GET', '/auth/me');
    $('#current-user').textContent = me.username;
    showPage('dashboard');
    startPolling();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

function logout() {
  token = '';
  localStorage.removeItem('rmm_token');
  location.reload();
}
$('#logout').addEventListener('click', logout);

document.querySelectorAll('.sidebar nav a').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); showPage(a.dataset.page); });
});

function startPolling() {
  if (dashboardInterval) clearInterval(dashboardInterval);
  dashboardInterval = setInterval(() => {
    if (currentPage === 'dashboard') loadDashboard();
    if (currentPage === 'devices') loadDevices();
    if (currentPage === 'device-detail') loadDeviceDetail(selectedDeviceId);
    if (currentPage === 'software') loadSoftware();
    if (currentPage === 'patches') loadPatches();
  }, 5000);
}

async function loadDashboard() {
  const dash = await api('GET', '/dashboard');
  $('#stat-total').textContent = dash.total;
  $('#stat-online').textContent = dash.online;
  $('#stat-offline').textContent = dash.offline;
  $('#stat-attention').textContent = dash.needs_attention;
  $('#stat-healthy').textContent = dash.healthy_pct + '%';

  renderPie('statusChart', 'Device Status', ['Online', 'Offline'], [dash.online, dash.offline], ['#22c55e', '#ef4444']);
  const plats = Object.keys(dash.by_platform);
  renderBar('platformChart', 'Status by Platform', plats, plats.map(p => dash.by_platform[p].total), plats.map(p => dash.by_platform[p].online));

  const host = window.location.host;
  $('#agent-install-cmd').textContent = `powershell -Command "iwr http://${host}/agent/install.ps1 -OutFile install.ps1; .\\install.ps1"`;
}

function renderPie(id, label, labels, data, colors) {
  const ctx = $('#' + id)?.getContext('2d');
  if (!ctx) return;
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'pie',
    data: { labels, datasets: [{ data, backgroundColor: colors }] },
    options: { responsive: true, plugins: { title: { display: true, text: label, color: '#e2e8f0' } }, legend: { labels: { color: '#e2e8f0' } } }
  });
}

function renderBar(id, label, labels, total, online) {
  const ctx = $('#' + id)?.getContext('2d');
  if (!ctx) return;
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Total', data: total, backgroundColor: '#3b82f6' },
        { label: 'Online', data: online, backgroundColor: '#22c55e' }
      ]
    },
    options: { responsive: true, plugins: { title: { display: true, text: label, color: '#e2e8f0' } }, scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } } }
  });
}

async function loadDevices() {
  const devices = await api('GET', '/devices');
  const tbody = $('#devices-table tbody');
  tbody.innerHTML = '';
  devices.forEach(d => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${d.hostname}</td><td class="status-${d.status}">${d.status}</td><td>${d.os}</td><td>${d.cpu_percent?.toFixed(1)}</td><td>${d.memory_percent?.toFixed(1)}</td><td>${d.disk_percent?.toFixed(1)}</td><td>${formatDate(d.last_seen)}</td><td>${d.group}</td><td><button data-id="${d.id}">Open</button></td>`;
    tr.querySelector('button').addEventListener('click', () => openDevice(d.id));
    tbody.appendChild(tr);
  });
}

async function openDevice(id) {
  selectedDeviceId = id;
  document.querySelectorAll('.page-section').forEach(e => e.classList.remove('active'));
  $('#device-detail').classList.add('active');
  await loadDeviceDetail(id);
}

$('#back-to-devices').addEventListener('click', () => showPage('devices'));

async function loadDeviceDetail(id) {
  if (!id) return;
  const d = await api('GET', `/devices/${id}`);
  currentDevice = d;
  $('#device-detail-name').textContent = `${d.hostname} — ${d.os} (${d.status})`;
  updateDeviceCharts(d);
  const cmds = await api('GET', `/devices/${id}/commands`);
  const tbody = $('#history-table tbody');
  tbody.innerHTML = '';
  cmds.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${formatDate(c.created_at)}</td><td>${c.shell}</td><td>${c.command}</td><td>${c.status}</td><td>${c.exit_code ?? ''}</td><td><pre>${c.output || ''}</pre></td>`;
    tbody.appendChild(tr);
  });
}

function updateDeviceCharts(d) {
  const now = new Date().toLocaleTimeString();
  if (!charts.cpuChart) {
    renderLine('cpuChart', 'CPU — recent history', [], []);
    renderLine('memoryChart', 'Memory — recent history', [], []);
  }
  addPoint('cpuChart', now, d.cpu_percent);
  addPoint('memoryChart', now, d.memory_percent);
}

function renderLine(id, label, labels, data) {
  const ctx = $('#' + id)?.getContext('2d');
  if (!ctx) return;
  charts[id] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label, data, borderColor: '#3b82f6', tension: 0.3, fill: false }] },
    options: { responsive: true, plugins: { title: { display: true, text: label, color: '#e2e8f0' } }, scales: { x: { display: false }, y: { min: 0, max: 100, ticks: { color: '#94a3b8' } } } }
  });
}

function addPoint(id, label, value) {
  const c = charts[id];
  if (!c) return;
  if (c.data.labels.length > 20) { c.data.labels.shift(); c.data.datasets[0].data.shift(); }
  c.data.labels.push(label);
  c.data.datasets[0].data.push(value);
  c.update();
}

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $(`#tab-${t.dataset.tab}`).classList.add('active');
    if (t.dataset.tab === 'terminal') connectTerminal();
    if (t.dataset.tab === 'remote') connectRemote();
  });
});

$('#show-curtain').addEventListener('click', async () => {
  if (!selectedDeviceId) return;
  const action = $('#curtain-action').value;
  let command = action;
  if (action === 'custom') {
    const path = $('#curtain-path').value.trim();
    if (!path) { alert('Enter the image path on the agent'); return; }
    command = `custom:${path}`;
  }
  $('#curtain-output').textContent = 'Sending curtain command...';
  const res = await api('POST', `/devices/${selectedDeviceId}/command`, { shell: 'curtain', command });
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const cmds = await api('GET', `/devices/${selectedDeviceId}/commands`);
    const c = cmds.find(x => x.id === res.id);
    if (c && c.status !== 'queued') {
      $('#curtain-output').textContent = `Status: ${c.status}\nExit: ${c.exit_code}\n\n${c.output || ''}`;
      return;
    }
  }
  $('#curtain-output').textContent = 'Timeout';
});

$('#run-console').addEventListener('click', runConsoleCommand);
$('#console-command').addEventListener('keydown', e => { if (e.key === 'Enter') runConsoleCommand(); });

async function runConsoleCommand() {
  if (!selectedDeviceId) return;
  const shell = $('#console-shell').value;
  const command = $('#console-command').value;
  $('#console-output').textContent = 'Queued...';
  const res = await api('POST', `/devices/${selectedDeviceId}/command`, { shell, command });
  $('#console-output').textContent = `Command queued (id=${res.id}). Waiting for agent...`;
  pollCommand(res.id);
}

async function pollCommand(id) {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const cmds = await api('GET', `/devices/${selectedDeviceId}/commands`);
    const c = cmds.find(x => x.id === id);
    if (c && c.status !== 'queued') {
      $('#console-output').textContent = `Status: ${c.status}\nExit: ${c.exit_code}\n\n${c.output || ''}`;
      if (currentPage === 'device-detail') loadDeviceDetail(selectedDeviceId);
      return;
    }
  }
  $('#console-output').textContent = 'Timeout waiting for command result.';
}

function connectTerminal() {
  if (!selectedDeviceId) return;
  if (terminalWs) { terminalWs.close(); terminalWs = null; }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  terminalWs = new WebSocket(`${protocol}://${window.location.host}/ws/terminal/${selectedDeviceId}?token=${token}`);
  const term = $('#terminal');
  terminalWs.onopen = () => { term.textContent += 'Terminal connected.\n'; };
  terminalWs.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'terminal_output') term.textContent += msg.data;
    if (msg.type === 'error') term.textContent += 'Error: ' + msg.text + '\n';
    term.scrollTop = term.scrollHeight;
  };
  terminalWs.onclose = () => { term.textContent += 'Terminal disconnected.\n'; };
}

$('#terminal-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && terminalWs?.readyState === 1) {
    const data = $('#terminal-input').value + '\n';
    terminalWs.send(JSON.stringify({ type: 'terminal_input', data }));
    $('#terminal').textContent += `$ ${data}`;
    $('#terminal-input').value = '';
  }
});

function connectRemote() {
  if (!selectedDeviceId) return;
  if (terminalWs) { terminalWs.close(); terminalWs = null; }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  terminalWs = new WebSocket(`${protocol}://${window.location.host}/ws/terminal/${selectedDeviceId}?token=${token}`);
  const img = $('#remote-screen');
  img.style.display = 'block';
  terminalWs.onopen = () => terminalWs.send(JSON.stringify({ type: 'remote_start' }));
  terminalWs.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'frame') img.src = msg.data;
  };
}

async function loadScripts() {
  const scripts = await api('GET', '/scripts');
  const tbody = $('#scripts-table tbody');
  tbody.innerHTML = '';
  scripts.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s.name}</td><td>${s.language}</td><td>${s.description || ''}</td>`;
    tbody.appendChild(tr);
  });
}

$('#add-script').addEventListener('click', () => $('#script-editor').classList.toggle('hidden'));
$('#save-script').addEventListener('click', async () => {
  const payload = {
    name: $('#script-name').value,
    language: $('#script-lang').value,
    code: $('#script-code').value,
    description: $('#script-desc').value
  };
  await api('POST', '/scripts', payload);
  $('#script-editor').classList.add('hidden');
  loadScripts();
});

async function loadAutomations() {
  const scripts = await api('GET', '/scripts');
  const automations = await api('GET', '/automations');
  const tbody = $('#automations-table tbody');
  tbody.innerHTML = '';
  automations.forEach(a => {
    const script = scripts.find(s => s.id === a.script_id);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${a.name}</td><td>${a.schedule}</td><td>${script?.name || a.script_id}</td><td>${a.target_group}</td><td>${a.enabled}</td>`;
    tbody.appendChild(tr);
  });
}

$('#add-automation').addEventListener('click', async () => {
  const scripts = await api('GET', '/scripts');
  if (scripts.length === 0) { alert('Create a script first.'); return; }
  const name = prompt('Automation name');
  const schedule = prompt('Cron schedule (e.g. 0 2 * * *)');
  const target = prompt('Target group', 'default');
  if (!name || !schedule) return;
  await api('POST', '/automations', { name, schedule, script_id: scripts[0].id, target_group: target });
  loadAutomations();
});

async function loadAudit() {
  const logs = await api('GET', '/audit');
  const tbody = $('#audit-table tbody');
  tbody.innerHTML = '';
  logs.forEach(a => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${formatDate(a.created_at)}</td><td>${a.username}</td><td>${a.action}</td><td>${a.detail}</td>`;
    tbody.appendChild(tr);
  });
}

async function loadUsers() {
  // Not exposed; placeholder
}

async function populateDeviceSelects() {
  const devices = await api('GET', '/devices');
  ['software-device', 'patches-device', 'toolbox-device'].forEach(id => {
    const sel = $('#' + id);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '';
    if (id !== 'toolbox-device') {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = 'All devices';
      sel.appendChild(opt);
    }
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.hostname;
      sel.appendChild(opt);
    });
    if (current && [...sel.options].some(o => o.value === current)) {
      sel.value = current;
    } else if (id === 'toolbox-device' && sel.options.length) {
      sel.selectedIndex = 0;
    }
  });
}

async function loadSoftware() {
  await populateDeviceSelects();
  const sel = $('#software-device');
  if (!sel.value) { sel.value = sel.options[1]?.value || ''; }
  const deviceId = sel.value;
  const rows = deviceId ? await api('GET', `/devices/${deviceId}/software`) : [];
  const tbody = $('#software-table tbody');
  tbody.innerHTML = '';
  rows.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s.device || ''}</td><td>${s.name}</td><td>${s.version || ''}</td><td>${s.publisher || ''}</td><td>${s.install_date || ''}</td><td>${s.source || ''}</td>`;
    tbody.appendChild(tr);
  });
}

async function loadPatches() {
  await populateDeviceSelects();
  const sel = $('#patches-device');
  if (!sel.value) { sel.value = sel.options[1]?.value || ''; }
  const deviceId = sel.value;
  const rows = deviceId ? await api('GET', `/devices/${deviceId}/patches`) : [];
  const tbody = $('#patches-table tbody');
  tbody.innerHTML = '';
  rows.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${p.device || ''}</td><td>${p.hotfix_id}</td><td>${p.description || ''}</td><td>${p.installed_on || ''}</td><td>${p.installed_by || ''}</td>`;
    tbody.appendChild(tr);
  });
}

async function loadToolbox() {
  await populateDeviceSelects();
}

const TOOLBOX_COMMANDS = {
  'services': ['powershell', 'Get-Service | Select-Object Name, Status, StartType | Format-Table -AutoSize'],
  'eventlog-system': ['powershell', 'Get-EventLog -LogName System -Newest 20 | Select-Object TimeGenerated, EntryType, Source, Message | Format-Table -Wrap -AutoSize'],
  'eventlog-application': ['powershell', 'Get-EventLog -LogName Application -Newest 20 | Select-Object TimeGenerated, EntryType, Source, Message | Format-Table -Wrap -AutoSize'],
  'registry-run': ['powershell', "Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' | Format-List"],
  'users': ['powershell', 'Get-LocalUser | Select-Object Name, Enabled, LastLogon | Format-Table -AutoSize'],
  'firewall': ['powershell', 'Get-NetFirewallProfile | Select-Object Name, Enabled | Format-Table -AutoSize']
};

$('#run-toolbox').addEventListener('click', async () => {
  const deviceId = $('#toolbox-device').value;
  if (!deviceId) { alert('Select a device'); return; }
  const action = $('#toolbox-action').value;
  const [shell, command] = TOOLBOX_COMMANDS[action];
  $('#toolbox-output').textContent = 'Running...';
  const res = await api('POST', `/devices/${deviceId}/command`, { shell, command });
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const cmds = await api('GET', `/devices/${deviceId}/commands`);
    const c = cmds.find(x => x.id === res.id);
    if (c && c.status !== 'queued') {
      $('#toolbox-output').textContent = `Status: ${c.status}\nExit: ${c.exit_code}\n\n${c.output || ''}`;
      return;
    }
  }
  $('#toolbox-output').textContent = 'Timeout';
});

$('#software-device').addEventListener('change', loadSoftware);
$('#patches-device').addEventListener('change', loadPatches);
$('#refresh-software').addEventListener('click', loadSoftware);
$('#refresh-patches').addEventListener('click', loadPatches);

$('#add-user').addEventListener('click', async () => {
  const username = prompt('Username');
  const password = prompt('Password');
  const is_admin = confirm('Is admin?');
  if (!username || !password) return;
  await api('POST', '/auth/users', { username, password, is_admin });
  loadUsers();
});

function formatDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleString();
}

if (token) {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  api('GET', '/auth/me').then(me => { $('#current-user').textContent = me.username; showPage('dashboard'); startPolling(); }).catch(logout);
}
