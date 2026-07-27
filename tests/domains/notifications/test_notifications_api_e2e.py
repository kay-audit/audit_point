"""E2E API-тесты эндпоинтов центра уведомлений.

Минимальный FastAPI + dependency_overrides (get_username + сервис-фабрика
на AsyncMock), без реальной БД. Образец — tests/domains/chat/test_chat_api_e2e.py.
"""

from __future__ import annotations

import datetime as dt
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.core.domain_registry import reset_registry
from app.core.exceptions import AppError
from app.core.settings_registry import reset as reset_settings
from app.domains.notifications.api.notifications import router as notif_router
from app.domains.notifications.deps import (
    get_notification_service,
    get_notifications_settings,
)
from app.domains.notifications.settings import NotificationsSettings

USERNAME = "12345"
ADMIN_ROLES = [{"id": 1, "name": "Администратор", "domain_name": None}]


@pytest.fixture(autouse=True)
def clean_registries():
    """Сброс реестров доменов/настроек между тестами (доменное глоб. состояние)."""
    reset_registry()
    reset_settings()
    yield
    reset_registry()
    reset_settings()


def _build_app(
    service: object,
    *,
    username: str = USERNAME,
    roles: list[dict] | None = None,
) -> FastAPI:
    """Собирает минимальный FastAPI с роутером уведомлений и оверрайдами DI.

    По умолчанию пользователь — администратор: создание уведомлений
    (POST /notifications) защищено require_admin, остальные эндпоинты —
    общий колокольчик и гейтом не покрыты.
    """
    app = FastAPI()

    @app.exception_handler(AppError)
    async def _app_err_handler(_request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())

    app.include_router(notif_router, prefix="/api/v1/notifications")
    app.dependency_overrides[get_username] = lambda: username
    app.dependency_overrides[get_user_roles] = lambda: (
        ADMIN_ROLES if roles is None else roles
    )
    app.dependency_overrides[get_notification_service] = lambda: service
    # Дефолтные настройки домена (реестр настроек в E2E пуст). Тесты, которым
    # важно конкретное значение, перекрывают этот оверрайд явно.
    app.dependency_overrides[get_notifications_settings] = (
        lambda: NotificationsSettings()
    )
    return app


def _make_service() -> MagicMock:
    """Mock NotificationService с async-методами."""
    svc = MagicMock()
    svc.list_for_user = AsyncMock(return_value=[])
    svc.unread_summary = AsyncMock(return_value={"count": 0, "severity": None})
    svc.mark_read = AsyncMock()
    svc.mark_unread = AsyncMock()
    svc.mark_all_read = AsyncMock()
    svc.dismiss = AsyncMock()
    svc.push = AsyncMock(return_value="new-id")
    return svc


# ── GET /notifications ───────────────────────────────────────────────────────


def test_list_returns_array():
    """GET /notifications возвращает список NotificationOut."""
    svc = _make_service()
    now = dt.datetime(2026, 6, 7, 12, 0, 0)
    svc.list_for_user.return_value = [
        {
            "id": "n1", "source": "acts", "severity": "info",
            "title": "Готов акт", "body": None,
            "link": "/constructor?act_id=42", "element_ref": None,
            "created_at": now, "is_read": False,
        },
    ]
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get("/api/v1/notifications")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == "n1"
    assert body[0]["link"] == "/constructor?act_id=42"
    assert body[0]["is_read"] is False
    # сервис вызван с username
    assert svc.list_for_user.await_args.args[0] == USERNAME


def test_list_respects_limit_query():
    """GET /notifications?limit=10 прокидывает limit в сервис."""
    svc = _make_service()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get("/api/v1/notifications?limit=10")
    assert resp.status_code == 200, resp.text
    assert svc.list_for_user.await_args.kwargs["limit"] == 10


def test_list_without_limit_uses_settings_default():
    """GET /notifications без ?limit берёт NOTIFICATIONS__LIST_LIMIT из настроек."""
    svc = _make_service()
    app = _build_app(svc)
    app.dependency_overrides[get_notifications_settings] = (
        lambda: NotificationsSettings(list_limit=7)
    )
    with TestClient(app) as client:
        resp = client.get("/api/v1/notifications")
    assert resp.status_code == 200, resp.text
    assert svc.list_for_user.await_args.kwargs["limit"] == 7


# ── GET /notifications/unread-count ──────────────────────────────────────────


def test_unread_count_with_severity():
    """GET /notifications/unread-count возвращает {count, severity}.

    severity = максимальная критичность среди непрочитанных (для бейджа).
    """
    svc = _make_service()
    svc.unread_summary.return_value = {"count": 7, "severity": "error"}
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get("/api/v1/notifications/unread-count")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"count": 7, "severity": "error"}
    assert svc.unread_summary.await_args.args[0] == USERNAME


