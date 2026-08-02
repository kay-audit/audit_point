"""Тесты AuthMiddleware: режимы, прозрачный refresh, редиректы и 401."""

import time
from unittest.mock import patch

import jwt as pyjwt
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette.responses import Response

from app.auth.context import get_request_username
from app.auth.jwt_handler import JWTTokenHandler
from app.auth.middleware import (
    ACCESS_TOKEN_COOKIE,
    REFRESH_TOKEN_COOKIE,
    AuthMiddleware,
    set_auth_cookies,
)
from app.core.config import get_settings
from app.core.middlewares.http_metrics import HttpMetricsMiddleware

SECRET = "test-secret-key-for-auth-middleware"
ACCESS_TTL = 900
REFRESH_TTL = 604800


@pytest.fixture(autouse=True)
def _auth_env(monkeypatch):
    """ОТП-режим с тестовым секретом и фиксированными TTL.

    TTL задаём явно: дефолты модели подменяются реальным .env, а от них
    зависят проверки max_age у cookie. Кэш настроек сбрасывается до и после.
    """
    monkeypatch.setenv("AUTH__ENABLED", "true")
    monkeypatch.setenv("AUTH__JWT_SECRET", SECRET)
    monkeypatch.setenv("AUTH__JWT_ACCESS_TTL", str(ACCESS_TTL))
    monkeypatch.setenv("AUTH__JWT_REFRESH_TTL", str(REFRESH_TTL))
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _identity(request: Request) -> dict:
    """Что middleware положил в запрос: sub в scope-state и username в contextvar."""
    user = request.scope.get("state", {}).get("user") or {}
    return {"sub": user.get("sub"), "ctx": get_request_username()}


def _make_client() -> TestClient:
    app = FastAPI()
    app.add_middleware(AuthMiddleware)

    @app.get("/api/v1/ping")
    async def ping(request: Request):
        return _identity(request)

    @app.get("/api/v1/auth/me")
    async def auth_me(request: Request):
        return _identity(request)

    @app.get("/static/js/app.js")
    async def static_asset(request: Request):
        return _identity(request)

    @app.get("/page")
    async def page():
        return {"page": True}

    @app.get("/auth/login")
    async def login_page():
        return {"login": True}

    @app.post("/api/v1/auth/request-otp")
    async def request_otp():
        return {"success": True}

    @app.post("/api/v1/auth/verify-otp")
    async def verify_otp():
        return {"success": True}

    return TestClient(app, follow_redirects=False)


def _expired_access(sub: str) -> str:
    now = int(time.time())
    return pyjwt.encode(
        {"sub": sub, "type": "access", "iat": now - 2000, "exp": now - 1000},
        SECRET,
        algorithm="HS256",
    )


def _by_cookie_name(raw: list[str]) -> dict[str, str]:
    """Заголовки Set-Cookie, разложенные по имени cookie."""
    return {value.split("=", 1)[0]: value for value in raw}


