import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceInfo, MetricsSample } from "@rmm/shared";

const execFileAsync = promisify(execFile);

/** The agent's advertised version, kept in sync with package.json. */
export const AGENT_VERSION = "0.1.0";

/** Gathers static device facts. Cheap; recomputed each heartbeat. */
export function collectDeviceInfo(): DeviceInfo {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel: cpus[0]?.model?.trim() ?? "unknown",
    cpuCores: cpus.length,
    totalMemoryBytes: os.totalmem(),
    agentVersion: AGENT_VERSION,
  };
}

interface CpuTimesSnapshot {
  idle: number;
  total: number;
}

function cpuSnapshot(): CpuTimesSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * CPU utilisation is the fraction of non-idle time between two snapshots.
 * We sample, wait a short interval, then sample again.
 */
async function cpuPercent(sampleMs = 500): Promise<number> {
  const start = cpuSnapshot();
  await delay(sampleMs);
  const end = cpuSnapshot();
  const idleDelta = end.idle - start.idle;
  const totalDelta = end.total - start.total;
  if (totalDelta <= 0) return 0;
  const usage = (1 - idleDelta / totalDelta) * 100;
  return clampPercent(usage);
}

interface DiskUsage {
  usedBytes: number;
  totalBytes: number;
  percent: number;
}

/**
 * Disk usage for the root/system volume. Uses `df` on POSIX and PowerShell on
 * Windows. Failures degrade gracefully to zeros rather than crashing the agent.
 */
async function diskUsage(): Promise<DiskUsage> {
  try {
    if (process.platform === "win32") {
      return await windowsDiskUsage();
    }
    return await posixDiskUsage();
  } catch {
    return { usedBytes: 0, totalBytes: 0, percent: 0 };
  }
}

async function posixDiskUsage(): Promise<DiskUsage> {
  // -k = 1K blocks, -P = POSIX output (stable columns).
  const { stdout } = await execFileAsync("df", ["-k", "-P", "/"], { timeout: 5000 });
  const lines = stdout.trim().split("\n");
  const cols = lines[lines.length - 1].split(/\s+/);
  const totalKb = Number(cols[1]);
  const usedKb = Number(cols[2]);
  const totalBytes = totalKb * 1024;
  const usedBytes = usedKb * 1024;
  const percent = totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0;
  return { usedBytes, totalBytes, percent };
}

async function windowsDiskUsage(): Promise<DiskUsage> {
  const script =
    "$d = Get-PSDrive -Name (Get-Location).Drive.Name; " +
    "Write-Output ($d.Used); Write-Output ($d.Free)";
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
    timeout: 8000,
  });
  const [usedStr, freeStr] = stdout.trim().split(/\r?\n/);
  const usedBytes = Number(usedStr);
  const freeBytes = Number(freeStr);
  const totalBytes = usedBytes + freeBytes;
  const percent = totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0;
  return { usedBytes, totalBytes, percent };
}

/** Best-effort running-process count. Zero if it cannot be determined. */
async function processCount(): Promise<number> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-Command", "(Get-Process).Count"],
        { timeout: 8000 }
      );
      return Number(stdout.trim()) || 0;
    }
    const { stdout } = await execFileAsync("ps", ["-e"], { timeout: 5000 });
    // Subtract the header line.
    return Math.max(0, stdout.trim().split("\n").length - 1);
  } catch {
    return 0;
  }
}

/** Collects a full metrics sample. */
export async function collectMetrics(): Promise<MetricsSample> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const [cpu, disk, procs] = await Promise.all([cpuPercent(), diskUsage(), processCount()]);
  const [load1, load5, load15] = os.loadavg();

  return {
    timestamp: Date.now(),
    cpuPercent: round2(cpu),
    memoryPercent: round2(totalMem > 0 ? (usedMem / totalMem) * 100 : 0),
    usedMemoryBytes: usedMem,
    diskPercent: round2(disk.percent),
    usedDiskBytes: disk.usedBytes,
    totalDiskBytes: disk.totalBytes,
    uptimeSeconds: Math.round(os.uptime()),
    load1: round2(load1),
    load5: round2(load5),
    load15: round2(load15),
    processCount: procs,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
