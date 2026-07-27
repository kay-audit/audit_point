"""E2E API-тесты эндпоинтов домена актов.

Покрывает маршрутизацию + статус-коды + ownership-проверки через
``TestClient(app)``. Полное приложение не поднимаем: собираем минимальный
``FastAPI`` с роутерами management/invoice, переопределяем DI-зависимости
(``get_username``, сервисы) на моки и проверяем поведение.

Образец: ``tests/domains/chat/test_chat_api_e2e.py``.
"""

from __future__ import annotations

import datetime as dt
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.core.exceptions import AppError
from app.domains.acts.api.management import router as management_router
from app.domains.acts.api.invoice import router as invoice_router
from app.domains.acts.deps import (
    _get_acts_settings,
    get_crud_service,
    get_invoice_service,
    get_lock_service,
)
from app.domains.acts.exceptions import (
    AccessDeniedError,
    ActLockError,
    ActNotFoundError,
    InsufficientRightsError,
    InvoiceError,
    KmConflictError,
)
from app.domains.acts.settings import ActsSettings, AutosaveSettings


USERNAME = "22494524"
ACT_ID = 42


def _build_app(
    *,
    crud_service: object | None = None,
    lock_service: object | None = None,
    invoice_service: object | None = None,
    username: str = USERNAME,
    user_roles: list[dict] | None = None,
) -> FastAPI:
    """Собирает минимальный FastAPI с двумя роутерами и оверрайдами DI.

    ``user_roles`` — список ролей пользователя, который передаётся в
    Depends(get_user_roles). По умолчанию — пустой список (тест-пользователь
    без админ-роли; так исторически было — раньше list_acts принимал только
    username). Тест может явно передать ``user_roles=[{"name": "Администратор"}]``
    чтобы проверить админ-ветку.
    """
    app = FastAPI()

    # Глобальный AppError-handler — как в app/main.py
    @app.exception_handler(AppError)
    async def _app_err_handler(_request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())

    app.include_router(management_router, prefix="/api/v1/acts")
    app.include_router(invoice_router, prefix="/api/v1/acts/invoice")

    app.dependency_overrides[get_username] = lambda: username
    app.dependency_overrides[get_user_roles] = lambda: (user_roles or [])
    app.dependency_overrides[_get_acts_settings] = lambda: ActsSettings()

    if crud_service is not None:
        app.dependency_overrides[get_crud_service] = lambda: crud_service
    if lock_service is not None:
        app.dependency_overrides[get_lock_service] = lambda: lock_service
    if invoice_service is not None:
        app.dependency_overrides[get_invoice_service] = lambda: invoice_service

    return app


def _make_crud_service() -> MagicMock:
    svc = MagicMock()
    svc.list_acts = AsyncMock(return_value=([], 0))
    svc.get_attention_summary = AsyncMock(return_value=[])
    svc.get_act = AsyncMock()
    svc.create_act = AsyncMock()
    svc.update_act_metadata = AsyncMock()
    svc.delete_act = AsyncMock()
    svc.duplicate_act = AsyncMock()
    svc.generate_audit_point_ids = AsyncMock()
    return svc


def _make_lock_service() -> MagicMock:
    svc = MagicMock()
    svc.lock_act = AsyncMock()
    svc.unlock_act = AsyncMock()
    svc.extend_lock = AsyncMock()
    return svc


def _make_invoice_service() -> MagicMock:
    svc = MagicMock()
    svc.list_metrics = AsyncMock(return_value=[])
    svc.list_processes = AsyncMock(return_value=[])
    svc.list_subsidiaries = AsyncMock(return_value=[])
    svc.list_tables = AsyncMock(return_value=[])
    svc.save_invoice = AsyncMock()
    svc.verify_invoice = AsyncMock()
    return svc


