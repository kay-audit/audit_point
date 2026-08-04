"""Middleware и утилиты cookie для JWT-авторизации."""

from __future__ import annotations

import logging

from fastapi.responses import JSONResponse, RedirectResponse
from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.responses import Response

from app.auth.context import resolve_env_username, set_request_username
from app.auth.jwt_handler import JWTTokenHandler
from app.auth.value_objects import TokenPair
from app.core.config import get_settings

logger = logging.getLogger("audit_workstation.auth.middleware")

ACCESS_TOKEN_COOKIE = "access_token"
REFRESH_TOKEN_COOKIE = "refresh_token"


def set_auth_cookies(
    response: Response,
    access_token: str,
    refresh_token: str,
) -> None:
    """Устанавливает HttpOnly cookie с JWT-токенами.

    max_age каждой cookie равен TTL её токена: без max_age обе cookie
    сессионные и умирают вместе с окном браузера, обрывая refresh-сессию
    задолго до её настоящего срока.
    """
    settings = get_settings().auth
    cookie_kwargs = {
        "httponly": True,
        "secure": settings.cookie_secure,
        "samesite": "lax",
        "path": "/",
    }
    if settings.cookie_domain:
        cookie_kwargs["domain"] = settings.cookie_domain

    response.set_cookie(
        ACCESS_TOKEN_COOKIE,
        access_token,
        max_age=settings.jwt_access_ttl,
        **cookie_kwargs,
    )
    response.set_cookie(
        REFRESH_TOKEN_COOKIE,
        refresh_token,
        max_age=settings.jwt_refresh_ttl,
        **cookie_kwargs,
    )


def clear_auth_cookies(response: Response) -> None:
    """Удаляет JWT-cookie (выход из системы)."""
    settings = get_settings().auth
    cookie_kwargs = {"path": "/"}
    if settings.cookie_domain:
        cookie_kwargs["domain"] = settings.cookie_domain
    response.delete_cookie(ACCESS_TOKEN_COOKIE, **cookie_kwargs)
    response.delete_cookie(REFRESH_TOKEN_COOKIE, **cookie_kwargs)


# Пути, которым личность пользователя не нужна вовсе: статика и favicon
# отдаются одинаково всем. Проверяются раньше чтения cookie — иначе каждый
# запрос картинки/скрипта платил бы HS256-верификацией JWT.
_IDENTITY_FREE_PREFIXES = ("/static",)
_IDENTITY_FREE_PATHS = ("/favicon.ico",)

# Открытые пути: HTML-страницы входа, статика, favicon; плюс API авторизации
# ({api_prefix}/auth/*) — иначе аноним не смог бы запросить и ввести ОТП-код.
# Профильный эндпоинт (/auth/me) защищён своей зависимостью, но она читает
# sub из scope["state"]["user"] — поэтому для /auth/* личность всё-таки
# разбирается, «открытость» здесь означает лишь отсутствие 401/редиректа.
# «/» закрыт: аноним на любом HTML-пути уходит редиректом на /auth/login.
# HTML-страница профиля (/profile) в этот список НЕ входит — она защищена
# самим middleware (редирект на /auth/login), а не только зависимостью.
_PUBLIC_PREFIXES = ("/auth", "/static")
_PUBLIC_PATHS = ("/favicon.ico",)


def _is_identity_free_path(path: str) -> bool:
    """Можно ли обработать путь, не разбирая JWT-cookie."""
    return path.startswith(_IDENTITY_FREE_PREFIXES) or path in _IDENTITY_FREE_PATHS


def _is_public_path(path: str, api_v1_prefix: str) -> bool:
    """Доступен ли путь без авторизации."""
    return (
        path.startswith(_PUBLIC_PREFIXES)
        or path.startswith(f"{api_v1_prefix}/auth")
        or path in _PUBLIC_PATHS
    )


def _send_with_auth_cookies(send, tokens: TokenPair):
    """Обёртка send, дописывающая Set-Cookie новой пары токенов в ответ.

    Значения заголовков собирает временный Response — чтобы флаги cookie
    (HttpOnly/Secure/SameSite/max_age) задавались единственным местом,
    ``set_auth_cookies``.
    """
    carrier = Response()
    set_auth_cookies(carrier, tokens.access_token, tokens.refresh_token)
    cookie_headers = [value for name, value in carrier.raw_headers if name == b"set-cookie"]

    async def send_wrapper(message):
        if message["type"] == "http.response.start":
            headers = MutableHeaders(scope=message)
            for value in cookie_headers:
                headers.append("set-cookie", value.decode("latin-1"))
        await send(message)

    return send_wrapper


class AuthMiddleware:
    """Аутентификация запроса по JWT-cookie с прозрачным refresh.

    Raw ASGI (как остальные middleware проекта, см. ``app/core/middleware.py``):
    BaseHTTPMiddleware буферизует тело ответа целиком и ломает потоковую
    отдачу — например FileResponse при экспорте DOCX.

    Валидный access — запрос проходит. Access истёк, refresh валиден —
    middleware сам выпускает новую пару токенов, ставит cookie в ответ
    и пропускает запрос («сессия» живёт, пока живёт refresh; фронт о TTL
    не знает). Аноним: HTML-пути — редирект на /auth/login, API — 401 JSON.

    В тест-режиме (AUTH__ENABLED=false) пропускает всё, заполняя contextvar
    username из окружения — метрики и аудит работают одинаково в обоих режимах.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        settings = get_settings()

        if not settings.auth.enabled:
            # Тест-режим: авторизация выключена, username из окружения.
            set_request_username(resolve_env_username())
            await self.app(scope, receive, send)
            return

        set_request_username(None)
        path = scope.get("path", "")

        if _is_identity_free_path(path):
            await self.app(scope, receive, send)
            return

        cookies = Request(scope).cookies
        access_token = cookies.get(ACCESS_TOKEN_COOKIE)
        refresh_token = cookies.get(REFRESH_TOKEN_COOKIE)

        user_sub: str | None = None
        if access_token:
            decoded = JWTTokenHandler.decode_token(access_token)
            if decoded and decoded.token_type == "access":
                user_sub = decoded.sub

        # Прозрачный refresh: access истёк/отсутствует, но refresh валиден —
        # ротация пары без участия пользователя (лечение «повторного ОТП»).
        new_tokens = None
        if user_sub is None and refresh_token:
            refresh_payload = JWTTokenHandler.decode_token(refresh_token)
            if refresh_payload and refresh_payload.token_type == "refresh":
                user_sub = refresh_payload.sub
                new_tokens = JWTTokenHandler.create_token_pair(user_sub)

        if user_sub is not None:
            scope.setdefault("state", {})["user"] = {"sub": user_sub}
            set_request_username(user_sub)
            if new_tokens is not None:
                send = _send_with_auth_cookies(send, new_tokens)
            await self.app(scope, receive, send)
            return

        if _is_public_path(path, settings.server.api_v1_prefix):
            await self.app(scope, receive, send)
            return

        # Не авторизован: API — 401 JSON, HTML — редирект на вход
        # (с пометкой «сессия истекла», если протухшие cookie ещё были).
        if "/api/" in path:
            response: Response = JSONResponse(
                status_code=401, content={"detail": "Не авторизован"}
            )
        else:
            login_url = (
                "/auth/login?expired=1" if (access_token or refresh_token) else "/auth/login"
            )
            # 303, а не 307: браузер обязан повторить запрос методом GET.
            # 307 сохранил бы метод и увёл POST на GET-only /auth/login → 405.
            response = RedirectResponse(url=login_url, status_code=303)
        await response(scope, receive, send)
