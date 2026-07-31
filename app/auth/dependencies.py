"""FastAPI-зависимости для слоя авторизации."""

from __future__ import annotations

import logging

from fastapi import HTTPException, Request

from app.auth.jwt_handler import JWTTokenHandler
from app.auth.redis_adapter import RedisAdapter
from app.auth.user_repository import AuthUserRepository
from app.auth.value_objects import UserContext
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
    """Возвращает RedisAdapter из app.state."""
    adapter = getattr(request.app.state, "redis_adapter", None)
    if adapter is None:
        raise HTTPException(status_code=503, detail="Сервис авторизации недоступен")
    return adapter


async def get_user_repository():
    """Создаёт AuthUserRepository с подключением из пула (request-scoped)."""
    async with get_db() as conn:
        yield AuthUserRepository(conn)


async def get_current_user(request: Request) -> UserContext:
    """Извлекает контекст пользователя из scope (заполняется AuthMiddleware).

    Для HTML-запросов перенаправляет на страницу авторизации,
    для API запросов возвращает 401 Unauthorized.
    """
    state = request.scope.get("state", {})
    user_data = state.get("user")

    if not user_data:
        if "/api/" not in request.url.path:
            # Для HTML-страниц делаем редирект на авторизацию
            from fastapi.responses import RedirectResponse
            return RedirectResponse(url="/auth/login")
        raise HTTPException(status_code=401, detail="Не авторизован")

    user_id = user_data.get("sub")
    if not user_id:
        if "/api/" not in request.url.path:
            from fastapi.responses import RedirectResponse
            return RedirectResponse(url="/auth/login")
        raise HTTPException(status_code=401, detail="Невалидный токен")

    async with get_db() as conn:
        repo = AuthUserRepository(conn)
        ctx = await repo.get_user_context(user_id)
    if ctx is None:
        if "/api/" not in request.url.path:
            from fastapi.responses import RedirectResponse
            return RedirectResponse(url="/auth/login")
        raise HTTPException(status_code=401, detail="Пользователь не найден")

    user_context = UserContext(
        sub=ctx["id"],
        email=ctx["email"],
        login=ctx["login"],
        fullname=ctx["fullname"],
        teams=ctx["teams"],
        roles=ctx["roles"],
    )
    return user_context
