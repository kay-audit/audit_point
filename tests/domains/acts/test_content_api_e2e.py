"""E2E API-тесты эндпоинтов содержимого актов и аудит-лога.

Покрывает маршрутизацию + статус-коды через TestClient. Полное приложение
не поднимаем — собираем минимальный FastAPI с двумя роутерами acts
(content + audit_log), переопределяем DI на моки и проверяем поведение.
"""

from __future__ import annotations

import datetime as dt
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.api.v1.deps.auth_deps import get_username
from app.core.exceptions import AppError
from app.domains.acts.api.audit_log import router as audit_router
from app.domains.acts.api.content import router as content_router
from app.domains.acts.deps import (
    get_audit_log_deps,
    get_audit_log_service,
    get_content_service,
    get_invoice_service,
)
from app.domains.acts.exceptions import (
    AccessDeniedError,
    ActLockError,
    ActNotFoundError,
    ActValidationError,
    ContentConflictError,
    InsufficientRightsError,
    ManagementRoleRequiredError,
)


USERNAME = "12345"


def _build_app(
    *,
    content_service=None,
    invoice_service=None,
    audit_deps=None,
    audit_service=None,
    username: str = USERNAME,
) -> FastAPI:
    """Минимальный FastAPI с двумя acts-роутерами под /api/v1/acts."""
    app = FastAPI()

    @app.exception_handler(AppError)
    async def _app_err_handler(_request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())

    app.include_router(content_router, prefix="/api/v1/acts")
    app.include_router(audit_router, prefix="/api/v1/acts")

    app.dependency_overrides[get_username] = lambda: username

    if content_service is not None:
        app.dependency_overrides[get_content_service] = lambda: content_service
    if invoice_service is not None:
        app.dependency_overrides[get_invoice_service] = lambda: invoice_service
    if audit_deps is not None:
        app.dependency_overrides[get_audit_log_deps] = lambda: audit_deps
    if audit_service is not None:
        app.dependency_overrides[get_audit_log_service] = lambda: audit_service

    return app


def _make_content_service() -> MagicMock:
    svc = MagicMock()
    svc.get_content = AsyncMock()
    svc.save_content = AsyncMock()
    return svc


def _make_invoice_service() -> MagicMock:
    svc = MagicMock()
    svc.get_invoices = AsyncMock()
    return svc


def _make_audit_deps():
    """Триплет (guard, audit_repo, versions_repo) — то, что отдаёт get_audit_log_deps."""
    guard = MagicMock()
    guard.require_management_role = AsyncMock()
    audit_repo = MagicMock()
    audit_repo.get_log = AsyncMock()
    versions_repo = MagicMock()
    versions_repo.get_versions_list = AsyncMock()
    versions_repo.get_version = AsyncMock()
    return guard, audit_repo, versions_repo


def _make_audit_service() -> MagicMock:
    svc = MagicMock()
    svc.restore_version = AsyncMock()
    return svc


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/v1/acts/{act_id}/content
# ─────────────────────────────────────────────────────────────────────────────


class TestGetActContent:
    """E2E: GET содержимого акта."""

    def test_get_content_returns_200_with_tree(self):
        """Успешное чтение содержимого возвращает 200 со структурой акта."""
        svc = _make_content_service()
        svc.get_content.return_value = {
            "metadata": {"km_number": "КМ-01-0000001"},
            "tree": {"id": "root", "label": "Акт", "children": []},
            "tables": {},
            "textBlocks": {},
            "violations": {},
            "invoices": {},
            "userPermission": {"canEdit": True, "role": "Куратор"},
        }
        app = _build_app(content_service=svc)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/42/content")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["metadata"]["km_number"] == "КМ-01-0000001"
        assert body["tree"]["id"] == "root"
        # сервис вызван с act_id и username
        svc.get_content.assert_awaited_once_with(42, USERNAME)

    def test_get_content_unknown_act_returns_404(self):
        """Несуществующий акт → 404 через ActNotFoundError."""
        svc = _make_content_service()
        svc.get_content.side_effect = ActNotFoundError("Акт не найден")
        app = _build_app(content_service=svc)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/9999/content")

        assert resp.status_code == 404
        assert resp.json()["detail"] == "Акт не найден"

    def test_get_content_no_access_returns_403(self):
        """Пользователь без доступа → 403 через AccessDeniedError."""
        svc = _make_content_service()
        svc.get_content.side_effect = AccessDeniedError("Нет доступа к акту")
        app = _build_app(content_service=svc)

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/1/content")

        assert resp.status_code == 403

    def test_get_content_unauthorized_returns_401(self):
        """Отсутствие пользователя → 401 (override get_username)."""
        svc = _make_content_service()
        app = _build_app(content_service=svc)

        def _no_user():
            raise HTTPException(status_code=401, detail="Требуется авторизация")
        app.dependency_overrides[get_username] = _no_user

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/1/content")
        assert resp.status_code == 401