def _make_act_response_data(**overrides) -> dict:
    """Полный набор полей для ActResponse."""
    now = dt.datetime(2026, 5, 18, 10, 0, 0)
    data = {
        "id": ACT_ID,
        "km_number": "КМ-99-94751",
        "part_number": 1,
        "total_parts": 1,
        "inspection_name": "Тестовая проверка",
        "city": "Москва",
        "created_date": dt.date(2026, 5, 1),
        "order_number": "ORD-001",
        "order_date": dt.date(2026, 4, 30),
        "is_process_based": True,
        "inspection_start_date": dt.date(2026, 5, 1),
        "inspection_end_date": dt.date(2026, 5, 15),
        "audit_team": [
            {
                "role": "Куратор",
                "full_name": "Иванов И.И.",
                "position": "Аудитор",
                "username": USERNAME,
            },
            {
                "role": "Руководитель",
                "full_name": "Петров П.П.",
                "position": "Руководитель",
                "username": "11111111",
            },
        ],
        "directives": [],
        "service_note": None,
        "service_note_date": None,
        "audit_act_id": None,
        "needs_created_date": False,
        "needs_directive_number": False,
        "needs_invoice_check": False,
        "needs_service_note": False,
        "created_at": now,
        "updated_at": now,
        "created_by": USERNAME,
        "last_edited_by": None,
        "last_edited_at": None,
    }
    data.update(overrides)
    return data


def _make_act_create_payload(**overrides) -> dict:
    """Валидный payload для POST /create."""
    payload = {
        "km_number": "КМ-99-94751",
        "part_number": 1,
        "total_parts": 1,
        "inspection_name": "Тестовая проверка",
        "city": "Москва",
        "created_date": "2026-05-01",
        "order_number": "ORD-001",
        "order_date": "2026-04-30",
        "audit_team": [
            {
                "role": "Куратор",
                "full_name": "Иванов И.И.",
                "position": "Аудитор",
                "username": USERNAME,
            },
            {
                "role": "Руководитель",
                "full_name": "Петров П.П.",
                "position": "Руководитель",
                "username": "11111111",
            },
        ],
        "inspection_start_date": "2026-05-01",
        "inspection_end_date": "2026-05-15",
        "is_process_based": True,
        "directives": [],
    }
    payload.update(overrides)
    return payload


# -------------------------------------------------------------------------
# GET /list — список актов пользователя
# -------------------------------------------------------------------------


class TestListActs:
    """GET /api/v1/acts/list возвращает массив актов."""

    def test_list_returns_empty_array(self):
        """Пустой список — 200, PaginatedResponse с items=[], сервис вызван с username + дефолтной пагинацией."""
        crud = _make_crud_service()
        crud.list_acts.return_value = ([], 0)
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/list")

        assert resp.status_code == 200
        body = resp.json()
        assert body == {"items": [], "total": 0, "limit": 50, "offset": 0}
        # Для не-админа list_acts вызывается с is_admin=False.
        crud.list_acts.assert_awaited_once_with(
            USERNAME, limit=50, offset=0, is_admin=False,
        )

    def test_list_unauthorized_returns_401(self):
        """Без авторизации — 401, сервис не вызван."""
        crud = _make_crud_service()
        app = _build_app(crud_service=crud)

        def _no_user() -> str:
            raise HTTPException(status_code=401, detail="Требуется авторизация")

        app.dependency_overrides[get_username] = _no_user

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/list")

        assert resp.status_code == 401
        crud.list_acts.assert_not_awaited()

    def test_list_limit_over_200_returns_422(self):
        """Лимит >200 отвергается на этапе валидации Query — сервис не вызван."""
        crud = _make_crud_service()
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/list?limit=300")

        assert resp.status_code == 422
        crud.list_acts.assert_not_awaited()

    def test_list_limit_200_accepted(self):
        """Лимит ровно 200 — валиден, сервис вызван с limit=200."""
        crud = _make_crud_service()
        crud.list_acts.return_value = ([], 0)
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/list?limit=200")

        assert resp.status_code == 200
        crud.list_acts.assert_awaited_once_with(
            USERNAME, limit=200, offset=0, is_admin=False,
        )

    def test_list_admin_calls_with_is_admin_true(self):
        """С ролью «Администратор» сервис вызывается с is_admin=True —
        админ видит все акты в системе, в т.ч. чужие."""
        crud = _make_crud_service()
        crud.list_acts.return_value = ([], 0)
        app = _build_app(
            crud_service=crud,
            user_roles=[{"name": "Администратор"}],
        )

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/list")

        assert resp.status_code == 200
        crud.list_acts.assert_awaited_once_with(
            USERNAME, limit=50, offset=0, is_admin=True,
        )


