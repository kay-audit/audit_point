"""Инициализация и завершение инфраструктуры модуля auth."""

from __future__ import annotations

import logging

from fastapi import FastAPI

from app.core.redis import close_redis, init_redis

logger = logging.getLogger("audit_workstation.auth.lifecycle")


def register_lifespan_hooks() -> None:
    """
    Регистрирует startup/shutdown hooks модуля auth в общем реестре.

    Вызывается из create_app. Идемпотентна относительно самого реестра
    hooks (реестр — append-only, дубликаты исполнялись бы дважды): если
    "auth.redis" уже зарегистрирован — no-op. После
    domain_registry.reset_registry() (между сборками app в тестах) реестр
    пуст, и повторный вызов регистрирует hook заново — это ожидаемо.
    """
    from app.core.domain_registry import (
        has_startup_hook,
        register_shutdown_hook,
        register_startup_hook,
    )

    if has_startup_hook("auth.redis"):
        return

    async def _startup_auth(app: FastAPI) -> None:
        """Подключает Redis для OTP, если JWT-авторизация включена."""
        from app.core.config import get_settings
        settings = get_settings()
        if not settings.auth.enabled:
            logger.info("JWT-авторизация отключена (AUTH__ENABLED=false)")
            app.state.redis_adapter = None
            return

        # Адаптер живёт в модульном глобале app.core.redis (доступен фоновым
        # задачам без Request); в app.state дублируем ссылку — её читает
        # зависимость get_redis_adapter и подменяют тесты.
        try:
            app.state.redis_adapter = await init_redis(settings.redis)
        except Exception as exc:
            logger.error("Не удалось подключиться к Redis для auth: %s", exc)
            raise RuntimeError(f"Redis недоступен для auth: {exc}") from exc

    async def _shutdown_auth(app: FastAPI) -> None:
        """Закрывает соединение с Redis."""
        try:
            await close_redis()
        except Exception:
            logger.exception("Ошибка при закрытии Redis auth")
        app.state.redis_adapter = None

    register_startup_hook("auth.redis", _startup_auth)
    register_shutdown_hook("auth.redis", _shutdown_auth)
