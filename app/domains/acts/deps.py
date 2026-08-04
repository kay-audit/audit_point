"""
DI-зависимости для сервисов актов.

Предоставляет get_*_service для использования в FastAPI Depends,
оборачивая get_db() (asynccontextmanager) в async generator.
"""

from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING

from fastapi import Depends

from app.core.config import get_settings, Settings
from app.core.settings_registry import get as get_domain_settings
from app.db.connection import get_db
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
    from app.domains.acts.services.audit_log_batcher import ActAuditLogBatcher

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


async def get_crud_service(
    settings: Settings = Depends(get_settings),
) -> AsyncGenerator[ActCrudService, None]:
    """Создает ActCrudService с подключением из пула."""
    async with get_db() as conn:
        yield ActCrudService(conn=conn, settings=settings)


async def get_lock_service(
    settings: Settings = Depends(get_settings),
) -> AsyncGenerator[ActLockService, None]:
    """Создает ActLockService с подключением из пула."""
    async with get_db() as conn:
        yield ActLockService(conn=conn, settings=settings, acts_settings=_get_acts_settings())


async def get_content_service(
    settings: Settings = Depends(get_settings),
) -> AsyncGenerator[ActContentService, None]:
    """Создает ActContentService с подключением из пула."""
    async with get_db() as conn:
        yield ActContentService(conn=conn, settings=settings, acts_settings=_get_acts_settings())


async def get_invoice_service(
    settings: Settings = Depends(get_settings),
) -> AsyncGenerator[ActInvoiceService, None]:
    """Создает ActInvoiceService с подключением из пула.

    Имена таблиц фактур ua_data разрешаются через ``get_factory`` —
    зависимость идёт через ключ реестра, без прямого импорта helper'а
    ``make_invoice_table_names``.
    """
    from app.core.domain_registry import get_factory

    async with get_db() as conn:
        yield ActInvoiceService(
            conn=conn,
            settings=settings,
            acts_settings=_get_acts_settings(),
            ua_tables=get_factory("ua_data.invoice_table_names")(),
        )


async def get_editor_telemetry_repo() -> AsyncGenerator[ActEditorTelemetryRepository, None]:
    """Создаёт репозиторий телеметрии редактора с подключением из пула."""
    async with get_db() as conn:
        yield ActEditorTelemetryRepository(conn)


async def get_audit_log_deps() -> AsyncGenerator[tuple[AccessGuard, ActAuditLogRepository, ActContentVersionRepository], None]:
    """Создает зависимости для аудит-лога: guard + репозитории."""
    async with get_db() as conn:
        access = ActAccessRepository(conn)
        lock = ActLockRepository()
        guard = AccessGuard(access, lock)
        audit_repo = ActAuditLogRepository(conn)
        versions_repo = ActContentVersionRepository(conn)
        yield guard, audit_repo, versions_repo


async def get_audit_log_service() -> AsyncGenerator:
    """Создает AuditLogService с подключением из пула."""
    from app.domains.acts.services.audit_log_service import AuditLogService

    async with get_db() as conn:
        access = ActAccessRepository(conn)
        lock = ActLockRepository()
        guard = AccessGuard(access, lock)
        audit_repo = ActAuditLogRepository(conn)
        versions_repo = ActContentVersionRepository(conn)
        yield AuditLogService(guard, audit_repo, versions_repo, conn)


async def get_users_repository() -> AsyncGenerator[IUserDirectory, None]:
    """Возвращает реализацию IUserDirectory из admin-домена через фабрику.

    Кросс-доменная связь — через ``domain_registry.get_factory(...)``,
    без прямого импорта конкретного класса репозитория. Это сохраняет
    границу доменов и проходит через топосортировку discover_domains
    (admin регистрирует фабрику в _build_domain, до создания акт-сервисов).
    """
    from app.core.domain_registry import get_factory

    factory = get_factory("admin.user_directory")
    async for repo in factory():
        yield repo
