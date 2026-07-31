"""Middleware и утилиты cookie для JWT-авторизации."""

from __future__ import annotations

import logging

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.auth.context import set_request_username
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


from fastapi.responses import RedirectResponse
from starlette.datastructures import URL

class AuthMiddleware(BaseHTTPMiddleware):
    """Декодирует access_token из cookie и кладёт payload в scope/state.
    Перенаправляет на страницу входа при отсутствии токена.
    """

    async def dispatch(self, request: Request, call_next):
        set_request_username(None)
        settings = get_settings()

        if not settings.auth.enabled:
            return await call_next(request)

        # Используем scope["path"] вместо request.url.path для корректной работы с root_path
        # (например, /user/{user}/proxy/{port}/auth/login)
        path = request.scope.get("path", request.url.path)

        # Исключения для эндпоинтов аутентификации, статики, favicon и страниц входа
        # Включаем все /auth/* маршруты (для порталов аутентификации)
        if (path.startswith("/auth") or 
            path.startswith("/static") or
            path == "/" or
            path == "/favicon.ico"):
            # Проверяем токен и устанавливаем user_data в scope, если он валиден
            access_token = request.cookies.get(ACCESS_TOKEN_COOKIE)

            # Проверяем access_token и устанавливаем user_data в scope для API-роутов
            if access_token:
                payload = JWTTokenHandler.decode_token(access_token)
                if payload and payload.token_type == "access":
                    user_data = {"sub": payload.sub}
                    request.scope.setdefault("state", {})["user"] = user_data
                    set_request_username(payload.sub)

            return await call_next(request)

        # Для остальных путей (не /auth/*, /static/*, /, /favicon.ico) проверяем токен
        access_token = request.cookies.get(ACCESS_TOKEN_COOKIE)
        if access_token:
            payload = JWTTokenHandler.decode_token(access_token)
            if payload and payload.token_type == "access":
                user_data = {"sub": payload.sub}
                request.scope.setdefault("state", {})["user"] = user_data
                set_request_username(payload.sub)
                return await call_next(request)

        # Редирект на страницу входа для HTML-запросов
        if "text/html" in request.headers.get("accept", ""):
            return RedirectResponse(url="/auth/login")

        # Для API запросов возвращаем 401
        response = RedirectResponse(url="/auth/login")
        response.status_code = 401
        return response
