"""Lifecycle auth-домена: сидинг credentials при первом запуске.

Создаёт записи в t_db_oarb_audit_act_auth_credentials для всех пользователей
из t_db_oarb_ua_user. Пароли:
- админы (роль 'Админ'): "admin"
- остальные: случайные 12-символьные

Дамп паролей пишется в secrets.txt в корне проекта (НЕ коммитится, в .gitignore).
Пересоздаётся только если в credentials_table пусто.
"""
from __future__ import annotations

import logging
import os
import secrets
import string
from datetime import datetime
from pathlib import Path

import asyncpg
import bcrypt

from app.core.settings_registry import get as get_domain_settings
from app.db.connection import get_db
from app.domains.auth.services.auth_service import AuthService
from app.domains.auth.settings import AuthSettings

logger = logging.getLogger("audit_workstation.domains.auth.lifecycle")

_ALPHABET = string.ascii_letters + string.digits
ADMIN_PASSWORD = "admin"  # nosec — MVP, осознанный выбор пользователя.
RANDOM_PASSWORD_LEN = 12
PROJECT_ROOT = Path(__file__).resolve().parents[3]
SECRETS_FILE = PROJECT_ROOT / "secrets.txt"


def _gen_password(length: int = RANDOM_PASSWORD_LEN) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


async def _all_usernames(conn: asyncpg.Connection) -> list[str]:
    """Возвращает все username, которые должны иметь credentials (из справочника)."""
    rows = await conn.fetch(
        "SELECT DISTINCT username FROM t_db_oarb_ua_user WHERE username <> '' ORDER BY username"
    )
    return [r["username"] for r in rows]


async def _admin_usernames(conn: asyncpg.Connection) -> set[str]:
    rows = await conn.fetch(
        """
        SELECT DISTINCT ur.username
        FROM t_db_oarb_audit_act_user_roles ur
        JOIN t_db_oarb_audit_act_roles r ON r.id = ur.role_id
        WHERE r.name = 'Админ'
        """
    )
    return {r["username"] for r in rows}


async def seed_auth_credentials(force: bool = False) -> dict:
    """Сидит credentials для всех пользователей справочника.

    Args:
        force: пересоздать credentials для всех (полезно после сброса).

    Returns:
        dict с распределением и путём к secrets.txt.
    """
    async with get_db() as conn:
        svc = AuthService(conn)
        if not force and await svc.repo.count_credentials() > 0:
            logger.info("Credentials уже сидированы, пропускаем")
            return {"skipped": True, "secrets_path": str(SECRETS_FILE)}

        usernames = await _all_usernames(conn)
        admins = await _admin_usernames(conn)
        if not usernames:
            logger.warning("Справочник t_db_oarb_ua_user пуст — нечего сидить")
            return {"skipped": True, "secrets_path": str(SECRETS_FILE)}

        secrets_log: list[tuple[str, str, str]] = []
        for uname in usernames:
            pwd = ADMIN_PASSWORD if uname in admins else _gen_password()
            creds = await svc.repo.get_credentials(uname)
            if creds and not force:
                continue
            recovery = svc.encrypt_for_recovery(pwd)
            pwd_hash = bcrypt.hashpw(pwd.encode("utf-8"), bcrypt.gensalt()).decode("ascii")
            await svc.repo.upsert_credentials(uname, pwd_hash, recovery)
            role = "admin" if uname in admins else "user"
            secrets_log.append((uname, role, pwd))

    # Пишем secrets.txt (НЕ перезаписываем существующий — чтобы повторный
    # сидинг не сносил старые пароли, иначе восстановление станет невозможной).
    if secrets_log:
        await _append_secrets_file(secrets_log)

    logger.info(
        "Auth-credentials: создано %d записей, secrets.txt обновлён",
        len(secrets_log),
    )
    return {
        "created": len(secrets_log),
        "secrets_path": str(SECRETS_FILE),
    }


async def _append_secrets_file(rows: list[tuple[str, str, str]]) -> None:
    """Дописывает блок credentials в secrets.txt. Не перезатирает прошлые блоки."""
    SECRETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    body = [
        "",
        f"# === Auth credentials seed @ {timestamp} ===",
        "# Формат: <username>\t<role>\t<password>",
        "",
    ]
    for uname, role, pwd in rows:
        body.append(f"{uname}\t{role}\t{pwd}")
    body.append("")
    with open(SECRETS_FILE, "a", encoding="utf-8") as f:
        f.write("\n".join(body))


async def reset_all_passwords() -> dict:
    """Полный сброс всех credentials (только для админа; используется при
    восстановлении). Генерирует новые пароли и дописывает их в secrets.txt."""
    return await seed_auth_credentials(force=True)
