"""Инициализация и завершение инфраструктуры модуля auth."""

from __future__ import annotations

import logging

from fastapi import FastAPI

from app.auth.redis_adapter import RedisAdapter, RedisConfig

logger = logging.getLogger("audit_workstation.auth.lifecycle")

# Глобальная переменная для хранения адаптера Redis
_redis_adapter: RedisAdapter | None = None


def register_lifespan_hooks() -> None:
    """
    Регистрирует startup/shutdown hooks домена auth в общем реестре.

    Вызывается на этапе сборки DomainDescriptor (``_build_domain``).
    """
    from app.core.domain_registry import register_shutdown_hook, register_startup_hook

    async def _startup_auth(app: FastAPI) -> None:
        """Подключает Redis для OTP, если JWT-авторизация включена."""
        from app.core.config import get_settings
        settings = get_settings()
        if not settings.auth.enabled:
            logger.info("JWT-авторизация отключена (AUTH__ENABLED=false)")
            app.state.redis_adapter = None
            return

        redis_cfg = RedisConfig(
            host=settings.auth.redis.host,
            port=settings.auth.redis.port,
            db=settings.auth.redis.db,
            password=settings.auth.redis.password or "",
        )
        adapter = RedisAdapter(redis_cfg)
        try:
            await adapter.connect()
            app.state.redis_adapter = adapter
            global _redis_adapter
            _redis_adapter = adapter
            logger.info("Redis для auth подключён: %s:%s", redis_cfg.host, redis_cfg.port)
        except Exception as exc:
            logger.error("Не удалось подключиться к Redis для auth: %s", exc)
            raise RuntimeError(f"Redis недоступен для auth: {exc}") from exc

    async def _shutdown_auth(app: FastAPI) -> None:
        """Закрывает соединение с Redis."""
        global _redis_adapter
        adapter = getattr(app.state, "redis_adapter", None)
        if adapter is not None:
            try:
                await adapter.close()
            except Exception:
                logger.exception("Ошибка при закрытии Redis auth")
        _redis_adapter = None

    register_startup_hook("auth.redis", _startup_auth)
    register_shutdown_hook("auth.redis", _shutdown_auth)