# ─────────────────────────────────────────────────────────────────────────────
# PUT /api/v1/acts/{act_id}/content
# ─────────────────────────────────────────────────────────────────────────────


def _valid_save_payload() -> dict:
    return {
        "tree": {"id": "root", "label": "Акт", "children": []},
        "tables": {},
        "textBlocks": {},
        "violations": {},
        "saveType": "manual",
    }


class TestSaveActContent:
    """E2E: PUT сохранения содержимого акта."""

    def test_save_content_returns_200_on_success(self):
        """Успешное сохранение возвращает SaveContentResponse."""
        svc = _make_content_service()
        svc.save_content.return_value = {
            "status": "success",
            "message": "Содержимое сохранено",
        }
        app = _build_app(content_service=svc)

        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/acts/42/content", json=_valid_save_payload(),
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "success"
        svc.save_content.assert_awaited_once()

    def test_save_content_response_includes_updated_at(self):
        """PUT отдаёт серверный updated_at — базу метаданных снимка-черновика (H3)."""
        svc = _make_content_service()
        svc.save_content.return_value = {
            "status": "success",
            "message": "Содержимое сохранено",
            "updated_at": dt.datetime(2026, 6, 11, 10, 0, 0, 123456),
        }
        app = _build_app(content_service=svc)

        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/acts/42/content", json=_valid_save_payload(),
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["updated_at"] == "2026-06-11T10:00:00.123456"

    def test_save_content_lock_conflict_returns_409(self):
        """Чужая блокировка → 409 через ActLockError."""
        svc = _make_content_service()
        svc.save_content.side_effect = ActLockError(
            "Акт редактируется другим пользователем",
            locked_by="other-user",
            locked_until="2026-05-18T13:00:00",
        )
        app = _build_app(content_service=svc)

        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/acts/42/content", json=_valid_save_payload(),
            )

        assert resp.status_code == 409
        body = resp.json()
        # to_envelope() для ActLockError кладёт locked_by/locked_until в extra
        assert body["extra"]["locked_by"] == "other-user"

    def test_save_content_optimistic_conflict_returns_409(self):
        """Устаревший expected_updated_at → 409 c code 'content-conflict' и extra."""
        svc = _make_content_service()
        svc.save_content.side_effect = ContentConflictError(
            "Содержимое акта изменено с момента загрузки — сохранение отклонено",
            current_updated_at="2026-08-18T10:30:45.123456",
            last_edited_by="67890",
            last_edited_at="2026-08-18T10:30:45.123456",
        )
        app = _build_app(content_service=svc)

        payload = _valid_save_payload()
        payload["expected_updated_at"] = "2026-08-18T10:25:00.000001"

        with TestClient(app) as client:
            resp = client.put("/api/v1/acts/42/content", json=payload)

        assert resp.status_code == 409
        body = resp.json()
        assert body["code"] == "content-conflict"
        assert body["extra"]["current_updated_at"] == "2026-08-18T10:30:45.123456"
        assert body["extra"]["last_edited_by"] == "67890"
        assert body["extra"]["last_edited_at"] == "2026-08-18T10:30:45.123456"

    def test_save_content_accepts_expected_updated_at(self):
        """Поле expected_updated_at проходит схему и доезжает до сервиса datetime'ом."""
        svc = _make_content_service()
        svc.save_content.return_value = {
            "status": "success",
            "message": "Содержимое сохранено",
        }
        app = _build_app(content_service=svc)

        payload = _valid_save_payload()
        payload["expected_updated_at"] = "2026-08-18T10:30:45.123456"

        with TestClient(app) as client:
            resp = client.put("/api/v1/acts/42/content", json=payload)

        assert resp.status_code == 200, resp.text
        data = svc.save_content.await_args.args[1]
        assert data.expected_updated_at == dt.datetime(
            2026, 8, 18, 10, 30, 45, 123456,
        )

    def test_save_content_no_edit_permission_returns_403(self):
        """Роль 'Участник' (viewer) → 403 через InsufficientRightsError."""
        svc = _make_content_service()
        svc.save_content.side_effect = InsufficientRightsError(
            "Недостаточно прав для редактирования",
        )
        app = _build_app(content_service=svc)

        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/acts/42/content", json=_valid_save_payload(),
            )

        assert resp.status_code == 403

    def test_save_content_invalid_payload_returns_422(self):
        """Невалидный body (отсутствует tree) → 422 Pydantic-валидация."""
        svc = _make_content_service()
        app = _build_app(content_service=svc)

        with TestClient(app) as client:
            # tree обязателен в ActDataSchema
            resp = client.put(
                "/api/v1/acts/42/content",
                json={"tables": {}, "textBlocks": {}, "violations": {}},
            )

        assert resp.status_code == 422
        # save_content не вызван — отсёк FastAPI на валидации
        svc.save_content.assert_not_awaited()

    def test_save_content_unknown_table_field_returns_422(self):
        """M.20: неизвестное поле в таблице → 422 (extra='forbid'), не молчаливая потеря."""
        svc = _make_content_service()
        app = _build_app(content_service=svc)

        payload = _valid_save_payload()
        payload["tables"] = {
            "t1": {
                "id": "t1", "nodeId": "n1",
                "grid": [], "colWidths": [],
                "totallyUnknownField": 123,
            },
        }
        payload["tree"]["children"] = [
            {"id": "n1", "label": "Таблица", "type": "table",
             "tableId": "t1", "children": []},
        ]

        with TestClient(app) as client:
            resp = client.put("/api/v1/acts/42/content", json=payload)

        assert resp.status_code == 422
        svc.save_content.assert_not_awaited()

    def test_save_content_dangling_tree_ref_accepted_with_warning(self):
        """M.13 (решение «lenient», findings 3+8): висячая ссылка узла больше
        НЕ отбивает PUT 422 на разборе — запрос принимается, сервис вызывается,
        а вычистку и warning делает ActContentService (см. service-level тесты).
        Здесь проверяется только то, что API пропускает такой payload и
        прокидывает поле warning ответа."""
        svc = _make_content_service()
        svc.save_content.return_value = {
            "status": "success",
            "message": "Содержимое сохранено",
            "warning": "Очищено рассогласование дерево ↔ словари (висячих ссылок: 1)",
        }
        app = _build_app(content_service=svc)

        payload = _valid_save_payload()
        payload["tree"]["children"] = [
            {"id": "n1", "label": "Таблица", "type": "table",
             "tableId": "t_ghost", "children": []},
        ]
        # tables пуст — ссылка висячая, но запрос больше не отбивается 422

        with TestClient(app) as client:
            resp = client.put("/api/v1/acts/42/content", json=payload)

        assert resp.status_code == 200, resp.text
        assert resp.json()["warning"]
        svc.save_content.assert_awaited_once()

    def test_save_content_business_validation_error_returns_400(self):
        """ActValidationError из сервиса (например, глубина дерева) → 400."""
        svc = _make_content_service()
        svc.save_content.side_effect = ActValidationError(
            "Глубина дерева (60) превышает максимум (50)",
        )
        app = _build_app(content_service=svc)

        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/acts/42/content", json=_valid_save_payload(),
            )

        assert resp.status_code == 400
        assert "Глубина" in resp.json()["detail"]

    def test_save_content_unknown_act_returns_404(self):
        """Несуществующий акт при сохранении → 404."""
        svc = _make_content_service()
        svc.save_content.side_effect = ActNotFoundError("Акт не найден")
        app = _build_app(content_service=svc)

        with TestClient(app) as client:
            resp = client.put(
                "/api/v1/acts/9999/content", json=_valid_save_payload(),
            )
        assert resp.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/v1/acts/{act_id}/audit-log
