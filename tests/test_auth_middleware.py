"""Тесты AuthMiddleware: режимы, прозрачный refresh, редиректы и 401."""

import time

import jwt as pyjwt
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.auth.context import get_request_username
from app.auth.jwt_handler import JWTTokenHandler
from app.auth.middleware import (
    ACCESS_TOKEN_COOKIE,
    REFRESH_TOKEN_COOKIE,
    AuthMiddleware,
)
from app.core.config import get_settings

SECRET = "test-secret-key-for-auth-middleware"


@pytest.fixture(autouse=True)
def _auth_env(monkeypatch):
    """ОТП-режим с тестовым секретом; кэш настроек сбрасывается до и после."""
    monkeypatch.setenv("AUTH__ENABLED", "true")
    monkeypatch.setenv("AUTH__JWT_SECRET", SECRET)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _make_client() -> TestClient:
    app = FastAPI()
    app.add_middleware(AuthMiddleware)

    @app.get("/api/v1/ping")
    async def ping(request: Request):
        user = request.scope.get("state", {}).get("user") or {}
        return {"sub": user.get("sub"), "ctx": get_request_username()}

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
        assert resp.status_code in (302, 307)
        assert resp.headers["location"] == "/auth/login"

    def test_expired_session_html_redirect_marks_expired(self):
        """Протухшие cookie без валидного refresh → /auth/login?expired=1."""
        client = _make_client()
        client.cookies.set(ACCESS_TOKEN_COOKIE, _expired_access("77"))
        resp = client.get("/page")
        assert resp.status_code in (302, 307)
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


class TestDisabledMode:

    def test_passthrough_with_env_username(self, monkeypatch):
        monkeypatch.setenv("AUTH__ENABLED", "false")
        monkeypatch.setenv("JUPYTERHUB_USER", "12345678_omega")
        get_settings.cache_clear()
        client = _make_client()
        resp = client.get("/api/v1/ping")
        assert resp.status_code == 200
        assert resp.json() == {"sub": None, "ctx": "12345678"}
