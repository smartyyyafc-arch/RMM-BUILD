/**
 * Shared types and constants used by the RMM server and agent.
 *
 * Keeping the wire contract in one place means the agent and server can never
 * drift out of sync on field names or job semantics.
 */

/** Current protocol version. Bumped when the agent<->server contract changes. */
export const PROTOCOL_VERSION = 1;

/** Job lifecycle states. */
export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";

/** The kinds of work an agent knows how to execute. */
export type JobType = "shell" | "script" | "ping";

/** Severity levels for alerts. */
export type AlertSeverity = "info" | "warning" | "critical";

/** Comparison operators supported by metric-threshold alert rules. */
export type Comparator = "gt" | "gte" | "lt" | "lte";

/** A metric that an alert rule can watch. */
export type MetricField =
  | "cpuPercent"
  | "memoryPercent"
  | "diskPercent"
  | "load1";

/** Static facts about a device, reported at enrollment and refreshed on heartbeat. */
export interface DeviceInfo {
  hostname: string;
  platform: string; // e.g. "linux", "darwin", "win32"
  arch: string; // e.g. "x64", "arm64"
  osRelease: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryBytes: number;
  agentVersion: string;
}

/** A point-in-time sample of a device's health. */
export interface MetricsSample {
  /** Unix epoch milliseconds when the sample was collected on the agent. */
  timestamp: number;
  cpuPercent: number;
  memoryPercent: number;
  usedMemoryBytes: number;
  diskPercent: number;
  usedDiskBytes: number;
  totalDiskBytes: number;
  uptimeSeconds: number;
  load1: number;
  load5: number;
  load15: number;
  processCount: number;
}

/** Request body for POST /api/enroll. */
export interface EnrollRequest {
  enrollmentToken: string;
  info: DeviceInfo;
  /** Optional stable identifier so re-enrollment updates the same device. */
  machineId?: string;
}

/** Response body for POST /api/enroll. */
export interface EnrollResponse {
  deviceId: string;
  agentToken: string;
  heartbeatIntervalSeconds: number;
}

/** A unit of work dispatched from the server to an agent. */
export interface Job {
  id: string;
  deviceId: string;
  type: JobType;
  /** For "shell"/"script": the command or script body. For "ping": ignored. */
  payload: string;
  status: JobStatus;
  createdAt: number;
  /** Seconds before the agent gives up on a running job. */
  timeoutSeconds: number;
}

/** Result of executing a job, reported by the agent. */
export interface JobResult {
  status: Extract<JobStatus, "succeeded" | "failed">;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  finishedAt: number;
}

/** Request body for POST /api/agents/heartbeat. */
export interface HeartbeatRequest {
  info: DeviceInfo;
  metrics: MetricsSample;
}

/** Response body for POST /api/agents/heartbeat. */
export interface HeartbeatResponse {
  /** Jobs the agent should execute now. */
  jobs: Job[];
  heartbeatIntervalSeconds: number;
}

/** A device as returned by the admin API. */
export interface Device {
  id: string;
  info: DeviceInfo;
  machineId: string | null;
  enrolledAt: number;
  lastSeenAt: number | null;
  online: boolean;
  latestMetrics: MetricsSample | null;
}

/** An alert rule that raises an alert when a metric crosses a threshold. */
export interface AlertRule {
  id: string;
  name: string;
  metric: MetricField;
  comparator: Comparator;
  threshold: number;
  severity: AlertSeverity;
  enabled: boolean;
  /** Optional: limit the rule to a single device. Null = all devices. */
  deviceId: string | null;
}

/** A raised alert instance. */
export interface Alert {
  id: string;
  ruleId: string | null;
  deviceId: string;
  severity: AlertSeverity;
  message: string;
  value: number | null;
  createdAt: number;
  acknowledgedAt: number | null;
}

/** Standard error envelope returned by the API. */
export interface ApiError {
  error: string;
}
