"""E2E API-тесты обратной связи по сообщениям (PUT/DELETE feedback + обогащение истории).

Минимальный FastAPI с chat-роутерами и оверрайдами DI на моки —
по образцу tests/domains/chat/test_chat_api_e2e.py.
"""

from __future__ import annotations

import datetime as dt
from unittest.mock import AsyncMock, MagicMock, patch

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
from app.domains.chat.api.feedback import router as feedback_router
from app.domains.chat.api.messages import router as msg_router
from app.domains.chat.deps import (
    get_conversation_service,
    get_feedback_service,
    get_message_service,
)
from app.domains.chat.exceptions import (
    ChatFeedbackValidationError,
    ChatMessageNotFoundError,
    ConversationNotFoundError,
)

USERNAME = "12345"


@pytest.fixture(autouse=True)
def clean_registries():
    reset_registry()
    reset_settings()
    reset_tools()
    yield
    reset_registry()
    reset_settings()
    reset_tools()


def _build_app(*, conv, msg, feedback, username: str = USERNAME) -> FastAPI:
    app = FastAPI()

    @app.exception_handler(AppError)
    async def _app_err_handler(_request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())

    app.include_router(msg_router, prefix="/api/v1/chat")
    app.include_router(feedback_router, prefix="/api/v1/chat")

    app.dependency_overrides[get_username] = lambda: username
    app.dependency_overrides[get_user_roles] = lambda: [
        {"id": 1, "name": "Администратор", "domain_name": None},
    ]
    app.dependency_overrides[get_conversation_service] = lambda: conv
    app.dependency_overrides[get_message_service] = lambda: msg
    app.dependency_overrides[get_feedback_service] = lambda: feedback
    return app


def _conv():
    svc = MagicMock()
    svc.get = AsyncMock(return_value={
        "id": "conv-1", "user_id": USERNAME, "title": None,
        "domain_name": None, "context": None,
    })
    return svc


def _msg(role: str = "assistant"):
    svc = MagicMock()
    svc.get_message = AsyncMock(return_value={
        "id": "m-1", "conversation_id": "conv-1", "role": role,
        "content": [{"type": "text", "content": "Ответ"}],
        "model": "gpt-4o", "status": "complete",
    })
    svc.get_history = AsyncMock(return_value=([], 0))
    return svc


def _feedback():
    svc = MagicMock()
    svc.submit = AsyncMock(return_value={
        "rating": "up", "reasons": None, "comment": None, "updated_at": None,
    })
    svc.clear = AsyncMock(return_value=None)
    svc.get_conversation_feedback_map = AsyncMock(return_value={})
    return svc


# --------------------------------------------------------------------------
# PUT feedback
# --------------------------------------------------------------------------


class TestPutFeedback:
    def test_put_like_returns_200(self):
        conv, msg, fb = _conv(), _msg(), _feedback()
        app = _build_app(conv=conv, msg=msg, feedback=fb)
        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/chat/conversations/conv-1/messages/m-1/feedback",
                json={"rating": "up"},
            )
        assert resp.status_code == 200, resp.text
        assert resp.json()["feedback"]["rating"] == "up"
        fb.submit.assert_awaited_once()
        kw = fb.submit.await_args.kwargs
        assert kw["rating"] == "up"
        assert kw["user_id"] == USERNAME

    def test_put_dislike_with_reasons_and_comment(self):
        conv, msg, fb = _conv(), _msg(), _feedback()
        fb.submit.return_value = {
            "rating": "down", "reasons": ["inaccurate"], "comment": "плохо",
            "updated_at": None,
        }
        app = _build_app(conv=conv, msg=msg, feedback=fb)
        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/chat/conversations/conv-1/messages/m-1/feedback",
                json={"rating": "down", "reasons": ["inaccurate"], "comment": "плохо"},
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()["feedback"]
        assert body["rating"] == "down"
        assert body["reasons"] == ["inaccurate"]
        kw = fb.submit.await_args.kwargs
        assert kw["reasons"] == ["inaccurate"]
        assert kw["comment"] == "плохо"

    def test_put_invalid_rating_returns_422(self):
        """Невалидный rating отсекается pydantic (Literal) до сервиса."""
        conv, msg, fb = _conv(), _msg(), _feedback()
        app = _build_app(conv=conv, msg=msg, feedback=fb)
        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/chat/conversations/conv-1/messages/m-1/feedback",
                json={"rating": "meh"},
            )
        assert resp.status_code == 422, resp.text
        fb.submit.assert_not_awaited()

    def test_put_service_validation_error_returns_422(self):
        conv, msg, fb = _conv(), _msg(), _feedback()
        fb.submit.side_effect = ChatFeedbackValidationError("Неизвестные коды причин: bogus.")
        app = _build_app(conv=conv, msg=msg, feedback=fb)
        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/chat/conversations/conv-1/messages/m-1/feedback",
                json={"rating": "down", "reasons": ["bogus"]},
            )
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "chat-feedback-validation"

    def test_put_foreign_conversation_returns_404(self):
        conv, msg, fb = _conv(), _msg(), _feedback()
        conv.get.side_effect = ConversationNotFoundError("Беседа не найдена")
        app = _build_app(conv=conv, msg=msg, feedback=fb)
        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/chat/conversations/foreign/messages/m-1/feedback",
                json={"rating": "up"},
            )
        assert resp.status_code == 404, resp.text
        fb.submit.assert_not_awaited()

    def test_put_unknown_message_returns_404(self):
        conv, msg, fb = _conv(), _msg(), _feedback()
        msg.get_message.side_effect = ChatMessageNotFoundError("Сообщение не найдено.")
        app = _build_app(conv=conv, msg=msg, feedback=fb)
        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/chat/conversations/conv-1/messages/nope/feedback",
                json={"rating": "up"},
            )
        assert resp.status_code == 404, resp.text
        fb.submit.assert_not_awaited()