def test_unread_count_severity_null_when_no_unread():
    """Непрочитанных нет → count=0, severity=null (бейдж не красится)."""
    svc = _make_service()
    svc.unread_summary.return_value = {"count": 0, "severity": None}
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.get("/api/v1/notifications/unread-count")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"count": 0, "severity": None}


# ── GET /notifications/config ────────────────────────────────────────────────


def test_config_returns_poll_interval():
    """GET /config отдаёт частоту опроса из настроек домена (camelCase)."""
    svc = _make_service()
    app = _build_app(svc)
    app.dependency_overrides[get_notifications_settings] = (
        lambda: NotificationsSettings(poll_interval_seconds=15)
    )
    with TestClient(app) as client:
        resp = client.get("/api/v1/notifications/config")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"pollIntervalSeconds": 15}


def test_settings_default_poll_interval():
    """Дефолт частоты опроса = 30 секунд (модель инстанцируется напрямую)."""
    assert NotificationsSettings().poll_interval_seconds == 30


# ── POST /notifications/{id}/read ────────────────────────────────────────────


def test_mark_read():
    """POST /{id}/read помечает прочитанным для текущего пользователя."""
    svc = _make_service()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post("/api/v1/notifications/n1/read")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    svc.mark_read.assert_awaited_once_with("n1", USERNAME)


# ── POST /notifications/{id}/unread ──────────────────────────────────────────


def test_mark_unread():
    """POST /{id}/unread возвращает уведомление в непрочитанное."""
    svc = _make_service()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post("/api/v1/notifications/n1/unread")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    svc.mark_unread.assert_awaited_once_with("n1", USERNAME)


# ── POST /notifications/read-all ─────────────────────────────────────────────


def test_mark_all_read():
    """POST /read-all помечает все видимые прочитанными."""
    svc = _make_service()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post("/api/v1/notifications/read-all")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    svc.mark_all_read.assert_awaited_once_with(USERNAME)


# ── POST /notifications/{id}/dismiss ─────────────────────────────────────────


def test_dismiss():
    """POST /{id}/dismiss скрывает уведомление."""
    svc = _make_service()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post("/api/v1/notifications/n1/dismiss")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    svc.dismiss.assert_awaited_once_with("n1", USERNAME)


# ── POST /notifications (создание) ───────────────────────────────────────────


def test_create_uses_username_as_created_by():
    """POST /notifications создаёт уведомление, created_by = текущий username."""
    svc = _make_service()
    svc.push.return_value = "created-123"
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/notifications",
            json={
                "source": "manual",
                "title": "Внимание",
                "severity": "warning",
                "recipient_user_id": "67890",
                "link": "/constructor?act_id=1",
            },
        )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"id": "created-123"}
    kwargs = svc.push.await_args.kwargs
    assert kwargs["created_by"] == USERNAME
    assert kwargs["source"] == "manual"
    assert kwargs["title"] == "Внимание"
    assert kwargs["severity"] == "warning"
    assert kwargs["recipient_user_id"] == "67890"
    assert kwargs["link"] == "/constructor?act_id=1"


def test_create_broadcast_default_severity():
    """POST без recipient_user_id → broadcast (None); severity по умолчанию info."""
    svc = _make_service()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/notifications",
            json={"source": "acts", "title": "Всем привет"},
        )
    assert resp.status_code == 200, resp.text
    kwargs = svc.push.await_args.kwargs
    assert kwargs["recipient_user_id"] is None
    assert kwargs["severity"] == "info"


def test_create_rejects_overlong_title():
    """Слишком длинный title отвергается на входе (422), а не падает 500 в БД."""
    svc = _make_service()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/notifications",
            json={"source": "manual", "title": "A" * 301},
        )
    assert resp.status_code == 422, resp.text
    svc.push.assert_not_awaited()


def test_create_rejects_invalid_severity():
    """severity вне набора Literal отвергается на входе (422)."""
    svc = _make_service()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/notifications",
            json={"source": "manual", "title": "Ок", "severity": "critical"},
        )
    assert resp.status_code == 422, resp.text
    svc.push.assert_not_awaited()


# ── POST /notifications: гейт require_admin ──────────────────────────────────


def test_create_allowed_for_admin():
    """Администратор создаёт уведомление (200), svc.push выполнен."""
    svc = _make_service()
    svc.push.return_value = "admin-id"
    app = _build_app(svc, roles=ADMIN_ROLES)
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/notifications",
            json={"source": "manual", "title": "От админа"},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"id": "admin-id"}
    svc.push.assert_awaited_once()


