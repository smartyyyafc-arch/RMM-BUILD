import type {
  AlertRule,
  AlertSeverity,
  Comparator,
  DeviceInfo,
  JobType,
  MetricField,
  MetricsSample,
} from "@rmm/shared";

/** Thrown when a request body fails validation. Mapped to HTTP 400. */
export class ValidationError extends Error {}

function str(obj: Record<string, unknown>, key: string, max = 4096): string {
  const v = obj[key];
  if (typeof v !== "string") throw new ValidationError(`"${key}" must be a string`);
  if (v.length > max) throw new ValidationError(`"${key}" exceeds ${max} characters`);
  return v;
}

function num(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ValidationError(`"${key}" must be a finite number`);
  }
  return v;
}

function obj(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], key: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`"${key}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseDeviceInfo(value: unknown): DeviceInfo {
  const o = obj(value, "info");
  return {
    hostname: str(o, "hostname", 255),
    platform: str(o, "platform", 64),
    arch: str(o, "arch", 32),
    osRelease: str(o, "osRelease", 255),
    cpuModel: str(o, "cpuModel", 255),
    cpuCores: num(o, "cpuCores"),
    totalMemoryBytes: num(o, "totalMemoryBytes"),
    agentVersion: str(o, "agentVersion", 32),
  };
}

export function parseMetricsSample(value: unknown): MetricsSample {
  const o = obj(value, "metrics");
  return {
    timestamp: num(o, "timestamp"),
    cpuPercent: num(o, "cpuPercent"),
    memoryPercent: num(o, "memoryPercent"),
    usedMemoryBytes: num(o, "usedMemoryBytes"),
    diskPercent: num(o, "diskPercent"),
    usedDiskBytes: num(o, "usedDiskBytes"),
    totalDiskBytes: num(o, "totalDiskBytes"),
    uptimeSeconds: num(o, "uptimeSeconds"),
    load1: num(o, "load1"),
    load5: num(o, "load5"),
    load15: num(o, "load15"),
    processCount: num(o, "processCount"),
  };
}

const JOB_TYPES: readonly JobType[] = ["shell", "script", "ping"];

export function parseJobCreate(value: unknown): {
  type: JobType;
  payload: string;
  timeoutSeconds: number;
} {
  const o = obj(value, "body");
  const type = oneOf(str(o, "type", 16), JOB_TYPES, "type");
  const payload = type === "ping" ? "" : str(o, "payload", 65536);
  let timeoutSeconds = 60;
  if (o.timeoutSeconds !== undefined) {
    timeoutSeconds = num(o, "timeoutSeconds");
    if (timeoutSeconds < 1 || timeoutSeconds > 3600) {
      throw new ValidationError('"timeoutSeconds" must be between 1 and 3600');
    }
  }
  return { type, payload, timeoutSeconds };
}

const METRIC_FIELDS: readonly MetricField[] = [
  "cpuPercent",
  "memoryPercent",
  "diskPercent",
  "load1",
];
const COMPARATORS: readonly Comparator[] = ["gt", "gte", "lt", "lte"];
const SEVERITIES: readonly AlertSeverity[] = ["info", "warning", "critical"];

export function parseAlertRule(value: unknown): Omit<AlertRule, "id"> {
  const o = obj(value, "body");
  return {
    name: str(o, "name", 128),
    metric: oneOf(str(o, "metric", 32), METRIC_FIELDS, "metric"),
    comparator: oneOf(str(o, "comparator", 8), COMPARATORS, "comparator"),
    threshold: num(o, "threshold"),
    severity: oneOf(str(o, "severity", 16), SEVERITIES, "severity"),
    enabled: o.enabled === undefined ? true : Boolean(o.enabled),
    deviceId: o.deviceId === undefined || o.deviceId === null ? null : str(o, "deviceId", 64),
  };
}
