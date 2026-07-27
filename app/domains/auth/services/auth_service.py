"""Сервис auth-домена: верификация паролей, сессии, смена/сброс, аватары."""
from __future__ import annotations

import logging
import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Any

import asyncpg
import bcrypt
from cryptography.fernet import Fernet, InvalidToken

from app.core.settings_registry import get as get_domain_settings
from app.domains.auth.repositories.auth_repository import AuthRepository
from app.domains.auth.settings import AuthSettings

logger = logging.getLogger("audit_workstation.domains.auth.service")

ALPHABET = string.ascii_letters + string.digits
MIN_USER_INFO_LEN = 1


def _bcrypt_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def _bcrypt_verify(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("ascii"))
    except (ValueError, TypeError):
        return False


def _generate_password(length: int = 12) -> str:
    """Генерирует пароль из букв+цифр (без спецсимволов — упрощает ввод)."""
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def _make_token() -> str:
    return secrets.token_urlsafe(48)


class AuthError(Exception):
    """Базовая ошибка auth-домена."""

    http_status = 400


class InvalidCredentialsError(AuthError):
    http_status = 401


class UserNotFoundError(AuthError):
    http_status = 404


class InvalidOldPasswordError(AuthError):
    http_status = 400


class AuthService:
    """Бизнес-логика авторизации: логин, сессии, пароли, аватары."""

    def __init__(self, conn: asyncpg.Connection):
        self.conn = conn
        self.settings = get_domain_settings("auth", AuthSettings)
        self.repo = AuthRepository(conn)
        self._fernet = self._build_fernet()

    def _build_fernet(self) -> Fernet | None:
        if not self.settings.fernet_key:
            return None
        try:
            return Fernet(self.settings.fernet_key.encode("ascii"))
        except (ValueError, TypeError) as e:
            logger.warning("AUTH__FERNET_KEY невалиден: %s", e)
            return None

    def encrypt_for_recovery(self, password: str) -> bytes | None:
        if self._fernet is None:
            return None
        return self._fernet.encrypt(password.encode("utf-8"))

    def decrypt_for_recovery(self, token: bytes) -> str | None:
        if self._fernet is None:
            return None
        try:
            return self._fernet.decrypt(bytes(token)).decode("utf-8")
        except InvalidToken:
            return None

    # ---------- директорий пользователей ----------

    async def _user_directory_row(self, username: str) -> dict | None:
        """Читает запись из t_db_oarb_ua_user (для fullname/job)."""
        # resolve user_table via admin-settings (он знает имя таблицы)
        from app.core.settings_registry import get as get_domain_settings
        from app.domains.admin.settings import AdminSettings
        admin_s = get_domain_settings("admin", AdminSettings)
        # user_directory.table — это имя С префиксом (например, t_db_oarb_ua_user),
        # qualify_table_name оставляет его как есть, добавляя только схему.
        ud_table = self.repo.adapter.qualify_table_name(
            admin_s.user_directory.table, admin_s.user_directory.schema_name,
        )
        row = await self.conn.fetchrow(
            f"""
            SELECT username,
                   COALESCE(fullname, '') AS fullname,
                   COALESCE(job, '') AS job,
                   COALESCE(tn, '') AS tn,
                   COALESCE(email, '') AS email,
                   COALESCE(branch, '') AS branch
            FROM {ud_table}
            WHERE username = $1
            """,
            username,
        )
        return dict(row) if row else None

    async def _user_roles(self, username: str) -> list[dict]:
        from app.core.settings_registry import get as get_domain_settings
        from app.domains.admin.settings import AdminSettings
        admin_s = get_domain_settings("admin", AdminSettings)
        # roles/user_roles — таблицы admin-домена, лежат в основной схеме приложения
        # (с префиксом DATABASE__TABLE_PREFIX). Используем get_table_name, который
        # добавит префикс.
        roles_table = self.repo.adapter.get_table_name("roles", admin_s.user_directory.schema_name)
        user_roles_table = self.repo.adapter.get_table_name("user_roles", admin_s.user_directory.schema_name)
        rows = await self.conn.fetch(
            f"""
            SELECT r.id, r.name, r.domain_name
            FROM {user_roles_table} ur
            JOIN {roles_table} r ON r.id = ur.role_id
            WHERE ur.username = $1
            ORDER BY r.id
            """,
            username,
        )
        return [dict(r) for r in rows]

    async def is_admin(self, username: str) -> bool:
        roles = await self._user_roles(username)
        return any(r["name"] == "Администратор" for r in roles)

    # ---------- credentials ----------

    async def get_or_create_credentials(
        self, username: str, *, default_password: str | None = None,
    ) -> dict:
        """Возвращает запись credentials, при отсутствии — создаёт с default_password.

        Используется при первичном сидинге.
        """
        existing = await self.repo.get_credentials(username)
        if existing:
            return existing
        pwd = default_password or _generate_password()
        recovery = self.encrypt_for_recovery(pwd)
        await self.repo.upsert_credentials(username, _bcrypt_hash(pwd), recovery)
        logger.info("Созданы credentials для пользователя %s", username)
        return await self.repo.get_credentials(username) or {}

    # ---------- login / logout ----------

    async def authenticate(self, username: str, password: str) -> dict:
        """Проверяет логин/пароль. Возвращает dict с user-инфо (fullname, job, is_admin).

        Raises:
            InvalidCredentialsError: неверный пароль или пользователь не найден.
        """
        creds = await self.repo.get_credentials(username)
        if not creds:
            raise InvalidCredentialsError("Неверный логин или пароль")
        if not _bcrypt_verify(password, creds["password_hash"]):
            raise InvalidCredentialsError("Неверный логин или пароль")
        user = await self._user_directory_row(username)
        if not user:
            raise InvalidCredentialsError(
                "Учётная запись существует, но пользователь не найден в справочнике",
            )
        is_admin = await self.is_admin(username)
        await self.repo.touch_last_login(username)
        return {
            "username": username,
            "fullname": user["fullname"],
            "job": user["job"],
            "is_admin": is_admin,
            "avatar_available": creds.get("avatar") is not None,
        }

    async def create_session(self, username: str) -> tuple[str, datetime]:
        token = _make_token()
        expires_at = datetime.now(timezone.utc) + timedelta(
            hours=self.settings.session_ttl_hours,
        )
        await self.repo.create_session(token, username, expires_at)
        return token, expires_at

    async def resolve_session(self, token: str) -> dict | None:
        return await self.repo.get_session(token)

    async def logout(self, token: str) -> bool:
        return await self.repo.delete_session(token)

    # ---------- смена / сброс пароля ----------

    async def change_password(
        self, username: str, old_password: str, new_password: str,
    ) -> None:
        """Смена своего пароля. Требует знание текущего."""
        creds = await self.repo.get_credentials(username)
        if not creds or not _bcrypt_verify(old_password, creds["password_hash"]):
            raise InvalidOldPasswordError("Неверный текущий пароль")
        await self._set_password(username, new_password)
        # Инвалидируем все сессии пользователя (кроме текущей — но для MVP это
        # упрощённо: гасим все, пусть залогинится заново).
        killed = await self.repo.delete_sessions_for_user(username)
        if killed:
            logger.info("Смена пароля %s: отозвано %d сессий", username, killed)

    async def reset_password(self, username: str, new_password: str | None) -> str:
        """Сброс пароля админом. Возвращает установленный пароль (для админа, одноразово)."""
        if not await self.repo.get_credentials(username):
            raise UserNotFoundError(f"Credentials для {username} не найдены")
        pwd = new_password or _generate_password(12)
        await self._set_password(username, pwd)
        killed = await self.repo.delete_sessions_for_user(username)
        if killed:
            logger.info("Сброс пароля %s: отозвано %d сессий", username, killed)
        return pwd

    async def _set_password(self, username: str, new_password: str) -> None:
        recovery = self.encrypt_for_recovery(new_password)
        await self.repo.update_password(
            username, _bcrypt_hash(new_password), recovery,
        )

    # ---------- current-user info ----------

    async def build_me(self, username: str) -> dict:
        creds = await self.repo.get_credentials(username)
        user = await self._user_directory_row(username)
        is_admin = await self.is_admin(username)
        password_recoverable = (
            creds is not None
            and creds.get("password_recovery") is not None
            and self._fernet is not None
        )
        return {
            "authenticated": True,
            "username": username,
            "fullname": user["fullname"] if user else "",
            "job": user["job"] if user else "",
            "is_admin": is_admin,
            "avatar_available": creds is not None and creds.get("avatar") is not None,
            "password_recoverable": password_recoverable,
        }

    async def get_own_password(self, username: str) -> str | None:
        """Расшифровка собственного Fernet-encrypted пароля (для попапа «Показать»)."""
        creds = await self.repo.get_credentials(username)
        if not creds or not creds.get("password_recovery"):
            return None
        return self.decrypt_for_recovery(creds["password_recovery"])

    # ---------- avatar ----------

    async def set_avatar(self, username: str, data: bytes, mime: str) -> None:
        await self.repo.update_avatar(username, data, mime)

    async def clear_avatar(self, username: str) -> None:
        await self.repo.update_avatar(username, None, None)

    async def get_avatar(self, username: str) -> tuple[bytes, str] | None:
        return await self.repo.get_avatar(username)

    # ---------- user info для админа ----------

    async def user_info(self, username: str) -> dict:
        user = await self._user_directory_row(username)
        creds = await self.repo.get_credentials(username)
        if not user:
            raise UserNotFoundError(f"Пользователь {username} не найден в справочнике")
        is_admin = await self.is_admin(username)
        return {
            "username": username,
            "fullname": user["fullname"],
            "job": user["job"],
            "is_admin": is_admin,
            "avatar_available": creds is not None and creds.get("avatar") is not None,
        }
