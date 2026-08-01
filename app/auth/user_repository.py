"""Репозиторий пользователей для модуля авторизации (asyncpg)."""

from __future__ import annotations

import logging

import asyncpg

from app.core.settings_registry import get as get_domain_settings
from app.db.connection import get_adapter
from app.domains.admin.settings import AdminSettings

logger = logging.getLogger("audit_workstation.auth.user_repository")


class AuthUserRepository:
    """Поиск пользователей в справочнике и загрузка контекста для JWT."""

    def __init__(self, conn: asyncpg.Connection) -> None:
        self._conn = conn
        adapter = get_adapter()
        settings = get_domain_settings("admin", AdminSettings)
        ud = settings.user_directory
        self._user_table = adapter.qualify_table_name(ud.table, ud.schema_name)
        self._roles_table = adapter.get_table_name("roles")
        self._user_roles_table = adapter.get_table_name("user_roles")

    async def find_by_email(self, email: str) -> dict | None:
        """Ищет пользователя по email (точное совпадение, без учёта регистра)."""
        row = await self._conn.fetchrow(
            f"""
            SELECT username, email, fullname
            FROM (
                SELECT DISTINCT ON (username)
                       username,
                       COALESCE(email, '') AS email,
                       COALESCE(fullname, '') AS fullname
                FROM {self._user_table}
                WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
                ORDER BY username
            ) sub
            LIMIT 1
            """,
            email,
        )
        if row is None:
            return None
        return {
            "id": row["username"],
            "email": row["email"],
            "login": row["username"],
            "fullname": row["fullname"],
        }

    async def find_by_id(self, user_id: str) -> dict | None:
        """Ищет пользователя по username (sub в JWT)."""
        row = await self._conn.fetchrow(
            f"""
            SELECT DISTINCT ON (username)
                   username,
                   COALESCE(email, '') AS email,
                   COALESCE(fullname, '') AS fullname
            FROM {self._user_table}
            WHERE username = $1
            ORDER BY username
            LIMIT 1
            """,
            user_id,
        )
        if row is None:
            return None
        return {
            "id": row["username"],
            "email": row["email"],
            "login": row["username"],
            "fullname": row["fullname"],
        }

    async def get_user_context(self, user_id: str) -> dict | None:
        """Загружает пользователя и его роли из существующей системы RBAC."""
        user = await self.find_by_id(user_id)
        if user is None:
            return None

        rows = await self._conn.fetch(
            f"""
            SELECT r.name
            FROM {self._user_roles_table} ur
            JOIN {self._roles_table} r ON ur.role_id = r.id
            WHERE ur.username = $1
            ORDER BY r.name
            """,
            user_id,
        )
        roles = [row["name"] for row in rows]

        return {
            "id": user["id"],
            "email": user["email"],
            "login": user["login"],
            "fullname": user["fullname"],
            "teams": [],
            "roles": roles,
        }
