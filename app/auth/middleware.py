"""Middleware и утилиты cookie для JWT-авторизации."""

from __future__ import annotations

import logging

from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.auth.context import resolve_env_username, set_request_username
from app.auth.jwt_handler import JWTTokenHandler
from app.core.config import get_settings

logger = logging.getLogger("audit_workstation.auth.middleware")

ACCESS_TOKEN_COOKIE = "access_token"
REFRESH_TOKEN_COOKIE = "refresh_token"


def set_auth_cookies(
    response: Response,
    access_token: str,
    refresh_token: str,
) -> None:
    """Устанавливает HttpOnly cookie с JWT-токенами."""
    settings = get_settings().auth
    cookie_kwargs = {
        "httponly": True,
        "secure": settings.cookie_secure,
        "samesite": "lax",
        "path": "/",
    }
    if settings.cookie_domain:
        cookie_kwargs["domain"] = settings.cookie_domain

    response.set_cookie(ACCESS_TOKEN_COOKIE, access_token, **cookie_kwargs)
    response.set_cookie(REFRESH_TOKEN_COOKIE, refresh_token, **cookie_kwargs)


def clear_auth_cookies(response: Response) -> None:
    """Удаляет JWT-cookie (выход из системы)."""
    settings = get_settings().auth
    cookie_kwargs = {"path": "/"}
    if settings.cookie_domain:
        cookie_kwargs["domain"] = settings.cookie_domain
    response.delete_cookie(ACCESS_TOKEN_COOKIE, **cookie_kwargs)
    response.delete_cookie(REFRESH_TOKEN_COOKIE, **cookie_kwargs)


# Открытые пути: HTML-страницы входа, статика, favicon; плюс API авторизации
# ({api_prefix}/auth/*) — иначе аноним не смог бы запросить и ввести ОТП-код.
# Профильные эндпоинты (/auth/me, /auth/profile) защищены своей зависимостью.
# «/» закрыт: аноним на любом HTML-пути уходит редиректом на /auth/login.
_PUBLIC_PREFIXES = ("/auth", "/static")
_PUBLIC_PATHS = ("/favicon.ico",)


def _is_public_path(path: str, api_v1_prefix: str) -> bool:
    """Доступен ли путь без авторизации."""
    return (
        path.startswith(_PUBLIC_PREFIXES)
        or path.startswith(f"{api_v1_prefix}/auth")
        or path in _PUBLIC_PATHS
    )


class AuthMiddleware(BaseHTTPMiddleware):
    """Аутентификация запроса по JWT-cookie с прозрачным refresh.

    Валидный access — запрос проходит. Access истёк, refresh валиден —
    middleware сам выпускает новую пару токенов, ставит cookie в ответ
    и пропускает запрос («сессия» живёт, пока живёт refresh; фронт о TTL
    не знает). Аноним: HTML-пути — редирект на /auth/login, API — 401 JSON.

    В тест-режиме (AUTH__ENABLED=false) пропускает всё, заполняя contextvar
    username из окружения — метрики и аудит работают одинаково в обоих режимах.
    """

    async def dispatch(self, request: Request, call_next):
        settings = get_settings()

        if not settings.auth.enabled:
            # Тест-режим: авторизация выключена, username из окружения.
            set_request_username(resolve_env_username())
            return await call_next(request)

        set_request_username(None)
        path = request.scope.get("path", request.url.path)

        user_sub: str | None = None
        access_token = request.cookies.get(ACCESS_TOKEN_COOKIE)
        if access_token:
            decoded = JWTTokenHandler.decode_token(access_token)
            if decoded and decoded.token_type == "access":
                user_sub = decoded.sub

        # Прозрачный refresh: access истёк/отсутствует, но refresh валиден —
        # ротация пары без участия пользователя (лечение «повторного ОТП»).
        new_tokens = None
        refresh_token = request.cookies.get(REFRESH_TOKEN_COOKIE)
        if user_sub is None and refresh_token:
            refresh_payload = JWTTokenHandler.decode_token(refresh_token)
            if refresh_payload and refresh_payload.token_type == "refresh":
                user_sub = refresh_payload.sub
                new_tokens = JWTTokenHandler.create_token_pair(user_sub)

        if user_sub is not None:
            request.scope.setdefault("state", {})["user"] = {"sub": user_sub}
            set_request_username(user_sub)
            response = await call_next(request)
            if new_tokens is not None:
                set_auth_cookies(
                    response, new_tokens.access_token, new_tokens.refresh_token
                )
            return response

        if _is_public_path(path, settings.server.api_v1_prefix):
            return await call_next(request)

        # Не авторизован: API — 401 JSON, HTML — редирект на вход
        # (с пометкой «сессия истекла», если протухшие cookie ещё были).
        if "/api/" in path:
            return JSONResponse(status_code=401, content={"detail": "Не авторизован"})
        login_url = "/auth/login?expired=1" if (access_token or refresh_token) else "/auth/login"
        return RedirectResponse(url=login_url)
