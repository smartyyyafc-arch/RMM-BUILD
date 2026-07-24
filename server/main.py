import asyncio
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional
from contextlib import asynccontextmanager

from croniter import croniter

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, status, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import init_db, get_db, SessionLocal
from models import User, Device, Command, AuditLog, Script, Automation, Software, Patch, Alert, Setting
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


DEFAULT_THRESHOLDS = {"cpu": 90.0, "memory": 90.0, "disk": 90.0}


def get_thresholds(db: Session):
    def _get(key, default):
        row = db.query(Setting).filter(Setting.key == key).first()
        try:
            return float(row.value) if row and row.value else default
        except (TypeError, ValueError):
            return default
    return {
        "cpu":    _get("threshold_cpu",    DEFAULT_THRESHOLDS["cpu"]),
        "memory": _get("threshold_memory", DEFAULT_THRESHOLDS["memory"]),
        "disk":   _get("threshold_disk",   DEFAULT_THRESHOLDS["disk"]),
    }


def upsert_alert(db: Session, device: Device, severity: str, category: str, message: str):
    existing = db.query(Alert).filter(
        Alert.device_id == device.id,
        Alert.category == category,
        Alert.dismissed == False
    ).first()
    if existing:
        existing.message = message
        existing.severity = severity
        existing.created_at = datetime.now(timezone.utc)
        return
    db.add(Alert(
        device_id=device.id,
        device_hostname=device.hostname or device.agent_id,
        severity=severity,
        category=category,
        message=message
    ))


def clear_alert(db: Session, device_id: int, category: str):
    for a in db.query(Alert).filter(Alert.device_id == device_id, Alert.category == category, Alert.dismissed == False).all():
        a.dismissed = True


def check_device_alerts(db: Session, device: Device):
    thresholds = get_thresholds(db)
    if device.status == "offline":
        upsert_alert(db, device, "critical", "offline", f"{device.hostname} is offline")
    else:
        clear_alert(db, device.id, "offline")
    for metric, threshold in thresholds.items():
        value = getattr(device, f"{metric}_percent", 0.0) or 0.0
        if value > threshold:
            upsert_alert(db, device, "warning" if value < 95 else "critical", metric, f"{device.hostname} {metric} usage is {value:.1f}%")
        else:
            clear_alert(db, device.id, metric)


async def mark_offline():
    while True:
        await asyncio.sleep(30)
        try:
            db = SessionLocal()
            try:
                now = datetime.now(timezone.utc).timestamp()
                for d in db.query(Device).filter(Device.status == "online").all():
                    # Never mark a device offline while its WebSocket is still open.
                    if d.agent_id in connected_agents:
                        continue
                    if d.last_seen and d.last_seen.timestamp() < now - HEARTBEAT_TIMEOUT_SECONDS:
                        d.status = "offline"
                        check_device_alerts(db, d)
                db.commit()
            finally:
                db.close()
        except Exception:
            pass


automation_last_run: dict[int, datetime] = {}


async def run_automations():
    while True:
        await asyncio.sleep(60)
        try:
            db = SessionLocal()
            try:
                now = datetime.now(timezone.utc).replace(tzinfo=None)  # naive UTC for croniter
                automations = db.query(Automation).filter(Automation.enabled == True).all()
                for a in automations:
                    try:
                        if not croniter.is_valid(a.schedule):
                            continue
                        prev = croniter(a.schedule, now).get_prev(datetime)
                        last = automation_last_run.get(a.id)
                        if last and last >= prev:
                            continue
                        if (now - prev).total_seconds() > 90:
                            continue
                        script = db.query(Script).filter(Script.id == a.script_id).first()
                        if not script:
                            continue
                        devices = db.query(Device).filter(Device.group == a.target_group).all() if a.target_group else db.query(Device).all()
                        for d in devices:
                            db.add(Command(device_id=d.id, shell=script.language, command=script.code))
                        log_audit(db, "system", "automation_run", f"automation={a.name} targets={len(devices)}")
                        automation_last_run[a.id] = prev
                    except Exception:
                        continue
                db.commit()
            finally:
                db.close()
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    db = SessionLocal()
    try:
        ensure_admin(db)
    finally:
        db.close()
    asyncio.create_task(mark_offline())
    asyncio.create_task(run_automations())
    yield


app = FastAPI(title="BasicRMM Server", lifespan=lifespan)
if os.path.isdir(AGENT_FILES_DIR):
    app.mount("/agent", StaticFiles(directory=AGENT_FILES_DIR), name="agent")


