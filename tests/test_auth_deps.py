"""Тесты get_username (ОТП-режим и тест-режим) и провайдера справочника
пользователей AuthUserDirectory."""

import contextlib

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.api.v1.deps.auth_deps import get_username
from app.auth.dependencies import AuthUserDirectory, get_user_repository
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


@pytest.fixture
def db_calls(monkeypatch) -> dict[str, int]:
    """Считает входы/выходы из get_db, подменяя пул и репозиторий фейками."""
    calls = {"opened": 0, "closed": 0}

    @contextlib.asynccontextmanager
    async def _fake_get_db():
        calls["opened"] += 1
        try:
            yield object()
        finally:
            calls["closed"] += 1

    class _FakeRepo:
        def __init__(self, conn):
            self._conn = conn

        async def find_by_email(self, email):
            return {"id": "77", "email": email}

        async def find_by_id(self, user_id):
            return {"id": user_id}

        async def get_user_context(self, user_id):
            return {"id": user_id, "roles": []}

    monkeypatch.setattr("app.auth.dependencies.get_db", _fake_get_db)
    monkeypatch.setattr("app.auth.dependencies.AuthUserRepository", _FakeRepo)
    return calls


class TestAuthUserDirectory:
    """Провайдер не удерживает соединение из пула на всё время запроса.

    Прежняя версия зависимости была async-генератором и держала соединение
    до конца обработки, включая отправку письма по SMTP (до 30 секунд).
    """

    def test_dependency_returns_provider_not_generator(self):
        """Зависимость отдаёт объект, а не генератор с открытым соединением."""
        provider = get_user_repository()
        assert isinstance(provider, AuthUserDirectory)
        assert not hasattr(provider, "__anext__")

    async def test_connection_taken_per_call_and_released(self, db_calls):
        provider = AuthUserDirectory()

        await provider.find_by_email("user@example.com")
        assert db_calls == {"opened": 1, "closed": 1}

        await provider.find_by_id("77")
        await provider.get_user_context("77")
        assert db_calls == {"opened": 3, "closed": 3}

    async def test_nothing_held_between_calls(self, db_calls):
        """Между обращениями к справочнику открытых соединений не остаётся."""
        provider = AuthUserDirectory()

        await provider.find_by_email("user@example.com")
        assert db_calls["opened"] == db_calls["closed"]

        # Здесь в эндпоинте происходит долгая отправка письма — пул свободен.
        await provider.get_user_context("77")
        assert db_calls["opened"] == db_calls["closed"]

    async def test_returns_repository_result(self, db_calls):
        provider = AuthUserDirectory()
        assert await provider.find_by_email("user@example.com") == {
            "id": "77",
            "email": "user@example.com",
        }
        assert await provider.get_user_context("77") == {"id": "77", "roles": []}
