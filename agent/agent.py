#!/usr/bin/env python3
import base64
import io
import json
import os
import platform
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections import deque

import psutil
import requests
import websocket

try:
    import mss
    from PIL import Image
    MSS_AVAILABLE = True
except Exception:
    MSS_AVAILABLE = False

try:
    from pynput.mouse import Controller as MouseController, Button
    from pynput.keyboard import Controller as KeyboardController
    PYNPUT_AVAILABLE = True
except Exception:
    PYNPUT_AVAILABLE = False

SERVER = os.getenv("RMM_SERVER", "http://localhost:8000")
AGENT_TOKEN = os.getenv("RMM_AGENT_TOKEN", "agent-secret-change-me")
AGENT_ID = os.getenv("RMM_AGENT_ID", str(uuid.uuid4()))
HEARTBEAT_INTERVAL = int(os.getenv("RMM_HEARTBEAT_INTERVAL", "30"))

class Agent:
    def __init__(self):
        self.agent_id = AGENT_ID
        self.token = AGENT_TOKEN
        self.server = SERVER.rstrip("/")
        self.command_queue = deque()
        self.ws = None
        self.ws_thread = None
        self.shell = None
        self.current_session_id = None
        self.remote_active = False

    def _get_user(self):
        try:
            return os.getlogin()
        except Exception:
            return os.getenv("USER") or os.getenv("USERNAME") or ""

    def get_metrics(self):
        return {
            "cpu_percent": psutil.cpu_percent(interval=1),
            "memory_percent": psutil.virtual_memory().percent,
            "disk_percent": psutil.disk_usage("/").percent if hasattr(psutil, "disk_usage") else 0.0,
        }

    def get_platform_info(self):
        return {
            "agent_id": self.agent_id,
            "token": self.token,
            "hostname": socket.gethostname(),
            "os": f"{platform.system()} {platform.release()}",
            "platform": platform.system().lower(),
            "version": "1.0.0",
            "ip": socket.gethostbyname(socket.gethostname()),
            "user": self._get_user(),
            "group": "default",
            "tags": "",
        }

    def heartbeat(self):
        info = self.get_platform_info()
        metrics = self.get_metrics()
        payload = {**info, **metrics}
        try:
            r = requests.post(f"{self.server}/api/agent/heartbeat", json=payload, timeout=10)
            r.raise_for_status()
            data = r.json()
            for cmd in data.get("commands", []):
                self.command_queue.append(cmd)
        except Exception as e:
            print("Heartbeat failed:", e)

    def run_command(self, cmd_id, shell, command):
        try:
            if shell == "powershell":
                proc = subprocess.run(["powershell", "-Command", command], capture_output=True, text=True, timeout=120)
            elif shell == "cmd":
                proc = subprocess.run(["cmd", "/c", command], capture_output=True, text=True, timeout=120)
            else:
                proc = subprocess.run([shell, "-c", command], capture_output=True, text=True, timeout=120)
            output = proc.stdout + proc.stderr
            self.report_result(cmd_id, proc.returncode, output)
        except Exception as e:
            self.report_result(cmd_id, 1, str(e))

    def report_result(self, cmd_id, exit_code, output):
        try:
            requests.post(f"{self.server}/api/agent/command/{cmd_id}/result", json={
                "status": "done" if exit_code == 0 else "failed",
                "exit_code": exit_code,
                "output": output[:100000]
            }, timeout=10)
        except Exception as e:
            print("Report failed:", e)

    def collect_software_windows(self):
        cmd = r"Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Select-Object DisplayName, DisplayVersion, Publisher, InstallDate | ConvertTo-Json"
        try:
            r = subprocess.run(["powershell", "-Command", cmd], capture_output=True, text=True, timeout=60)
            data = json.loads(r.stdout or "[]")
            if isinstance(data, dict):
                data = [data]
            return [{
                "name": x.get("DisplayName", ""),
                "version": x.get("DisplayVersion", ""),
                "publisher": x.get("Publisher", ""),
                "install_date": x.get("InstallDate", ""),
                "source": "registry"
            } for x in data if x.get("DisplayName")]
        except Exception as e:
            print("collect software failed:", e)
            return []

    def collect_patches_windows(self):
        try:
            r = subprocess.run(["powershell", "-Command", "Get-HotFix | Select-Object HotFixID, Description, InstalledOn, InstalledBy | ConvertTo-Json"], capture_output=True, text=True, timeout=60)
            data = json.loads(r.stdout or "[]")
            if isinstance(data, dict):
                data = [data]
            return [{
                "hotfix_id": x.get("HotFixID", ""),
                "description": x.get("Description", ""),
                "installed_on": str(x.get("InstalledOn", "")),
                "installed_by": x.get("InstalledBy", "")
            } for x in data if x.get("HotFixID")]
        except Exception as e:
            print("collect patches failed:", e)
            return []

    def collect_software_linux(self):
        pkgs = []
        try:
            if subprocess.run(["which", "dpkg"], capture_output=True).returncode == 0:
                r = subprocess.run(["dpkg", "-l"], capture_output=True, text=True, timeout=60)
                for line in r.stdout.splitlines():
                    parts = line.split()
                    if len(parts) >= 4 and parts[0] == "ii":
                        pkgs.append({"name": parts[1], "version": parts[2], "publisher": "", "install_date": "", "source": "dpkg"})
            elif subprocess.run(["which", "rpm"], capture_output=True).returncode == 0:
                r = subprocess.run(["rpm", "-qa", "--queryformat", "%{NAME}\t%{VERSION}\n"], capture_output=True, text=True, timeout=60)
                for line in r.stdout.splitlines():
                    parts = line.split("\t")
                    if len(parts) == 2:
                        pkgs.append({"name": parts[0], "version": parts[1], "publisher": "", "install_date": "", "source": "rpm"})
        except Exception as e:
            print("collect software linux failed:", e)
        return pkgs

    def collect_patches_linux(self):
        return []

    def send_inventory(self):
        if sys.platform.startswith("win"):
            software = self.collect_software_windows()
            patches = self.collect_patches_windows()
        else:
            software = self.collect_software_linux()
            patches = self.collect_patches_linux()
        try:
            requests.post(f"{self.server}/api/agent/inventory", json={
                "token": self.token,
                "agent_id": self.agent_id,
                "software": software,
                "patches": patches
            }, timeout=30)
        except Exception as e:
            print("Inventory report failed:", e)

    def process_commands(self):
        while True:
            if self.command_queue:
                cmd = self.command_queue.popleft()
                threading.Thread(target=self.run_command, args=(cmd["id"], cmd.get("shell", "powershell"), cmd["command"]), daemon=True).start()
            time.sleep(1)

    def on_ws_message(self, ws, message):
        try:
            msg = json.loads(message)
            mtype = msg.get("type")
            session_id = msg.get("session_id")
            if mtype == "terminal_input":
                if not self.shell or self.current_session_id != session_id:
                    self.start_shell(session_id)
                if self.shell and self.shell.stdin:
                    try:
                        self.shell.stdin.write(msg["data"].encode())
                        self.shell.stdin.flush()
                    except Exception as e:
                        self.send_ws({"type": "error", "text": str(e), "session_id": session_id})
            elif mtype == "run":
                threading.Thread(target=self.run_command, args=(0, msg.get("shell", "powershell"), msg["command"]), daemon=True).start()
            elif mtype == "remote_start":
                self.remote_active = True
                threading.Thread(target=self.remote_stream, args=(session_id,), daemon=True).start()
            elif mtype == "remote_input":
                self.handle_remote_input(msg)
        except Exception as e:
            print("WS message error:", e)

    def send_ws(self, msg):
        if self.ws:
            try:
                self.ws.send(json.dumps(msg))
            except Exception:
                pass

    def shell_reader(self, pipe, session_id, stream_name):
        try:
            for line in iter(pipe.readline, b""):
                text = line.decode("utf-8", errors="replace")
                self.send_ws({"type": "terminal_output", "data": text, "stream": stream_name, "session_id": session_id})
        except Exception:
            pass

    def start_shell(self, session_id):
        if self.shell:
            try:
                self.shell.terminate()
            except Exception:
                pass
            try:
                self.shell.wait(timeout=2)
            except Exception:
                self.shell.kill()
        self.current_session_id = session_id
        shell_cmd = "powershell" if sys.platform.startswith("win") else "bash"
        try:
            self.shell = subprocess.Popen(
                shell_cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )
            threading.Thread(target=self.shell_reader, args=(self.shell.stdout, session_id, "stdout"), daemon=True).start()
            threading.Thread(target=self.shell_reader, args=(self.shell.stderr, session_id, "stderr"), daemon=True).start()
        except Exception as e:
            self.send_ws({"type": "error", "text": str(e), "session_id": session_id})

    def remote_stream(self, session_id):
        if not MSS_AVAILABLE:
            self.send_ws({"type": "error", "text": "Screen capture not available", "session_id": session_id})
            return
        with mss.mss() as sct:
            while self.remote_active:
                try:
                    monitor = sct.monitors[1]
                    img = sct.grab(monitor)
                    pil = Image.frombytes("RGB", img.size, img.bgra, "raw", "BGRX")
                    pil.thumbnail((1280, 720))
                    buf = io.BytesIO()
                    pil.save(buf, format="JPEG", quality=50)
                    b64 = base64.b64encode(buf.getvalue()).decode()
                    self.send_ws({"type": "frame", "data": "data:image/jpeg;base64," + b64, "session_id": session_id})
                    time.sleep(0.2)
                except Exception as e:
                    print("Remote stream error:", e)
                    time.sleep(1)

    def handle_remote_input(self, msg):
        if not PYNPUT_AVAILABLE:
            return
        try:
            if msg.get("event") == "move":
                MouseController().position = (msg["x"], msg["y"])
            elif msg.get("event") == "click":
                MouseController().click(Button.left if msg["button"] == 0 else Button.right)
            elif msg.get("event") == "key":
                KeyboardController().type(msg["key"])
        except Exception as e:
            print("Remote input error:", e)

    def ws_runner(self):
        proto = "wss" if self.server.startswith("https") else "ws"
        host = self.server.replace("http://", "").replace("https://", "")
        url = f"{proto}://{host}/ws/agent/{self.agent_id}?token={self.token}"
        while True:
            try:
                self.ws = websocket.create_connection(url, timeout=10)
                print("Agent websocket connected")
                while True:
                    try:
                        message = self.ws.recv()
                        if message is None:
                            break
                        self.on_ws_message(self.ws, message)
                    except websocket.WebSocketTimeoutException:
                        continue
                    except Exception as e:
                        print("WS recv error:", e)
                        break
            except Exception as e:
                print("WS connect error:", e)
            finally:
                if self.ws:
                    try:
                        self.ws.close()
                    except Exception:
                        pass
                self.ws = None
                print("Agent websocket disconnected")
            time.sleep(5)

    def inventory_loop(self):
        while True:
            time.sleep(300)
            self.send_inventory()

    def run(self):
        threading.Thread(target=self.process_commands, daemon=True).start()
        threading.Thread(target=self.inventory_loop, daemon=True).start()
        self.ws_thread = threading.Thread(target=self.ws_runner, daemon=True)
        self.ws_thread.start()
        while True:
            self.heartbeat()
            time.sleep(HEARTBEAT_INTERVAL)

if __name__ == "__main__":
    Agent().run()
