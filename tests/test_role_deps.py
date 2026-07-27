"""Интеграционные тесты ``require_domain_access`` через FastAPI TestClient.

Поднимаем минимальный ``FastAPI`` с защищённым эндпоинтом, переопределяем
``get_user_roles`` (и при необходимости ``get_username``) и проверяем
все сценарии доступа.
"""

from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import (
    get_user_roles,
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
        _set_roles(app, [{"id": 99, "name": "Администратор", "domain_name": None}])

        with TestClient(app) as client:
            resp = client.get("/protected")

        assert resp.status_code == 200

    def test_admin_passes_for_arbitrary_domain(self):
        app = _build_app(protected_domain="ck_fin_res")
        _set_roles(app, [{"id": 99, "name": "Администратор", "domain_name": None}])

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

        # Только роль 'Администратор' получает универсальный доступ
        assert resp.status_code == 403


# -------------------------------------------------------------------------
# require_admin
# -------------------------------------------------------------------------


class TestRequireAdmin:

    def test_admin_role_passes(self):
        app = _build_app()
        _set_roles(app, [{"id": 99, "name": "Администратор", "domain_name": None}])

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
