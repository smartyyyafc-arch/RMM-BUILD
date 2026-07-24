import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
import jwt
from jwt.exceptions import InvalidTokenError as JWTError
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from database import get_db
from models import User

SECRET_KEY = os.getenv("SECRET_KEY", "change-me-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("sub")
    except JWTError:
        return None

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    creds = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    username = decode_token(token)
    if username is None:
        raise creds
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        raise creds
    return user

def require_admin(current: User = Depends(get_current_user)) -> User:
    if not current.is_admin:
        raise HTTPException(status_code=403, detail="Admin required")
    return current

def ensure_admin(db: Session):
    """Provision the initial admin on first boot without leaking the password to
    ordinary container logs. Order of precedence for the initial password:
      1. ADMIN_PASSWORD env var (preferred — set it in the compose/secret store).
      2. A cryptographically random password written ONCE to a restricted file
         ($RMM_ADMIN_CREDENTIALS_FILE, default <data dir>/initial_admin_password),
         chmod 600. The operator reads it there and then deletes the file.
    The password is never written to stdout/stderr."""
    if db.query(User).first():
        return

    env_pw = os.getenv("ADMIN_PASSWORD", "").strip()
    password = env_pw or secrets.token_urlsafe(16)
    db.add(User(
        username="admin",
        email="admin@example.com",
        hashed_password=get_password_hash(password),
        is_admin=True,
    ))
    db.commit()

    if env_pw:
        # Operator supplied it; nothing to persist or print.
        print("[BasicRMM] Initial admin created from ADMIN_PASSWORD.", flush=True)
        return

    data_dir = os.getenv("DATA_DIR") or os.path.dirname(
        os.getenv("DATABASE_URL", "").replace("sqlite:///", "") or ""
    ) or "."
    cred_path = os.getenv(
        "RMM_ADMIN_CREDENTIALS_FILE", os.path.join(data_dir, "initial_admin_password")
    )
    try:
        os.makedirs(os.path.dirname(cred_path) or ".", exist_ok=True)
        fd = os.open(cred_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(f"username: admin\npassword: {password}\n")
        print(
            f"[BasicRMM] Initial admin created. Password written to {cred_path} "
            f"(mode 600) — read it, then delete the file. Or set ADMIN_PASSWORD.",
            flush=True,
        )
    except Exception:
        # Last resort so a fresh deploy is never permanently locked out, but keep
        # the secret out of the normal logs: only note that manual reset is needed.
        print(
            "[BasicRMM] Initial admin created but the password file could not be "
            "written. Set ADMIN_PASSWORD and restart, or reset the admin password.",
            flush=True,
        )
