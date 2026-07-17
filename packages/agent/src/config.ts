import { hostname } from "node:os";

/** Agent configuration, sourced from environment variables. */
export interface AgentConfig {
  serverUrl: string;
  enrollmentToken: string;
  /** Stable machine identifier so re-enrollment maps to the same device. */
  machineId: string;
  /** Where the agent persists its issued token between restarts. */
  statePath: string;
}

export function loadAgentConfig(): AgentConfig {
  const serverUrl = process.env.RMM_SERVER_URL?.replace(/\/$/, "");
  if (!serverUrl) {
    throw new Error("RMM_SERVER_URL is required (e.g. https://rmm.example.com)");
  }
  const enrollmentToken = process.env.RMM_ENROLLMENT_TOKEN ?? "";
  if (!enrollmentToken) {
    throw new Error("RMM_ENROLLMENT_TOKEN is required to enroll the agent");
  }
  return {
    serverUrl,
    enrollmentToken,
    machineId: process.env.RMM_MACHINE_ID?.trim() || defaultMachineId(),
    statePath: process.env.RMM_AGENT_STATE?.trim() || "./agent-state.json",
  };
}

/** Derives a stable-ish machine id from the hostname when none is provided. */
function defaultMachineId(): string {
  return `host-${hostname()}`;
}