def test_create_forbidden_for_non_admin():
    """Не-админ получает 403 на создание; svc.push не вызывается."""
    svc = _make_service()
    app = _build_app(
        svc,
        roles=[{"id": 1, "name": "Цифровой акт", "domain_name": "acts"}],
    )
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/notifications",
            json={"source": "manual", "title": "Запрещено"},
        )
    assert resp.status_code == 403, resp.text
    svc.push.assert_not_awaited()


def test_read_and_dismiss_available_to_non_admin():
    """Общий колокольчик: read/dismiss доступны не-админу (гейтом не покрыты)."""
    svc = _make_service()
    app = _build_app(
        svc,
        roles=[{"id": 1, "name": "Цифровой акт", "domain_name": "acts"}],
    )
    with TestClient(app) as client:
        read_resp = client.post("/api/v1/notifications/n1/read")
        dismiss_resp = client.post("/api/v1/notifications/n1/dismiss")
    assert read_resp.status_code == 200, read_resp.text
    assert dismiss_resp.status_code == 200, dismiss_resp.text
    svc.mark_read.assert_awaited_once_with("n1", USERNAME)
    svc.dismiss.assert_awaited_once_with("n1", USERNAME)


# ── Общий колокольчик: НЕТ доменного гейта (public_api) ───────────────────────


def test_public_api_skips_domain_gate():
    """register_domains не вешает require_domain_access на public_api-домен:
    рядовой пользователь без роли 'notifications' получает 200, а не 403.

    Регрессия на контракт «общий колокольчик везде» — в отличие от остальных
    тестов файла, монтирует домен через настоящий register_domains, а не
    include_router напрямую (гейт навешивается именно реестром)."""
    from app.core.domain_registry import register_domains
    from app.domains.notifications import _build_domain

    svc = _make_service()
    svc.unread_summary.return_value = {"count": 3, "severity": "info"}

    app = FastAPI()

    @app.exception_handler(AppError)
    async def _app_err_handler(_request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())

    descriptor = _build_domain()
    assert descriptor.public_api is True, "домен уведомлений должен быть public_api"
    register_domains(app, [descriptor], "/api/v1")
    app.dependency_overrides[get_username] = lambda: USERNAME
    app.dependency_overrides[get_notification_service] = lambda: svc

    with TestClient(app) as client:
        resp = client.get("/api/v1/notifications/unread-count")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"count": 3, "severity": "info"}


# ── POST /notifications/internal (sidecar service-to-service) ─────────────────


def test_internal_push_forces_recipient_source_and_default_link():
    """POST /internal форсит source=sqlagent, адресата=текущий пользователь, link=/sqlagent."""
    svc = _make_service()
    svc.push.return_value = "nid-123"
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/notifications/internal",
            json={
                "severity": "success",
                "title": "Выгрузка завершилась",
                "body": "CSV, 100 строк",
            },
        )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"id": "nid-123"}
    kw = svc.push.await_args.kwargs
    assert kw["source"] == "sqlagent"
    assert kw["recipient_user_id"] == USERNAME
    assert kw["severity"] == "success"
    assert kw["link"] == "/sqlagent"
    assert kw["created_by"] == "sqlagent"


def test_internal_push_keeps_explicit_link():
    """Явный link сохраняется (не перетирается дефолтом /sqlagent)."""
    svc = _make_service()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/notifications/internal",
            json={"severity": "error", "title": "Ошибка выгрузки", "link": "/sqlagent?j=1"},
        )
    assert resp.status_code == 200, resp.text
    assert svc.push.await_args.kwargs["link"] == "/sqlagent?j=1"


def test_internal_push_rejects_bad_severity():
    """severity вне набора Literal → 422, svc.push не вызван."""
    svc = _make_service()
    app = _build_app(svc)
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/notifications/internal",
            json={"severity": "critical", "title": "x"},
        )
    assert resp.status_code == 422, resp.text
    svc.push.assert_not_awaited()


def test_internal_push_available_to_non_admin():
    """Внутренний эндпоинт доступен не-админу (в отличие от POST '' — не под require_admin)."""
    svc = _make_service()
    svc.push.return_value = "nid-9"
    app = _build_app(
        svc,
        roles=[{"id": 1, "name": "Цифровой акт", "domain_name": "acts"}],
    )
    with TestClient(app) as client:
        resp = client.post(
            "/api/v1/notifications/internal",
            json={"severity": "success", "title": "Готово"},
        )
    assert resp.status_code == 200, resp.text
    svc.push.assert_awaited_once()
