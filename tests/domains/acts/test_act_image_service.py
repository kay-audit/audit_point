"""Тесты ActImageService: права, валидация формата/размера, дедуп, MIME-политика.

Единственная точка серверной валидации картинок — загрузка. До выноса байт
в act_images её не было вовсе: лимиты жили только в браузере.
"""

import hashlib
import io
from unittest.mock import AsyncMock, MagicMock

import asyncpg
import pytest
from PIL import Image

from app.domains.acts.exceptions import (
    AccessDeniedError,
    ActImageNotFoundError,
    ActImageValidationError,
    ActLockError,
    InsufficientRightsError,
)
from app.domains.acts.services.act_image_service import (
    ActImageService,
    collect_image_ids,
)
from app.domains.acts.settings import ActsSettings, ImagesSettings

USERNAME = "12345"
ACT_ID = 7


def _image_bytes(fmt: str = "PNG", size=(4, 4)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (1, 2, 3)).save(buf, format=fmt)
    return buf.getvalue()


def _make_service(
    *, images_settings: ImagesSettings | None = None,
    can_edit: bool = True, has_access: bool = True, lock_owner: str | None = USERNAME,
    total_size: int = 0, existing_hash_id: str | None = None,
):
    """Сервис на моках репозиториев (реального соединения в тестах нет)."""
    access = MagicMock()
    access.get_user_edit_permission = AsyncMock(return_value={
        "has_access": has_access, "can_edit": can_edit, "role": "Редактор",
    })
    access.check_user_access = AsyncMock(return_value=has_access)

    lock = MagicMock()
    lock.get_lock_info = AsyncMock(return_value=(
        {"locked_by": lock_owner, "lock_expires_at": "2030-01-01"} if lock_owner else None
    ))

    images = MagicMock()
    images.total_size = AsyncMock(return_value=total_size)
    images.find_id_by_hash = AsyncMock(return_value=existing_hash_id)
    images.create = AsyncMock(return_value=None)
    images.get = AsyncMock(return_value=None)

    service = ActImageService(
        conn=MagicMock(),
        acts_settings=ActsSettings(images=images_settings or ImagesSettings()),
        access=access, lock=lock, images=images,
    )
    return service, images


# ── Права ──────────────────────────────────────────────────────────────────


async def test_upload_requires_access():
    service, images = _make_service(has_access=False)
    with pytest.raises(AccessDeniedError):
        await service.upload(ACT_ID, USERNAME, _image_bytes())
    images.create.assert_not_called()


async def test_upload_requires_edit_permission():
    """Роль «Участник» (только просмотр) картинку загрузить не может."""
    service, images = _make_service(can_edit=False)
    with pytest.raises(InsufficientRightsError):
        await service.upload(ACT_ID, USERNAME, _image_bytes())
    images.create.assert_not_called()


async def test_upload_requires_lock_ownership():
    """Лок держит другой — загрузка отбивается, бюджет акта не расходуется.

    Те же требования, что у PUT /content: писать в акт может только владелец
    активной блокировки.
    """
    service, images = _make_service(lock_owner="99999")
    with pytest.raises(ActLockError):
        await service.upload(ACT_ID, USERNAME, _image_bytes())
    images.create.assert_not_called()


async def test_get_requires_access():
    service, _ = _make_service(has_access=False)
    with pytest.raises(AccessDeniedError):
        await service.get(ACT_ID, "img-1", USERNAME)


async def test_get_missing_image_is_404():
    service, images = _make_service()
    images.get = AsyncMock(return_value=None)
    with pytest.raises(ActImageNotFoundError) as exc:
        await service.get(ACT_ID, "нет-такой", USERNAME)
    assert exc.value.status_code == 404


async def test_get_scopes_lookup_to_act():
    service, images = _make_service()
    images.get = AsyncMock(return_value={
        "id": "img-1", "mime_type": "image/png", "byte_size": 2, "data": b"ok",
    })
    result = await service.get(ACT_ID, "img-1", USERNAME)
    assert result["data"] == b"ok"
    images.get.assert_awaited_once_with(ACT_ID, "img-1")


# ── Валидация формата ──────────────────────────────────────────────────────


async def test_upload_rejects_non_image():
    """Не картинка — 422, даже если клиент прислал Content-Type: image/png."""
    service, images = _make_service()
    with pytest.raises(ActImageValidationError) as exc:
        await service.upload(ACT_ID, USERNAME, b"<html>not an image</html>")
    assert exc.value.status_code == 422
    images.create.assert_not_called()


async def test_upload_rejects_empty_file():
    service, _ = _make_service()
    with pytest.raises(ActImageValidationError, match="пустой"):
        await service.upload(ACT_ID, USERNAME, b"")


async def test_upload_rejects_format_outside_allowlist():
    """GIF вне allowlist настроек — отбивается, хотя Pillow его понимает."""
    service, _ = _make_service(images_settings=ImagesSettings(
        allowed_mime_types=["image/png"],
    ))
    with pytest.raises(ActImageValidationError, match="не поддерживается"):
        await service.upload(ACT_ID, USERNAME, _image_bytes("GIF"))


async def test_mime_is_detected_from_bytes_not_from_client():
    """MIME определяется по байтам: клиентский Content-Type не контракт.

    Сервис вообще не принимает заявленный тип — иначе HTML/SVG, названный
    image/png, лёг бы в БД и отдался браузеру с рендерящимся MIME.
    """
    service, images = _make_service()
    result = await service.upload(ACT_ID, USERNAME, _image_bytes("WEBP"))
    assert result["mime_type"] == "image/webp"
    assert images.create.call_args.kwargs["mime_type"] == "image/webp"


