"""E2E-тесты админских эндпоинтов аналитики чата (routing + require_admin)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.core.chat.tools import reset as reset_tools
from app.core.domain_registry import reset_registry
from app.core.exceptions import AppError
from app.core.settings_registry import reset as reset_settings
from app.domains.chat.api.admin_analytics import router as analytics_router
from app.domains.chat.deps import get_analytics_service

USERNAME = "12345"
ADMIN_ROLES = [{"id": 1, "name": "Администратор", "domain_name": None}]
USER_ROLES = [{"id": 2, "name": "Чат-ассистент", "domain_name": "chat"}]


@pytest.fixture(autouse=True)
def clean_registries():
    reset_registry()
    reset_settings()
    reset_tools()
    yield
    reset_registry()
    reset_settings()
    reset_tools()


def _build_app(*, service, roles=ADMIN_ROLES):
    app = FastAPI()

    @app.exception_handler(AppError)
    async def _h(_r, exc: AppError):
        return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())

    app.include_router(analytics_router, prefix="/api/v1/chat")
    app.dependency_overrides[get_username] = lambda: USERNAME
    app.dependency_overrides[get_user_roles] = lambda: roles
    app.dependency_overrides[get_analytics_service] = lambda: service
    return app


def _service():
    svc = MagicMock()
    svc.get_stats = AsyncMock(return_value={
        "total": 10, "up": 7, "down": 3, "like_rate": 0.7,
        "by_route": {}, "by_model": {}, "by_reason": {},
    })
    svc.list_feedback = AsyncMock(return_value={
        "items": [{"message_id": "m1", "rating": "down", "answer_text": "..."}],
        "total": 1, "limit": 50, "offset": 0,
    })
    svc.inspect_conversation = AsyncMock(return_value={
        "conversation_id": "c1", "messages": [],
    })
    return svc


class TestAnalyticsAccess:
    def test_stats_requires_admin_403_for_non_admin(self):
        app = _build_app(service=_service(), roles=USER_ROLES)
        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/admin/feedback/stats")
        assert resp.status_code == 403, resp.text

    def test_stats_ok_for_admin(self):
        svc = _service()
        app = _build_app(service=svc)
        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/admin/feedback/stats?route_type=kb_agent&from=2026-01-01")
        assert resp.status_code == 200, resp.text
        assert resp.json()["like_rate"] == 0.7
        kw = svc.get_stats.await_args.kwargs
        assert kw["route_type"] == "kb_agent"
        assert kw["date_from"] == "2026-01-01"


class TestFeedbackList:
    def test_list_passes_filters(self):
        svc = _service()
        app = _build_app(service=svc)
        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/admin/feedback?rating=down&limit=20")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 1
        kw = svc.list_feedback.await_args.kwargs
        assert kw["rating"] == "down"
        assert kw["limit"] == 20

    def test_list_limit_validation(self):
        """limit вне диапазона → 422."""
        app = _build_app(service=_service())
        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/admin/feedback?limit=99999")
        assert resp.status_code == 422, resp.text


class TestInspect:
    def test_inspect_returns_conversation(self):
        svc = _service()
        app = _build_app(service=svc)
        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/admin/conversations/c1/inspect")
        assert resp.status_code == 200, resp.text
        assert resp.json()["conversation_id"] == "c1"
        svc.inspect_conversation.assert_awaited_once_with("c1")

    def test_inspect_requires_admin(self):
        app = _build_app(service=_service(), roles=USER_ROLES)
        with TestClient(app) as client:
            resp = client.get("/api/v1/chat/admin/conversations/c1/inspect")
        assert resp.status_code == 403, resp.text
