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

# Generate and persist a stable agent ID so reinstalls don't create duplicate devices.
AGENT_ID_FILE="$INSTALL_DIR/agent_id"
if [ ! -f "$AGENT_ID_FILE" ]; then
  python3 -c "import uuid; print(uuid.uuid4())" > "$AGENT_ID_FILE"
fi
AGENT_ID=$(cat "$AGENT_ID_FILE")

curl -sSL "$SERVER/agent/requirements.txt" -o "$INSTALL_DIR/requirements.txt"
curl -sSL "$SERVER/agent/agent.py" -o "$INSTALL_DIR/agent.py"

# Use a virtual environment to avoid PEP 668 system-package restrictions.
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install -q -r "$INSTALL_DIR/requirements.txt"

cat > /etc/systemd/system/basicrmm-agent.service <<EOF
[Unit]
Description=BasicRMM Agent
After=network.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/venv/bin/python3 $INSTALL_DIR/agent.py
Restart=always
Environment=RMM_SERVER=$SERVER
Environment=RMM_AGENT_TOKEN=$TOKEN
Environment=RMM_AGENT_ID=$AGENT_ID

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now basicrmm-agent

echo "BasicRMM agent installed and started (agent_id=$AGENT_ID)."
