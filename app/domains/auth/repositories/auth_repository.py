"""Репозиторий auth-домена: учётные данные + сессии."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import asyncpg

from app.core.settings_registry import get as get_domain_settings
from app.db.repositories.base import BaseRepository
from app.domains.auth.settings import AuthSettings

logger = logging.getLogger("audit_workstation.db.repository.auth")


class AuthRepository(BaseRepository):
    """Операции с auth_credentials + auth_sessions."""

    def __init__(self, conn: asyncpg.Connection):
        super().__init__(conn)
        s = get_domain_settings("auth", AuthSettings)
        self.credentials_table = self.adapter.get_table_name("auth_credentials")
        self.sessions_table = self.adapter.get_table_name("auth_sessions")

    # ---------- credentials ----------

    async def get_credentials(self, username: str) -> dict | None:
        row = await self.conn.fetchrow(
            f"""
            SELECT username, password_hash, password_recovery, avatar, avatar_mime,
                   created_at, updated_at, last_login_at
            FROM {self.credentials_table}
            WHERE username = $1
            """,
            username,
        )
        return dict(row) if row else None

    async def upsert_credentials(
        self,
        username: str,
        password_hash: str,
        password_recovery: bytes | None = None,
    ) -> None:
        """Создаёт/обновляет запись credentials.

        password_recovery — Fernet-encrypted пароль (опционально, для собственного
        просмотра через /me). При передаче None поле не обновляется.
        """
        if password_recovery is None:
            await self.conn.execute(
                f"""
                INSERT INTO {self.credentials_table} (username, password_hash)
                VALUES ($1, $2)
                ON CONFLICT (username) DO UPDATE
                  SET password_hash = EXCLUDED.password_hash,
                      updated_at    = NOW()
                """,
                username, password_hash,
            )
        else:
            await self.conn.execute(
                f"""
                INSERT INTO {self.credentials_table}
                    (username, password_hash, password_recovery)
                VALUES ($1, $2, $3)
                ON CONFLICT (username) DO UPDATE
                  SET password_hash    = EXCLUDED.password_hash,
                      password_recovery = EXCLUDED.password_recovery,
                      updated_at        = NOW()
                """,
                username, password_hash, password_recovery,
            )

    async def update_password(
        self, username: str, password_hash: str, password_recovery: bytes | None,
    ) -> None:
        """Обновляет только пароль (после смены)."""
        if password_recovery is None:
            await self.conn.execute(
                f"""
                UPDATE {self.credentials_table}
                   SET password_hash = $2,
                       updated_at    = NOW()
                 WHERE username = $1
                """,
                username, password_hash,
            )
        else:
            await self.conn.execute(
                f"""
                UPDATE {self.credentials_table}
                   SET password_hash    = $2,
                       password_recovery = $3,
                       updated_at        = NOW()
                 WHERE username = $1
                """,
                username, password_hash, password_recovery,
            )

    async def update_avatar(
        self, username: str, avatar: bytes | None, mime: str | None,
    ) -> None:
        await self.conn.execute(
            f"""
            UPDATE {self.credentials_table}
               SET avatar      = $2,
                   avatar_mime = $3,
                   updated_at  = NOW()
             WHERE username = $1
            """,
            username, avatar, mime,
        )

    async def touch_last_login(self, username: str) -> None:
        await self.conn.execute(
            f"""
            UPDATE {self.credentials_table}
               SET last_login_at = NOW(),
                   updated_at    = NOW()
             WHERE username = $1
            """,
            username,
        )

    async def get_avatar(self, username: str) -> tuple[bytes, str] | None:
        row = await self.conn.fetchrow(
            f"SELECT avatar, avatar_mime FROM {self.credentials_table} WHERE username = $1",
            username,
        )
        if not row or row["avatar"] is None:
            return None
        return bytes(row["avatar"]), row["avatar_mime"]

    async def count_credentials(self) -> int:
        return await self.conn.fetchval(
            f"SELECT COUNT(*) FROM {self.credentials_table}"
        )

    # ---------- sessions ----------

    async def create_session(
        self, token: str, username: str, expires_at: datetime,
    ) -> None:
        await self.conn.execute(
            f"""
            INSERT INTO {self.sessions_table} (token, username, expires_at)
            VALUES ($1, $2, $3)
            """,
            token, username, expires_at,
        )

    async def get_session(self, token: str) -> dict | None:
        row = await self.conn.fetchrow(
            f"""
            SELECT token, username, created_at, expires_at
            FROM {self.sessions_table}
            WHERE token = $1 AND expires_at > NOW()
            """,
            token,
        )
        return dict(row) if row else None

    async def delete_session(self, token: str) -> bool:
        result = await self.conn.execute(
            f"DELETE FROM {self.sessions_table} WHERE token = $1",
            token,
        )
        return result == "DELETE 1"

    async def delete_sessions_for_user(self, username: str) -> int:
        result = await self.conn.execute(
            f"DELETE FROM {self.sessions_table} WHERE username = $1",
            username,
        )
        # asyncpg.execute returns "DELETE n"
        try:
            return int(result.split()[-1])
        except (ValueError, IndexError):
            return 0

    async def purge_expired_sessions(self) -> int:
        result = await self.conn.execute(
            f"DELETE FROM {self.sessions_table} WHERE expires_at <= NOW()"
        )
        try:
            return int(result.split()[-1])
        except (ValueError, IndexError):
            return 0
