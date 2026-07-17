import { Router } from "express";
import type { Store } from "../store.js";
import type { Config } from "../config.js";
import type { EventHub } from "../events.js";
import { safeEqual, bearer } from "../auth.js";
import { parseAlertRule, parseJobCreate, ValidationError } from "../validate.js";

/**
 * Admin/dashboard routes. Every route requires the admin key, supplied as a
 * Bearer token. These endpoints expose devices, metrics history, jobs, and
 * alert management.
 */
export function adminRoutes(store: Store, config: Config, hub: EventHub): Router {
  const router = Router();

  // Gate the whole router behind the admin key.
  router.use((req, res, next) => {
    const token = bearer(req.headers.authorization);
    if (!token || !safeEqual(token, config.adminKey)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    return next();
  });

  // ---- Devices ----------------------------------------------------------

  router.get("/devices", (_req, res) => {
    res.json({ devices: store.listDevices() });
  });

  router.get("/devices/:deviceId", (req, res) => {
    const device = store.getDevice(req.params.deviceId);
    if (!device) return res.status(404).json({ error: "device not found" });
    return res.json({ device });
  });

  router.delete("/devices/:deviceId", (req, res) => {
    const ok = store.deleteDevice(req.params.deviceId);
    if (!ok) return res.status(404).json({ error: "device not found" });
    return res.json({ ok: true });
  });

  router.get("/devices/:deviceId/metrics", (req, res) => {
    const device = store.getDevice(req.params.deviceId);
    if (!device) return res.status(404).json({ error: "device not found" });
    const windowMinutes = clampInt(req.query.windowMinutes, 60, 1, 1440 * 7);
    const limit = clampInt(req.query.limit, 500, 1, 5000);
    const since = Date.now() - windowMinutes * 60_000;
    return res.json({ metrics: store.metricsSince(req.params.deviceId, since, limit) });
  });

  // ---- Jobs -------------------------------------------------------------

  router.get("/devices/:deviceId/jobs", (req, res) => {
    const device = store.getDevice(req.params.deviceId);
    if (!device) return res.status(404).json({ error: "device not found" });
    const limit = clampInt(req.query.limit, 50, 1, 500);
    return res.json({ jobs: store.listJobs(req.params.deviceId, limit) });
  });

  router.post("/devices/:deviceId/jobs", (req, res) => {
    const device = store.getDevice(req.params.deviceId);
    if (!device) return res.status(404).json({ error: "device not found" });
    let parsed;
    try {
      parsed = parseJobCreate(req.body);
    } catch (err) {
      const status = err instanceof ValidationError ? 400 : 500;
      return res.status(status).json({ error: (err as Error).message });
    }
    const job = store.createJob(
      req.params.deviceId,
      parsed.type,
      parsed.payload,
      parsed.timeoutSeconds
    );
    hub.broadcast({ type: "job.updated", deviceId: job.deviceId, payload: { jobId: job.id } });
    return res.status(201).json({ job });
  });

  router.get("/jobs/:jobId", (req, res) => {
    const job = store.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "job not found" });
    return res.json({ job });
  });

  // ---- Alert rules ------------------------------------------------------

  router.get("/alert-rules", (_req, res) => {
    res.json({ rules: store.listAlertRules() });
  });

  router.post("/alert-rules", (req, res) => {
    let parsed;
    try {
      parsed = parseAlertRule(req.body);
    } catch (err) {
      const status = err instanceof ValidationError ? 400 : 500;
      return res.status(status).json({ error: (err as Error).message });
    }
    if (parsed.deviceId && !store.getDevice(parsed.deviceId)) {
      return res.status(400).json({ error: "deviceId does not match a known device" });
    }
    return res.status(201).json({ rule: store.createAlertRule(parsed) });
  });

  router.delete("/alert-rules/:ruleId", (req, res) => {
    const ok = store.deleteAlertRule(req.params.ruleId);
    if (!ok) return res.status(404).json({ error: "rule not found" });
    return res.json({ ok: true });
  });

  // ---- Alerts -----------------------------------------------------------

  router.get("/alerts", (req, res) => {
    const includeAcknowledged = req.query.all === "true";
    const limit = clampInt(req.query.limit, 100, 1, 1000);
    res.json({ alerts: store.listAlerts(limit, includeAcknowledged) });
  });

  router.post("/alerts/:alertId/acknowledge", (req, res) => {
    const ok = store.acknowledgeAlert(req.params.alertId);
    if (!ok) return res.status(404).json({ error: "alert not found or already acknowledged" });
    return res.json({ ok: true });
  });

  return router;
}

/** Parses a query-string integer, clamping to [min, max] with a fallback. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
