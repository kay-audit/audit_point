"""
Сервис картинок нарушений.

Единственная точка серверной валидации картинок: формат (allowlist MIME),
размер файла и суммарный бюджет акта проверяются здесь, на загрузке, а не
на каждом сохранении контента. Прежняя схема (data-URL внутри JSONB
``act_violations``) валидации размера на бэке не имела вовсе — лимиты жили
только в браузере.
"""

import hashlib
import io
import logging
import uuid

import asyncpg
from PIL import Image, UnidentifiedImageError

from app.db.types import DbConn
from app.domains.acts.exceptions import (
    ActImageNotFoundError,
    ActImageValidationError,
)
from app.domains.acts.repositories.act_access import ActAccessRepository
from app.domains.acts.repositories.act_image import ActImageRepository
from app.domains.acts.repositories.act_lock import ActLockRepository
from app.domains.acts.services.access_guard import AccessGuard
from app.domains.acts.settings import ActsSettings
from app.domains.acts.violation_fields import VIOLATION_FIELDS

logger = logging.getLogger("audit_workstation.service.acts.images")

# Формат, распознанный Pillow, → MIME. Источник истины «какой это на самом
# деле файл»: Content-Type из multipart'а приходит от клиента и подделывается
# тривиально, поэтому в БД пишется MIME, выведенный из САМИХ БАЙТ. Форматы вне
# таблицы отбиваются как неподдерживаемые ещё до сверки с allowlist настроек.
_PILLOW_FORMAT_TO_MIME = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "GIF": "image/gif",
    "WEBP": "image/webp",
}


def collect_image_ids(violations) -> set[str]:
    """Все ``image_id``, на которые ссылается словарь нарушений акта.

    Принимает как объектную форму (``{vid: ViolationSchema}``), так и
    dict-форму (снимок версии): читает поля реестра VIOLATION_FIELDS и берёт
    ``image_id`` у блоков ``type == 'image'``. Нужен экспорту — подгрузить
    ровно те картинки, которые реально встретятся в документе, ОДНИМ
    запросом до начала рендера.
    """
    ids: set[str] = set()
    for violation in (violations or {}).values():
        for field in VIOLATION_FIELDS:
            container = (
                violation.get(field.key) if isinstance(violation, dict)
                else getattr(violation, field.key, None)
            )
            blocks = (
                container.get("blocks") if isinstance(container, dict)
                else getattr(container, "blocks", None)
            )
            if not isinstance(blocks, list):
                continue
            for block in blocks:
                block_type = (
                    block.get("type") if isinstance(block, dict)
                    else getattr(block, "type", None)
                )
                if block_type != "image":
                    continue
                image_id = (
                    block.get("image_id") if isinstance(block, dict)
                    else getattr(block, "image_id", None)
                )
                if isinstance(image_id, str) and image_id:
                    ids.add(image_id)
    return ids