@app.get("/install.ps1")
def serve_install_ps1(token: str = "", request: Request = None):
    """Serve install.ps1 with server URL and token baked in as param defaults.

    Enables the clean one-liner: iex ((New-Object Net.WebClient).DownloadString('URL?token=TOKEN'))
    """
    import re
    script_path = os.path.join(AGENT_FILES_DIR, "install.ps1")
    if not os.path.isfile(script_path):
        raise HTTPException(status_code=404, detail="Installer not found")
    with open(script_path, "r", encoding="utf-8") as f:
        script = f.read()
    # Prefer the configured server_url; fall back to request origin respecting X-Forwarded-Proto
    db2 = SessionLocal()
    try:
        rows = db2.query(Setting).all()
        cfg = {s.key: s.value for s in rows}
    finally:
        db2.close()
    server_url = cfg.get("server_url", "").strip()
    if not server_url:
        proto = request.headers.get("x-forwarded-proto", request.url.scheme)
        server_url = f"{proto}://{request.headers.get('host', request.url.netloc)}"
    server_url = server_url.rstrip("/")
    # Embed real server URL and token as param defaults so iex needs no extra args
    script = re.sub(
        r'\[string\]\$ServerUrl\s*=\s*"[^"]*"',
        f'[string]$ServerUrl   = "{server_url}"',
        script,
    )
    if token:
        script = re.sub(
            r'\[string\]\$EnrollToken\s*=\s*"[^"]*"',
            f'[string]$EnrollToken = "{token}"',
            script,
        )
    from fastapi.responses import Response as FResponse
    return FResponse(content=script, media_type="text/plain; charset=utf-8")
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
    check_device_alerts(db, device)
    db.commit()
    db.refresh(device)

    queued = db.query(Command).filter(
        Command.device_id == device.id,
        Command.status == "queued"
    ).order_by(Command.created_at.asc()).all()
    # Advance status to "running" so the same command is never re-dispatched
    # on a subsequent heartbeat before the agent posts its result.
    for c in queued:
        c.status = "running"
    db.commit()
    return {
        "commands": [
            {"id": c.id, "shell": c.shell, "command": c.command}
            for c in queued
        ]
    }


