"use strict";

/* Minimal dependency-free dashboard client for the RMM server API. */

const KEY_STORAGE = "rmm.adminKey";
const state = {
  adminKey: null,
  devices: [],
  selectedId: null,
  ws: null,
  showAck: false,
};

// ---- API helpers ----------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.adminKey}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    signOut();
    throw new Error("Unauthorized — check your admin key.");
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

// ---- Auth -----------------------------------------------------------------

function signIn(key) {
  state.adminKey = key;
  localStorage.setItem(KEY_STORAGE, key);
  el("login").hidden = true;
  el("app").hidden = false;
  connectWs();
  refreshAll();
}

function signOut() {
  state.adminKey = null;
  localStorage.removeItem(KEY_STORAGE);
  if (state.ws) state.ws.close();
  el("app").hidden = true;
  el("login").hidden = false;
}

// ---- WebSocket live updates ----------------------------------------------

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.adminKey)}`);
  state.ws = ws;
  ws.onopen = () => setWsStatus(true);
  ws.onclose = () => {
    setWsStatus(false);
    // Reconnect while still signed in.
    if (state.adminKey) setTimeout(connectWs, 3000);
  };
  ws.onmessage = (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    if (msg.type === "device.updated" || msg.type === "metrics" || msg.type === "job.updated") {
      refreshDevices();
      if (state.selectedId) renderDetail(state.selectedId);
    }
    if (msg.type === "alert") {
      refreshAlerts();
      toast("New alert raised");
    }
  };
}

function setWsStatus(online) {
  const pill = el("ws-status");
  pill.textContent = online ? "live" : "offline";
  pill.className = `pill ${online ? "pill-on" : "pill-off"}`;
}

// ---- Rendering: devices ---------------------------------------------------

async function refreshAll() {
  await Promise.all([refreshDevices(), refreshAlerts(), refreshRules()]);
}

async function refreshDevices() {
  try {
    const { devices } = await api("/devices");
    state.devices = devices;
    renderDeviceList();
    if (state.selectedId) renderDetail(state.selectedId);
  } catch (err) {
    toast(err.message);
  }
}

function renderDeviceList() {
  const list = el("device-list");
  el("device-count").textContent = `${state.devices.length} total`;
  list.innerHTML = "";
  if (state.devices.length === 0) {
    list.innerHTML = `<li class="muted">No devices enrolled yet.</li>`;
    return;
  }
  for (const d of state.devices) {
    const li = document.createElement("li");
    li.className = "device-item" + (d.id === state.selectedId ? " selected" : "");
    const m = d.latestMetrics;
    li.innerHTML = `
      <div class="name">
        <span class="status-dot ${d.online ? "online" : ""}"></span>
        ${escapeHtml(d.info.hostname)}
      </div>
      <div class="muted" style="font-size:12px">${escapeHtml(d.info.platform)} · ${escapeHtml(d.info.arch)}</div>
      <div class="mini-metrics">
        <span>CPU ${m ? fmt(m.cpuPercent) : "–"}%</span>
        <span>MEM ${m ? fmt(m.memoryPercent) : "–"}%</span>
        <span>DISK ${m ? fmt(m.diskPercent) : "–"}%</span>
      </div>`;
    li.onclick = () => {
      state.selectedId = d.id;
      renderDeviceList();
      renderDetail(d.id);
    };
    list.appendChild(li);
  }
}

async function renderDetail(deviceId) {
  const device = state.devices.find((d) => d.id === deviceId);
  if (!device) {
    el("device-detail").innerHTML = `<div class="empty">Device not found.</div>`;
    return;
  }
  const m = device.latestMetrics;
  const info = device.info;
  const detail = el("device-detail");
  detail.className = "";
  detail.innerHTML = `
    <div class="card">
      <h3>
        <span class="status-dot ${device.online ? "online" : ""}"></span>
        ${escapeHtml(info.hostname)}
        <span class="badge">${device.online ? "online" : "offline"}</span>
      </h3>
      <div class="gauge-grid">
        ${gauge("CPU", m && m.cpuPercent, "%")}
        ${gauge("Memory", m && m.memoryPercent, "%")}
        ${gauge("Disk", m && m.diskPercent, "%")}
        ${gauge("Load (1m)", m && m.load1, "", 100)}
      </div>
    </div>

    <div class="card">
      <h3>System</h3>
      <dl class="kv">
        <dt>OS</dt><dd>${escapeHtml(info.platform)} ${escapeHtml(info.osRelease)} (${escapeHtml(info.arch)})</dd>
        <dt>CPU</dt><dd>${escapeHtml(info.cpuModel)} × ${info.cpuCores}</dd>
        <dt>Memory</dt><dd>${bytes(info.totalMemoryBytes)}</dd>
        <dt>Disk</dt><dd>${m ? `${bytes(m.usedDiskBytes)} / ${bytes(m.totalDiskBytes)}` : "–"}</dd>
        <dt>Uptime</dt><dd>${m ? duration(m.uptimeSeconds) : "–"}</dd>
        <dt>Processes</dt><dd>${m ? m.processCount : "–"}</dd>
        <dt>Last seen</dt><dd>${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "never"}</dd>
        <dt>Agent</dt><dd>v${escapeHtml(info.agentVersion)}</dd>
        <dt>Device ID</dt><dd>${escapeHtml(device.id)}</dd>
      </dl>
    </div>

    <div class="card console">
      <h3>Run command</h3>
      <textarea id="cmd-input" placeholder="e.g. uptime && df -h"></textarea>
      <div class="console-row">
        <select id="cmd-type">
          <option value="shell">shell</option>
          <option value="script">script</option>
          <option value="ping">ping</option>
        </select>
        <button id="run-btn">Run on device</button>
        <span class="muted">Runs with the agent's privileges.</span>
      </div>
    </div>

    <div class="card">
      <h3>Recent jobs</h3>
      <div id="job-list"><span class="muted">Loading…</span></div>
    </div>`;

  el("run-btn").onclick = () => runCommand(deviceId);
  renderJobs(deviceId);
}

function gauge(label, value, unit, max = 100) {
  const has = typeof value === "number";
  const pct = has ? Math.min(100, (value / max) * 100) : 0;
  const cls = pct >= 90 ? "crit" : pct >= 75 ? "warn" : "";
  return `
    <div class="gauge">
      <div class="label">${label}</div>
      <div class="value">${has ? fmt(value) : "–"}${unit}</div>
      <div class="bar ${cls}"><span style="width:${pct}%"></span></div>
    </div>`;
}

async function renderJobs(deviceId) {
  try {
    const { jobs } = await api(`/devices/${deviceId}/jobs?limit=20`);
    const container = el("job-list");
    if (!container) return;
    if (jobs.length === 0) {
      container.innerHTML = `<span class="muted">No jobs yet.</span>`;
      return;
    }
    const rows = await Promise.all(jobs.map(async (j) => {
      const full = await api(`/jobs/${j.id}`);
      const r = full.job.result;
      const out = r ? [r.stdout, r.stderr].filter(Boolean).join("\n") : "";
      return `
        <div class="job">
          <div class="job-head">
            <span><strong>${escapeHtml(j.type)}</strong> · ${new Date(j.createdAt).toLocaleTimeString()}</span>
            <span class="badge ${j.status}">${j.status}${r && r.exitCode !== null ? ` · exit ${r.exitCode}` : ""}</span>
          </div>
          ${j.payload ? `<div class="muted" style="margin-top:4px">${escapeHtml(j.payload)}</div>` : ""}
          ${out ? `<pre>${escapeHtml(out)}</pre>` : ""}
        </div>`;
    }));
    container.innerHTML = rows.join("");
  } catch (err) {
    toast(err.message);
  }
}

async function runCommand(deviceId) {
  const type = el("cmd-type").value;
  const payload = el("cmd-input").value;
  if (type !== "ping" && !payload.trim()) {
    toast("Enter a command first.");
    return;
  }
  try {
    await api(`/devices/${deviceId}/jobs`, {
      method: "POST",
      body: JSON.stringify({ type, payload }),
    });
    el("cmd-input").value = "";
    toast("Job queued — it runs on the next heartbeat.");
    renderJobs(deviceId);
  } catch (err) {
    toast(err.message);
  }
}

// ---- Rendering: alerts ----------------------------------------------------

async function refreshAlerts() {
  try {
    const { alerts } = await api(`/alerts?all=${state.showAck}`);
    const list = el("alert-list");
    list.innerHTML = "";
    if (alerts.length === 0) {
      list.innerHTML = `<li class="muted">No alerts.</li>`;
      return;
    }
    for (const a of alerts) {
      const li = document.createElement("li");
      li.className = `alert-item ${a.severity}` + (a.acknowledgedAt ? " ack" : "");
      li.innerHTML = `
        <div>
          <div><strong>${escapeHtml(a.severity.toUpperCase())}</strong> · ${escapeHtml(a.message)}</div>
          <div class="muted" style="font-size:12px">${new Date(a.createdAt).toLocaleString()}</div>
        </div>
        ${a.acknowledgedAt ? `<span class="muted">acknowledged</span>` : `<button data-ack="${a.id}">Acknowledge</button>`}`;
      list.appendChild(li);
    }
    list.querySelectorAll("[data-ack]").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/alerts/${btn.dataset.ack}/acknowledge`, { method: "POST" });
          refreshAlerts();
        } catch (err) {
          toast(err.message);
        }
      };
    });
  } catch (err) {
    toast(err.message);
  }
}