# --------------------------------------------------------------------------
# DELETE feedback
# --------------------------------------------------------------------------


class TestDeleteFeedback:
    def test_delete_returns_200_null_feedback(self):
        conv, msg, fb = _conv(), _msg(), _feedback()
        app = _build_app(conv=conv, msg=msg, feedback=fb)
        with TestClient(app) as client:
            resp = client.delete(
                "/api/v1/chat/conversations/conv-1/messages/m-1/feedback",
            )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"feedback": None}
        fb.clear.assert_awaited_once()
        kw = fb.clear.await_args.kwargs
        assert kw["message_id"] == "m-1"
        assert kw["user_id"] == USERNAME

    def test_delete_foreign_conversation_returns_404(self):
        conv, msg, fb = _conv(), _msg(), _feedback()
        conv.get.side_effect = ConversationNotFoundError("Беседа не найдена")
        app = _build_app(conv=conv, msg=msg, feedback=fb)
        with TestClient(app) as client:
            resp = client.delete(
                "/api/v1/chat/conversations/foreign/messages/m-1/feedback",
            )
        assert resp.status_code == 404, resp.text
        fb.clear.assert_not_awaited()


# --------------------------------------------------------------------------
# GET /messages — обогащение истории оценками
# --------------------------------------------------------------------------


class TestHistoryEnrichment:
    def _history(self):
        now = dt.datetime(2026, 1, 1, 12, 0, 0)
        return [
            {
                "id": "u-1", "conversation_id": "conv-1", "role": "user",
                "content": [{"type": "text", "content": "Вопрос"}],
                "model": None, "token_usage": None, "status": "complete",
                "created_at": now,
            },
            {
                "id": "a-1", "conversation_id": "conv-1", "role": "assistant",
                "content": [{"type": "text", "content": "Ответ"}],
                "model": "gpt-4o", "token_usage": None, "status": "complete",
                "created_at": now,
            },
        ]

    def test_history_enriched_with_feedback(self):
        conv = _conv()
        msg = _msg()
        msg.get_history = AsyncMock(return_value=(self._history(), 2))
        fb = _feedback()

        fb_repo = MagicMock()
        fb_repo.get_map_for_conversation = AsyncMock(return_value={
            "a-1": {"rating": "up", "reasons": None, "comment": None, "updated_at": None},
        })

        app = _build_app(conv=conv, msg=msg, feedback=fb)
        # Репозиторий строится на соединении msg_service (без второго
        # соединения пула) — подменяем класс целиком.
        with patch(
            "app.domains.chat.api.messages.ChatMessageFeedbackRepository",
            return_value=fb_repo,
        ):
            with TestClient(app) as client:
                resp = client.get("/api/v1/chat/conversations/conv-1/messages")

        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        by_id = {m["id"]: m for m in items}
        assert by_id["a-1"]["feedback"]["rating"] == "up"
        assert by_id["u-1"]["feedback"] is None  # без оценки

    def test_history_returns_even_if_feedback_fetch_fails(self):
        """Сбой обогащения оценками не ломает загрузку истории (best-effort)."""
        conv = _conv()
        msg = _msg()
        msg.get_history = AsyncMock(return_value=(self._history(), 2))
        fb = _feedback()

        app = _build_app(conv=conv, msg=msg, feedback=fb)
        # Конструктор репозитория падает — как реальный get_adapter() без
        # инициализированной БД.
        with patch(
            "app.domains.chat.api.messages.ChatMessageFeedbackRepository",
            side_effect=RuntimeError("Database pool не инициализирован"),
        ):
            with TestClient(app) as client:
                resp = client.get("/api/v1/chat/conversations/conv-1/messages")

        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        assert len(items) == 2
        assert all(m["feedback"] is None for m in items)