# ─────────────────────────────────────────────────────────────────────────────


class TestGetAuditLog:
    """E2E: чтение аудит-лога."""

    def test_get_audit_log_returns_paginated_items(self):
        """Возвращает items + total."""
        guard, audit_repo, versions_repo = _make_audit_deps()
        guard.require_management_role.return_value = {"role": "Куратор"}
        now = dt.datetime(2026, 5, 18, 12, 0, 0)
        audit_repo.get_log.return_value = (
            [
                {
                    "id": 1,
                    "action": "create",
                    "username": "12345",
                    "details": {},
                    "changelog": [],
                    "created_at": now,
                },
            ],
            1,
        )
        app = _build_app(audit_deps=(guard, audit_repo, versions_repo))

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/42/audit-log")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["action"] == "create"
        # guard вызван
        guard.require_management_role.assert_awaited_once_with(42, USERNAME)

    def test_get_audit_log_requires_management_role(self):
        """Не Куратор/Руководитель → 403 через ManagementRoleRequiredError."""
        guard, audit_repo, versions_repo = _make_audit_deps()
        guard.require_management_role.side_effect = ManagementRoleRequiredError(
            "Доступно только для Куратора и Руководителя",
        )
        app = _build_app(audit_deps=(guard, audit_repo, versions_repo))

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/42/audit-log")

        assert resp.status_code == 403
        audit_repo.get_log.assert_not_awaited()

    def test_get_audit_log_passes_filters_to_repo(self):
        """Query-параметры action/username/dates пробрасываются в repo."""
        guard, audit_repo, versions_repo = _make_audit_deps()
        audit_repo.get_log.return_value = ([], 0)
        app = _build_app(audit_deps=(guard, audit_repo, versions_repo))

        with TestClient(app) as client:
            resp = client.get(
                "/api/v1/acts/42/audit-log"
                "?action=create&username=иван"
                "&from_date=2026-01-01&to_date=2026-12-31"
                "&limit=10&offset=5",
            )

        assert resp.status_code == 200
        # Проверяем что фильтры пробрасываются (через kwargs)
        kwargs = audit_repo.get_log.await_args.kwargs
        assert kwargs["action"] == "create"
        assert kwargs["username"] == "иван"
        assert kwargs["from_date"] == "2026-01-01"
        assert kwargs["to_date"] == "2026-12-31"
        assert kwargs["limit"] == 10
        assert kwargs["offset"] == 5


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/v1/acts/{act_id}/versions  и  /versions/{version_id}
# ─────────────────────────────────────────────────────────────────────────────


