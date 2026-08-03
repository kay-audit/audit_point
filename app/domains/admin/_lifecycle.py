"""Жизненный цикл домена администрирования."""

import logging

from fastapi import FastAPI

logger = logging.getLogger("audit_workstation.domains.admin.lifecycle")


def register_factories() -> None:
    """
    Регистрирует фабрики, экспортируемые admin-доменом для других доменов.

    Вызывается на этапе сборки DomainDescriptor (``_build_domain``) — это
    гарантирует, что фабрики доступны до старта lifespan'а потребителей.
    Идемпотентна: повторный вызов перезаписывает фабрики.
    """
    from app.core.domain_registry import register_factory
    from app.db.connection import get_db
    from app.domains.admin.repositories.user_avatars import UserAvatarRepository
    from app.domains.admin.services.user_directory import UserDirectoryRepository

    def _user_directory_factory():
        """Создаёт UserDirectoryRepository, оборачивая get_db() в async-генератор.

        Возвращает async-генератор — потребители используют его
        в FastAPI Depends или как ``async with`` через ``contextlib``.
        """
        async def _gen():
            async with get_db() as conn:
                yield UserDirectoryRepository(conn)
        return _gen()

    register_factory("admin.user_directory", _user_directory_factory)

    def _user_avatars_factory():
        """Создаёт UserAvatarRepository, оборачивая get_db() в async-генератор.

        Потребитель — слой авторизации (эндпоинты фото профиля): таблица
        живёт в admin-домене, а обращаются к ней снаружи, поэтому связь
        идёт через реестр фабрик, как и справочник пользователей.
        """
        async def _gen():
            async with get_db() as conn:
                yield UserAvatarRepository(conn)
        return _gen()

    register_factory("admin.user_avatars", _user_avatars_factory)

    def _http_metrics_service_factory():
        """Возвращает HttpMetricsService, если HTTP-метрики включены, иначе None.

        Инкапсулирует проверку ``admin.http_metrics_enabled``, чтобы core
        (``app/main.py``) не импортировал ``AdminSettings``/``admin.deps``
        напрямую — связь идёт через реестр фабрик.
        """
        from app.core.settings_registry import get as get_domain_settings
        from app.domains.admin.deps import get_http_metrics_service
        from app.domains.admin.settings import AdminSettings

        admin_settings = get_domain_settings("admin", AdminSettings)
        if not admin_settings.http_metrics_enabled:
            return None
        return get_http_metrics_service()

    register_factory("admin.http_metrics_service", _http_metrics_service_factory)

    def _access_denied_audit_factory():
        """Возвращает async-функцию записи отказа доступа в аудит admin.

        Инкапсулирует доступ к батчеру и тип ``AccessDeniedRecord``, чтобы core
        (``role_deps``) не импортировал admin напрямую. Функция возвращает
        ``True``, если запись передана батчеру (или попытка была), и ``False``,
        если батчер ещё не поднят — тогда core залогирует warning. Исключения
        самого батчера поглощаются: цель — не помешать 403-ответу.
        """
        from app.domains.admin.deps import get_access_denied_audit_batcher
        from app.domains.admin.repositories.access_denied_audit import (
            AccessDeniedRecord,
        )

        async def _record(
            *, username: str, domain: str, path: str, method: str, reason: str,
        ) -> bool:
            batcher = get_access_denied_audit_batcher()
            if batcher is None:
                return False
            try:
                await batcher.add(
                    AccessDeniedRecord(
                        username=username,
                        domain=domain,
                        path=path,
                        method=method,
                        reason=reason,
                    )
                )
            except Exception:
                logger.exception(
                    "Не удалось записать отказ доступа в аудит: username=%s domain=%s",
                    username, domain,
                )
            return True

        return _record

    register_factory("admin.access_denied_audit", _access_denied_audit_factory)