class ActImageService:
    """Загрузка и выдача картинок нарушений."""

    def __init__(
        self,
        conn: DbConn,
        acts_settings: ActsSettings,
        *,
        access: ActAccessRepository | None = None,
        lock: ActLockRepository | None = None,
        images: ActImageRepository | None = None,
    ):
        self.conn = conn
        self.acts_settings = acts_settings
        self._access = access or ActAccessRepository(conn)
        self._lock = lock or ActLockRepository()
        self._images = images or ActImageRepository(conn)
        self.guard = AccessGuard(self._access, self._lock)

    async def upload(
        self, act_id: int, username: str, data: bytes, *, filename: str = "",
    ) -> dict:
        """Загружает картинку в акт и возвращает её дескриптор.

        Права: редактирование акта И владение активной блокировкой — те же
        требования, что у ``PUT /content``. Без проверки блокировки любой
        участник с правом правки мог бы расходовать бюджет картинок акта,
        который держит в руках другой редактор.

        Дедупликация — по sha256 в пределах акта: повторная загрузка того же
        файла возвращает уже существующий ``image_id`` и новых байт не пишет
        (типичный сценарий — один и тот же скриншот в нескольких нарушениях).

        Returns:
            ``{image_id, byte_size, mime_type, width, height}``
        """
        await self.guard.require_edit_permission(act_id, username)
        await self.guard.require_lock_owner(act_id, username)

        mime_type, width, height = self._inspect(data)
        self._check_file_size(len(data))
        await self._check_act_budget(act_id, len(data))

        content_hash = hashlib.sha256(data).hexdigest()
        existing = await self._images.find_id_by_hash(act_id, content_hash)
        if existing:
            logger.debug(
                f"Картинка акта ID={act_id} дедуплицирована по хэшу: image_id={existing}"
            )
            return {
                "image_id": existing,
                "byte_size": len(data),
                "mime_type": mime_type,
                "width": width,
                "height": height,
            }

        image_id = str(uuid.uuid4())
        try:
            await self._images.create(
                act_id=act_id,
                image_id=image_id,
                content_hash=content_hash,
                mime_type=mime_type,
                byte_size=len(data),
                data=data,
                created_by=username,
            )
        except asyncpg.UniqueViolationError:
            # Гонка двух параллельных загрузок одного файла: UNIQUE
            # (act_id, content_hash) отдал победу конкуренту — переиспользуем
            # его строку. ON CONFLICT недоступен (Greenplum), поэтому развилка
            # именно такая.
            existing = await self._images.find_id_by_hash(act_id, content_hash)
            if not existing:
                raise
            image_id = existing

        logger.info(
            f"Загружена картинка акта ID={act_id}: image_id={image_id}, "
            f"{len(data)} байт, {mime_type}, файл '{filename}'"
        )
        return {
            "image_id": image_id,
            "byte_size": len(data),
            "mime_type": mime_type,
            "width": width,
            "height": height,
        }

    async def get(self, act_id: int, image_id: str, username: str) -> dict:
        """Байты картинки акта. Доступ — та же проверка, что у чтения акта."""
        await self.guard.require_access(act_id, username)

        image = await self._images.get(act_id, image_id)
        if image is None:
            raise ActImageNotFoundError("Изображение не найдено")
        return image

    def safe_mime_type(self, mime_type: str | None) -> str:
        """MIME для отдачи в ответе: реальный из allowlist, иначе octet-stream.

        Картинка рендерится в ``<img src>`` на origin'е приложения, поэтому
        отдать произвольный сохранённый MIME нельзя — SVG/HTML в нём означал
        бы XSS. Строка вне allowlist настроек превращается в
        ``application/octet-stream`` (браузер такой ответ не рендерит).
        Ответ всегда сопровождается ``X-Content-Type-Options: nosniff``.
        """
        if mime_type in self.acts_settings.images.allowed_mime_types:
            return mime_type
        logger.warning(
            f"MIME '{mime_type}' вне allowlist картинок — отдаём octet-stream"
        )
        return "application/octet-stream"

    # ------------------------------------------------------------------
    # ВАЛИДАЦИЯ
    # ------------------------------------------------------------------

    def _inspect(self, data: bytes) -> tuple[str, int, int]:
        """Определяет реальный формат и размеры картинки по её байтам.

        Returns:
            ``(mime_type, width, height)``

        Raises:
            ActImageValidationError: пустой файл, не картинка, либо формат
                вне allowlist ``ACTS__IMAGES__ALLOWED_MIME_TYPES``.
        """
        if not data:
            raise ActImageValidationError("Файл пустой — загружать нечего")

        try:
            with Image.open(io.BytesIO(data)) as img:
                pillow_format = img.format
                width, height = img.size
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise ActImageValidationError(
                "Файл не распознан как изображение. Допустимые форматы: "
                f"{self._allowed_labels()}."
            ) from exc

        mime_type = _PILLOW_FORMAT_TO_MIME.get(pillow_format or "")
        allowed = self.acts_settings.images.allowed_mime_types
        if mime_type is None or mime_type not in allowed:
            raise ActImageValidationError(
                f"Формат изображения не поддерживается. Допустимые форматы: "
                f"{self._allowed_labels()}."
            )
        return mime_type, int(width), int(height)

    def _check_file_size(self, size: int) -> None:
        """Проверяет размер одного файла по ACTS__IMAGES__MAX_FILE_SIZE."""
        limit = self.acts_settings.images.max_file_size
        if size > limit:
            raise ActImageValidationError(
                f"Размер изображения ({_mb(size)} МБ) превышает допустимый "
                f"({_mb(limit)} МБ). Уменьшите изображение."
            )

    async def _check_act_budget(self, act_id: int, size: int) -> None:
        """Проверяет суммарный вес картинок акта (с учётом загружаемой)."""
        limit = self.acts_settings.images.max_total_size_per_act
        used = await self._images.total_size(act_id)
        if used + size > limit:
            raise ActImageValidationError(
                f"Превышен общий лимит изображений акта ({_mb(limit)} МБ): "
                f"уже занято {_mb(used)} МБ. Удалите ненужные изображения."
            )

    def _allowed_labels(self) -> str:
        """Человекочитаемый список разрешённых форматов («png, jpeg, …»)."""
        labels = [
            mime.split("/", 1)[1]
            for mime in self.acts_settings.images.allowed_mime_types
            if "/" in mime
        ]
        return ", ".join(labels) or "нет"


def _mb(size: int) -> str:
    """Байты → строка с мегабайтами для пользовательских сообщений."""
    return f"{size / (1024 * 1024):.1f}".replace(".0", "")
