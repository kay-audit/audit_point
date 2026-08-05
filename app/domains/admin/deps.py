"""
DI-зависимости для сервисов администрирования.

Предоставляет get_admin_service для использования в FastAPI Depends.
Сервис строится на исполнителе БД (``get_executor()``): соединение берётся
из пула на время одного SQL-вызова или одной явной транзакции, а не на весь
HTTP-запрос.
"""

from app.core.settings_registry import get as get_domain_settings
from app.db.executor import get_executor
from app.domains.admin.services.admin_service import AdminService
from app.domains.admin.services.http_metrics_service import HttpMetricsService
from app.domains.admin.settings import AdminSettings


def _get_admin_settings() -> AdminSettings:
    return get_domain_settings("admin", AdminSettings)


async def get_admin_service() -> AdminService:
    """Создаёт AdminService на исполнителе БД (соединение на операцию)."""
    return AdminService(conn=get_executor(), settings=_get_admin_settings())


# Батчер HTTP-метрик — инициализируется в lifespan и подкладывается в сервис.
# None — fallback на синхронный путь (используется в тестах).
from app.core.metrics_batcher import MetricsBatcher
from app.domains.admin.repositories.access_denied_audit import (
    AccessDeniedRecord,
)
from app.domains.admin.repositories.http_metrics_repository import (
    HttpMetricRecord,
)

_http_metrics_batcher: MetricsBatcher[HttpMetricRecord] | None = None
_access_denied_audit_batcher: MetricsBatcher[AccessDeniedRecord] | None = None


def set_http_metrics_batcher(
    batcher: MetricsBatcher[HttpMetricRecord] | None,
) -> None:
    """Устанавливает (или сбрасывает) батчер HTTP-метрик. Зовётся из lifespan."""
    global _http_metrics_batcher
    _http_metrics_batcher = batcher


def get_http_metrics_batcher() -> MetricsBatcher[HttpMetricRecord] | None:
    """Возвращает активный батчер HTTP-метрик."""
    return _http_metrics_batcher


def set_access_denied_audit_batcher(
    batcher: MetricsBatcher[AccessDeniedRecord] | None,
) -> None:
    """Устанавливает (или сбрасывает) батчер аудита отказов. Зовётся из lifespan."""
    global _access_denied_audit_batcher
    _access_denied_audit_batcher = batcher


def get_access_denied_audit_batcher() -> MetricsBatcher[AccessDeniedRecord] | None:
    """Возвращает активный батчер аудита отказов доступа.

    Возвращает None, если батчер не поднят (например, в тестах).
    Потребители должны корректно обрабатывать этот случай.
    """
    return _access_denied_audit_batcher


def get_http_metrics_service() -> HttpMetricsService:
    """Возвращает сервис записи HTTP-метрик.

    Если в lifespan установлен батчер — запись идёт через него (отложенный
    bulk-INSERT). Иначе сервис открывает короткое соединение из пула на
    каждый ``record()`` (legacy-fallback для тестов).
    """
    return HttpMetricsService(batcher=_http_metrics_batcher)