# -------------------------------------------------------------------------
# GET /attention-summary — сводка «мои акты, требующие внимания»
# -------------------------------------------------------------------------


class TestAttentionSummary:
    """GET /api/v1/acts/attention-summary возвращает срез актов для колокольчика."""

    def test_attention_summary_returns_array(self):
        """Сводка — 200, массив ActAttentionItem; сервис вызван с username."""
        crud = _make_crud_service()
        from app.domains.acts.schemas.act_metadata import ActAttentionItem
        crud.get_attention_summary.return_value = [
            ActAttentionItem(
                id=42, inspection_name="Акт А", needs_invoice_check=True,
                validation_status="ok",
            ),
            ActAttentionItem(
                id=43, inspection_name="Акт Б", validation_status="warning",
            ),
        ]
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/attention-summary")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert [it["id"] for it in body] == [42, 43]
        assert body[0]["needs_invoice_check"] is True
        assert body[1]["validation_status"] == "warning"
        crud.get_attention_summary.assert_awaited_once_with(USERNAME)

    def test_attention_summary_empty(self):
        """Нет актов, требующих внимания → пустой массив."""
        crud = _make_crud_service()
        crud.get_attention_summary.return_value = []
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/attention-summary")

        assert resp.status_code == 200, resp.text
        assert resp.json() == []

    def test_attention_summary_unauthorized_returns_401(self):
        """Без авторизации — 401, сервис не вызван."""
        crud = _make_crud_service()
        app = _build_app(crud_service=crud)

        def _no_user() -> str:
            raise HTTPException(status_code=401, detail="Требуется авторизация")

        app.dependency_overrides[get_username] = _no_user

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/attention-summary")

        assert resp.status_code == 401
        crud.get_attention_summary.assert_not_awaited()


# -------------------------------------------------------------------------
# POST /create — создание акта
# -------------------------------------------------------------------------


class TestCreateAct:
    """POST /api/v1/acts/create."""

    def test_create_returns_201_with_act_response(self):
        """Успешное создание — 201, ActResponse."""
        crud = _make_crud_service()
        # Router читает result.id для логирования — отдадим объект с атрибутами
        from app.domains.acts.schemas.act_metadata import ActResponse
        crud.create_act.return_value = ActResponse(**_make_act_response_data())
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/acts/create",
                json=_make_act_create_payload(),
            )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["id"] == ACT_ID
        assert body["km_number"] == "КМ-99-94751"
        crud.create_act.assert_awaited_once()

    def test_create_invalid_km_number_returns_422(self):
        """Невалидный формат КМ — 422 ещё на этапе pydantic-валидации."""
        crud = _make_crud_service()
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/acts/create",
                json=_make_act_create_payload(km_number="BAD"),
            )

        assert resp.status_code == 422
        crud.create_act.assert_not_awaited()

    def test_create_km_conflict_returns_409(self):
        """KmConflictError → 409 + details из to_detail."""
        crud = _make_crud_service()
        crud.create_act.side_effect = KmConflictError(
            "Акт с таким КМ уже существует",
            km_number="КМ-99-94751",
            current_parts=1,
            next_part=2,
        )
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.post(
                "/api/v1/acts/create",
                json=_make_act_create_payload(),
            )

        assert resp.status_code == 409
        body = resp.json()
        assert body["code"] == "km-number-exists"
        assert body["extra"]["next_part"] == 2

    def test_create_audit_team_without_curator_returns_422(self):
        """Аудиторская группа без куратора — 422 (model_validator)."""
        crud = _make_crud_service()
        app = _build_app(crud_service=crud)

        payload = _make_act_create_payload(
            audit_team=[
                {
                    "role": "Руководитель",
                    "full_name": "Только руководитель",
                    "position": "Лид",
                    "username": "11111111",
                },
            ],
        )

        with TestClient(app) as client:
            resp = client.post("/api/v1/acts/create", json=payload)

        assert resp.status_code == 422
        crud.create_act.assert_not_awaited()


# -------------------------------------------------------------------------
# GET /{act_id} — чтение акта
# -------------------------------------------------------------------------


