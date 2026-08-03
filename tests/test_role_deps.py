"""Интеграционные тесты ``require_domain_access`` через FastAPI TestClient.

Поднимаем минимальный ``FastAPI`` с защищённым эндпоинтом, переопределяем
``get_user_roles`` (и при необходимости ``get_username``) и проверяем
все сценарии доступа.
"""

from __future__ import annotations

import contextlib
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import (
    _roles_cache,
    get_user_roles,
    invalidate_user_roles_cache,
    require_admin,
    require_domain_access,
)


USERNAME = "22222222"


def _build_app(*, protected_domain: str = "acts") -> FastAPI:
    """Сборка минимального app с тремя ручками для покрытия сценариев."""
    app = FastAPI()

    @app.get(
        "/protected",
        dependencies=[Depends(require_domain_access(protected_domain))],
    )
    def protected():
        return {"ok": True}

    @app.get(
        "/admin-only",
        dependencies=[Depends(require_admin())],
    )
    def admin_only():
        return {"admin": True}

    @app.get("/echo-roles")
    def echo_roles(roles: list[dict] = Depends(get_user_roles)):
        return {"roles": roles}

    app.dependency_overrides[get_username] = lambda: USERNAME
    return app


def _set_roles(app: FastAPI, roles: list[dict]) -> None:
    app.dependency_overrides[get_user_roles] = lambda: roles


# -------------------------------------------------------------------------
# require_domain_access
# -------------------------------------------------------------------------


class TestRequireDomainAccess:

    def test_user_with_matching_domain_role_passes(self):
        app = _build_app(protected_domain="acts")
        _set_roles(app, [{"id": 1, "name": "Аудитор", "domain_name": "acts"}])

        with TestClient(app) as client:
            resp = client.get("/protected")

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}

    def test_user_with_other_domain_role_denied(self):
        app = _build_app(protected_domain="acts")
        _set_roles(app, [{"id": 2, "name": "Чат", "domain_name": "chat"}])

        with TestClient(app) as client:
            resp = client.get("/protected")

        assert resp.status_code == 403
        assert resp.json()["detail"] == "Нет доступа к разделу"

    def test_admin_passes_any_domain(self):
        """Админ — особое имя роли, ``domain_name`` может быть любым (включая None)."""
        app = _build_app(protected_domain="acts")
        _set_roles(app, [{"id": 99, "name": "Админ", "domain_name": None}])

        with TestClient(app) as client:
            resp = client.get("/protected")

        assert resp.status_code == 200

    def test_admin_passes_for_arbitrary_domain(self):
        app = _build_app(protected_domain="ck_fin_res")
        _set_roles(app, [{"id": 99, "name": "Админ", "domain_name": None}])

        with TestClient(app) as client:
            resp = client.get("/protected")

        assert resp.status_code == 200

    def test_user_with_no_roles_denied(self):
        app = _build_app(protected_domain="acts")
        _set_roles(app, [])

        with TestClient(app) as client:
            resp = client.get("/protected")

        assert resp.status_code == 403

    def test_user_with_multiple_roles_one_matching_passes(self):
        app = _build_app(protected_domain="acts")
        _set_roles(
            app,
            [
                {"id": 1, "name": "Чат", "domain_name": "chat"},
                {"id": 2, "name": "Аудитор", "domain_name": "acts"},
                {"id": 3, "name": "ЦК ФР", "domain_name": "ck_fin_res"},
            ],
        )

        with TestClient(app) as client:
            resp = client.get("/protected")

        assert resp.status_code == 200

    def test_user_with_multiple_roles_none_matching_denied(self):
        app = _build_app(protected_domain="acts")
        _set_roles(
            app,
            [
                {"id": 1, "name": "Чат", "domain_name": "chat"},
                {"id": 3, "name": "ЦК ФР", "domain_name": "ck_fin_res"},
            ],
        )

        with TestClient(app) as client:
            resp = client.get("/protected")

        assert resp.status_code == 403

    def test_unauthenticated_returns_401(self):
        """``get_username`` бросает 401 → защищённая ручка отвечает 401."""
        app = _build_app(protected_domain="acts")

        def _unauth() -> str:
            raise HTTPException(status_code=401, detail="Требуется авторизация")

        app.dependency_overrides[get_username] = _unauth

        # ``get_user_roles`` нельзя оставлять заглушкой — оно зависит от get_username
        app.dependency_overrides.pop(get_user_roles, None)

        with TestClient(app) as client:
            resp = client.get("/protected")

        assert resp.status_code == 401

    def test_factory_returns_fresh_callable_per_call(self):
        """``require_domain_access`` — фабрика; разные вызовы дают разные dep'ы."""
        dep1 = require_domain_access("acts")
        dep2 = require_domain_access("chat")
        assert dep1 is not dep2

    def test_domain_with_null_name_in_role_not_treated_as_match(self):
        """``domain_name=None`` в обычной роли не должен открывать произвольный домен."""
        app = _build_app(protected_domain="acts")
        _set_roles(app, [{"id": 5, "name": "Цифровой акт", "domain_name": None}])

        with TestClient(app) as client:
            resp = client.get("/protected")

        # Только роль 'Админ' получает универсальный доступ
        assert resp.status_code == 403


