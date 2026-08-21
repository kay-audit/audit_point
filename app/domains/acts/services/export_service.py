"""
Сервис экспорта актов в различные форматы.

Подтягивает metadata через ActCrudService и content через ActContentService,
передаёт в форматер как ExportContext (для DOCX) или dict (для txt/md).
"""

import asyncio
import gc
import logging
from typing import TYPE_CHECKING, Literal

from docx.exceptions import InvalidSpanError

from app.core.config import Settings
from app.core.exceptions import AppError
from app.domains.acts.exceptions import (
    ActExportValidationError,
    ActNotFoundError,
    UnsupportedFormatError,
)
from app.domains.acts.formatters.docx import DocxFormatter, ExportContext
from app.domains.acts.formatters.markdown_formatter import MarkdownFormatter
from app.domains.acts.formatters.text_formatter import TextFormatter
from app.domains.acts.repositories.act_image import ActImageRepository
from app.domains.acts.schemas.act_content import ActDataSchema, ActSaveResponse
from app.domains.acts.services.act_image_service import collect_image_ids
from app.domains.acts.services.storage_service import StorageService
from app.domains.acts.settings import ActsSettings
from app.domains.acts._lifecycle import get_format_thread_pool

if TYPE_CHECKING:
    from app.domains.acts.services.act_crud_service import ActCrudService
    from app.domains.acts.services.act_content_service import ActContentService

logger = logging.getLogger("audit_workstation.service.acts.export")


class ExportService:
    """
    Сервис экспорта актов.

    Подтягивает metadata и content из БД по act_id/username,
    форматирует через кэшированные форматеры и сохраняет через StorageService.
    """

    def __init__(
        self,
        storage: StorageService,
        settings: Settings,
        acts_settings: ActsSettings,
        act_crud_service: "ActCrudService | None" = None,
        act_content_service: "ActContentService | None" = None,
        image_repository: ActImageRepository | None = None,
    ):
        self.storage = storage
        self.settings = settings
        self.act_crud_service = act_crud_service
        self.act_content_service = act_content_service
        # Репозиторий картинок нарушений: байты подгружаются ОДНИМ запросом
        # ДО построения документа (форматеры крутятся в пуле потоков и в БД
        # не ходят). None — картинки уйдут плейсхолдерами (юнит-тесты).
        self.image_repository = image_repository

        # Кэшируем экземпляры форматеров (они stateless и thread-safe)
        self._formatters = {
            "txt": TextFormatter(settings, acts_settings),
            "md": MarkdownFormatter(settings, acts_settings),
            "docx": DocxFormatter(settings, acts_settings),
        }
        logger.debug("ExportService инициализирован с кэшированными форматерами")

    async def _load_images(self, act_id: int, content: ActDataSchema) -> dict:
        """Байты картинок нарушений акта одним запросом (``image_id → строка``).

        Соединение берётся ровно на один SELECT и отпускается: рендер
        документа идёт дальше без него. Репозиторий не задан (юнит-тесты) или
        картинок в акте нет — пустая карта, рендер уходит в плейсхолдеры.
        """
        if self.image_repository is None:
            return {}
        image_ids = collect_image_ids(content.violations)
        if not image_ids:
            return {}
        return await self.image_repository.get_many(act_id, image_ids)

    async def save_act(
        self,
        act_id: int,
        username: str,
        fmt: Literal["txt", "md", "docx"] = "docx",
    ) -> ActSaveResponse:
        """
        Асинхронно экспортирует акт в выбранный формат.

        Загружает metadata через ActCrudService.get_act и content через
        ActContentService.get_content, затем форматирует и сохраняет файл.

        Args:
            act_id: ID акта
            username: Имя пользователя (для проверки доступа)
            fmt: Формат файла ('txt', 'md' или 'docx')

        Returns:
            Результат операции с именем файла

        Raises:
            UnsupportedFormatError: Если указан неподдерживаемый формат
            ActNotFoundError: Если акт не найден
        """
        if fmt not in self._formatters:
            raise UnsupportedFormatError(
                f"Неподдерживаемый формат: {fmt}. "
                f"Используйте 'txt', 'md' или 'docx'."
            )

        formatted_content = None
        try:
            # Загружаем metadata и content из БД
            metadata = await self.act_crud_service.get_act(act_id, username)
            if metadata is None:
                raise ActNotFoundError(f"Акт {act_id} не найден")

            raw_content = await self.act_content_service.get_content(act_id, username)
            # ActContentService.get_content возвращает dict с лишними полями;
            # берём только те, которые нужны ActDataSchema
            content = ActDataSchema(
                tree=raw_content.get("tree", {}),
                tables=raw_content.get("tables", {}),
                textBlocks=raw_content.get("textBlocks", {}),
                violations=raw_content.get("violations", {}),
            )

            # Картинки нарушений — одним запросом до рендера (нет N+1 и нет
            # захвата соединения внутри форматера). TXT картинки не выводит,
            # поэтому байты ему не нужны.
            images = await self._load_images(act_id, content) if fmt != "txt" else {}

            loop = asyncio.get_running_loop()
            try:
                if fmt == "docx":
                    ctx = ExportContext(
                        metadata=metadata, content=content, images=images,
                    )
                    formatted_content = await loop.run_in_executor(
                        get_format_thread_pool(),
                        self._formatters["docx"].format,
                        ctx,
                    )
                else:
                    data_dict = content.model_dump(mode="python")
                    data_dict["metadata"] = metadata.model_dump(mode="python")
                    data_dict["images"] = images
                    formatted_content = await loop.run_in_executor(
                        get_format_thread_pool(),
                        self._formatters[fmt].format,
                        data_dict,
                    )
            except AppError:
                raise
            except InvalidSpanError as e:
                # Пересекающиеся / непрямоугольные объединения ячеек в таблице —
                # ошибка данных, а не баг. InvalidSpanError НЕ наследник
                # ValueError, поэтому ловим явно ПЕРЕД catch-all (иначе 500).
                logger.warning(f"Некорректные объединения ячеек при экспорте акта: {e}")
                raise ActExportValidationError(
                    "Не удалось экспортировать акт: в одной из таблиц объединения "
                    "ячеек пересекаются или образуют непрямоугольную область. "
                    "Исправьте структуру таблицы."
                ) from e
            except (MemoryError, ValueError, AttributeError, KeyError, TypeError) as e:
                logger.exception(f"Ошибка форматирования акта в формат {fmt}: {e}")
                raise AppError(f"Не удалось отформатировать акт в формат {fmt.upper()}") from e
            except Exception as e:
                logger.exception(f"Неожиданная ошибка форматирования акта в формат {fmt}: {e}")
                raise AppError(f"Не удалось отформатировать акт в формат {fmt.upper()}") from e

            try:
                if fmt == "docx":
                    filename = self.storage.save_docx(formatted_content, prefix="act")
                else:
                    filename = self.storage.save(
                        formatted_content,
                        prefix="act",
                        extension=fmt,
                    )
            except AppError:
                raise
            except (OSError, PermissionError, MemoryError) as e:
                logger.exception(f"Ошибка сохранения файла акта ({fmt}): {e}")
                raise AppError("Не удалось сохранить файл акта") from e
            except Exception as e:
                logger.exception(f"Неожиданная ошибка сохранения файла акта ({fmt}): {e}")
                raise AppError("Не удалось сохранить файл акта") from e

            return ActSaveResponse(
                status="success",
                message=f"Акт успешно сохранён в формате {fmt.upper()}",
                filename=filename,
            )
        finally:
            formatted_content = None
            gc.collect()
            logger.debug("Память очищена после сохранения акта")