@app.post("/api/agent/command/{command_id}/result")
def command_result(command_id: int, payload: dict, db: Session = Depends(get_db)):
    if payload.get("token") != AGENT_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid agent token")
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
            name=(sw.get("name") or "")[:255],
            version=(sw.get("version") or "")[:100],
            publisher=(sw.get("publisher") or "")[:255],
            install_date=(sw.get("install_date") or "")[:50],
            source=(sw.get("source") or "")[:100]
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
def list_devices(status: Optional[str] = None, group: Optional[str] = None, q: Optional[str] = None, skip: int = 0, limit: int = 100, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    query = db.query(Device)
    if status:
        query = query.filter(Device.status == status)
    if group:
        query = query.filter(Device.group == group)
    if q:
        query = query.filter(Device.hostname.ilike(f"%{q}%"))
    total = query.count()
    devices = query.order_by(Device.hostname).offset(skip).limit(limit).all()
    items = [{
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
    return {"total": total, "skip": skip, "limit": limit, "items": items}


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
    t = get_thresholds(db)
    needs_attention = db.query(Device).filter(
        (Device.cpu_percent > t["cpu"]) |
        (Device.memory_percent > t["memory"]) |
        (Device.disk_percent > t["disk"])
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


@app.get("/api/scripts/{script_id}")
def get_script(script_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    s = db.query(Script).filter(Script.id == script_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Script not found")
    return {
        "id": s.id,
        "name": s.name,
        "language": s.language,
        "description": s.description,
        "code": s.code,
        "created_at": s.created_at.isoformat() if s.created_at else None
    }


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


# ---- Users ----

@app.get("/api/auth/users")
def list_users(db: Session = Depends(get_db), current: User = Depends(require_admin)):
    return [{"id": u.id, "username": u.username, "email": u.email, "is_admin": u.is_admin} for u in db.query(User).order_by(User.username).all()]


# ---- Alerts ----

@app.get("/api/alerts")
def list_alerts(dismissed: Optional[str] = None, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    q = db.query(Alert)
    if dismissed == "0":
        q = q.filter(Alert.dismissed == False)
    elif dismissed == "1":
        q = q.filter(Alert.dismissed == True)
    return [{
        "id": a.id,
        "device_id": a.device_id,
        "device_hostname": a.device_hostname,
        "severity": a.severity,
        "category": a.category,
        "message": a.message,
        "dismissed": a.dismissed,
        "created_at": a.created_at.isoformat() if a.created_at else None
    } for a in q.order_by(Alert.created_at.desc()).limit(200).all()]


@app.post("/api/alerts/{alert_id}/dismiss")
def dismiss_alert(alert_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    a = db.query(Alert).filter(Alert.id == alert_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="Alert not found")
    a.dismissed = True
    db.commit()
    return {"ok": True}


# ---- Settings ----

@app.get("/api/settings")
def get_settings(db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    rows = db.query(Setting).all()
    settings = {s.key: s.value for s in rows}
    result = {
        "threshold_cpu": settings.get("threshold_cpu", "90"),
        "threshold_memory": settings.get("threshold_memory", "90"),
        "threshold_disk": settings.get("threshold_disk", "90"),
        "server_url": settings.get("server_url", "")
    }
    if current.is_admin:
        result["agent_token"] = AGENT_TOKEN
    return result


class SettingsPayload(BaseModel):
    threshold_cpu: Optional[float] = None
    threshold_memory: Optional[float] = None
    threshold_disk: Optional[float] = None
    server_url: Optional[str] = None


@app.put("/api/settings")
def update_settings(payload: SettingsPayload, db: Session = Depends(get_db), current: User = Depends(require_admin)):
    for key, value in payload.dict(exclude_unset=True).items():
        if value is None:
            continue
        s = db.query(Setting).filter(Setting.key == key).first()
        val = str(value)
        if s:
            s.value = val
        else:
            db.add(Setting(key=key, value=val))
    db.commit()
    return {"ok": True}


# ---- Reports ----

@app.get("/api/reports/summary")
def report_summary(db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    total = db.query(Device).count()
    online = db.query(Device).filter(Device.status == "online").count()
    offline = total - online
    t = get_thresholds(db)
    needs_attention = db.query(Device).filter(
        (Device.cpu_percent > t["cpu"]) |
        (Device.memory_percent > t["memory"]) |
        (Device.disk_percent > t["disk"])
    ).count()
    alerts = db.query(Alert).filter(Alert.dismissed == False).count()
    by_platform = {}
    for d in db.query(Device).all():
        p = d.platform or "unknown"
        by_platform[p] = by_platform.get(p, {"total": 0, "online": 0})
        by_platform[p]["total"] += 1
        if d.status == "online":
            by_platform[p]["online"] += 1
    recent_audit = db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(10).all()
    return {
        "total_devices": total,
        "online": online,
        "offline": offline,
        "needs_attention": needs_attention,
        "open_alerts": alerts,
        "by_platform": by_platform,
        "recent_audit": [{"time": a.created_at.isoformat() if a.created_at else None, "user": a.username, "action": a.action, "detail": a.detail} for a in recent_audit]
    }


# ---- Agent WebSocket ----

@app.websocket("/ws/agent/{agent_id}")
async def agent_websocket(websocket: WebSocket, agent_id: str, token: str = ""):
    if token != AGENT_TOKEN:
        await websocket.close(code=4001)
        return
    await websocket.accept()
    connected_agents[agent_id] = websocket
    # Mark online immediately so the UI reflects reality without waiting for
    # the next 30-second heartbeat.
    _db = SessionLocal()
    try:
        _dev = _db.query(Device).filter(Device.agent_id == agent_id).first()
        if _dev and _dev.status != "online":
            _dev.status = "online"
            _dev.last_seen = datetime.now(timezone.utc)
            _db.commit()
    except Exception:
        pass
    finally:
        _db.close()
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            mtype = msg.get("type")
            session_id = msg.get("session_id")
            # Remote desktop frames are broadcast to all operators watching this device.
            if mtype == "frame" and msg.get("device_id"):
                raw_id = msg.get("device_id")
                try:
                    device_id = int(raw_id)
                except (TypeError, ValueError):
                    device_id = raw_id
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
    # Resolve agent_id once at connect time — avoids a blocking DB call on every message.
    db = SessionLocal()
    try:
        device = db.query(Device).filter(Device.id == device_id).first()
        cached_agent_id = device.agent_id if device else None
    finally:
        db.close()
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            msg["session_id"] = session_id
            msg["device_id"] = device_id
            agent_ws = connected_agents.get(cached_agent_id) if cached_agent_id else None
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
        if not ops:
            device_operators.pop(device_id, None)


# ---- Commands (individual poll) ----

@app.get("/api/commands/{command_id}")
def get_command(command_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    c = db.query(Command).filter(Command.id == command_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Command not found")
    return {
        "id": c.id, "shell": c.shell, "command": c.command,
        "status": c.status, "exit_code": c.exit_code, "output": c.output,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "completed_at": c.completed_at.isoformat() if c.completed_at else None
    }


# ---- Delete endpoints ----

@app.delete("/api/devices/{device_id}")
def delete_device(device_id: int, db: Session = Depends(get_db), current: User = Depends(require_admin)):
    d = db.query(Device).filter(Device.id == device_id).first()
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")
    db.query(Command).filter(Command.device_id == device_id).delete()
    db.query(Software).filter(Software.device_id == device_id).delete()
    db.query(Patch).filter(Patch.device_id == device_id).delete()
    db.query(Alert).filter(Alert.device_id == device_id).delete()
    hostname = d.hostname
    db.delete(d)
    db.add(AuditLog(username=current.username, action="delete_device", detail=f"deleted {hostname}"))
    db.commit()
    return {"ok": True}


@app.delete("/api/scripts/{script_id}")
def delete_script(script_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    s = db.query(Script).filter(Script.id == script_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Script not found")
    db.delete(s)
    db.commit()
    return {"ok": True}


@app.put("/api/scripts/{script_id}")
def update_script(script_id: int, payload: ScriptPayload, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    s = db.query(Script).filter(Script.id == script_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Script not found")
    s.name = payload.name
    s.language = payload.language
    s.code = payload.code
    s.description = payload.description
    db.commit()
    return {"ok": True}


@app.delete("/api/automations/{automation_id}")
def delete_automation(automation_id: int, db: Session = Depends(get_db), current: User = Depends(get_current_user)):
    a = db.query(Automation).filter(Automation.id == automation_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="Automation not found")
    db.delete(a)
    db.commit()
    return {"ok": True}


@app.delete("/api/auth/users/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db), current: User = Depends(require_admin)):
    u = db.query(User).filter(User.id == user_id).first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if u.username == current.username:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    db.delete(u)
    db.commit()
    log_audit(db, current.username, "delete_user", f"deleted {u.username}")
    return {"ok": True}


# ---- Agent self-update ----

@app.post("/api/admin/update-agents")
async def update_all_agents(db: Session = Depends(get_db), current: User = Depends(require_admin)):
    """Send update_agent command to every currently-connected agent via WebSocket."""
    notified = 0
    for agent_id, ws in list(connected_agents.items()):
        try:
            await ws.send_json({"type": "update_agent"})
            notified += 1
        except Exception:
            pass
    log_audit(db, current.username, "update_agents", f"triggered self-update on {notified} agents")
    return {"updated": notified, "total": len(connected_agents)}


# ---- Installer downloads ----

@app.get("/install.sh")
async def serve_install_sh(token: str = ""):
    from fastapi.responses import FileResponse
    import pathlib
    p = pathlib.Path("/app/agent/install.sh")
    if not p.exists():
        from fastapi.responses import PlainTextResponse
        sh = f"""#!/usr/bin/env bash
set -euo pipefail
SERVER_URL="${{1:-$RMM_SERVER}}"
AGENT_TOKEN="${{2:-$RMM_AGENT_TOKEN}}"
INSTALL_DIR="/opt/basicrmm"
mkdir -p "$INSTALL_DIR"
curl -fsSL "$SERVER_URL/agent/agent.py" -o "$INSTALL_DIR/agent.py"
curl -fsSL "$SERVER_URL/agent/requirements.txt" -o "$INSTALL_DIR/requirements.txt"
pip3 install -q -r "$INSTALL_DIR/requirements.txt"
cat > /etc/systemd/system/basicrmm-agent.service <<EOF
[Unit]
Description=BasicRMM Agent
After=network.target
[Service]
ExecStart=/usr/bin/python3 $INSTALL_DIR/agent.py
Environment=RMM_SERVER=$SERVER_URL
Environment=RMM_AGENT_TOKEN=$AGENT_TOKEN
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now basicrmm-agent
echo "BasicRMM agent installed."
"""
        return PlainTextResponse(sh, media_type="text/plain")
    return FileResponse(str(p), media_type="text/plain; charset=utf-8")


# ---- Static frontend ----

app.mount("/", StaticFiles(directory="web", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
