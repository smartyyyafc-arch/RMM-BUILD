import { Router } from "express";
import type { EnrollResponse, HeartbeatResponse, JobResult } from "@rmm/shared";
import type { Store } from "../store.js";
import type { Config } from "../config.js";
import type { EventHub } from "../events.js";
import { bearer, generateToken, safeEqual } from "../auth.js";
import { evaluateRules } from "../alerts.js";
import { parseDeviceInfo, parseMetricsSample, ValidationError } from "../validate.js";

/**
 * Routes used by agents. Enrollment is gated by the shared enrollment token;
 * every subsequent call is authenticated with the per-agent token issued at
 * enrollment, scoped to the device id in the path.
 */
export function agentRoutes(store: Store, config: Config, hub: EventHub): Router {
  const router = Router();

  // Enroll a new agent (or re-enroll an existing machine).
  router.post("/enroll", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const token = typeof body.enrollmentToken === "string" ? body.enrollmentToken : "";
    if (!safeEqual(token, config.enrollmentToken)) {
      return res.status(401).json({ error: "invalid enrollment token" });
    }
    let info;
    try {
      info = parseDeviceInfo(body.info);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
    const machineId =
      typeof body.machineId === "string" && body.machineId.length > 0 ? body.machineId : null;

    const agentToken = generateToken();
    const deviceId = store.enrollDevice(info, agentToken, machineId);
    hub.broadcast({ type: "device.updated", deviceId, payload: store.getDevice(deviceId) });

    const response: EnrollResponse = {
      deviceId,
      agentToken,
      heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
    };
    return res.status(201).json(response);
  });

  // Authenticate the per-agent token for all routes below.
  const authenticate = (deviceId: string, header: string | undefined): boolean => {
    const token = bearer(header);
    return token !== null && store.authenticateAgent(deviceId, token);
  };

  // Heartbeat: ingest metrics, evaluate alerts, return pending jobs.
  router.post("/agents/:deviceId/heartbeat", (req, res) => {
    const { deviceId } = req.params;
    if (!authenticate(deviceId, req.headers.authorization)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    let info, metrics;
    try {
      const body = req.body as Record<string, unknown>;
      info = parseDeviceInfo(body.info);
      metrics = parseMetricsSample(body.metrics);
    } catch (err) {
      const status = err instanceof ValidationError ? 400 : 500;
      return res.status(status).json({ error: (err as Error).message });
    }

    const now = Date.now();
    store.updateHeartbeat(deviceId, info, now);
    store.insertMetrics(deviceId, metrics);
    const raised = evaluateRules(store, deviceId, info.hostname, metrics);

    hub.broadcast({ type: "metrics", deviceId, payload: metrics });
    hub.broadcast({ type: "device.updated", deviceId, payload: store.getDevice(deviceId) });
    if (raised > 0) {
      hub.broadcast({ type: "alert", deviceId, payload: { raised } });
    }

    const jobs = store.claimPendingJobs(deviceId, now);
    if (jobs.length > 0) {
      hub.broadcast({ type: "job.updated", deviceId, payload: { dispatched: jobs.length } });
    }
    const response: HeartbeatResponse = {
      jobs,
      heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
    };
    return res.json(response);
  });

  // Report the result of a dispatched job.
  router.post("/agents/:deviceId/jobs/:jobId/result", (req, res) => {
    const { deviceId, jobId } = req.params;
    if (!authenticate(deviceId, req.headers.authorization)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const body = req.body as Record<string, unknown>;
    const status = body.status;
    if (status !== "succeeded" && status !== "failed") {
      return res.status(400).json({ error: '"status" must be "succeeded" or "failed"' });
    }
    const result: JobResult = {
      status,
      exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
      stdout: typeof body.stdout === "string" ? body.stdout.slice(0, 1_000_000) : "",
      stderr: typeof body.stderr === "string" ? body.stderr.slice(0, 1_000_000) : "",
      startedAt: typeof body.startedAt === "number" ? body.startedAt : Date.now(),
      finishedAt: typeof body.finishedAt === "number" ? body.finishedAt : Date.now(),
    };
    const ok = store.recordJobResult(jobId, deviceId, result);
    if (!ok) {
      return res.status(404).json({ error: "job not found or not in running state" });
    }
    hub.broadcast({ type: "job.updated", deviceId, payload: { jobId, status: result.status } });
    return res.json({ ok: true });
  });

  return router;
}
