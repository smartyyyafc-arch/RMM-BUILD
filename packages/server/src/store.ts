import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Alert,
  AlertRule,
  Device,
  DeviceInfo,
  Job,
  JobResult,
  JobType,
  MetricsSample,
} from "@rmm/shared";
import { hashToken } from "./auth.js";

/**
 * The Store is the only place that talks SQL. Routes call typed methods and
 * receive shared-package types back, so the wire contract and the storage
 * schema stay decoupled.
 */
export class Store {
  constructor(
    private readonly db: DatabaseSync,
    private readonly offlineAfterSeconds: number
  ) {}

  // ---- Devices -----------------------------------------------------------

  /** Creates a new device, or updates the existing one matching machineId. */
  enrollDevice(info: DeviceInfo, agentToken: string, machineId: string | null): string {
    const now = Date.now();
    const tokenHash = hashToken(agentToken);

    if (machineId) {
      const existing = this.db
        .prepare("SELECT id FROM devices WHERE machine_id = ?")
        .get(machineId) as { id: string } | undefined;
      if (existing) {
        this.db
          .prepare(
            "UPDATE devices SET agent_token_hash = ?, info_json = ?, last_seen_at = ? WHERE id = ?"
          )
          .run(tokenHash, JSON.stringify(info), now, existing.id);
        return existing.id;
      }
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO devices (id, machine_id, agent_token_hash, info_json, enrolled_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, machineId, tokenHash, JSON.stringify(info), now, null);
    return id;
  }

  /** Returns the device id whose token matches, or null. */
  authenticateAgent(deviceId: string, agentToken: string): boolean {
    const row = this.db
      .prepare("SELECT agent_token_hash FROM devices WHERE id = ?")
      .get(deviceId) as { agent_token_hash: string } | undefined;
    if (!row) return false;
    return row.agent_token_hash === hashToken(agentToken);
  }

  updateHeartbeat(deviceId: string, info: DeviceInfo, now: number): void {
    this.db
      .prepare("UPDATE devices SET info_json = ?, last_seen_at = ? WHERE id = ?")
      .run(JSON.stringify(info), now, deviceId);
  }

  getDevice(deviceId: string): Device | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as
      | DeviceRow
      | undefined;
    if (!row) return null;
    return this.toDevice(row);
  }

  listDevices(): Device[] {
    const rows = this.db
      .prepare("SELECT * FROM devices ORDER BY info_json")
      .all() as unknown as DeviceRow[];
    return rows.map((r) => this.toDevice(r));
  }

  deleteDevice(deviceId: string): boolean {
    const res = this.db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
    return Number(res.changes) > 0;
  }

  private toDevice(row: DeviceRow): Device {
    const online =
      row.last_seen_at !== null &&
      Date.now() - row.last_seen_at <= this.offlineAfterSeconds * 1000;
    return {
      id: row.id,
      info: JSON.parse(row.info_json) as DeviceInfo,
      machineId: row.machine_id,
      enrolledAt: row.enrolled_at,
      lastSeenAt: row.last_seen_at,
      online,
      latestMetrics: this.latestMetrics(row.id),
    };
  }

  // ---- Metrics -----------------------------------------------------------

  insertMetrics(deviceId: string, sample: MetricsSample): void {
    this.db
      .prepare("INSERT INTO metrics (device_id, timestamp, sample_json) VALUES (?, ?, ?)")
      .run(deviceId, sample.timestamp, JSON.stringify(sample));
  }

  latestMetrics(deviceId: string): MetricsSample | null {
    const row = this.db
      .prepare("SELECT sample_json FROM metrics WHERE device_id = ? ORDER BY timestamp DESC LIMIT 1")
      .get(deviceId) as { sample_json: string } | undefined;
    return row ? (JSON.parse(row.sample_json) as MetricsSample) : null;
  }

