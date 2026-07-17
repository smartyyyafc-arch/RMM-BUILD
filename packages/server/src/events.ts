import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { bearer, safeEqual } from "./auth.js";

/** A server-sent event pushed to connected dashboards over WebSocket. */
export interface ServerEvent {
  type: "device.updated" | "metrics" | "alert" | "job.updated";
  deviceId: string;
  payload: unknown;
}

/**
 * Broadcasts real-time events to authenticated dashboard clients.
 *
 * Clients connect to /ws and authenticate with the admin key, supplied either
 * as a `token` query parameter or a Bearer Authorization header. Unauthorized
 * sockets are closed immediately.
 */
export class EventHub {
  private readonly wss: WebSocketServer;

  constructor(server: Server, private readonly adminKey: string) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (socket, req) => {
      const url = new URL(req.url ?? "/ws", "http://localhost");
      const token = url.searchParams.get("token") ?? bearer(req.headers.authorization);
      if (!token || !safeEqual(token, this.adminKey)) {
        socket.close(4401, "unauthorized");
        return;
      }
      socket.send(JSON.stringify({ type: "hello", payload: { ok: true } }));
    });
  }

  broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  close(): void {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}
