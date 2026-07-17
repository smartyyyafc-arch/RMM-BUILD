#!/usr/bin/env bash
set -e

SERVER="${RMM_SERVER:-}"
TOKEN="${RMM_AGENT_TOKEN:-}"

if [ -z "$SERVER" ]; then
  read -rp "Enter server URL (e.g. http://rmm.example.com:8000): " SERVER
fi
if [ -z "$TOKEN" ]; then
  read -rsp "Enter agent token: " TOKEN
  echo
fi

INSTALL_DIR="/opt/basicrmm-agent"
mkdir -p "$INSTALL_DIR"

curl -sSL "$SERVER/agent/requirements.txt" -o "$INSTALL_DIR/requirements.txt"
curl -sSL "$SERVER/agent/agent.py" -o "$INSTALL_DIR/agent.py"

python3 -m pip install -q -r "$INSTALL_DIR/requirements.txt"

cat > /etc/systemd/system/basicrmm-agent.service <<EOF
[Unit]
Description=BasicRMM Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 $INSTALL_DIR/agent.py
Restart=always
Environment=RMM_SERVER=$SERVER
Environment=RMM_AGENT_TOKEN=$TOKEN

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now basicrmm-agent

echo "BasicRMM agent installed and started."