class TestOtpMode:

    def test_valid_access_passes(self):
        client = _make_client()
        client.cookies.set(ACCESS_TOKEN_COOKIE, JWTTokenHandler.create_access_token("77"))
        resp = client.get("/api/v1/ping")
        assert resp.status_code == 200
        assert resp.json() == {"sub": "77", "ctx": "77"}

    def test_expired_access_with_refresh_rotates_pair(self):
        """Прозрачный refresh: запрос проходит, в ответе новая пара cookie."""
        client = _make_client()
        old_access = _expired_access("77")
        client.cookies.set(ACCESS_TOKEN_COOKIE, old_access)
        client.cookies.set(REFRESH_TOKEN_COOKIE, JWTTokenHandler.create_refresh_token("77"))
        resp = client.get("/api/v1/ping")
        assert resp.status_code == 200
        assert resp.json()["sub"] == "77"
        assert resp.cookies.get(ACCESS_TOKEN_COOKIE)
        assert resp.cookies.get(ACCESS_TOKEN_COOKIE) != old_access
        assert resp.cookies.get(REFRESH_TOKEN_COOKIE)
        # Своих заголовков ответ при этом не теряет — cookie дописываются.
        assert resp.headers["content-type"].startswith("application/json")

    def test_rotated_cookies_carry_max_age(self):
        """Ротация ставит обе cookie с max_age = TTL соответствующего токена."""
        client = _make_client()
        client.cookies.set(ACCESS_TOKEN_COOKIE, _expired_access("77"))
        client.cookies.set(REFRESH_TOKEN_COOKIE, JWTTokenHandler.create_refresh_token("77"))
        resp = client.get("/api/v1/ping")
        cookies = _by_cookie_name(resp.headers.get_list("set-cookie"))
        assert f"Max-Age={ACCESS_TTL}" in cookies[ACCESS_TOKEN_COOKIE]
        assert f"Max-Age={REFRESH_TTL}" in cookies[REFRESH_TOKEN_COOKIE]

    def test_fresh_access_does_not_rotate(self):
        client = _make_client()
        client.cookies.set(ACCESS_TOKEN_COOKIE, JWTTokenHandler.create_access_token("77"))
        resp = client.get("/api/v1/ping")
        assert ACCESS_TOKEN_COOKIE not in resp.cookies

    def test_anonymous_api_gets_401_json(self):
        client = _make_client()
        resp = client.get("/api/v1/ping")
        assert resp.status_code == 401
        assert resp.json() == {"detail": "Не авторизован"}
        assert "location" not in resp.headers

    def test_anonymous_html_redirects_to_login(self):
        client = _make_client()
        resp = client.get("/page")
        assert resp.status_code == 303
        assert resp.headers["location"] == "/auth/login"

    def test_anonymous_post_redirect_does_not_preserve_method(self):
        """303, а не 307: браузер повторит запрос GET'ом, иначе POST ушёл бы
        на GET-only /auth/login и получил 405."""
        client = _make_client()
        resp = client.post("/page")
        assert resp.status_code == 303
        assert resp.headers["location"] == "/auth/login"

    def test_expired_session_html_redirect_marks_expired(self):
        """Протухшие cookie без валидного refresh → /auth/login?expired=1."""
        client = _make_client()
        client.cookies.set(ACCESS_TOKEN_COOKIE, _expired_access("77"))
        resp = client.get("/page")
        assert resp.status_code == 303
        assert resp.headers["location"] == "/auth/login?expired=1"

    def test_refresh_token_not_accepted_as_access(self):
        """Refresh-токен в access-cookie не аутентифицирует запрос."""
        client = _make_client()
        client.cookies.set(ACCESS_TOKEN_COOKIE, JWTTokenHandler.create_refresh_token("77"))
        resp = client.get("/api/v1/ping")
        assert resp.status_code == 401

    def test_public_path_open_for_anonymous(self):
        client = _make_client()
        resp = client.get("/auth/login")
        assert resp.status_code == 200

    def test_login_api_open_for_anonymous(self):
        """Регрессия: API входа под {api_prefix}/auth не должен блокироваться
        самим middleware — иначе запросить и ввести ОТП-код невозможно."""
        client = _make_client()
        assert client.post("/api/v1/auth/request-otp").status_code == 200
        assert client.post("/api/v1/auth/verify-otp").status_code == 200

    def test_public_auth_api_resolves_identity(self):
        """Регрессия: {api_prefix}/auth/me открыт для анонима, но авторизованному
        обязан отдать личность — get_current_user читает её из scope-state."""
        client = _make_client()
        client.cookies.set(ACCESS_TOKEN_COOKIE, JWTTokenHandler.create_access_token("77"))
        resp = client.get("/api/v1/auth/me")
        assert resp.status_code == 200
        assert resp.json() == {"sub": "77", "ctx": "77"}

    def test_public_auth_api_anonymous_passes_without_identity(self):
        client = _make_client()
        resp = client.get("/api/v1/auth/me")
        assert resp.status_code == 200
        assert resp.json() == {"sub": None, "ctx": None}

    def test_static_path_does_not_decode_jwt(self):
        """Статика отдаётся до чтения cookie — HS256 на каждый /static/* не платим."""
        client = _make_client()
        client.cookies.set(ACCESS_TOKEN_COOKIE, JWTTokenHandler.create_access_token("77"))
        with patch.object(JWTTokenHandler, "decode_token") as decode:
            resp = client.get("/static/js/app.js")
        assert resp.status_code == 200
        assert resp.json() == {"sub": None, "ctx": None}
        decode.assert_not_called()