class TestGetAct:
    """GET /api/v1/acts/{act_id}."""

    def test_get_returns_act_response(self):
        """Успешное чтение возвращает ActResponse."""
        crud = _make_crud_service()
        crud.get_act.return_value = _make_act_response_data()
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.get(f"/api/v1/acts/{ACT_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == ACT_ID
        crud.get_act.assert_awaited_once_with(ACT_ID, USERNAME)

    def test_get_no_access_returns_403(self):
        """AccessDeniedError → 403."""
        crud = _make_crud_service()
        crud.get_act.side_effect = AccessDeniedError("Нет доступа к акту")
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.get(f"/api/v1/acts/{ACT_ID}")

        assert resp.status_code == 403

    def test_get_not_found_returns_404(self):
        """ActNotFoundError → 404."""
        crud = _make_crud_service()
        crud.get_act.side_effect = ActNotFoundError("Акт не найден")
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/999")

        assert resp.status_code == 404


# -------------------------------------------------------------------------
# PATCH /{act_id} — обновление метаданных
# -------------------------------------------------------------------------


class TestUpdateAct:
    """PATCH /api/v1/acts/{act_id}."""

    def test_patch_inspection_name(self):
        """Частичное обновление — 200, ActResponse."""
        crud = _make_crud_service()
        crud.update_act_metadata.return_value = _make_act_response_data(
            inspection_name="Новое имя",
        )
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.patch(
                f"/api/v1/acts/{ACT_ID}",
                json={"inspection_name": "Новое имя"},
            )

        assert resp.status_code == 200
        assert resp.json()["inspection_name"] == "Новое имя"
        crud.update_act_metadata.assert_awaited_once()

    def test_patch_invalid_km_returns_422(self):
        """Невалидный km_number в обновлении — 422."""
        crud = _make_crud_service()
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.patch(
                f"/api/v1/acts/{ACT_ID}",
                json={"km_number": "INVALID"},
            )

        assert resp.status_code == 422
        crud.update_act_metadata.assert_not_awaited()

    def test_patch_insufficient_rights_returns_403(self):
        """InsufficientRightsError (Участник) → 403."""
        crud = _make_crud_service()
        crud.update_act_metadata.side_effect = InsufficientRightsError(
            "Недостаточно прав для редактирования",
        )
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.patch(
                f"/api/v1/acts/{ACT_ID}",
                json={"inspection_name": "Любое"},
            )

        assert resp.status_code == 403


# -------------------------------------------------------------------------
# DELETE /{act_id} — удаление
# -------------------------------------------------------------------------


class TestDeleteAct:
    """DELETE /api/v1/acts/{act_id}."""

    def test_delete_returns_operation_result(self):
        """Успешное удаление — 200 + success/message."""
        crud = _make_crud_service()
        crud.delete_act.return_value = {
            "success": True,
            "message": "Акт успешно удален",
        }
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.delete(f"/api/v1/acts/{ACT_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        crud.delete_act.assert_awaited_once_with(ACT_ID, USERNAME)

    def test_delete_locked_by_other_returns_409(self):
        """ActLockError → 409, с locked_by в детали."""
        crud = _make_crud_service()
        crud.delete_act.side_effect = ActLockError(
            "Акт заблокирован пользователем 11111111",
            locked_by="11111111",
            locked_until="2026-05-18T13:00:00",
        )
        app = _build_app(crud_service=crud)

        with TestClient(app) as client:
            resp = client.delete(f"/api/v1/acts/{ACT_ID}")

        assert resp.status_code == 409
        body = resp.json()
        assert body["extra"]["locked_by"] == "11111111"


# -------------------------------------------------------------------------
# Lock-операции
# -------------------------------------------------------------------------


class TestLockEndpoints:
    """POST /{act_id}/lock, /unlock, /extend-lock."""

    def test_lock_act_returns_200(self):
        """Успешный lock — 200 + locked_until."""
        lock = _make_lock_service()
        lock.lock_act.return_value = {
            "success": True,
            "locked_until": "2026-05-18T12:30:00",
            "message": "Акт заблокирован для редактирования",
        }
        app = _build_app(lock_service=lock)

        with TestClient(app) as client:
            resp = client.post(f"/api/v1/acts/{ACT_ID}/lock")

        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert "locked_until" in body
        lock.lock_act.assert_awaited_once_with(ACT_ID, USERNAME)

    def test_lock_conflict_returns_409_with_locked_by(self):
        """ActLockError (чужая блокировка) → 409 + locked_by/locked_until."""
        lock = _make_lock_service()
        lock.lock_act.side_effect = ActLockError(
            "Акт редактируется пользователем 11111111",
            locked_by="11111111",
            locked_until="2026-05-18T12:30:00",
        )
        app = _build_app(lock_service=lock)

        with TestClient(app) as client:
            resp = client.post(f"/api/v1/acts/{ACT_ID}/lock")

        assert resp.status_code == 409
        body = resp.json()
        assert body["extra"]["locked_by"] == "11111111"
        assert body["extra"]["locked_until"] == "2026-05-18T12:30:00"

    def test_unlock_returns_200(self):
        """Успешный unlock — 200 + OperationResult."""
        lock = _make_lock_service()
        lock.unlock_act.return_value = {"success": True, "message": "Блокировка снята"}
        app = _build_app(lock_service=lock)

        with TestClient(app) as client:
            resp = client.post(f"/api/v1/acts/{ACT_ID}/unlock")

        assert resp.status_code == 200
        assert resp.json()["success"] is True


# -------------------------------------------------------------------------
# Конфигурационные ручки (не требуют сервиса)
# -------------------------------------------------------------------------


class TestConfigEndpoints:
    """GET /config/lock и /config/invoice — отдают значения из ActsSettings."""

    def test_lock_config(self):
        """GET /config/lock возвращает дефолтные значения LockSettings."""
        app = _build_app()

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/config/lock")

        assert resp.status_code == 200
        body = resp.json()
        assert body["lockDurationMinutes"] == 15
        assert "inactivityTimeoutMinutes" in body
        # Период автосохранения черновика в браузере отдаётся тем же эндпоинтом.
        assert body["autoSavePeriodSeconds"] == 3

    def test_autosave_period_default(self):
        """AutosaveSettings по умолчанию — период 3 сек.

        Инстанцируем модель напрямую (не через .env), чтобы проверить именно
        дефолт кода, а не значение из реального окружения.
        """
        assert AutosaveSettings().period_seconds == 3

    def test_invoice_config(self):
        """GET /config/invoice возвращает hiveSchema/gpSchema."""
        app = _build_app()

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/config/invoice")

        assert resp.status_code == 200
        body = resp.json()
        assert "hiveSchema" in body
        assert "gpSchema" in body


# -------------------------------------------------------------------------
# Invoice-эндпоинты
# -------------------------------------------------------------------------


class TestInvoiceEndpoints:
    """GET /invoice/metrics, /tables/{db_type}."""

    def test_list_metrics_returns_array(self):
        """GET /metrics проксирует в сервис."""
        invoice = _make_invoice_service()
        invoice.list_metrics.return_value = [
            {"code": "ФР00001", "metric_name": "Тест", "metric_group": "ФР"},
        ]
        app = _build_app(invoice_service=invoice)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/invoice/metrics")

        assert resp.status_code == 200
        assert resp.json()[0]["code"] == "ФР00001"
        invoice.list_metrics.assert_awaited_once()

    def test_list_tables_unsupported_db_type_returns_422(self):
        """Path-валидация Literal — oracle отклоняется до сервиса."""
        invoice = _make_invoice_service()
        app = _build_app(invoice_service=invoice)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/invoice/tables/oracle")

        # Literal["hive", "greenplum"] на уровне path — FastAPI отклоняет с 422
        assert resp.status_code == 422
        invoice.list_tables.assert_not_awaited()

    def test_list_tables_service_invoice_error_returns_400(self):
        """InvoiceError из сервиса → 400 (status_code AppError)."""
        invoice = _make_invoice_service()
        invoice.list_tables.side_effect = InvoiceError("Неподдерживаемый тип БД")
        app = _build_app(invoice_service=invoice)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/invoice/tables/hive")

        assert resp.status_code == 400
