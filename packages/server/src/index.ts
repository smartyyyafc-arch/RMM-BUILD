import http from "node:http";
import path from "node:path";
import express from "express";
import { loadConfig } from "./config.js";
import { openDatabase, pruneMetrics } from "./db.js";
import { Store } from "./store.js";
import { EventHub } from "./events.js";
import { agentRoutes } from "./routes/agents.js";
import { adminRoutes } from "./routes/admin.js";

const METRICS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

function dashboardDir(): string {
  // dist/index.js -> ../../dashboard/public
  return path.resolve(__dirname, "../../dashboard/public");
}

export function createApp(store: Store, config: ReturnType<typeof loadConfig>, hub: EventHub) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  // Liveness probe (unauthenticated) for load balancers / uptime checks.
  app.get("/healthz", (_req, res) => res.json({ ok: true, time: Date.now() }));

  app.use("/api", agentRoutes(store, config, hub));
  app.use("/api", adminRoutes(store, config, hub));

  // Serve the dashboard SPA.
  const dir = dashboardDir();
  app.use(express.static(dir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path === "/ws") return next();
    return res.sendFile(path.join(dir, "index.html"));
  });

  // JSON error handler so malformed bodies don't leak stack traces.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof SyntaxError) {
      return res.status(400).json({ error: "invalid JSON body" });
    }
    // eslint-disable-next-line no-console
    console.error("[server] unhandled error:", err);
    return res.status(500).json({ error: "internal server error" });
  });

  return app;
}

function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const store = new Store(db, config.offlineAfterSeconds);

  const httpServer = http.createServer();
  const hub = new EventHub(httpServer, config.adminKey);
  const app = createApp(store, config, hub);
  httpServer.on("request", app);

  const pruneTimer = setInterval(() => {
    const removed = pruneMetrics(db, METRICS_RETENTION_MS, Date.now());
    if (removed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[server] pruned ${removed} old metric rows`);
    }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  httpServer.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] RMM server listening on http://0.0.0.0:${config.port}`);
    // eslint-disable-next-line no-console
    console.log(`[server] dashboard: http://localhost:${config.port}/`);
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[server] received ${signal}, shutting down`);
    clearInterval(pruneTimer);
    hub.close();
    httpServer.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Run only when executed directly (not when imported by tests).
if (require.main === module) {
  main();
}
