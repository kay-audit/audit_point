"""E2E-тесты endpoint'а ``/api/v1/admin/diagnostics``.

Поднимается минимальный FastAPI с одним роутером
``admin_diagnostics.router`` + DI-оверрайды на роли пользователя.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.api.v1.endpoints.admin_diagnostics import router as diag_router
from app.core import observability_registry as obs


@pytest.fixture(autouse=True)
def _reset_registry():
    """Сброс observability-реестра между тестами."""
    obs.reset()
    yield
    obs.reset()


class _StaticBatcher:
    """Стабильный заглушка-batcher для тестов."""

    def __init__(self, payload: dict):
        self._payload = payload

    def get_status(self) -> dict:
        return dict(self._payload)


def _build_app(roles: list[dict]) -> FastAPI:
    """Собирает минимальный FastAPI с роутером diagnostics и оверрайдами DI."""
    app = FastAPI()
    app.include_router(diag_router, prefix="/api/v1/admin/diagnostics")
    app.dependency_overrides[get_username] = lambda: "12345"
    app.dependency_overrides[get_user_roles] = lambda: roles
    return app


def test_admin_role_returns_200_with_payload():
    """Админ получает 200 + JSON с зарегистрированными компонентами."""
    obs.register_batcher(
        "admin.http_metrics_batcher",
        _StaticBatcher(
            {
                "name": "admin.http_metrics_batcher",
                "buffer_size": 12,
                "dropped_count": 0,
                "last_error": None,
                "running": True,
            },
        ),
    )
    obs.register_background_task(
        "chat.agent_channel_poller",
        lambda: {
            "name": "chat.agent_channel_poller",
            "running": True,
            "restart_count": 0,
            "active_subscribers": 2,
        },
    )

    app = _build_app(roles=[{"id": 1, "name": "Администратор", "domain_name": None}])
    client = TestClient(app)
    resp = client.get("/api/v1/admin/diagnostics")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "batchers" in data
    assert "background_tasks" in data
    assert "admin.http_metrics_batcher" in data["batchers"]
    assert data["batchers"]["admin.http_metrics_batcher"]["buffer_size"] == 12
    assert "chat.agent_channel_poller" in data["background_tasks"]
    assert (
        data["background_tasks"]["chat.agent_channel_poller"]["active_subscribers"]
        == 2
    )


def test_empty_registry_returns_200_with_empty_dicts():
    """Если ничего не зарегистрировано — 200 + пустые словари."""
    app = _build_app(roles=[{"id": 1, "name": "Администратор", "domain_name": None}])
    client = TestClient(app)
    resp = client.get("/api/v1/admin/diagnostics")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"batchers": {}, "background_tasks": {}}


def test_non_admin_user_returns_403():
    """Пользователь с ролью домена чата (не админ) получает 403."""
    app = _build_app(
        roles=[{"id": 2, "name": "Чат-ассистент", "domain_name": "chat"}],
    )
    client = TestClient(app)
    resp = client.get("/api/v1/admin/diagnostics")
    assert resp.status_code == 403, resp.text


def test_user_with_no_roles_returns_403():
    """Пользователь без ролей вообще получает 403."""
    app = _build_app(roles=[])
    client = TestClient(app)
    resp = client.get("/api/v1/admin/diagnostics")
    assert resp.status_code == 403, resp.text