  metricsSince(deviceId: string, sinceMs: number, limit: number): MetricsSample[] {
    const rows = this.db
      .prepare(
        `SELECT sample_json FROM metrics
         WHERE device_id = ? AND timestamp >= ?
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(deviceId, sinceMs, limit) as { sample_json: string }[];
    return rows.map((r) => JSON.parse(r.sample_json) as MetricsSample).reverse();
  }

  // ---- Jobs --------------------------------------------------------------

  createJob(deviceId: string, type: JobType, payload: string, timeoutSeconds: number): Job {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO jobs (id, device_id, type, payload, status, timeout_seconds, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(id, deviceId, type, payload, timeoutSeconds, now);
    return {
      id,
      deviceId,
      type,
      payload,
      status: "pending",
      createdAt: now,
      timeoutSeconds,
    };
  }

  /** Atomically claims all pending jobs for a device, marking them running. */
  claimPendingJobs(deviceId: string, now: number): Job[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE device_id = ? AND status = 'pending' ORDER BY created_at")
      .all(deviceId) as unknown as JobRow[];
    const claim = this.db.prepare(
      "UPDATE jobs SET status = 'running', dispatched_at = ? WHERE id = ? AND status = 'pending'"
    );
    const claimed: Job[] = [];
    for (const row of rows) {
      const res = claim.run(now, row.id);
      if (Number(res.changes) > 0) claimed.push(this.toJob({ ...row, status: "running" }));
    }
    return claimed;
  }

  recordJobResult(jobId: string, deviceId: string, result: JobResult): boolean {
    const res = this.db
      .prepare(
        `UPDATE jobs SET status = ?, finished_at = ?, result_json = ?
         WHERE id = ? AND device_id = ? AND status = 'running'`
      )
      .run(result.status, result.finishedAt, JSON.stringify(result), jobId, deviceId);
    return Number(res.changes) > 0;
  }

  listJobs(deviceId: string, limit: number): Job[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE device_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(deviceId, limit) as unknown as JobRow[];
    return rows.map((r) => this.toJob(r));
  }

  getJob(jobId: string): (Job & { result: JobResult | null }) | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as
      | JobRow
      | undefined;
    if (!row) return null;
    return {
      ...this.toJob(row),
      result: row.result_json ? (JSON.parse(row.result_json) as JobResult) : null,
    };
  }

  private toJob(row: JobRow): Job {
    return {
      id: row.id,
      deviceId: row.device_id,
      type: row.type as JobType,
      payload: row.payload,
      status: row.status as Job["status"],
      createdAt: row.created_at,
      timeoutSeconds: row.timeout_seconds,
    };
  }

  // ---- Alert rules -------------------------------------------------------

  createAlertRule(rule: Omit<AlertRule, "id">): AlertRule {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO alert_rules (id, name, metric, comparator, threshold, severity, enabled, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        rule.name,
        rule.metric,
        rule.comparator,
        rule.threshold,
        rule.severity,
        rule.enabled ? 1 : 0,
        rule.deviceId
      );
    return { id, ...rule };
  }

  listAlertRules(): AlertRule[] {
    const rows = this.db
      .prepare("SELECT * FROM alert_rules ORDER BY name")
      .all() as unknown as AlertRuleRow[];
    return rows.map((r) => this.toAlertRule(r));
  }

  deleteAlertRule(id: string): boolean {
    const res = this.db.prepare("DELETE FROM alert_rules WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  private toAlertRule(row: AlertRuleRow): AlertRule {
    return {
      id: row.id,
      name: row.name,
      metric: row.metric as AlertRule["metric"],
      comparator: row.comparator as AlertRule["comparator"],
      threshold: row.threshold,
      severity: row.severity as AlertRule["severity"],
      enabled: row.enabled === 1,
      deviceId: row.device_id,
    };
  }

  // ---- Alerts ------------------------------------------------------------

  createAlert(alert: Omit<Alert, "id" | "createdAt" | "acknowledgedAt">): Alert {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO alerts (id, rule_id, device_id, severity, message, value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, alert.ruleId, alert.deviceId, alert.severity, alert.message, alert.value, createdAt);
    return { id, createdAt, acknowledgedAt: null, ...alert };
  }

  /** True if an unacknowledged alert for this rule+device already exists. */
  hasOpenAlert(ruleId: string, deviceId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM alerts WHERE rule_id = ? AND device_id = ? AND acknowledged_at IS NULL LIMIT 1"
      )
      .get(ruleId, deviceId);
    return row !== undefined;
  }

  listAlerts(limit: number, includeAcknowledged: boolean): Alert[] {
    const sql = includeAcknowledged
      ? "SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM alerts WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT ?";
    const rows = this.db.prepare(sql).all(limit) as unknown as AlertRow[];
    return rows.map((r) => this.toAlert(r));
  }

  acknowledgeAlert(id: string): boolean {
    const res = this.db
      .prepare("UPDATE alerts SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL")
      .run(Date.now(), id);
    return Number(res.changes) > 0;
  }

  private toAlert(row: AlertRow): Alert {
    return {
      id: row.id,
      ruleId: row.rule_id,
      deviceId: row.device_id,
      severity: row.severity as Alert["severity"],
      message: row.message,
      value: row.value,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
    };
  }
}

// ---- Row shapes (raw SQLite results) -------------------------------------

interface DeviceRow {
  id: string;
  machine_id: string | null;
  agent_token_hash: string;
  info_json: string;
  enrolled_at: number;
  last_seen_at: number | null;
}

interface JobRow {
  id: string;
  device_id: string;
  type: string;
  payload: string;
  status: string;
  timeout_seconds: number;
  created_at: number;
  dispatched_at: number | null;
  finished_at: number | null;
  result_json: string | null;
}

interface AlertRuleRow {
  id: string;
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  severity: string;
  enabled: number;
  device_id: string | null;
}

interface AlertRow {
  id: string;
  rule_id: string | null;
  device_id: string;
  severity: string;
  message: string;
  value: number | null;
  created_at: number;
  acknowledged_at: number | null;
}