def register_lifespan_hooks() -> None:
    """
    Регистрирует startup/shutdown hooks admin-домена в общем lifespan-реестре.

    Вызывается на этапе сборки DomainDescriptor. Сам ``on_startup`` домена
    отрабатывает в общем цикле lifespan (через ``DomainDescriptor.on_startup``);
    здесь регистрируются дополнительные hooks для инфраструктурных задач
    (батчер HTTP-метрик).
    """
    from app.core.domain_registry import register_shutdown_hook, register_startup_hook
    from app.core.metrics_batcher import MetricsBatcher
    from app.core.observability_registry import (
        register_background_task,
        register_batcher,
        unregister_background_task,
        unregister_batcher,
    )
    from app.db.connection import get_db
    from app.domains.admin.deps import set_http_metrics_batcher
    from app.domains.admin.repositories.http_metrics_repository import (
        HttpMetricRecord,
        HttpMetricsRepository,
    )

    async def _start_http_metrics_batcher(app: FastAPI) -> None:
        """Поднимает батчер HTTP-метрик и кладёт его в deps + app.state."""
        from app.core.config import get_settings

        obs = get_settings().observability

        async def _flush(records: list[HttpMetricRecord]) -> None:
            async with get_db() as conn:
                await HttpMetricsRepository(conn).record_many(records)

        batcher = MetricsBatcher(
            flush_callback=_flush,
            max_batch_size=obs.metrics_batch_size,
            flush_interval_sec=obs.metrics_flush_interval_sec,
            max_buffer_size=obs.metrics_max_buffer_size,
            name="admin_http_metrics",
        )
        await batcher.start()
        set_http_metrics_batcher(batcher)
        app.state.http_metrics_batcher = batcher
        register_batcher("admin.http_metrics_batcher", batcher)

    async def _stop_http_metrics_batcher(app: FastAPI) -> None:
        """Останавливает батчер HTTP-метрик и сбрасывает ссылку в deps."""
        batcher = getattr(app.state, "http_metrics_batcher", None)
        unregister_batcher("admin.http_metrics_batcher")
        try:
            set_http_metrics_batcher(None)
        except Exception:
            logger.exception("Не удалось сбросить ссылку на батчер HTTP-метрик")
        if batcher is not None:
            try:
                await batcher.stop()
            except Exception:
                logger.exception("Ошибка при остановке батчера HTTP-метрик")

    register_startup_hook("admin.http_metrics_batcher", _start_http_metrics_batcher)
    register_shutdown_hook("admin.http_metrics_batcher", _stop_http_metrics_batcher)

    # Батчер аудита отказов доступа: переиспользует параметры observability
    # (batch_size / flush_interval / max_buffer) — поток событий маленький
    # (только 403), отдельные настройки не нужны.
    from app.domains.admin.deps import set_access_denied_audit_batcher
    from app.domains.admin.repositories.access_denied_audit import (
        AccessDeniedAuditRepository,
        AccessDeniedRecord,
    )

    async def _start_access_denied_audit_batcher(app: FastAPI) -> None:
        from app.core.config import get_settings

        obs = get_settings().observability

        async def _flush(records: list[AccessDeniedRecord]) -> None:
            async with get_db() as conn:
                await AccessDeniedAuditRepository(conn).log_many(records)

        batcher = MetricsBatcher(
            flush_callback=_flush,
            max_batch_size=obs.metrics_batch_size,
            flush_interval_sec=obs.metrics_flush_interval_sec,
            max_buffer_size=obs.metrics_max_buffer_size,
            name="admin_access_denied_audit",
        )
        await batcher.start()
        set_access_denied_audit_batcher(batcher)
        app.state.access_denied_audit_batcher = batcher
        register_batcher("admin.access_denied_audit_batcher", batcher)

    async def _stop_access_denied_audit_batcher(app: FastAPI) -> None:
        batcher = getattr(app.state, "access_denied_audit_batcher", None)
        unregister_batcher("admin.access_denied_audit_batcher")
        try:
            set_access_denied_audit_batcher(None)
        except Exception:
            logger.exception("Не удалось сбросить ссылку на батчер аудита отказов")
        if batcher is not None:
            try:
                await batcher.stop()
            except Exception:
                logger.exception("Ошибка при остановке батчера аудита отказов")

    register_startup_hook(
        "admin.access_denied_audit_batcher",
        _start_access_denied_audit_batcher,
    )
    register_shutdown_hook(
        "admin.access_denied_audit_batcher",
        _stop_access_denied_audit_batcher,
    )

    # Мониторинг asyncpg-пула: WARNING-лог, когда acquired >= warn_ratio×max.
    # Без БД-таблицы — только в логи (Loki/syslog построит алёрт).
    from app.core.settings_registry import get as get_domain_settings
    from app.domains.admin.services.db_pool_monitor import DbPoolMonitor
    from app.domains.admin.settings import AdminSettings

    async def _start_db_pool_monitor(app: FastAPI) -> None:
        admin_settings = get_domain_settings("admin", AdminSettings)
        if not admin_settings.db_pool_monitor.enabled:
            logger.info("db_pool_monitor выключен в настройках, пропуск старта")
            return
        monitor = DbPoolMonitor(
            check_interval_sec=admin_settings.db_pool_monitor.check_interval_sec,
            warn_ratio=admin_settings.db_pool_monitor.warn_ratio,
        )
        await monitor.start()
        app.state.db_pool_monitor = monitor
        register_background_task("admin.db_pool_monitor", monitor.get_status)

    async def _stop_db_pool_monitor(app: FastAPI) -> None:
        monitor = getattr(app.state, "db_pool_monitor", None)
        unregister_background_task("admin.db_pool_monitor")
        if monitor is not None:
            try:
                await monitor.stop()
            except Exception:
                logger.exception("Ошибка при остановке db_pool_monitor")

    register_startup_hook("admin.db_pool_monitor", _start_db_pool_monitor)
    register_shutdown_hook("admin.db_pool_monitor", _stop_db_pool_monitor)


async def on_startup(app: FastAPI) -> None:
    """
    Инициализация домена при старте приложения.

    Проверяет, заполнена ли таблица user_roles.
    Если пуста — заполняет начальными ролями из справочника пользователей.
    """
    from app.core.settings_registry import get as get_domain_settings
    from app.db.connection import get_db
    from app.domains.admin.services.admin_service import AdminService
    from app.domains.admin.settings import AdminSettings

    settings = get_domain_settings("admin", AdminSettings)

    try:
        async with get_db() as conn:
            service = AdminService(conn=conn, settings=settings)
            await service.seed_initial_roles(
                branch_filter=settings.user_directory.branch_filter,
                default_admin=settings.user_directory.default_admin,
            )
    except Exception:
        logger.exception("Ошибка начального заполнения ролей")
        # Не прерываем запуск приложения — роли можно назначить позже
