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


# Открытые пути: страницы/эндпоинты входа, статика, favicon.
# «/» закрыт: аноним на любом HTML-пути уходит редиректом на /auth/login.
_PUBLIC_PREFIXES = ("/auth", "/static")
_PUBLIC_PATHS = ("/favicon.ico",)


class AuthMiddleware(BaseHTTPMiddleware):
    """Декодирует access_token из cookie и кладёт payload в scope/state.

    Аноним: HTML-пути — редирект на /auth/login, API (/api/*) — 401 JSON.
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

        payload = None
        access_token = request.cookies.get(ACCESS_TOKEN_COOKIE)
        if access_token:
            decoded = JWTTokenHandler.decode_token(access_token)
            if decoded and decoded.token_type == "access":
                payload = decoded

        if payload is not None:
            request.scope.setdefault("state", {})["user"] = {"sub": payload.sub}
            set_request_username(payload.sub)
            return await call_next(request)

        if path.startswith(_PUBLIC_PREFIXES) or path in _PUBLIC_PATHS:
            return await call_next(request)

        # Не авторизован: API — 401 JSON, HTML — редирект на вход.
        if "/api/" in path:
            return JSONResponse(status_code=401, content={"detail": "Не авторизован"})
        return RedirectResponse(url="/auth/login")