class TestVersions:
    """E2E: список и детали версий содержимого."""

    def test_list_versions_returns_paginated(self):
        """GET /versions возвращает items + total."""
        guard, audit_repo, versions_repo = _make_audit_deps()
        now = dt.datetime(2026, 5, 18, 12, 0, 0)
        versions_repo.get_versions_list.return_value = (
            [
                {
                    "id": 1,
                    "version_number": 1,
                    "save_type": "manual",
                    "username": "12345",
                    "created_at": now,
                },
            ],
            1,
        )
        app = _build_app(audit_deps=(guard, audit_repo, versions_repo))

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/42/versions")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["version_number"] == 1

    def test_get_version_detail_404_when_missing(self):
        """GET /versions/{id} c несуществующей версией → 404."""
        guard, audit_repo, versions_repo = _make_audit_deps()
        versions_repo.get_version.return_value = None
        app = _build_app(audit_deps=(guard, audit_repo, versions_repo))

        with TestClient(app) as client:
            resp = client.get("/api/v1/acts/42/versions/999")

        assert resp.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/v1/acts/{act_id}/versions/{version_id}/restore
# ─────────────────────────────────────────────────────────────────────────────


class TestRestoreVersion:
    """E2E: восстановление версии содержимого."""

    def test_restore_version_returns_200_on_success(self):
        """Успешный restore → 200 c restored_version."""
        svc = _make_audit_service()
        svc.restore_version.return_value = {
            "success": True,
            "message": "Содержимое восстановлено из версии #3",
            "restored_version": 3,
        }
        app = _build_app(audit_service=svc)

        with TestClient(app) as client:
            resp = client.post("/api/v1/acts/42/versions/100/restore")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["restored_version"] == 3
        assert body["success"] is True
        svc.restore_version.assert_awaited_once_with(42, 100, USERNAME)

    def test_restore_version_unknown_returns_404(self):
        """Несуществующая версия → 404 через ActNotFoundError из сервиса."""
        svc = _make_audit_service()
        svc.restore_version.side_effect = ActNotFoundError("Версия 999 не найдена")
        app = _build_app(audit_service=svc)

        with TestClient(app) as client:
            resp = client.post("/api/v1/acts/42/versions/999/restore")

        assert resp.status_code == 404
