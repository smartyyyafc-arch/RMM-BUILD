import { randomBytes } from "node:crypto";

/** Resolved server configuration, sourced from the environment with sane defaults. */
export interface Config {
  port: number;
  dbPath: string;
  adminKey: string;
  enrollmentToken: string;
  offlineAfterSeconds: number;
  heartbeatIntervalSeconds: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

/**
 * Secrets fall back to a random value so the server never boots with a
 * predictable key. A warning is printed so operators know to pin the value.
 */
function envSecret(name: string, label: string): string {
  const raw = process.env[name];
  if (raw && raw.trim() !== "" && raw !== `change-me-${label}`) {
    return raw;
  }
  const generated = randomBytes(24).toString("hex");
  // eslint-disable-next-line no-console
  console.warn(
    `[config] ${name} is unset or default; generated an ephemeral ${label}. ` +
      `Set ${name} in the environment to keep it stable across restarts.`
  );
  // eslint-disable-next-line no-console
  console.warn(`[config]   ${name}=${generated}`);
  return generated;
}

export function loadConfig(): Config {
  return {
    port: envInt("PORT", 8080),
    dbPath: process.env.RMM_DB_PATH?.trim() || "./data/rmm.db",
    adminKey: envSecret("RMM_ADMIN_KEY", "admin-key"),
    enrollmentToken: envSecret("RMM_ENROLLMENT_TOKEN", "enrollment-token"),
    offlineAfterSeconds: envInt("RMM_OFFLINE_AFTER_SECONDS", 120),
    heartbeatIntervalSeconds: envInt("RMM_HEARTBEAT_INTERVAL_SECONDS", 30),
  };
}