async def test_upload_returns_pixel_dimensions():
    """Фронту нужны реальные размеры — считаем их Pillow при загрузке."""
    service, _ = _make_service()
    result = await service.upload(ACT_ID, USERNAME, _image_bytes(size=(12, 5)))
    assert (result["width"], result["height"]) == (12, 5)


# ── Валидация размеров ─────────────────────────────────────────────────────


async def test_upload_rejects_file_over_limit():
    data = _image_bytes()
    service, images = _make_service(images_settings=ImagesSettings(
        max_file_size=len(data) - 1,
    ))
    with pytest.raises(ActImageValidationError, match="превышает"):
        await service.upload(ACT_ID, USERNAME, data)
    images.create.assert_not_called()


async def test_upload_rejects_when_act_budget_exhausted():
    """Бюджет акта считается запросом к act_images, а не обходом JSONB."""
    data = _image_bytes()
    service, images = _make_service(
        images_settings=ImagesSettings(max_total_size_per_act=len(data)),
        total_size=1,
    )
    with pytest.raises(ActImageValidationError, match="общий лимит"):
        await service.upload(ACT_ID, USERNAME, data)
    images.total_size.assert_awaited_once_with(ACT_ID)
    images.create.assert_not_called()


async def test_upload_fits_exactly_into_budget():
    """Ровно по границе бюджета — проходит (лимит не строгий «меньше»)."""
    data = _image_bytes()
    service, images = _make_service(
        images_settings=ImagesSettings(max_total_size_per_act=len(data)),
        total_size=0,
    )
    await service.upload(ACT_ID, USERNAME, data)
    images.create.assert_awaited_once()


# ── Дедуп ──────────────────────────────────────────────────────────────────


async def test_upload_deduplicates_by_hash_within_act():
    """Тот же файл в тот же акт — существующий id, новых байт не пишем."""
    data = _image_bytes()
    service, images = _make_service(existing_hash_id="img-old")

    result = await service.upload(ACT_ID, USERNAME, data)

    assert result["image_id"] == "img-old"
    images.create.assert_not_called()
    images.find_id_by_hash.assert_awaited_once_with(
        ACT_ID, hashlib.sha256(data).hexdigest(),
    )


async def test_upload_race_falls_back_to_existing_row():
    """Гонку двух загрузок одного файла разруливает UNIQUE + повторный поиск.

    ON CONFLICT на Greenplum недоступен, поэтому конкурента ловим по
    UniqueViolationError и переиспользуем его строку.
    """
    service, images = _make_service()
    images.create = AsyncMock(side_effect=asyncpg.UniqueViolationError("dup"))
    images.find_id_by_hash = AsyncMock(side_effect=[None, "img-konkurenta"])

    result = await service.upload(ACT_ID, USERNAME, _image_bytes())
    assert result["image_id"] == "img-konkurenta"


async def test_upload_reraises_unique_violation_without_winner():
    """UNIQUE упал, а строки по хэшу нет — это другой констрейнт, не глотаем."""
    service, images = _make_service()
    images.create = AsyncMock(side_effect=asyncpg.UniqueViolationError("dup"))
    images.find_id_by_hash = AsyncMock(return_value=None)

    with pytest.raises(asyncpg.UniqueViolationError):
        await service.upload(ACT_ID, USERNAME, _image_bytes())


# ── MIME-политика выдачи ───────────────────────────────────────────────────


def test_safe_mime_type_passes_allowlisted():
    service, _ = _make_service()
    assert service.safe_mime_type("image/png") == "image/png"
    assert service.safe_mime_type("image/webp") == "image/webp"


def test_safe_mime_type_downgrades_everything_else():
    """Вне allowlist — octet-stream: картинка рендерится в <img> на origin'е.

    SVG/HTML с рендерящимся MIME означал бы XSS в контексте приложения.
    """
    service, _ = _make_service()
    for mime in ("image/svg+xml", "text/html", "application/xhtml+xml", None, ""):
        assert service.safe_mime_type(mime) == "application/octet-stream"


# ── Сбор ссылок для предзагрузки экспорта ──────────────────────────────────


def test_collect_image_ids_reads_all_registry_fields():
    """Ссылки собираются по ВСЕМ 10 полям реестра, не только по доп. контенту."""
    violations = {
        "v1": {
            "violated": {"blocks": [{"type": "image", "image_id": "a"}]},
            "responsible": {"blocks": [{"type": "image", "image_id": "b"}]},
        },
        "v2": {
            "reasons": {"blocks": [
                {"type": "text", "content": "x"},
                {"type": "image", "image_id": "a"},
                {"type": "image", "image_id": ""},
            ]},
        },
    }
    assert collect_image_ids(violations) == {"a", "b"}


def test_collect_image_ids_handles_object_form():
    """Объектная форма (ViolationSchema) читается так же, как dict-снимок."""
    from app.domains.acts.schemas.act_content import ViolationSchema

    violation = ViolationSchema.model_validate({
        "id": "v1", "nodeId": "n1",
        "additionalContent": {"enabled": True, "blocks": [
            {"id": "b1", "type": "image", "image_id": "img-77"},
        ]},
    })
    assert collect_image_ids({"v1": violation}) == {"img-77"}


def test_collect_image_ids_empty_input():
    assert collect_image_ids(None) == set()
    assert collect_image_ids({}) == set()
