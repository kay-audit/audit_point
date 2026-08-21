"""
API эндпоинты картинок нарушений.

Байты картинок живут в таблице ``act_images``, а блок-картинка нарушения
хранит только ``image_id``. Загрузка — multipart'ом сюда, отдача — по
``(act_id, image_id)``; и то, и другое проверяет доступ к акту той же
машинерией (``AccessGuard``), что и остальные операции домена.
"""

import logging

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import Response

from app.api.v1.deps.auth_deps import get_username
from app.domains.acts.deps import get_image_service
from app.domains.acts.exceptions import ActImageValidationError
from app.domains.acts.services.act_image_service import ActImageService
from app.schemas.errors import ErrorDetail

logger = logging.getLogger("audit_workstation.api.acts.images")

router = APIRouter()

# Размер куска чтения multipart-потока. Файл читается порциями, чтобы
# превышение лимита обрывало загрузку, а не поднимало в память весь payload.
_UPLOAD_CHUNK_BYTES = 256 * 1024


async def _read_upload_limited(upload: UploadFile, limit: int) -> bytes:
    """Читает файл кусками, обрываясь на превышении лимита размера."""
    chunks: list[bytes] = []
    total = 0
    while chunk := await upload.read(_UPLOAD_CHUNK_BYTES):
        total += len(chunk)
        if total > limit:
            raise ActImageValidationError(
                f"Размер изображения превышает допустимый "
                f"({limit / (1024 * 1024):.0f} МБ). Уменьшите изображение."
            )
        chunks.append(chunk)
    return b"".join(chunks)


@router.post(
    "/{act_id}/images",
    summary="Загрузить картинку нарушения",
    responses={
        403: {"description": "Нет прав на редактирование акта", "model": ErrorDetail},
        404: {"description": "Акт не найден", "model": ErrorDetail},
        409: {"description": "Акт заблокирован другим пользователем", "model": ErrorDetail},
        422: {"description": "Неподдерживаемый формат или превышен лимит", "model": ErrorDetail},
    },
)
async def upload_act_image(
    act_id: int,
    file: UploadFile = File(...),
    username: str = Depends(get_username),
    service: ActImageService = Depends(get_image_service),
) -> dict:
    """Принимает файл картинки и возвращает её дескриптор.

    MIME определяется по САМИМ БАЙТАМ (Pillow), а не по заголовку части
    multipart'а — заявленный клиентом тип не является контрактом.
    """
    limit = service.acts_settings.images.max_file_size
    data = await _read_upload_limited(file, limit)
    result = await service.upload(
        act_id, username, data, filename=file.filename or "",
    )
    logger.info(
        "Картинка %s загружена в акт id=%s пользователем %s",
        result["image_id"], act_id, username,
    )
    return result


@router.get(
    "/{act_id}/images/{image_id}",
    summary="Получить картинку нарушения",
    responses={
        403: {"description": "Нет доступа к акту", "model": ErrorDetail},
        404: {"description": "Картинка не найдена", "model": ErrorDetail},
    },
)
async def get_act_image(
    act_id: int,
    image_id: str,
    username: str = Depends(get_username),
    service: ActImageService = Depends(get_image_service),
) -> Response:
    """Отдаёт байты картинки акта.

    MIME — реальный, но ТОЛЬКО из allowlist ``ACTS__IMAGES__ALLOWED_MIME_TYPES``
    (иначе ``application/octet-stream``): картинка рендерится в ``<img src>``
    на origin'е приложения, и произвольный MIME означал бы XSS через
    загруженный SVG/HTML. ``X-Content-Type-Options: nosniff`` — всегда.

    Кэш — годовой и ``immutable``: содержимое адресуется идентификатором
    строки ``act_images`` и никогда не меняется (правка картинки на фронте
    порождает новую загрузку и новый ``image_id``).
    """
    image = await service.get(act_id, image_id, username)
    return Response(
        content=image["data"],
        media_type=service.safe_mime_type(image["mime_type"]),
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )
