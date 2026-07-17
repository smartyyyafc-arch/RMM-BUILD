from sqlalchemy import Column, Integer, String, Float, DateTime, Text, Boolean, ForeignKey, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.sql import func

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    email = Column(String)
    hashed_password = Column(String)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class Device(Base):
    __tablename__ = "devices"
    id = Column(Integer, primary_key=True, index=True)
    hostname = Column(String, index=True)
    agent_id = Column(String, unique=True, index=True)
    os = Column(String)
    platform = Column(String)
    version = Column(String)
    status = Column(String, default="offline")
    cpu_percent = Column(Float, default=0.0)
    memory_percent = Column(Float, default=0.0)
    disk_percent = Column(Float, default=0.0)
    last_seen = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    group = Column(String, default="default")
    tags = Column(String, default="")
    ip = Column(String)
    user = Column(String)

class Command(Base):
    __tablename__ = "commands"
    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"))
    shell = Column(String, default="powershell")
    command = Column(Text)
    status = Column(String, default="queued")  # queued, running, done, failed
    exit_code = Column(Integer, nullable=True)
    output = Column(Text, default="")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)

class AuditLog(Base):
    __tablename__ = "audit_logs"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String)
    action = Column(String)
    detail = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class Script(Base):
    __tablename__ = "scripts"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True)
    language = Column(String, default="powershell")
    code = Column(Text)
    description = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class Automation(Base):
    __tablename__ = "automations"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True)
    schedule = Column(String)
    script_id = Column(Integer, ForeignKey("scripts.id"))
    target_group = Column(String, default="default")
    enabled = Column(Boolean, default=True)

class Software(Base):
    __tablename__ = "software"
    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"))
    name = Column(String)
    version = Column(String)
    publisher = Column(String)
    install_date = Column(String)
    source = Column(String)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class Patch(Base):
    __tablename__ = "patches"
    id = Column(Integer, primary_key=True, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"))
    hotfix_id = Column(String)
    description = Column(String)
    installed_on = Column(String)
    installed_by = Column(String)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
