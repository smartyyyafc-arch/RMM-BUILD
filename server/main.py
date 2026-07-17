import asyncio
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, status, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import init_db, get_db, SessionLocal
from models import User, Device, Command, AuditLog, Script, Automation, Software, Patch
from auth import (
    get_current_user, create_access_token, verify_password, get_password_hash,
    require_admin, ensure_admin, decode_token
)

AGENT_TOKEN = os.getenv("AGENT_TOKEN", "agent-secret-change-me")
AGENT_FILES_DIR = os.getenv("AGENT_FILES_DIR", "../agent")
HEARTBEAT_TIMEOUT_SECONDS = 120

connected_agents: dict[str, WebSocket] = {}
terminal_sessions: dict[str, WebSocket] = {}
device_operators: dict[int, list[WebSocket]] = {}


def log_audit(db: Session, username: str, action: str, detail: str = ""):
    db.add(AuditLog(username=username, action=action, detail=detail))
    db.commit()


async def mark_offline():
    while True:
        await asyncio.sleep(30)
        db = SessionLocal()
        try:
            now = datetime.now(timezone.utc).timestamp()
            for d in db.query(Device).filter(Device.status == "online").all():
                if d.last_seen and d.last_seen.timestamp() < now - HEARTBEAT_TIMEOUT_SECONDS:
                    d.status = "offline"
            db.commit()
        finally:
            db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    db = SessionLocal()
    try:
        ensure_admin(db)
    finally:
        db.close()
    asyncio.create_task(mark_offline())
    yield


app = FastAPI(title="BasicRMM Server", lifespan=lifespan)
if os.path.isdir(AGENT_FILES_DIR):
    app.mount("/agent", StaticFiles(directory=AGENT_FILES_DIR), name="agent")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- Auth ----

class TokenResponse(BaseModel):
    access_token: str
    token_type: str


class UserCreate(BaseModel):
    username: str
    password: str
    email: Optional[str] = None
    is_admin: bool = False


