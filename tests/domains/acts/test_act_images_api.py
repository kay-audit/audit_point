"""E2E-тесты эндпоинтов картинок нарушений.

Полное приложение не поднимаем — минимальный FastAPI с images-роутером и
переопределённым DI (образец — test_content_api_e2e.py). Проверяются
маршрутизация, коды ошибок и заголовки ответа: MIME-allowlist, nosniff и
immutable-кэш — часть контракта безопасности, а не деталь реализации.
"""

from __future__ import annotations

import io
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from PIL import Image

from app.api.v1.deps.auth_deps import get_username
from app.core.exceptions import AppError
from app.domains.acts.api.images import router as images_router
from app.domains.acts.deps import get_image_service
from app.domains.acts.exceptions import (
    AccessDeniedError,
    ActImageNotFoundError,
    ActImageValidationError,
    ActLockError,
)
from app.domains.acts.services.act_image_service import ActImageService
from app.domains.acts.settings import ActsSettings, ImagesSettings

USERNAME = "12345"
ACT_ID = 7


def _png(size=(4, 4)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (9, 9, 9)).save(buf, format="PNG")
    return buf.getvalue()


def _build_app(service, username: str = USERNAME) -> FastAPI:
    app = FastAPI()

    @app.exception_handler(AppError)
    async def _app_err_handler(_request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.to_envelope())

    app.include_router(images_router, prefix="/api/v1/acts")
    app.dependency_overrides[get_username] = lambda: username
    app.dependency_overrides[get_image_service] = lambda: service
    return app


def _service_mock(*, acts_settings: ActsSettings | None = None) -> MagicMock:
    """Мок сервиса; safe_mime_type берём НАСТОЯЩИЙ (это и есть контракт)."""
    settings = acts_settings or ActsSettings()
    service = MagicMock()
    service.acts_settings = settings
    service.upload = AsyncMock()
    service.get = AsyncMock()
    service.safe_mime_type = lambda mime: ActImageService.safe_mime_type(service, mime)
    return service


# ── POST /acts/{act_id}/images ─────────────────────────────────────────────


def test_upload_returns_descriptor():
    service = _service_mock()
    service.upload.return_value = {
        "image_id": "img-1", "byte_size": 120,
        "mime_type": "image/png", "width": 4, "height": 4,
    }
    with TestClient(_build_app(service)) as client:
        resp = client.post(
            f"/api/v1/acts/{ACT_ID}/images",
            files={"file": ("screen.png", _png(), "image/png")},
        )

    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "image_id": "img-1", "byte_size": 120,
        "mime_type": "image/png", "width": 4, "height": 4,
    }
    kwargs = service.upload.call_args
    assert kwargs[0][0] == ACT_ID and kwargs[0][1] == USERNAME
    assert kwargs.kwargs["filename"] == "screen.png"


def test_upload_forwards_validation_error_as_422():
    service = _service_mock()
    service.upload.side_effect = ActImageValidationError("Формат не поддерживается")
    with TestClient(_build_app(service)) as client:
        resp = client.post(
            f"/api/v1/acts/{ACT_ID}/images",
            files={"file": ("x.png", _png(), "image/png")},
        )
    assert resp.status_code == 422
    assert "Формат не поддерживается" in resp.text


def test_upload_forwards_access_denied_as_403():
    service = _service_mock()
    service.upload.side_effect = AccessDeniedError("Нет доступа к акту")
    with TestClient(_build_app(service)) as client:
        resp = client.post(
            f"/api/v1/acts/{ACT_ID}/images",
            files={"file": ("x.png", _png(), "image/png")},
        )
    assert resp.status_code == 403


def test_upload_forwards_lock_conflict_as_409():
    service = _service_mock()
    service.upload.side_effect = ActLockError("Акт редактируется другим")
    with TestClient(_build_app(service)) as client:
        resp = client.post(
            f"/api/v1/acts/{ACT_ID}/images",
            files={"file": ("x.png", _png(), "image/png")},
        )
    assert resp.status_code == 409


