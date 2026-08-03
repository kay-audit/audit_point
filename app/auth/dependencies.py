"""FastAPI-зависимости для слоя авторизации."""

from __future__ import annotations

import logging

from fastapi import HTTPException, Request

from app.auth.jwt_handler import JWTTokenHandler
from app.auth.user_repository import AuthUserRepository
from app.auth.value_objects import UserContext
from app.core.redis import RedisAdapter, get_redis
from app.db.connection import get_db

logger = logging.getLogger("audit_workstation.auth.dependencies")

_jwt_handler: JWTTokenHandler | None = None


def get_jwt_handler() -> JWTTokenHandler:
    """Возвращает синглтон JWTTokenHandler."""
    global _jwt_handler
    if _jwt_handler is None:
        _jwt_handler = JWTTokenHandler()
    return _jwt_handler


def get_redis_adapter(request: Request) -> RedisAdapter:
    """Возвращает RedisAdapter: сначала из app.state, затем из глобала core.

    Приоритет app.state сохранён ради тестов — они кладут туда fakeredis,
    не поднимая модульный синглтон.
    """
    adapter = getattr(request.app.state, "redis_adapter", None)
    if adapter is None:
        adapter = get_redis()
    if adapter is None:
        raise HTTPException(status_code=503, detail="Сервис авторизации недоступен")
    return adapter


class AuthUserDirectory:
    """Провайдер справочника пользователей поверх AuthUserRepository.

    Соединение из пула берётся на время одного запроса к БД, а не на всё время
    HTTP-запроса. Это важно для эндпоинтов авторизации: между обращениями к
    справочнику они делают долгие внешние вызовы (отправка письма по SMTP —
    до 30 секунд), и удержание соединения всё это время выедало пул.
    """

    async def find_by_email(self, email: str) -> dict | None:
        """Ищет пользователя по email."""
        async with get_db() as conn:
            return await AuthUserRepository(conn).find_by_email(email)

    async def find_by_id(self, user_id: str) -> dict | None:
        """Ищет пользователя по username (sub в JWT)."""
        async with get_db() as conn:
            return await AuthUserRepository(conn).find_by_id(user_id)

    async def get_user_context(self, user_id: str) -> dict | None:
        """Загружает пользователя вместе с его ролями."""
        async with get_db() as conn:
            return await AuthUserRepository(conn).get_user_context(user_id)


def get_user_repository() -> AuthUserDirectory:
    """Возвращает провайдер справочника пользователей."""
    return AuthUserDirectory()


async def get_current_user(request: Request) -> UserContext:
    """Полный контекст пользователя (профиль и роли из БД).

    Использовать только там, где нужен профиль (/auth/me, /auth/profile).
    Для username в обычных эндпоинтах — get_username (без похода в БД).
    Незавершённая авторизация — всегда 401; редиректами занимается AuthMiddleware.

    В тест-режиме (AUTH__ENABLED=false) собирает минимальный контекст из окружения.
    """
    from app.auth.context import resolve_env_username
    from app.core.config import get_settings

    if not get_settings().auth.enabled:
        username = resolve_env_username()
        if not username:
            raise HTTPException(status_code=401, detail="Не авторизован")
        return UserContext(
            sub=username,
            email="",
            login=username,
            fullname=f"Пользователь {username}",
        )

    user_data = request.scope.get("state", {}).get("user") or {}
    user_id = user_data.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Не авторизован")

    async with get_db() as conn:
        repo = AuthUserRepository(conn)
        ctx = await repo.get_user_context(user_id)
    if ctx is None:
        raise HTTPException(status_code=401, detail="Пользователь не найден")

    return UserContext(
        sub=ctx["id"],
        email=ctx["email"],
        login=ctx["login"],
        fullname=ctx["fullname"],
        teams=ctx["teams"],
        roles=ctx["roles"],
    )


def get_optional_user_id(request: Request) -> str | None:
    """Username текущего пользователя без 401 и без похода в БД.

    Для HTML-роутов, которые рендерятся и без авторизации (лендинг):
    sub из scope (положил AuthMiddleware) либо, в тест-режиме, из окружения.
    """
    from app.auth.context import resolve_env_username
    from app.core.config import get_settings

    if not get_settings().auth.enabled:
        return resolve_env_username()
    user_data = request.scope.get("state", {}).get("user") or {}
    return user_data.get("sub") or None