# -------------------------------------------------------------------------
# require_admin
# -------------------------------------------------------------------------


class TestRequireAdmin:

    def test_admin_role_passes(self):
        app = _build_app()
        _set_roles(app, [{"id": 99, "name": "Админ", "domain_name": None}])

        with TestClient(app) as client:
            resp = client.get("/admin-only")

        assert resp.status_code == 200
        assert resp.json() == {"admin": True}

    def test_non_admin_role_denied(self):
        app = _build_app()
        _set_roles(app, [{"id": 1, "name": "Аудитор", "domain_name": "acts"}])

        with TestClient(app) as client:
            resp = client.get("/admin-only")

        assert resp.status_code == 403
        assert resp.json()["detail"] == "Только для администраторов"

    def test_empty_roles_denied(self):
        app = _build_app()
        _set_roles(app, [])

        with TestClient(app) as client:
            resp = client.get("/admin-only")

        assert resp.status_code == 403


# -------------------------------------------------------------------------
# Сигнатура и инвариант фабрики
# -------------------------------------------------------------------------


class TestFactoryInvariants:

    def test_returns_async_callable(self):
        dep = require_domain_access("acts")
        assert callable(dep)
        # фабрика возвращает async-функцию (исполняется FastAPI)
        import inspect
        assert inspect.iscoroutinefunction(dep)

    def test_require_admin_returns_async_callable(self):
        dep = require_admin()
        assert callable(dep)
        import inspect
        assert inspect.iscoroutinefunction(dep)


# -------------------------------------------------------------------------
# get_user_roles — двухуровневый кеш (L1 in-process TTLCache + L2 Redis)
# -------------------------------------------------------------------------


def _fake_get_db(rows: list[dict]):
    """Фейковый get_db модуля role_deps: один conn.fetch → rows.

    role_deps.py импортирует get_db/get_adapter на уровне модуля, поэтому
    патчить нужно по месту использования (app.api.v1.deps.role_deps.get_db),
    не app.db.connection.get_db.
    """
    mock_conn = AsyncMock()
    mock_conn.fetch = AsyncMock(return_value=rows)

    @contextlib.asynccontextmanager
    async def _get_db():
        yield mock_conn

    return _get_db, mock_conn


def _fake_adapter() -> MagicMock:
    adapter = MagicMock()
    adapter.get_table_name = lambda name, schema="": name
    return adapter


def _redis_mock() -> MagicMock:
    m = MagicMock()
    m.get_json = AsyncMock(return_value=None)
    m.set_json = AsyncMock(return_value=True)
    m.delete = AsyncMock(return_value=2)
    return m


