"""Тесты get_username: ОТП-режим (sub из scope) и тест-режим (env)."""

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.api.v1.deps.auth_deps import get_username
from app.core.config import get_settings


def _make_request(state: dict | None = None) -> Request:
    scope = {"type": "http", "path": "/api/v1/acts", "headers": []}
    if state is not None:
        scope["state"] = state
    return Request(scope)


@pytest.fixture(autouse=True)
def _reset_settings_cache():
    """Настройки кэшируются lru_cache — сбрасываем до и после теста."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class TestGetUsernameTestMode:
    """AUTH__ENABLED=false: username из окружения (JUPYTERHUB_USER)."""

    async def test_returns_digits_from_env(self, monkeypatch):
        monkeypatch.setenv("AUTH__ENABLED", "false")
        monkeypatch.setenv("JUPYTERHUB_USER", "12345678_omega-sbrf-ru")
        assert await get_username(_make_request()) == "12345678"

    async def test_raises_401_for_unknown_user(self, monkeypatch):
        monkeypatch.setenv("AUTH__ENABLED", "false")
        monkeypatch.setenv("JUPYTERHUB_USER", "unknown_user")
        with pytest.raises(HTTPException) as exc_info:
            await get_username(_make_request())
        assert exc_info.value.status_code == 401


class TestGetUsernameOtpMode:
    """AUTH__ENABLED=true: username = sub из scope (кладёт AuthMiddleware), без БД."""

    async def test_returns_sub_from_scope(self, monkeypatch):
        monkeypatch.setenv("AUTH__ENABLED", "true")
        monkeypatch.setenv("AUTH__JWT_SECRET", "test-secret-key-for-auth-deps-suite")
        request = _make_request(state={"user": {"sub": "87654321"}})
        assert await get_username(request) == "87654321"

    async def test_raises_401_without_scope_user(self, monkeypatch):
        monkeypatch.setenv("AUTH__ENABLED", "true")
        monkeypatch.setenv("AUTH__JWT_SECRET", "test-secret-key-for-auth-deps-suite")
        with pytest.raises(HTTPException) as exc_info:
            await get_username(_make_request())
        assert exc_info.value.status_code == 401

    async def test_env_user_ignored_in_otp_mode(self, monkeypatch):
        """Окружение не подменяет авторизацию, когда включён ОТП-режим."""
        monkeypatch.setenv("AUTH__ENABLED", "true")
        monkeypatch.setenv("AUTH__JWT_SECRET", "test-secret-key-for-auth-deps-suite")
        monkeypatch.setenv("JUPYTERHUB_USER", "12345678")
        with pytest.raises(HTTPException):
            await get_username(_make_request())