// ---- Rendering: rules -----------------------------------------------------

async function refreshRules() {
  try {
    const { rules } = await api("/alert-rules");
    const list = el("rule-list");
    list.innerHTML = "";
    if (rules.length === 0) {
      list.innerHTML = `<li class="muted">No alert rules defined.</li>`;
      return;
    }
    const ops = { gt: ">", gte: "≥", lt: "<", lte: "≤" };
    for (const r of rules) {
      const li = document.createElement("li");
      li.className = "rule-item";
      li.innerHTML = `
        <div>
          <strong>${escapeHtml(r.name)}</strong>
          <span class="muted">— ${r.metric} ${ops[r.comparator]} ${r.threshold} → ${r.severity}</span>
        </div>
        <button class="danger" data-del="${r.id}">Delete</button>`;
      list.appendChild(li);
    }
    list.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/alert-rules/${btn.dataset.del}`, { method: "DELETE" });
          refreshRules();
        } catch (err) {
          toast(err.message);
        }
      };
    });
  } catch (err) {
    toast(err.message);
  }
}

// ---- Formatting helpers ---------------------------------------------------

function fmt(n) {
  return typeof n === "number" ? Math.round(n * 10) / 10 : "–";
}

function bytes(n) {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function duration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d ? `${d}d` : "", h ? `${h}h` : "", `${m}m`].filter(Boolean).join(" ");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

let toastTimer = null;
function toast(message) {
  const t = el("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function el(id) {
  return document.getElementById(id);
}

// ---- Wiring ---------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  el("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const key = el("admin-key").value.trim();
    if (!key) return;
    // Probe the key with a lightweight request before committing.
    state.adminKey = key;
    api("/devices")
      .then(() => signIn(key))
      .catch((err) => {
        state.adminKey = null;
        const errEl = el("login-error");
        errEl.textContent = err.message;
        errEl.hidden = false;
      });
  });

  el("logout").addEventListener("click", signOut);

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      el(`tab-${tab.dataset.tab}`).classList.add("active");
    });
  });

  el("show-ack").addEventListener("change", (e) => {
    state.showAck = e.target.checked;
    refreshAlerts();
  });

  el("rule-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = {
      name: form.name.value.trim(),
      metric: form.metric.value,
      comparator: form.comparator.value,
      threshold: Number(form.threshold.value),
      severity: form.severity.value,
    };
    try {
      await api("/alert-rules", { method: "POST", body: JSON.stringify(body) });
      form.reset();
      refreshRules();
      toast("Rule added");
    } catch (err) {
      toast(err.message);
    }
  });

  // Auto-login if a key is stored.
  const saved = localStorage.getItem(KEY_STORAGE);
  if (saved) {
    state.adminKey = saved;
    api("/devices")
      .then(() => signIn(saved))
      .catch(() => signOut());
  }
});
