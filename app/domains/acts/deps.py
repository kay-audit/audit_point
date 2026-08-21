"""
DI-зависимости для сервисов актов.

Предоставляет get_*_service для использования в FastAPI Depends. Сервисы
строятся на исполнителе БД (``get_executor()``): соединение берётся из пула
на время одного SQL-вызова или одной явной транзакции, а не на весь
HTTP-запрос.
"""

from typing import TYPE_CHECKING

from fastapi import Depends

from app.core.config import get_settings, Settings
from app.core.settings_registry import get as get_domain_settings
from app.db.executor import get_executor
from app.domains.acts.repositories.act_access import ActAccessRepository
from app.domains.acts.repositories.act_audit_log import ActAuditLogRepository
from app.domains.acts.repositories.act_content_version import ActContentVersionRepository
from app.domains.acts.repositories.act_editor_telemetry import ActEditorTelemetryRepository
from app.domains.acts.repositories.act_lock import ActLockRepository
from app.domains.acts.services.access_guard import AccessGuard
from app.domains.acts.services.act_crud_service import ActCrudService
from app.domains.acts.services.act_lock_service import ActLockService
from app.domains.acts.services.act_content_service import ActContentService
from app.domains.acts.services.act_invoice_service import ActInvoiceService
from app.domains.acts.settings import ActsSettings
from app.domains.admin.interfaces import IUserDirectory

if TYPE_CHECKING:
    from app.domains.acts.services.act_image_service import ActImageService
    from app.domains.acts.services.audit_log_batcher import ActAuditLogBatcher
    from app.domains.acts.services.audit_log_service import AuditLogService

# Батчер аудит-лога актов. Инициализируется в lifespan
# (см. ``app/domains/acts/_lifecycle.py``). ``None`` — fallback на
# синхронный путь записи через одиночный INSERT.
_audit_log_batcher: "ActAuditLogBatcher | None" = None


def set_audit_log_batcher(batcher: "ActAuditLogBatcher | None") -> None:
    """Устанавливает (или сбрасывает) батчер audit-лога актов.

    Зовётся из lifespan-хуков домена актов.
    """
    global _audit_log_batcher
    _audit_log_batcher = batcher


def get_audit_log_batcher() -> "ActAuditLogBatcher | None":
    """Возвращает активный батчер audit-лога актов (или ``None``)."""
    return _audit_log_batcher


def _get_acts_settings() -> ActsSettings:
    from app.domains.acts import DOMAIN_NAME
    return get_domain_settings(DOMAIN_NAME, ActsSettings)


async def get_crud_service(settings: Settings = Depends(get_settings)) -> ActCrudService:
    """Создаёт ActCrudService на исполнителе БД (соединение на операцию)."""
    return ActCrudService(conn=get_executor(), settings=settings)


async def get_lock_service(settings: Settings = Depends(get_settings)) -> ActLockService:
    """Создаёт ActLockService на исполнителе БД."""
    return ActLockService(
        conn=get_executor(), settings=settings, acts_settings=_get_acts_settings()
    )


async def get_content_service(
    settings: Settings = Depends(get_settings),
) -> ActContentService:
    """Создаёт ActContentService на исполнителе БД."""
    return ActContentService(
        conn=get_executor(), settings=settings, acts_settings=_get_acts_settings()
    )


async def get_invoice_service(
    settings: Settings = Depends(get_settings),
) -> ActInvoiceService:
    """Создаёт ActInvoiceService на исполнителе БД.

    Имена таблиц фактур ua_data — через ``get_factory`` (без прямого импорта).
    """
    from app.core.domain_registry import get_factory

    return ActInvoiceService(
        conn=get_executor(),
        settings=settings,
        acts_settings=_get_acts_settings(),
        ua_tables=get_factory("ua_data.invoice_table_names")(),
    )


async def get_image_service() -> "ActImageService":
    """Создаёт ActImageService на исполнителе БД (соединение на операцию).

    Корневые Settings сервису не нужны — лимиты и allowlist картинок живут
    в доменных ACTS__IMAGES__*.
    """
    from app.domains.acts.services.act_image_service import ActImageService

    return ActImageService(conn=get_executor(), acts_settings=_get_acts_settings())


async def get_editor_telemetry_repo() -> ActEditorTelemetryRepository:
    """Создаёт репозиторий телеметрии редактора на исполнителе БД."""
    return ActEditorTelemetryRepository(get_executor())


async def get_audit_log_deps() -> tuple[AccessGuard, ActAuditLogRepository, ActContentVersionRepository]:
    """Создаёт зависимости аудит-лога: guard + репозитории (на исполнителе)."""
    ex = get_executor()
    access = ActAccessRepository(ex)
    lock = ActLockRepository()
    guard = AccessGuard(access, lock)
    return guard, ActAuditLogRepository(ex), ActContentVersionRepository(ex)


async def get_audit_log_service() -> "AuditLogService":
    """Создаёт AuditLogService на исполнителе БД (поверх ``get_audit_log_deps``)."""
    from app.domains.acts.services.audit_log_service import AuditLogService

    guard, audit_repo, versions_repo = await get_audit_log_deps()
    return AuditLogService(guard, audit_repo, versions_repo, get_executor())


async def get_users_repository() -> IUserDirectory:
    """Возвращает реализацию IUserDirectory из admin-домена через фабрику.

    Кросс-доменная связь — через ``domain_registry.get_factory(...)``,
    без прямого импорта класса репозитория.
    """
    from app.core.domain_registry import get_factory

    return get_factory("admin.user_directory")()
