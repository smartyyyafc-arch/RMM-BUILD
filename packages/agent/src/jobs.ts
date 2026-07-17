import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { writeFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job, JobResult } from "@rmm/shared";

const MAX_OUTPUT_BYTES = 512 * 1024; // cap captured output per stream

/**
 * Executes a job on this host and returns its result.
 *
 * - `shell`  : runs the payload through the platform shell.
 * - `script` : writes the payload to a temp file and executes it (bash on
 *              POSIX, PowerShell on Windows), so multi-line scripts work.
 * - `ping`   : a no-op health check that always succeeds.
 *
 * Jobs run with the privileges of the agent process. Output is truncated to
 * keep a runaway command from exhausting memory.
 */
export async function executeJob(job: Job): Promise<JobResult> {
  const startedAt = Date.now();
  if (job.type === "ping") {
    return {
      status: "succeeded",
      exitCode: 0,
      stdout: "pong",
      stderr: "",
      startedAt,
      finishedAt: Date.now(),
    };
  }

  if (job.type === "script") {
    return runScript(job, startedAt);
  }
  return runShell(job.payload, job.timeoutSeconds, startedAt);
}

function runShell(command: string, timeoutSeconds: number, startedAt: number): Promise<JobResult> {
  const isWin = process.platform === "win32";
  const [cmd, args] = isWin
    ? ["powershell", ["-NoProfile", "-Command", command]]
    : ["/bin/sh", ["-c", command]];
  return runProcess(cmd, args as string[], timeoutSeconds, startedAt);
}

async function runScript(job: Job, startedAt: number): Promise<JobResult> {
  const isWin = process.platform === "win32";
  const ext = isWin ? "ps1" : "sh";
  const file = join(tmpdir(), `rmm-job-${randomUUID()}.${ext}`);
  try {
    const body = isWin ? job.payload : `#!/bin/sh\n${job.payload}`;
    await writeFile(file, body, "utf8");
    if (!isWin) await chmod(file, 0o700);
    const [cmd, args] = isWin
      ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file]]
      : ["/bin/sh", [file]];
    return await runProcess(cmd, args as string[], job.timeoutSeconds, startedAt);
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

function runProcess(
  command: string,
  args: string[],
  timeoutSeconds: number,
  startedAt: number
): Promise<JobResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        status: "failed",
        exitCode: null,
        stdout: truncate(stdout),
        stderr: truncate(stderr || String(err)),
        startedAt,
        finishedAt: Date.now(),
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        stderr += `\n[agent] job killed after ${timeoutSeconds}s timeout`;
      }
      resolve({
        status: code === 0 && !killedByTimeout ? "succeeded" : "failed",
        exitCode: code,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        startedAt,
        finishedAt: Date.now(),
      });
    });
  });
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return text.slice(0, MAX_OUTPUT_BYTES) + "\n[agent] output truncated";
}