class TestDisabledMode:

    def test_passthrough_with_env_username(self, monkeypatch):
        monkeypatch.setenv("AUTH__ENABLED", "false")
        monkeypatch.setenv("JUPYTERHUB_USER", "12345678_omega")
        get_settings.cache_clear()
        client = _make_client()
        resp = client.get("/api/v1/ping")
        assert resp.status_code == 200
        assert resp.json() == {"sub": None, "ctx": "12345678"}


class TestNonHttpScope:

    async def test_lifespan_scope_passes_through(self):
        """Не-http scope уходит вниз нетронутым, без разбора cookie."""
        seen = {}

        async def downstream(scope, receive, send):
            seen["scope"] = scope

        async def receive():
            return {"type": "lifespan.startup"}

        async def send(message):
            seen.setdefault("sent", []).append(message)

        scope = {"type": "lifespan"}
        with patch.object(JWTTokenHandler, "decode_token") as decode:
            await AuthMiddleware(downstream)(scope, receive, send)

        assert seen["scope"] is scope
        decode.assert_not_called()


class TestStackPosition:
    """Auth — самый внутренний слой стека; проверяем, что внешним это не мешает."""

    @staticmethod
    def _make_metrics_client(recorded: dict) -> TestClient:
        """Мини-стек как в create_app: HttpMetrics снаружи, Auth внутри."""

        class _Sink:
            async def record(self, **kwargs):
                recorded.update(kwargs)

        app = FastAPI()

        @app.get("/api/v1/ping")
        async def ping(request: Request):
            return _identity(request)

        app.add_middleware(AuthMiddleware)
        app.add_middleware(HttpMetricsMiddleware, service=_Sink())
        return TestClient(app, follow_redirects=False)

    def test_outer_middleware_sees_username_from_auth(self):
        """Raw ASGI не разрывает контекст задачи: contextvar, выставленный
        внутренним Auth, виден внешнему слою — метрика знает автора запроса."""
        recorded: dict = {}
        client = self._make_metrics_client(recorded)
        client.cookies.set(ACCESS_TOKEN_COOKIE, JWTTokenHandler.create_access_token("77"))
        resp = client.get("/api/v1/ping")
        assert resp.status_code == 200
        assert recorded["username"] == "77"
        assert recorded["status_code"] == 200

    def test_anonymous_401_reaches_outer_metrics(self):
        """401 от Auth поднимается через внешние слои и попадает в метрики."""
        recorded: dict = {}
        client = self._make_metrics_client(recorded)
        resp = client.get("/api/v1/ping")
        assert resp.status_code == 401
        assert recorded["status_code"] == 401
        assert recorded["username"] is None


class TestAuthCookies:

    def test_max_age_matches_token_ttl(self):
        """Cookie не сессионные: живут ровно столько, сколько их токены."""
        response = Response()
        set_auth_cookies(response, "access-value", "refresh-value")
        cookies = _by_cookie_name(response.headers.getlist("set-cookie"))
        assert f"Max-Age={ACCESS_TTL}" in cookies[ACCESS_TOKEN_COOKIE]
        assert f"Max-Age={REFRESH_TTL}" in cookies[REFRESH_TOKEN_COOKIE]
        assert "HttpOnly" in cookies[ACCESS_TOKEN_COOKIE]
        assert "HttpOnly" in cookies[REFRESH_TOKEN_COOKIE]