@app.post("/api/auth/login", response_model=TokenResponse)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == form.username).first()
    if not user or not verify_password(form.password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Incorrect username or password")
    log_audit(db, user.username, "login", "web")
    return {"access_token": create_access_token({"sub": user.username}), "token_type": "bearer"}


@app.post("/api/auth/users")
def create_user(payload: UserCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    if db.query(User).filter(User.username == payload.username).first():
        raise HTTPException(status_code=400, detail="Username exists")
    user = User(
        username=payload.username,
        email=payload.email,
        hashed_password=get_password_hash(payload.password),
        is_admin=payload.is_admin
    )
    db.add(user)
    db.commit()
    log_audit(db, admin.username, "create_user", f"created {payload.username}")
    return {"ok": True}


@app.get("/api/auth/me")
def me(current: User = Depends(get_current_user)):
    return {"username": current.username, "is_admin": current.is_admin}


# ---- Devices ----

class HeartbeatPayload(BaseModel):
    agent_id: str
    token: str
    hostname: str
    os: str
    platform: str
    version: str = "1.0.0"
    cpu_percent: float = 0.0
    memory_percent: float = 0.0
    disk_percent: float = 0.0
    ip: Optional[str] = None
    user: Optional[str] = None
    group: Optional[str] = "default"
    tags: Optional[str] = ""


class CommandPayload(BaseModel):
    shell: str = "powershell"
    command: str


@app.post("/api/agent/heartbeat")
def heartbeat(payload: HeartbeatPayload, req: Request, db: Session = Depends(get_db)):
    if payload.token != AGENT_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid agent token")
    device = db.query(Device).filter(Device.agent_id == payload.agent_id).first()
    if not device:
        device = Device(
            agent_id=payload.agent_id,
            hostname=payload.hostname,
            os=payload.os,
            platform=payload.platform,
            version=payload.version,
            ip=payload.ip or req.client.host,
            user=payload.user,
            group=payload.group or "default",
            tags=payload.tags or "",
            cpu_percent=payload.cpu_percent,
            memory_percent=payload.memory_percent,
            disk_percent=payload.disk_percent,
        )
        db.add(device)
    else:
        device.hostname = payload.hostname
        device.os = payload.os
        device.platform = payload.platform
        device.version = payload.version
        device.ip = payload.ip or req.client.host
        device.user = payload.user
        device.cpu_percent = payload.cpu_percent
        device.memory_percent = payload.memory_percent
        device.disk_percent = payload.disk_percent
        device.group = payload.group or device.group
        device.tags = payload.tags or device.tags
    device.status = "online"
    device.last_seen = datetime.now(timezone.utc)
    db.commit()
    db.refresh(device)

    queued = db.query(Command).filter(
        Command.device_id == device.id,
        Command.status == "queued"
    ).order_by(Command.created_at.asc()).all()
    return {
        "commands": [
            {"id": c.id, "shell": c.shell, "command": c.command}
            for c in queued
        ]
    }


@app.post("/api/agent/command/{command_id}/result")
def command_result(command_id: int, payload: dict, db: Session = Depends(get_db)):
    cmd = db.query(Command).filter(Command.id == command_id).first()
    if not cmd:
        raise HTTPException(status_code=404, detail="Command not found")
    cmd.status = payload.get("status", "done")
    cmd.exit_code = payload.get("exit_code")
    cmd.output = payload.get("output", "")
    cmd.completed_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


@app.post("/api/agent/inventory")
def inventory(payload: dict, db: Session = Depends(get_db)):
    if payload.get("token") != AGENT_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid agent token")
    agent_id = payload.get("agent_id")
    device = db.query(Device).filter(Device.agent_id == agent_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    db.query(Software).filter(Software.device_id == device.id).delete()
    db.query(Patch).filter(Patch.device_id == device.id).delete()
    for sw in payload.get("software", []):
        db.add(Software(
            device_id=device.id,
            name=sw.get("name", "")[:255],
            version=sw.get("version", "")[:100],
            publisher=sw.get("publisher", "")[:255],
            install_date=sw.get("install_date", "")[:50],
            source=sw.get("source", "")[:100]
        ))
    for p in payload.get("patches", []):
        db.add(Patch(
            device_id=device.id,
            hotfix_id=p.get("hotfix_id", "")[:100],
            description=p.get("description", "")[:500],
            installed_on=p.get("installed_on", "")[:50],
            installed_by=p.get("installed_by", "")[:255]
        ))
    db.commit()
    return {"ok": True}


@app.get("/api/devices")
def list_devices(status: Optional[str] = None, group: Optional[str] = None, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    query = db.query(Device)
    if status:
        query = query.filter(Device.status == status)
    if group:
        query = query.filter(Device.group == group)
    devices = query.order_by(Device.hostname).all()
    return [{
        "id": d.id,
        "hostname": d.hostname,
        "agent_id": d.agent_id,
        "os": d.os,
        "platform": d.platform,
        "version": d.version,
        "status": d.status,
        "cpu_percent": d.cpu_percent,
        "memory_percent": d.memory_percent,
        "disk_percent": d.disk_percent,
        "last_seen": d.last_seen.isoformat() if d.last_seen else None,
        "group": d.group,
        "tags": d.tags,
        "ip": d.ip,
        "user": d.user
    } for d in devices]


@app.get("/api/devices/{device_id}")
def get_device(device_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    d = db.query(Device).filter(Device.id == device_id).first()
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")
    return {
        "id": d.id,
        "hostname": d.hostname,
        "agent_id": d.agent_id,
        "os": d.os,
        "platform": d.platform,
        "version": d.version,
        "status": d.status,
        "cpu_percent": d.cpu_percent,
        "memory_percent": d.memory_percent,
        "disk_percent": d.disk_percent,
        "last_seen": d.last_seen.isoformat() if d.last_seen else None,
        "group": d.group,
        "tags": d.tags,
        "ip": d.ip,
        "user": d.user
    }


@app.post("/api/devices/{device_id}/command")
def queue_command(device_id: int, payload: CommandPayload, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    d = db.query(Device).filter(Device.id == device_id).first()
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")
    cmd = Command(device_id=device_id, shell=payload.shell, command=payload.command)
    db.add(cmd)
    db.commit()
    log_audit(db, current.username, "queue_command", f"device={d.hostname} shell={payload.shell} command={payload.command}")
    return {"id": cmd.id, "status": "queued"}


@app.get("/api/devices/{device_id}/software")
def get_software(device_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    device = db.query(Device).filter(Device.id == device_id).first()
    hostname = device.hostname if device else ""
    rows = db.query(Software).filter(Software.device_id == device_id).order_by(Software.name).all()
    return [{"id": s.id, "device": hostname, "name": s.name, "version": s.version, "publisher": s.publisher, "install_date": s.install_date, "source": s.source} for s in rows]


@app.get("/api/devices/{device_id}/patches")
def get_patches(device_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    device = db.query(Device).filter(Device.id == device_id).first()
    hostname = device.hostname if device else ""
    rows = db.query(Patch).filter(Patch.device_id == device_id).order_by(Patch.installed_on.desc()).all()
    return [{"id": p.id, "device": hostname, "hotfix_id": p.hotfix_id, "description": p.description, "installed_on": p.installed_on, "installed_by": p.installed_by} for p in rows]


@app.get("/api/devices/{device_id}/commands")
def get_commands(device_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    cmds = db.query(Command).filter(Command.device_id == device_id).order_by(Command.created_at.desc()).all()
    return [{
        "id": c.id,
        "shell": c.shell,
        "command": c.command,
        "status": c.status,
        "exit_code": c.exit_code,
        "output": c.output,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "completed_at": c.completed_at.isoformat() if c.completed_at else None
    } for c in cmds]


@app.get("/api/dashboard")
def dashboard(db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    total = db.query(Device).count()
    online = db.query(Device).filter(Device.status == "online").count()
    offline = total - online
    needs_attention = db.query(Device).filter(
        (Device.cpu_percent > 90) | (Device.memory_percent > 90) | (Device.disk_percent > 90)
    ).count()
    healthy_pct = round(online / total * 100, 1) if total else 0
    by_platform = {}
    for d in db.query(Device).all():
        by_platform[d.platform] = by_platform.get(d.platform, {"total": 0, "online": 0})
        by_platform[d.platform]["total"] += 1
        if d.status == "online":
            by_platform[d.platform]["online"] += 1
    return {
        "total": total,
        "online": online,
        "offline": offline,
        "needs_attention": needs_attention,
        "healthy_pct": healthy_pct,
        "by_platform": by_platform
    }


# ---- Scripts ----

class ScriptPayload(BaseModel):
    name: str
    language: str = "powershell"
    code: str
    description: Optional[str] = ""


@app.get("/api/scripts")
def list_scripts(db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    return [{
        "id": s.id,
        "name": s.name,
        "language": s.language,
        "description": s.description,
        "created_at": s.created_at.isoformat() if s.created_at else None
    } for s in db.query(Script).order_by(Script.name).all()]


@app.post("/api/scripts")
def create_script(payload: ScriptPayload, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    s = Script(name=payload.name, language=payload.language, code=payload.code, description=payload.description)
    db.add(s)
    db.commit()
    return {"id": s.id}


@app.post("/api/devices/{device_id}/run-script/{script_id}")
def run_script(device_id: int, script_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script:
        raise HTTPException(status_code=404, detail="Script not found")
    cmd = Command(device_id=device_id, shell=script.language, command=script.code)
    db.add(cmd)
    db.commit()
    return {"id": cmd.id, "status": "queued"}


# ---- Automations ----

class AutomationPayload(BaseModel):
    name: str
    schedule: str
    script_id: int
    target_group: str = "default"
    enabled: bool = True


@app.get("/api/automations")
def list_automations(db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    return [{
        "id": a.id,
        "name": a.name,
        "schedule": a.schedule,
        "script_id": a.script_id,
        "target_group": a.target_group,
        "enabled": a.enabled
    } for a in db.query(Automation).order_by(Automation.name).all()]


@app.post("/api/automations")
def create_automation(payload: AutomationPayload, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    a = Automation(
        name=payload.name,
        schedule=payload.schedule,
        script_id=payload.script_id,
        target_group=payload.target_group,
        enabled=payload.enabled
    )
    db.add(a)
    db.commit()
    return {"id": a.id}


# ---- Audit ----

@app.get("/api/audit")
def list_audit(db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    return [{
        "id": a.id,
        "username": a.username,
        "action": a.action,
        "detail": a.detail,
        "created_at": a.created_at.isoformat() if a.created_at else None
    } for a in db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(200).all()]


# ---- Agent WebSocket ----

@app.websocket("/ws/agent/{agent_id}")
async def agent_websocket(websocket: WebSocket, agent_id: str, token: str = ""):
    if token != AGENT_TOKEN:
        await websocket.close(code=4001)
        return
    await websocket.accept()
    connected_agents[agent_id] = websocket
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            mtype = msg.get("type")
            session_id = msg.get("session_id")
            # Remote desktop frames are broadcast to all operators watching this device.
            if mtype == "frame" and msg.get("device_id"):
                device_id = msg.get("device_id")
                for op_ws in device_operators.get(device_id, [])[:]:
                    try:
                        await op_ws.send_text(data)
                    except Exception:
                        pass
                continue
            # Terminal output/errors are routed to the specific operator session.
            if session_id and session_id in terminal_sessions:
                await terminal_sessions[session_id].send_text(data)
    except WebSocketDisconnect:
        pass
    finally:
        connected_agents.pop(agent_id, None)


# ---- Operator WebSocket terminal ----

@app.websocket("/ws/terminal/{device_id}")
async def operator_terminal(websocket: WebSocket, device_id: int, token: str = ""):
    if not decode_token(token):
        await websocket.close(code=4001)
        return
    await websocket.accept()
    session_id = str(uuid.uuid4())
    terminal_sessions[session_id] = websocket
    device_operators.setdefault(device_id, []).append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            msg["session_id"] = session_id
            msg["device_id"] = device_id
            db = SessionLocal()
            try:
                device = db.query(Device).filter(Device.id == device_id).first()
                agent_ws = connected_agents.get(device.agent_id) if device else None
            finally:
                db.close()
            if agent_ws:
                await agent_ws.send_text(json.dumps(msg))
            else:
                await websocket.send_text(json.dumps({"type": "error", "text": "Agent offline"}))
    except WebSocketDisconnect:
        pass
    finally:
        terminal_sessions.pop(session_id, None)
        ops = device_operators.get(device_id, [])
        if websocket in ops:
            ops.remove(websocket)


# ---- Static frontend ----

app.mount("/", StaticFiles(directory="web", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
