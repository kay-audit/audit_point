"""E2E-тесты эндпоинта корректора /chat/text-actions/correct."""

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
from app.domains.chat.api.text_actions import router
from app.domains.chat.deps import (
    get_text_corrector_service,
    get_violation_formalizer_service,
)
from app.domains.chat.exceptions import TextActionValidationError
from app.domains.chat.schemas.text_actions import FormalizeResponse


@pytest.fixture(autouse=True)
def _reset():
    reset_registry()
    reset_settings()
    reset_tools()
    yield
    reset_registry()
    reset_settings()
    reset_tools()


def _app(service):
    app = FastAPI()

    @app.exception_handler(AppError)
    async def _handle(_request, exc: AppError):
        return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())

    app.include_router(router, prefix="/api/v1/chat")
    # require_domain_access("chat") — фабрика: не переопределяем её напрямую,
    # а даём админ-роль через get_user_roles (тогда проверка проходит).
    app.dependency_overrides[get_username] = lambda: "user1"
    app.dependency_overrides[get_user_roles] = lambda: [
        {"id": 1, "name": "Администратор", "domain_name": None},
    ]
    app.dependency_overrides[get_text_corrector_service] = lambda: service
    app.dependency_overrides[get_violation_formalizer_service] = lambda: service
    return app


def test_correct_ok():
    svc = MagicMock()
    svc.correct = AsyncMock(return_value="исправлено")
    with TestClient(_app(svc)) as c:
        r = c.post("/api/v1/chat/text-actions/correct", json={"text": "исходый"})
    assert r.status_code == 200
    assert r.json()["corrected_text"] == "исправлено"


def test_correct_forwards_mode():
    svc = MagicMock()
    svc.correct = AsyncMock(return_value="улучшено")
    with TestClient(_app(svc)) as c:
        r = c.post(
            "/api/v1/chat/text-actions/correct",
            json={"text": "текст", "mode": "readability"},
        )
    assert r.status_code == 200
    svc.correct.assert_awaited_once_with("текст", "readability")


def test_correct_rejects_bad_mode():
    svc = MagicMock()
    svc.correct = AsyncMock(return_value="x")
    with TestClient(_app(svc)) as c:
        r = c.post(
            "/api/v1/chat/text-actions/correct",
            json={"text": "текст", "mode": "bogus"},
        )
    assert r.status_code == 422  # Literal["fix","readability"] в CorrectRequest


def test_correct_too_long_422():
    svc = MagicMock()
    svc.correct = AsyncMock(side_effect=TextActionValidationError("слишком длинно"))
    with TestClient(_app(svc)) as c:
        r = c.post("/api/v1/chat/text-actions/correct", json={"text": "x"})
    assert r.status_code == 422
    assert r.json()["code"] == "text-action-validation"


def test_correct_empty_text_rejected_by_dto():
    svc = MagicMock()
    svc.correct = AsyncMock(return_value="x")
    with TestClient(_app(svc)) as c:
        r = c.post("/api/v1/chat/text-actions/correct", json={"text": ""})
    assert r.status_code == 422  # min_length=1 в CorrectRequest


def test_formalize_ok():
    svc = MagicMock()
    svc.formalize = AsyncMock(return_value=FormalizeResponse(
        violated="норма", established="факт", responsible="Иванов",
    ))
    with TestClient(_app(svc)) as c:
        r = c.post(
            "/api/v1/chat/text-actions/formalize-violation",
            json={"text": "сырой текст нарушения"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["violated"] == "норма"
    assert body["established"] == "факт"
    assert body["responsible"] == "Иванов"
    assert body["reasons"] == ""  # не извлечено → пусто


def test_formalize_empty_text_rejected_by_dto():
    svc = MagicMock()
    svc.formalize = AsyncMock(return_value=FormalizeResponse())
    with TestClient(_app(svc)) as c:
        r = c.post(
            "/api/v1/chat/text-actions/formalize-violation",
            json={"text": ""},
        )
    assert r.status_code == 422  # min_length=1 в FormalizeRequest
