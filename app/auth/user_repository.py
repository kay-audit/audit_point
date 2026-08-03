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

from app.core.redis import RedisAdapter, get_redis
from app.core.settings_registry import get as get_domain_settings
from app.domains.admin.settings import AdminSettings

logger = logging.getLogger("audit_workstation.auth.user_repository")

# Полный ключ — префикс + user_id + номер эпохи (см. read_user_cache_epoch).
# TTL держит контекст свежим без явной инвалидации на случай изменений в
# справочнике (ФИО/должность из ETL) мимо смены ролей.
USERCTX_CACHE_KEY_PREFIX = "cache:userctx:"
_USERCTX_CACHE_TTL_SEC = 300

# Общая эпоха пользовательских кэшей — user-контекста (здесь) и ролей
# (app.api.v1.deps.role_deps): у обоих один идентификатор, username == user_id
# (см. докстринг find_by_id), и инвалидируются они всегда вместе.
# Живёт здесь, а не рядом с инвалидацией в role_deps: тот импортирует auth,
# обратный импорт замкнул бы цикл.
# Ключ намеренно без TTL: истеки он — эпоха вернулась бы к «0», а ключи старых
# эпох ещё живы, и чтения снова увидели бы устаревшие данные.
USER_CACHE_EPOCH_KEY_PREFIX = "cache:userver:"


async def read_user_cache_epoch(redis: RedisAdapter, user_id: str) -> str:
    """Номер эпохи пользовательских кэшей; ключа нет — эпоха «0».

    Эпоха зашита в адрес ключа данных, а инвалидация — это INCR эпохи
    (``invalidate_user_roles_cache``), не DEL ключей. Читатель обязан взять
    номер ДО похода в БД и записать результат в ключ ИМЕННО этой эпохи: тогда
    инвалидация, случившаяся пока он читал базу, уводит его запоздавшую запись
    в ключ старой эпохи — его больше никто не читает, и он умирает по TTL.
    С DEL такая запись легла бы в живой ключ уже после сброса и держала бы
    устаревшие данные весь TTL (для ролей — до 5 минут после снятия роли).
    """
    return await redis.get(f"{USER_CACHE_EPOCH_KEY_PREFIX}{user_id}") or "0"


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
        """Загружает пользователя и его роли из существующей системы RBAC.

        Кэшируется в Redis (TTL 300с) — фронт дёргает этот путь на каждой
        загрузке страницы (``/auth/me``) плюс login/refresh. Рантайм-сбой
        Redis — путь без кэша, как до его появления; исключение наружу не
        пробрасывается. Инвалидация — явная, см. ``invalidate_user_roles_cache``.
        """
        redis = get_redis()
        cached = None
        # Ключ фиксируется ДО запросов в БД — см. read_user_cache_epoch.
        cache_key: str | None = None

        try:
            epoch = await read_user_cache_epoch(redis, user_id)
            cache_key = f"{USERCTX_CACHE_KEY_PREFIX}{user_id}:v{epoch}"
            cached = await redis.get_json(cache_key)
        except Exception as e:
            logger.warning("Redis недоступен при чтении кеша user-контекста: %s", e)
        if cached is not None:
            return cached

        user = await self.find_by_id(user_id)
        if user is None:
            return None

        roles = await self._admin.get_user_roles(user_id)

        result = {
            "id": user["id"],
            "email": user["email"],
            "login": user["login"],
            "fullname": user["fullname"],
            "job": user["job"],
            "teams": [],
            "roles": sorted(role["name"] for role in roles),
        }

        if cache_key is not None:
            try:
                await redis.set_json(cache_key, result, ex=_USERCTX_CACHE_TTL_SEC)
            except Exception as e:
                logger.warning("Redis недоступен при записи кеша user-контекста: %s", e)

        return result
