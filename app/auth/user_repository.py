"""Репозиторий пользователей для модуля авторизации (asyncpg).

Собственного SQL не держит: и справочник пользователей, и модель ролей
принадлежат домену admin, поэтому запросы выполняют его репозитории
(``UserDirectoryRepository`` и ``AdminRepository``). Здесь остаётся только
приведение строк справочника к форме, которую ожидает слой авторизации
(``id``/``email``/``login``/``fullname``). Дублировать эти запросы в auth
нельзя: расхождение с admin означало бы, что авторизация видит пользователя
и его роли иначе, чем администрирование.
"""

from __future__ import annotations

import logging

import asyncpg

from app.core.settings_registry import get as get_domain_settings
from app.domains.admin.settings import AdminSettings

logger = logging.getLogger("audit_workstation.auth.user_repository")


class AuthUserRepository:
    """Поиск пользователей в справочнике и загрузка контекста для JWT."""

    def __init__(self, conn: asyncpg.Connection) -> None:
        # Импорт репозиториев admin — внутри функции: на уровне модуля он
        # замыкает цикл. app.auth.router подключён к app.api.v1.routes, а
        # пакет admin.services тянет admin_service → app.api.v1.deps.role_deps
        # → app.api → ... → app.auth.router, и auth импортировался бы сам в
        # себя недоинициализированным.
        from app.domains.admin.repositories.admin_repository import AdminRepository
        from app.domains.admin.services.user_directory import UserDirectoryRepository

        self._directory = UserDirectoryRepository(conn)
        self._admin = AdminRepository(
            conn, get_domain_settings("admin", AdminSettings)
        )

    @staticmethod
    def _to_auth_user(row: dict) -> dict:
        """Приводит строку справочника к форме слоя авторизации."""
        return {
            "id": row["username"],
            "email": row["email"],
            "login": row["username"],
            "fullname": row["fullname"],
            "job": row["job"],
        }

    async def find_by_email(self, email: str) -> dict | None:
        """Ищет пользователя по email (точное совпадение, без учёта регистра)."""
        row = await self._directory.find_by_email(email)
        return self._to_auth_user(row) if row else None

    async def find_by_id(self, user_id: str) -> dict | None:
        """Ищет пользователя по username (sub в JWT)."""
        row = await self._directory.find_by_username(user_id)
        return self._to_auth_user(row) if row else None

    async def get_user_context(self, user_id: str) -> dict | None:
        """Загружает пользователя и его роли из существующей системы RBAC."""
        user = await self.find_by_id(user_id)
        if user is None:
            return None

        roles = await self._admin.get_user_roles(user_id)

        return {
            "id": user["id"],
            "email": user["email"],
            "login": user["login"],
            "fullname": user["fullname"],
            "job": user["job"],
            "teams": [],
            "roles": sorted(role["name"] for role in roles),
        }
