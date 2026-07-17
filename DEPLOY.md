# Deploying RMM on a VPS with your own domain

This guide walks through hosting the RMM server on a fresh Linux VPS (Ubuntu/Debian)
behind an nginx reverse proxy with a Let's Encrypt TLS certificate for your domain.

There are two supported paths:

- **A. Docker Compose** (recommended) — server + nginx in containers.
- **B. systemd** — run the compiled server directly under systemd, proxy with the
  host's nginx.

---

## 0. Prerequisites

- A VPS with a public IP and ports **80** and **443** open.
- A domain you control, e.g. `rmm.example.com`.
- **DNS**: create an `A` record for `rmm.example.com` pointing to the VPS IP
  (and an `AAAA` record if you have IPv6). Confirm it resolves before continuing:

  ```bash
  dig +short rmm.example.com
  ```

Pick strong secrets now — you'll reuse them below:

```bash
openssl rand -hex 32   # use for RMM_ADMIN_KEY
openssl rand -hex 32   # use for RMM_ENROLLMENT_TOKEN
```

---

## A. Docker Compose

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

### 2. Get the code and configure

```bash
git clone <your-repo-url> rmm && cd rmm
cp .env.example .env
```

Edit `.env` and set at least:

```ini
RMM_DOMAIN=rmm.example.com
RMM_ADMIN_KEY=<the first random value>
RMM_ENROLLMENT_TOKEN=<the second random value>
```

### 3. Obtain a TLS certificate

The nginx container expects certs at `deploy/certs/fullchain.pem` and
`deploy/certs/privkey.pem`. Use certbot to issue them via the webroot challenge.

First bring up a temporary HTTP-only nginx so the ACME challenge can be served.
The simplest reliable approach is certbot's standalone mode on first issue:

```bash
sudo apt-get update && sudo apt-get install -y certbot
sudo certbot certonly --standalone -d rmm.example.com \
  --non-interactive --agree-tos -m you@example.com

# Copy the issued certs where the nginx container reads them.
mkdir -p deploy/certs
sudo cp /etc/letsencrypt/live/rmm.example.com/fullchain.pem deploy/certs/
sudo cp /etc/letsencrypt/live/rmm.example.com/privkey.pem  deploy/certs/
sudo chown "$USER" deploy/certs/*.pem
```

> Standalone mode needs port 80 free, so run it **before** `docker compose up`.

### 4. Launch

```bash
docker compose up -d --build
docker compose logs -f rmm-server   # watch it boot
```

Visit `https://rmm.example.com` and sign in with your `RMM_ADMIN_KEY`.

### 5. Certificate renewal

Let's Encrypt certs last 90 days. Renew and reload nginx on a schedule:

```bash
# /etc/cron.d/rmm-cert-renew
0 3 * * * root certbot renew --standalone --pre-hook "cd /path/to/rmm && docker compose stop nginx" \
  --post-hook "cp /etc/letsencrypt/live/rmm.example.com/*.pem /path/to/rmm/deploy/certs/ && cd /path/to/rmm && docker compose start nginx"
```

---

## B. systemd (no Docker)

### 1. Install Node.js 22 and build

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx
git clone <your-repo-url> /opt/rmm && cd /opt/rmm
npm ci && npm run build
```

### 2. Configure and run the server

```bash
sudo useradd --system --home /opt/rmm --shell /usr/sbin/nologin rmm || true
sudo mkdir -p /opt/rmm/data /etc/rmm
sudo cp .env.example /etc/rmm/server.env    # edit: set RMM_ADMIN_KEY, RMM_ENROLLMENT_TOKEN, RMM_DB_PATH=/opt/rmm/data/rmm.db
sudo chown -R rmm:rmm /opt/rmm/data

sudo cp deploy/rmm-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rmm-server
systemctl status rmm-server
```

The server now listens on `127.0.0.1:8080` (or `PORT`).

### 3. nginx + TLS

```bash
# Minimal server block that proxies to the app and supports WebSockets:
sudo tee /etc/nginx/sites-available/rmm >/dev/null <<'EOF'
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
    listen 80;
    server_name rmm.example.com;
    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/rmm /etc/nginx/sites-enabled/rmm
sudo nginx -t && sudo systemctl reload nginx

# Let certbot obtain the cert and rewrite the block for HTTPS automatically:
sudo certbot --nginx -d rmm.example.com --non-interactive --agree-tos -m you@example.com --redirect
```

certbot installs a renewal timer automatically (`systemctl list-timers | grep certbot`).

---

## Enrolling an endpoint agent

On each machine you want to monitor (Linux example):

```bash
# Copy the built agent + node_modules to the endpoint, then:
sudo mkdir -p /opt/rmm-agent /etc/rmm
sudo cp deploy/agent.env.example /etc/rmm/agent.env   # edit RMM_SERVER_URL + RMM_ENROLLMENT_TOKEN
sudo cp deploy/rmm-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rmm-agent
journalctl -u rmm-agent -f
```

Within one heartbeat the device appears in the dashboard.

---

## Security notes

- Treat `RMM_ADMIN_KEY` like a root password — anyone with it can run commands on
  every enrolled device. Rotate it by updating the server env and restarting.
- Rotate `RMM_ENROLLMENT_TOKEN` after you finish provisioning agents; existing
  agents keep working with their own issued tokens.
- Agents execute jobs with the privileges of the agent process. Run the agent as
  a dedicated least-privilege user where possible.
- Always deploy behind TLS (this guide does). Never expose the app port directly
  to the internet without the proxy.
