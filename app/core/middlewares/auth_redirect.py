"""AuthRedirectMiddleware: редирект на /login для неавторизованных browser-запросов.

Для API-запросов (Accept: application/json, /api/*, /openapi.json, /docs)
— пропускает. Только HTML-запросы (страницы) редиректятся на /login, если
нет валидной сессионной cookie.

Подключается в main.py как часть auth-инфраструктуры.
"""
from __future__ import annotations

import logging
from urllib.parse import quote

from starlette.requests import Request
from starlette.responses import RedirectResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger("audit_workstation.middleware.auth_redirect")


# Пути, которые всегда публично доступны.
_ALWAYS_PUBLIC_PREFIXES: tuple[str, ...] = (
    "/login",
    "/static/",
    "/api/v1/auth/",  # /login, /logout, /me, /me/* — публичные
    "/api/v1/system/",  # /health и пр. — публичные для мониторинга
    "/openapi.json",
    "/docs",
    "/redoc",
    "/favicon",
    "/error/",  # страницы ошибок
)

# Пути, которые редиректятся на /login при отсутствии сессии.
_BROWSER_ROUTES_PREFIXES: tuple[str, ...] = (
    "/",
    "/acts",
    "/admin",
    "/constructor",
    "/ck-fin-res",
    "/ck-client-experience",
    "/notifications",
    "/chat",
)


def _wants_html(request: Request) -> bool:
    """True если клиент ожидает HTML (браузер), False если JSON (fetch)."""
    accept = request.headers.get("accept", "").lower()
    if "application/json" in accept and "text/html" not in accept:
        return False
    if "text/html" in accept:
        return True
    # По умолчанию считаем запрос браузерным (без заголовка Accept — обычно
    # это переход по ссылке в адресной строке).
    return True


def _is_protected_browser_route(path: str) -> bool:
    # Корень "/" — HTML-страница портала.
    if path in ("/", ""):
        return True
    # Для остальных префиксов проверяем ТОЧНОЕ равенство или вхождение с "/".
    # Это нужно, чтобы "/admin" ловил "/admin" и "/admin/anything", но НЕ
    # ловил "/api/v1/admin/..." (тот начинается с "/api/", а не с "/admin/").
    for prefix in _BROWSER_ROUTES_PREFIXES:
        if prefix == "/":
            continue
        # Должно совпадать либо точно, либо через "/"
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


def _is_always_public(path: str) -> bool:
    return any(path.startswith(p) for p in _ALWAYS_PUBLIC_PREFIXES)


async def _has_valid_session(scope: Scope) -> bool:
    """Достаём cookie и валидируем против БД. При ошибке — пропускаем (не редиректим)."""
    try:
        from app.core.settings_registry import get as get_domain_settings
        from app.domains.auth.settings import AuthSettings
        from app.db.connection import get_db
        from app.domains.auth.services.auth_service import AuthService

        s = get_domain_settings("auth", AuthSettings)
        # Извлечь cookie из scope['headers']
        token: str | None = None
        for k, v in scope.get("headers", []):
            if k == b"cookie":
                cookie_header = v.decode("latin-1", errors="ignore")
                for part in cookie_header.split(";"):
                    part = part.strip()
                    if part.startswith(s.session_cookie_name + "="):
                        token = part.split("=", 1)[1]
                        break
        if not token:
            return False
        async with get_db() as conn:
            svc = AuthService(conn)
            sess = await svc.resolve_session(token)
        return sess is not None
    except Exception as e:
        logger.debug("session check failed (treated as not-authenticated): %s", e)
        return False


class AuthRedirectMiddleware:
    """ASGI-middleware: HTML-маршруты без валидной сессии → редирект на /login.

    API-запросы и всегда-публичные пути пропускает (проверка авторизации —
    на уровне Depends(get_username) внутри endpoint'ов).
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        method = scope.get("method", "GET")

        if (
            method in ("GET", "HEAD")
            and _is_protected_browser_route(path)
            and not _is_always_public(path)
            and not _wants_html_from_scope(scope)
        ):
            # Проверка Accept: если хочет JSON — пропускаем (это API/JS-запрос)
            await self.app(scope, receive, send)
            return

        # Для не-GET/HEAD (POST/PUT/DELETE) — пропускаем, не редиректим
        if method not in ("GET", "HEAD"):
            await self.app(scope, receive, send)
            return

        if (
            _is_protected_browser_route(path)
            and not _is_always_public(path)
            and _wants_html_from_scope(scope)
        ):
            if not await _has_valid_session(scope):
                next_url = quote(path, safe="/")
                response = RedirectResponse(
                    url=f"/login?next={next_url}",
                    status_code=302,
                )
                await response(scope, receive, send)
                return

        await self.app(scope, receive, send)


def _wants_html_from_scope(scope: Scope) -> bool:
    accept = ""
    for k, v in scope.get("headers", []):
        if k == b"accept":
            accept = v.decode("latin-1", errors="ignore").lower()
            break
    if "application/json" in accept and "text/html" not in accept:
        return False
    return "text/html" in accept or not accept
