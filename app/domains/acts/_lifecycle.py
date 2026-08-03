"""Жизненный цикл домена актов."""

import logging
import os
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI

logger = logging.getLogger("audit_workstation.domains.acts.lifecycle")


def register_lifespan_hooks() -> None:
    """
    Регистрирует startup/shutdown hooks домена актов в общем реестре.

    Вызывается на этапе сборки DomainDescriptor (``_build_domain``).
    На данный момент регистрирует:

    * ``acts.audit_log_batcher`` — батчер пакетной записи аудит-лога
      (Wave 2: снижение нагрузки на GP — десятки операций пользователя
      в минуту → один bulk-INSERT раз в 30 сек или при наборе 50 записей).
    """
    from app.core.domain_registry import register_shutdown_hook, register_startup_hook
    from app.core.observability_registry import register_batcher, unregister_batcher
    from app.domains.acts.deps import set_audit_log_batcher
    from app.domains.acts.services.audit_log_batcher import ActAuditLogBatcher

    async def _start_audit_log_batcher(app: FastAPI) -> None:
        """Поднимает батчер аудит-лога и кладёт его в deps + app.state."""
        batcher = ActAuditLogBatcher(
            batch_size=50,
            flush_interval_sec=30.0,
        )
        await batcher.start()
        set_audit_log_batcher(batcher)
        app.state.acts_audit_log_batcher = batcher
        register_batcher("acts.audit_log_batcher", batcher)
        logger.info("Батчер аудит-лога актов запущен")

    async def _stop_audit_log_batcher(app: FastAPI) -> None:
        """Останавливает батчер аудит-лога с финальным flush'ем."""
        batcher = getattr(app.state, "acts_audit_log_batcher", None)
        unregister_batcher("acts.audit_log_batcher")
        try:
            set_audit_log_batcher(None)
        except Exception:
            logger.exception(
                "Не удалось сбросить ссылку на батчер аудит-лога актов",
            )
        if batcher is not None:
            try:
                await batcher.stop()
            except Exception:
                logger.exception("Ошибка при остановке батчера аудит-лога актов")

    register_startup_hook("acts.audit_log_batcher", _start_audit_log_batcher)
    register_shutdown_hook("acts.audit_log_batcher", _stop_audit_log_batcher)


def get_executor() -> ThreadPoolExecutor:
    """Возвращает ThreadPoolExecutor домена актов.

    Каноническое хранилище — app.state.executor; этот геттер обращается
    к нему через публичный атрибут FastAPI-приложения.
    Для обратной совместимости (тесты, прямые вызовы) ищет сначала
    в app.state, затем в module-level _executor.
    """
    executor: ThreadPoolExecutor | None = _executor
    if executor is None:
        raise RuntimeError("ThreadPoolExecutor не инициализирован — приложение не запущено")
    return executor


async def on_startup(app: FastAPI) -> None:
    """Инициализация ресурсов домена актов."""
    global _executor
    max_workers = os.cpu_count() or 4
    app.state.executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="act_formatter")
    # Сохраняем ссылку на один и тот же объект — app.state является
    # каноническим владельцем; _executor — удобный геттер без Request.
    _executor = app.state.executor
    logger.info(f"ThreadPoolExecutor домена актов запущен (workers={max_workers})")


async def on_shutdown(app: FastAPI) -> None:
    """Корректное завершение ресурсов домена актов."""
    global _executor
    executor: ThreadPoolExecutor | None = getattr(app.state, "executor", None)
    if executor is not None:
        executor.shutdown(wait=True, cancel_futures=False)
        app.state.executor = None
        _executor = None
        logger.info("ThreadPoolExecutor домена актов корректно закрыт")


# Модульная ссылка — указывает на тот же объект, что и app.state.executor.
# Обновляется lifecycle-хуками; не использовать напрямую вне get_executor().
_executor: ThreadPoolExecutor | None = None
