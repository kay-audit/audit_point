"""Сбросить все пароли и переписать secrets.txt (MVP-инструмент).

Админ-пароль = 'admin', остальные случайные 12-символьные.
Fernet-encrypted (ключ из .env) — расшифровываем и пишем в secrets.txt.
Запускать при старте dev-стенда или после сброса прав.
"""
import asyncio
import os
import secrets
import string
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, r"C:\Users\pasco\opencode_projects\audit_point")

import bcrypt
from cryptography.fernet import Fernet

from app.core.config import get_settings
from app.db.connection import init_db, close_db, get_db

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SECRETS_FILE = PROJECT_ROOT / "secrets.txt"

ALPHABET = string.ascii_letters + string.digits


def gen_password(length: int = 12) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def bcrypt_hash(pwd: str) -> str:
    return bcrypt.hashpw(pwd.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def make_fernet() -> Fernet:
    key = os.environ.get("AUTH__FERNET_KEY", "").strip()
    if not key:
        # Запасной путь — прочитать .env вручную (отбрасываем inline-комментарии)
        env_path = PROJECT_ROOT / ".env"
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("AUTH__FERNET_KEY="):
                raw = line.split("=", 1)[1].strip()
                # Отбрасываем комментарий после значения (whitespace + #)
                for sep in [" #", "\t#", "  #"]:
                    if sep in raw:
                        raw = raw.split(sep, 1)[0].rstrip()
                key = raw
                break
    if not key:
        raise SystemExit("AUTH__FERNET_KEY не найден ни в env, ни в .env")
    return Fernet(key.encode("ascii"))


async def main():
    fernet = make_fernet()
    settings = get_settings()
    await init_db(settings)

    async with get_db() as conn:
        # 1. Список админов (по роли "Админ")
        admin_role_id = await conn.fetchval(
            "SELECT id FROM t_db_oarb_audit_act_roles WHERE name = 'Админ'"
        )
        admin_usernames = set()
        if admin_role_id:
            admin_rows = await conn.fetch(
                "SELECT username FROM t_db_oarb_audit_act_user_roles WHERE role_id = $1",
                admin_role_id,
            )
            admin_usernames = {r["username"] for r in admin_rows}

        # 2. Все пользователи с credentials
        creds = await conn.fetch("""
            SELECT username FROM t_db_oarb_audit_act_auth_credentials
            ORDER BY username
        """)

        new_pwds = {}
        for r in creds:
            uname = r["username"]
            pwd = "admin" if uname in admin_usernames else gen_password()
            new_pwds[uname] = pwd
            recovery = fernet.encrypt(pwd.encode("utf-8"))
            h = bcrypt_hash(pwd)
            await conn.execute(
                """
                UPDATE t_db_oarb_audit_act_auth_credentials
                SET password_hash = $2,
                    password_recovery = $3,
                    updated_at = NOW()
                WHERE username = $1
                """,
                uname, h, recovery,
            )
        # 3. Дамп в secrets.txt (новый блок — append)
        SECRETS_FILE.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        body = [
            "",
            f"# === Auth credentials RESET @ {ts} ===",
            "# Сброшены ВСЕ пароли. Админы -> 'admin', остальные случайные 12-символьные.",
            "# Формат: <username>\t<role>\t<password>",
            "",
        ]
        for uname in sorted(new_pwds):
            role = "admin" if uname in admin_usernames else "user"
            body.append(f"{uname}\t{role}\t{new_pwds[uname]}")
        body.append("")
        with open(SECRETS_FILE, "a", encoding="utf-8") as f:
            f.write("\n".join(body))
        print(f"OK: сброшено {len(new_pwds)} паролей, secrets.txt дополнен.")

    await close_db()


asyncio.run(main())
