"""
Эндпоинты для работы с актами.

Предоставляет HTTP API для сохранения актов в различных форматах
и скачивания сохраненных файлов.
"""

import asyncio
import logging
import threading
from typing import Literal

from fastapi import APIRouter, Query, HTTPException, Depends
from fastapi.responses import FileResponse

from app.api.v1.deps.auth_deps import get_username
from app.core.config import get_settings, Settings
from app.core.exceptions import AppError
from app.db.connection import get_db
from app.db.executor import get_executor
from app.domains.acts.deps import _get_acts_settings, get_crud_service, get_content_service
from app.domains.acts.exceptions import ActExportTimeoutError
from app.domains.acts.repositories.act_access import ActAccessRepository
from app.domains.acts.repositories.act_audit_log import ActAuditLogRepository
from app.domains.acts.repositories.act_image import ActImageRepository
from app.domains.acts.settings import ActsSettings
from app.domains.acts.schemas.act_content import ActSaveResponse
from app.domains.acts.services.act_content_service import ActContentService
from app.domains.acts.services.act_crud_service import ActCrudService
from app.domains.acts.services.export_service import ExportService
from app.domains.acts.services.notifications_producer import emit_act_notification
from app.domains.acts.services.storage_service import StorageService
from app.schemas.errors import ErrorDetail

logger = logging.getLogger("audit_workstation.api.export")
router = APIRouter()

_download_semaphore: asyncio.Semaphore | None = None
# Лок первой инициализации семафора: в одном event loop'е между проверкой и
# присваиванием нет await, но двойная проверка под локом исключает создание
# двух семафоров и при обращении из других потоков (ebe-6).
_download_semaphore_init_lock = threading.Lock()


def _get_download_semaphore(acts_cfg: ActsSettings) -> asyncio.Semaphore:
    """Возвращает per-worker семафор для ограничения файловых операций."""
    global _download_semaphore
    if _download_semaphore is None:
        with _download_semaphore_init_lock:
            if _download_semaphore is None:
                _download_semaphore = asyncio.Semaphore(
                    acts_cfg.resource.max_concurrent_file_operations
                )
                logger.info(f"File semaphore создан для worker: {acts_cfg.resource.max_concurrent_file_operations}")
    return _download_semaphore


def get_storage_service(settings: Settings = Depends(get_settings)) -> StorageService:
    """Создает экземпляр StorageService для dependency injection."""
    return StorageService(storage_dir=settings.storage_dir)


def get_act_service(
        storage: StorageService = Depends(get_storage_service),
        settings: Settings = Depends(get_settings),
        acts_settings: ActsSettings = Depends(_get_acts_settings),
        act_crud_service: ActCrudService = Depends(get_crud_service),
        act_content_service: ActContentService = Depends(get_content_service),
) -> ExportService:
    """Создает экземпляр ExportService для dependency injection."""
    return ExportService(
        storage=storage,
        settings=settings,
        acts_settings=acts_settings,
        act_crud_service=act_crud_service,
        act_content_service=act_content_service,
        # Байты картинок нарушений: репозиторий на исполнителе — соединение
        # берётся на один SELECT предзагрузки, а не на весь экспорт.
        image_repository=ActImageRepository(get_executor()),
    )


@router.post(
    "/save-act",
    response_model=ActSaveResponse,
    responses={
        400: {"description": "Неподдерживаемый формат или акт не найден", "model": ErrorDetail},
        408: {"description": "Таймаут обработки акта", "model": ErrorDetail},
        422: {"description": "Ошибка валидации входных данных"},
        500: {"description": "Внутренняя ошибка при сохранении", "model": ErrorDetail},
    },
)
async def save_act(
        act_id: int = Query(..., description="ID акта"),
        fmt: Literal["txt", "md", "docx"] = Query(
            "docx",
            description="Формат сохранения файла"
        ),
        username: str = Depends(get_username),
        act_service: ExportService = Depends(get_act_service),
        storage: StorageService = Depends(get_storage_service),
        acts_cfg: ActsSettings = Depends(_get_acts_settings),
) -> ActSaveResponse:
    """
    Экспортирует акт в указанном формате.

    Читает metadata и content из БД по act_id. Перед вызовом этого
    эндпоинта фронт должен синхронизировать содержимое через POST /save-content.

    Args:
        act_id: ID акта (обязательный)
        fmt: Формат экспорта — 'txt', 'md' или 'docx'
        username: Имя пользователя (из авторизации)
        act_service: Сервис экспорта (injected)
        storage: Сервис хранения файлов (injected)
        acts_cfg: Доменные настройки актов (injected)

    Returns:
        Результат операции с именем сохраненного файла

    Raises:
        HTTPException: При ошибках (400 — формат/акт, 408 — timeout, 500 — ошибка)
    """
    try:
        logger.info(f"Запрос на сохранение акта {act_id} в формате {fmt}")

        try:
            result = await asyncio.wait_for(
                act_service.save_act(act_id, username, fmt=fmt),
                timeout=acts_cfg.resource.save_act_timeout
            )
        except asyncio.TimeoutError:
            logger.error(f"Timeout при сохранении акта (>{acts_cfg.resource.save_act_timeout}s)")
            raise ActExportTimeoutError(
                f"Обработка акта заняла слишком много времени "
                f"(>{acts_cfg.resource.save_act_timeout}s). Попробуйте позже."
            )

        logger.info(f"Акт {act_id} сохранён: {result.filename}")

        # Регистрируем связь файла с актом для контроля доступа при скачивании
        storage.register_file(result.filename, act_id)

        # Аудит-лог экспорта
        try:
            async with get_db() as audit_conn:
                audit = ActAuditLogRepository(audit_conn)
                await audit.log("export", username, act_id, {
                    "format": fmt,
                    "filename": result.filename,
                })
        except Exception:
            logger.exception("Не удалось записать аудит-лог экспорта")

        # Уведомление о завершённом экспорте — адресно текущему пользователю.
        # Эмитим только после успеха; сбой/отсутствие notifications не ломает
        # экспорт (вся логика в emit_act_notification обёрнута в try/except).
        await emit_act_notification(
            title=f"Акт сохранён в формате {fmt.upper()}",
            severity="success",
            link=f"/constructor?act_id={act_id}",
            recipient_user_id=username,
        )

        return result

    except AppError:
        raise
    except Exception as e:
        logger.exception(f"Неожиданная ошибка при сохранении акта: {e}")
        raise AppError("Произошла ошибка при сохранении акта. Попробуйте позже.") from e