def test_upload_stops_reading_oversized_file():
    """Поток обрывается по лимиту — сервис даже не зовётся.

    Иначе тело запроса целиком поднималось бы в память до первой проверки.
    """
    service = _service_mock(acts_settings=ActsSettings(
        images=ImagesSettings(max_file_size=16),
    ))
    with TestClient(_build_app(service)) as client:
        resp = client.post(
            f"/api/v1/acts/{ACT_ID}/images",
            files={"file": ("big.png", b"x" * 4096, "image/png")},
        )
    assert resp.status_code == 422
    assert "превышает" in resp.text
    service.upload.assert_not_called()


# ── GET /acts/{act_id}/images/{image_id} ───────────────────────────────────


def test_get_returns_bytes_with_real_mime_and_security_headers():
    service = _service_mock()
    service.get.return_value = {
        "id": "img-1", "mime_type": "image/png", "byte_size": 3, "data": b"png",
    }
    with TestClient(_build_app(service)) as client:
        resp = client.get(f"/api/v1/acts/{ACT_ID}/images/img-1")

    assert resp.status_code == 200
    assert resp.content == b"png"
    assert resp.headers["content-type"] == "image/png"
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_get_downgrades_mime_outside_allowlist():
    """SVG в БД (как бы он там ни оказался) не отдаётся рендерящимся MIME.

    Картинка живёт на origin'е приложения — рендер SVG/HTML был бы XSS.
    """
    service = _service_mock()
    service.get.return_value = {
        "id": "img-1", "mime_type": "image/svg+xml", "byte_size": 3, "data": b"<svg",
    }
    with TestClient(_build_app(service)) as client:
        resp = client.get(f"/api/v1/acts/{ACT_ID}/images/img-1")

    assert resp.headers["content-type"] == "application/octet-stream"
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_get_webp_is_served_as_webp():
    """webp — в allowlist: фронт кодирует скриншоты в него."""
    service = _service_mock()
    service.get.return_value = {
        "id": "img-1", "mime_type": "image/webp", "byte_size": 3, "data": b"web",
    }
    with TestClient(_build_app(service)) as client:
        resp = client.get(f"/api/v1/acts/{ACT_ID}/images/img-1")
    assert resp.headers["content-type"] == "image/webp"


def test_get_missing_image_is_404():
    service = _service_mock()
    service.get.side_effect = ActImageNotFoundError("Изображение не найдено")
    with TestClient(_build_app(service)) as client:
        resp = client.get(f"/api/v1/acts/{ACT_ID}/images/нет-такой")
    assert resp.status_code == 404


def test_get_without_access_is_403():
    service = _service_mock()
    service.get.side_effect = AccessDeniedError("Нет доступа к акту")
    with TestClient(_build_app(service)) as client:
        resp = client.get(f"/api/v1/acts/{ACT_ID}/images/img-1")
    assert resp.status_code == 403


def test_get_passes_act_id_to_service():
    """Картинка адресуется парой (act_id, image_id) — чужой uuid не помогает."""
    service = _service_mock()
    service.get.return_value = {
        "id": "img-1", "mime_type": "image/png", "byte_size": 1, "data": b"1",
    }
    with TestClient(_build_app(service)) as client:
        client.get(f"/api/v1/acts/{ACT_ID}/images/img-1")
    service.get.assert_awaited_once_with(ACT_ID, "img-1", USERNAME)


# ── Маршрутизация в боевом наборе роутеров ─────────────────────────────────


def test_images_routes_registered_in_domain_routers():
    """Роутер картинок попадает в get_api_routers() под префиксом /acts."""
    from app.domains.acts.api import get_api_routers

    paths = {
        prefix + route.path
        for router, prefix, _tags in get_api_routers()
        for route in router.routes
    }
    assert "/acts/{act_id}/images" in paths
    assert "/acts/{act_id}/images/{image_id}" in paths
