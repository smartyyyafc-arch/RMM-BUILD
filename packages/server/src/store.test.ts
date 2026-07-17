import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "./db.js";
import { Store } from "./store.js";
import { evaluateRules } from "./alerts.js";
import type { DeviceInfo, MetricsSample } from "@rmm/shared";

function sampleInfo(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    hostname: "test-host",
    platform: "linux",
    arch: "x64",
    osRelease: "6.0.0",
    cpuModel: "Test CPU",
    cpuCores: 4,
    totalMemoryBytes: 8 * 1024 ** 3,
    agentVersion: "0.1.0",
    ...overrides,
  };
}

function sampleMetrics(overrides: Partial<MetricsSample> = {}): MetricsSample {
  return {
    timestamp: Date.now(),
    cpuPercent: 10,
    memoryPercent: 20,
    usedMemoryBytes: 1024,
    diskPercent: 30,
    usedDiskBytes: 1024,
    totalDiskBytes: 2048,
    uptimeSeconds: 100,
    load1: 0.1,
    load5: 0.2,
    load15: 0.3,
    processCount: 42,
    ...overrides,
  };
}

function freshStore(): Store {
  return new Store(openDatabase(":memory:"), 120);
}

test("enroll creates a device and re-enroll updates by machineId", () => {
  const store = freshStore();
  const id1 = store.enrollDevice(sampleInfo(), "token-a", "machine-1");
  const id2 = store.enrollDevice(sampleInfo({ hostname: "renamed" }), "token-b", "machine-1");
  assert.equal(id1, id2, "same machineId should reuse device");
  assert.equal(store.listDevices().length, 1);
  assert.equal(store.getDevice(id1)?.info.hostname, "renamed");
});

test("agent authentication uses hashed token", () => {
  const store = freshStore();
  const id = store.enrollDevice(sampleInfo(), "secret-token", "m1");
  assert.equal(store.authenticateAgent(id, "secret-token"), true);
  assert.equal(store.authenticateAgent(id, "wrong-token"), false);
});

test("jobs are claimed once and results recorded", () => {
  const store = freshStore();
  const id = store.enrollDevice(sampleInfo(), "t", "m1");
  const job = store.createJob(id, "shell", "echo hi", 60);

  const firstClaim = store.claimPendingJobs(id, Date.now());
  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0].id, job.id);

  // A second claim returns nothing — the job is already running.
  assert.equal(store.claimPendingJobs(id, Date.now()).length, 0);

  const ok = store.recordJobResult(job.id, id, {
    status: "succeeded",
    exitCode: 0,
    stdout: "hi",
    stderr: "",
    startedAt: Date.now(),
    finishedAt: Date.now(),
  });
  assert.equal(ok, true);
  assert.equal(store.getJob(job.id)?.status, "succeeded");
});

test("alert rules raise one alert and de-duplicate while open", () => {
  const store = freshStore();
  const id = store.enrollDevice(sampleInfo(), "t", "m1");
  store.createAlertRule({
    name: "High CPU",
    metric: "cpuPercent",
    comparator: "gt",
    threshold: 90,
    severity: "critical",
    enabled: true,
    deviceId: null,
  });

  // Below threshold: no alert.
  assert.equal(evaluateRules(store, id, "test-host", sampleMetrics({ cpuPercent: 50 })), 0);
  // Above threshold: one alert.
  assert.equal(evaluateRules(store, id, "test-host", sampleMetrics({ cpuPercent: 95 })), 1);
  // Still above, but alert already open: de-duplicated.
  assert.equal(evaluateRules(store, id, "test-host", sampleMetrics({ cpuPercent: 99 })), 0);
  assert.equal(store.listAlerts(10, false).length, 1);
});

test("metrics history is returned in chronological order", () => {
  const store = freshStore();
  const id = store.enrollDevice(sampleInfo(), "t", "m1");
  const base = Date.now();
  store.insertMetrics(id, sampleMetrics({ timestamp: base + 200 }));
  store.insertMetrics(id, sampleMetrics({ timestamp: base + 100 }));
  store.insertMetrics(id, sampleMetrics({ timestamp: base + 300 }));
  const history = store.metricsSince(id, base, 10);
  assert.deepEqual(
    history.map((m) => m.timestamp),
    [base + 100, base + 200, base + 300]
  );
});
