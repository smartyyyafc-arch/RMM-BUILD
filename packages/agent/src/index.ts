import { readFile, writeFile } from "node:fs/promises";
import { loadAgentConfig, type AgentConfig } from "./config.js";
import { collectDeviceInfo, collectMetrics } from "./metrics.js";
import { executeJob } from "./jobs.js";
import { ApiClient, UnauthorizedError } from "./client.js";

interface AgentState {
  deviceId: string;
  agentToken: string;
}

/** Loads persisted enrollment state, or null on first run. */
async function loadState(path: string): Promise<AgentState | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentState>;
    if (parsed.deviceId && parsed.agentToken) {
      return { deviceId: parsed.deviceId, agentToken: parsed.agentToken };
    }
    return null;
  } catch {
    return null;
  }
}

async function saveState(path: string, state: AgentState): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function enroll(config: AgentConfig, client: ApiClient): Promise<AgentState> {
  const info = collectDeviceInfo();
  const res = await client.enroll(config.enrollmentToken, info, config.machineId);
  const state: AgentState = { deviceId: res.deviceId, agentToken: res.agentToken };
  await saveState(config.statePath, state);
  client.setToken(state.agentToken);
  log(`enrolled as device ${state.deviceId}`);
  return state;
}

let heartbeatIntervalSeconds = 30;
let stopped = false;

async function heartbeatOnce(client: ApiClient, state: AgentState): Promise<void> {
  const info = collectDeviceInfo();
  const metrics = await collectMetrics();
  const res = await client.heartbeat(state.deviceId, info, metrics);
  heartbeatIntervalSeconds = res.heartbeatIntervalSeconds || heartbeatIntervalSeconds;

  for (const job of res.jobs) {
    log(`executing job ${job.id} (${job.type})`);
    try {
      const result = await executeJob(job);
      await client.reportJobResult(state.deviceId, job.id, result);
      log(`job ${job.id} ${result.status} (exit ${result.exitCode})`);
    } catch (err) {
      log(`job ${job.id} error: ${(err as Error).message}`);
    }
  }
}

async function run(): Promise<void> {
  const config = loadAgentConfig();
  const client = new ApiClient(config.serverUrl, null);

  let state = await loadState(config.statePath);
  if (state) {
    client.setToken(state.agentToken);
    log(`resuming as device ${state.deviceId}`);
  } else {
    state = await enroll(config, client);
  }

  log(`agent started; reporting to ${config.serverUrl}`);
  while (!stopped) {
    try {
      await heartbeatOnce(client, state);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        log("token rejected; re-enrolling");
        state = await enroll(config, client);
      } else {
        log(`heartbeat error: ${(err as Error).message}`);
      }
    }
    await delay(heartbeatIntervalSeconds * 1000);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[agent] ${new Date().toISOString()} ${message}`);
}

process.on("SIGINT", () => {
  stopped = true;
  log("received SIGINT, stopping");
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopped = true;
  log("received SIGTERM, stopping");
  process.exit(0);
});

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[agent] fatal: ${(err as Error).message}`);
  process.exit(1);
});