class TestGetUserRolesCache:

    USERNAME = "22222222"
    ROWS = [{"id": 1, "name": "Аудитор", "domain_name": "acts"}]

    @pytest.fixture(autouse=True)
    def _clear_l1(self):
        _roles_cache.clear()
        yield
        _roles_cache.clear()

    async def test_redis_none_behaves_as_before(self):
        """get_redis() is None (тест-режим) — L1 → SQL, Redis не трогается вовсе."""
        fake_get_db, mock_conn = _fake_get_db(self.ROWS)

        with patch("app.api.v1.deps.role_deps.get_redis", return_value=None), \
             patch("app.api.v1.deps.role_deps.get_db", fake_get_db), \
             patch("app.api.v1.deps.role_deps.get_adapter", return_value=_fake_adapter()):
            result = await get_user_roles(username=self.USERNAME)

        assert result == self.ROWS
        mock_conn.fetch.assert_awaited_once()
        assert _roles_cache[self.USERNAME] == self.ROWS

    async def test_l1_hit_skips_redis(self):
        """L1 уже заполнен — до Redis дело не доходит."""
        _roles_cache[self.USERNAME] = self.ROWS
        redis = _redis_mock()

        with patch("app.api.v1.deps.role_deps.get_redis", return_value=redis):
            result = await get_user_roles(username=self.USERNAME)

        assert result == self.ROWS
        redis.get_json.assert_not_awaited()

    async def test_l1_miss_l2_hit_skips_sql_and_fills_l1(self):
        """L1 пуст, L2-хит — SQL не вызывается, результат кладётся в L1."""
        redis = _redis_mock()
        redis.get_json = AsyncMock(return_value=self.ROWS)
        fake_get_db, mock_conn = _fake_get_db([])  # не должен быть вызван

        with patch("app.api.v1.deps.role_deps.get_redis", return_value=redis), \
             patch("app.api.v1.deps.role_deps.get_db", fake_get_db), \
             patch("app.api.v1.deps.role_deps.get_adapter", return_value=_fake_adapter()):
            result = await get_user_roles(username=self.USERNAME)

        assert result == self.ROWS
        redis.get_json.assert_awaited_once_with(f"cache:roles:{self.USERNAME}")
        mock_conn.fetch.assert_not_awaited()
        assert _roles_cache[self.USERNAME] == self.ROWS

    async def test_l2_miss_calls_sql_and_writes_through(self):
        """L1 и L2 пусты — SQL выполняется, результат пишется в L1 и L2 (TTL 300с)."""
        redis = _redis_mock()
        fake_get_db, mock_conn = _fake_get_db(self.ROWS)

        with patch("app.api.v1.deps.role_deps.get_redis", return_value=redis), \
             patch("app.api.v1.deps.role_deps.get_db", fake_get_db), \
             patch("app.api.v1.deps.role_deps.get_adapter", return_value=_fake_adapter()):
            result = await get_user_roles(username=self.USERNAME)

        assert result == self.ROWS
        mock_conn.fetch.assert_awaited_once()
        redis.set_json.assert_awaited_once_with(
            f"cache:roles:{self.USERNAME}", self.ROWS, ex=300,
        )
        assert _roles_cache[self.USERNAME] == self.ROWS

    async def test_redis_read_exception_falls_back_to_sql(self):
        """Сбой Redis на чтении L2 — честный SQL-путь, исключение не пробрасывается."""
        redis = _redis_mock()
        redis.get_json = AsyncMock(side_effect=ConnectionError("boom"))
        fake_get_db, mock_conn = _fake_get_db(self.ROWS)

        with patch("app.api.v1.deps.role_deps.get_redis", return_value=redis), \
             patch("app.api.v1.deps.role_deps.get_db", fake_get_db), \
             patch("app.api.v1.deps.role_deps.get_adapter", return_value=_fake_adapter()):
            result = await get_user_roles(username=self.USERNAME)  # не должно бросить

        assert result == self.ROWS
        mock_conn.fetch.assert_awaited_once()

    async def test_redis_write_exception_still_returns_sql_result(self):
        """Сбой Redis на записи в L2 — результат из БД всё равно возвращается."""
        redis = _redis_mock()
        redis.set_json = AsyncMock(side_effect=ConnectionError("boom"))
        fake_get_db, mock_conn = _fake_get_db(self.ROWS)

        with patch("app.api.v1.deps.role_deps.get_redis", return_value=redis), \
             patch("app.api.v1.deps.role_deps.get_db", fake_get_db), \
             patch("app.api.v1.deps.role_deps.get_adapter", return_value=_fake_adapter()):
            result = await get_user_roles(username=self.USERNAME)  # не должно бросить

        assert result == self.ROWS
        assert _roles_cache[self.USERNAME] == self.ROWS


# -------------------------------------------------------------------------
# invalidate_user_roles_cache
# -------------------------------------------------------------------------


class TestInvalidateUserRolesCache:

    USERNAME = "22222222"

    @pytest.fixture(autouse=True)
    def _clear_l1(self):
        _roles_cache.clear()
        yield
        _roles_cache.clear()

    async def test_clears_l1_and_deletes_both_redis_keys(self):
        """DEL уходит и по ключу ролей, и по ключу user-контекста (общий username)."""
        _roles_cache[self.USERNAME] = [{"id": 1, "name": "Аудитор", "domain_name": "acts"}]
        redis = _redis_mock()

        with patch("app.api.v1.deps.role_deps.get_redis", return_value=redis):
            await invalidate_user_roles_cache(self.USERNAME)

        assert self.USERNAME not in _roles_cache
        redis.delete.assert_awaited_once_with(
            f"cache:roles:{self.USERNAME}", f"cache:userctx:{self.USERNAME}",
        )

    async def test_redis_none_only_clears_l1(self):
        """get_redis() is None — L1 всё равно чистится, без похода в Redis."""
        _roles_cache[self.USERNAME] = [{"id": 1, "name": "Аудитор", "domain_name": "acts"}]

        with patch("app.api.v1.deps.role_deps.get_redis", return_value=None):
            await invalidate_user_roles_cache(self.USERNAME)  # не должно бросить

        assert self.USERNAME not in _roles_cache

    async def test_redis_exception_does_not_raise(self):
        """Сбой Redis при инвалидации не должен ронять admin-операцию."""
        _roles_cache[self.USERNAME] = [{"id": 1, "name": "Аудитор", "domain_name": "acts"}]
        redis = _redis_mock()
        redis.delete = AsyncMock(side_effect=ConnectionError("boom"))

        with patch("app.api.v1.deps.role_deps.get_redis", return_value=redis):
            await invalidate_user_roles_cache(self.USERNAME)  # не должно бросить

        assert self.USERNAME not in _roles_cache