@router.get(
    "/download/{filename}",
    responses={
        400: {"description": "Некорректное имя файла", "model": ErrorDetail},
        403: {"description": "Нет доступа к файлу", "model": ErrorDetail},
        404: {"description": "Файл не найден", "model": ErrorDetail},
        500: {"description": "Ошибка при скачивании файла", "model": ErrorDetail},
    },
)
async def download_act(
        filename: str,
        username: str = Depends(get_username),
        storage: StorageService = Depends(get_storage_service),
        settings: Settings = Depends(get_settings),
        acts_cfg: ActsSettings = Depends(_get_acts_settings),
) -> FileResponse:
    """
    Скачивает сохраненный файл акта.

    Проверяет авторизацию пользователя и его доступ к акту,
    которому принадлежит файл. Использует per-worker semaphore
    для ограничения одновременных файловых операций.

    Args:
        filename: Имя файла для скачивания
        username: Имя пользователя (из авторизации)
        storage: Сервис хранения (injected)
        settings: Настройки приложения (injected)
        acts_cfg: Доменные настройки актов (injected)

    Returns:
        Файл для скачивания с корректным MIME-типом

    Raises:
        HTTPException: 401 без авторизации, 403 нет доступа,
            400 небезопасное имя, 404 файл не найден
    """
    async with _get_download_semaphore(acts_cfg):
        try:
            logger.info(f"Запрос на скачивание файла: {filename} от пользователя {username}")

            # Валидация и получение безопасного пути
            file_path = storage.get_file_path(filename)
            if file_path is None:
                is_valid = storage.validate_filename(filename)
                status_code = 400 if not is_valid else 404
                detail = "Некорректное имя файла" if not is_valid else "Файл не найден"
                logger.warning(f"Отказ в доступе к файлу: {filename} (код: {status_code})")
                raise HTTPException(status_code=status_code, detail=detail)

            # Проверка доступа пользователя к акту, которому принадлежит файл
            act_id = storage.get_act_id_for_file(filename)
            if act_id is not None:
                async with get_db() as conn:
                    access_repo = ActAccessRepository(conn)
                    has_access = await access_repo.check_user_access(act_id, username)
                    if not has_access:
                        logger.warning(
                            f"Отказ в скачивании файла {filename}: "
                            f"пользователь {username} не имеет доступа к акту {act_id}"
                        )
                        raise HTTPException(
                            status_code=403,
                            detail="Нет доступа к файлу"
                        )

                    # Аудит-лог скачивания
                    audit = ActAuditLogRepository(conn)
                    await audit.log("download", username, act_id, {
                        "filename": filename,
                    })

            # Определяем MIME-тип по расширению файла
            mime_types = {
                ".txt": "text/plain",
                ".md": "text/markdown",
                ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            }
            media_type = mime_types.get(
                file_path.suffix,
                "application/octet-stream"
            )

            logger.info(f"Файл {filename} отправлен на скачивание пользователю {username}")

            # Возвращаем файл для скачивания
            return FileResponse(
                path=file_path,
                media_type=media_type,
                filename=filename
            )
        except AppError:
            raise
        except Exception as e:
            logger.exception(f"Ошибка при скачивании файла {filename}: {e}")
            raise AppError("Произошла ошибка при скачивании файла") from e
