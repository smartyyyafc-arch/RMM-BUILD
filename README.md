# RMM-BUILD

A lightweight, self-hostable **Remote Monitoring & Management** platform. Enroll
agents on your machines, watch their health in real time, get alerted when
something goes wrong, and run commands remotely — all from a single dashboard.

Built in TypeScript with a small footprint: no external database, no heavyweight
frontend framework, and only two runtime dependencies on the server.

```
┌────────────┐   heartbeat + metrics    ┌──────────────┐
│  Endpoint  │ ───────────────────────► │              │      ┌───────────┐
│   agent    │ ◄─────────────────────── │  RMM server  │◄────►│ Dashboard │
│ (Node.js)  │      jobs to run         │ (API + WS +  │  WS  │  (browser)│
└────────────┘                          │   SQLite)    │      └───────────┘
                                        └──────────────┘
```

## Features

- **Agent enrollment** with a shared enrollment token; each agent then gets its
  own long-lived per-device token.
- **Live metrics** — CPU, memory, disk, load average, uptime, process count —
  collected cross-platform (Linux, macOS, Windows) and streamed to the dashboard
  over WebSockets.
- **Remote command execution** — queue `shell` or `script` jobs (or a `ping`
  health check) from the dashboard; the agent runs them and reports stdout,
  stderr, and exit code.
- **Threshold alerting** — define rules like "CPU > 90% → critical"; the server
  raises de-duplicated alerts you can acknowledge.
- **Zero-dependency storage** — uses Node's built-in `node:sqlite`, so there's no
  database server to run and no native modules to compile.
- **Deployment-ready** — Dockerfile, docker-compose with an nginx/TLS reverse
  proxy, and systemd units. See [DEPLOY.md](./DEPLOY.md).

## Repository layout

```
packages/
  shared/      Wire-contract types shared by server and agent
  server/      Express API + SQLite + WebSocket hub  (@rmm/server)
  agent/       Endpoint agent: metrics + job execution (@rmm/agent)
  dashboard/   Static single-page dashboard (served by the server)
deploy/        nginx template, systemd units, agent env example
Dockerfile, docker-compose.yml, DEPLOY.md
```

## Quick start (local)

Requires **Node.js ≥ 22.5** (for the built-in SQLite module).

```bash
npm install
npm run build

# Terminal 1 — start the server
PORT=8080 \
RMM_ADMIN_KEY=dev-admin-key \
RMM_ENROLLMENT_TOKEN=dev-enroll-token \
RMM_HEARTBEAT_INTERVAL_SECONDS=5 \
npm run server

# Terminal 2 — start an agent that reports to it
RMM_SERVER_URL=http://localhost:8080 \
RMM_ENROLLMENT_TOKEN=dev-enroll-token \
npm run agent
```

Open <http://localhost:8080>, enter the admin key (`dev-admin-key`), and you'll
see the device appear with live metrics. Queue a command from the device detail
view to see remote execution end to end.

There's also a helper that boots both with sensible defaults:

```bash
./scripts/dev.sh
```

## Configuration

### Server (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port to listen on |
| `RMM_DB_PATH` | `./data/rmm.db` | SQLite database file path |
| `RMM_ADMIN_KEY` | *(random, logged)* | Admin/dashboard bearer token |
| `RMM_ENROLLMENT_TOKEN` | *(random, logged)* | One-time token agents use to enroll |
| `RMM_OFFLINE_AFTER_SECONDS` | `120` | Mark a device offline after this gap |
| `RMM_HEARTBEAT_INTERVAL_SECONDS` | `30` | Interval the server tells agents to use |

If a secret is unset, the server generates a random one and prints it at startup
so it never runs with a predictable key.

### Agent (environment variables)

| Variable | Required | Description |
| --- | --- | --- |
| `RMM_SERVER_URL` | yes | Base URL of the server, e.g. `https://rmm.example.com` |
| `RMM_ENROLLMENT_TOKEN` | yes | Must match the server's enrollment token |
| `RMM_MACHINE_ID` | no | Stable id so re-enrollment maps to the same device |
| `RMM_AGENT_STATE` | no | Path to persist the issued token (`./agent-state.json`) |

## API overview

All admin routes require `Authorization: Bearer <RMM_ADMIN_KEY>`.

| Method & path | Purpose |
| --- | --- |
| `POST /api/enroll` | Agent enrollment (enrollment token) |
| `POST /api/agents/:id/heartbeat` | Agent metrics + job pickup (agent token) |
| `POST /api/agents/:id/jobs/:jobId/result` | Agent reports a job result |
| `GET /api/devices` | List devices with latest metrics |
| `GET /api/devices/:id/metrics` | Metrics history (`windowMinutes`, `limit`) |
| `POST /api/devices/:id/jobs` | Queue a job (`type`, `payload`, `timeoutSeconds`) |
| `GET /api/jobs/:id` | Job status + result |
| `GET/POST/DELETE /api/alert-rules` | Manage alert rules |
| `GET /api/alerts`, `POST /api/alerts/:id/acknowledge` | View / ack alerts |
| `GET /healthz` | Unauthenticated liveness probe |

## Testing

```bash
npm run build && npm test
```

## Security model

This is genuine remote-administration tooling: with the admin key you can run
arbitrary commands on every enrolled endpoint, by design. Protect the admin and
enrollment tokens accordingly, always run behind TLS, and prefer running agents
as a dedicated least-privilege user. See the security notes in
[DEPLOY.md](./DEPLOY.md).

## License

MIT — see [LICENSE](./LICENSE).
