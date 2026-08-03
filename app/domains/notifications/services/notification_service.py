"""Сервис центра уведомлений."""

import logging
import uuid

import asyncpg

from app.core.redis import RedisAdapter, get_redis
from app.domains.notifications.repositories.notification_repository import (
    NotificationRepository,
)

logger = logging.getLogger("audit_workstation.domains.notifications.service")


class NotificationService:
    """Бизнес-логика центра уведомлений.

    Тонкая обёртка над репозиторием: делегирует выборки/пометки и генерирует
    id при создании уведомления (``push``). Принимает соединение из пула.

    ``unread_summary`` дополнительно кэшируется в Redis (частый поллинг бейджа
    с фронта). Рантайм-сбой Redis — предупреждение в лог и честный SQL-путь,
    наружу не пробрасывается: деградация кэша не должна ронять бейдж.
    """

    # broadcast-push не знает адресатов поштучно, поэтому вместо перебора ключей
    # инвалидируется целая эпоха: INCR меняет v{epoch} в ключе, старые ключи
    # перестают читаться и просто умирают по TTL.
    _EPOCH_KEY = "cache:notif:epoch"
    _UNREAD_KEY_PREFIX = "cache:notif:unread:"
    _UNREAD_TTL_SEC = 600

    def __init__(self, conn: asyncpg.Connection):
        self.conn = conn
        self.repo = NotificationRepository(conn)

    async def list_for_user(self, user_id: str, *, limit: int = 50) -> list[dict]:
        """Возвращает видимые пользователю уведомления (адресные + broadcast)."""
        return await self.repo.list_for_user(user_id, limit=limit)

    async def unread_summary(self, user_id: str) -> dict:
        """Число непрочитанных видимых уведомлений и их максимальная критичность.

        Возвращает ``{"count": int, "severity": "error"|"warning"|"info"|None}``.
        Читает через Redis (TTL 10 минут); промах или недоступность кэша — считает
        по БД (и, при доступном Redis, сохраняет результат на следующий раз).
        """
        redis = get_redis()
        try:
            key = await self._unread_cache_key(redis, user_id)
            cached = await redis.get_json(key)
        except Exception as e:
            logger.warning("Redis недоступен при чтении unread-кэша: %s", e)
            return await self.repo.unread_summary(user_id)

        if cached is not None:
            return cached

        result = await self.repo.unread_summary(user_id)
        try:
            await redis.set_json(key, result, ex=self._UNREAD_TTL_SEC)
        except Exception as e:
            logger.warning("Redis недоступен при записи unread-кэша: %s", e)
        return result

    async def mark_read(self, notification_id: str, user_id: str) -> None:
        """Помечает уведомление прочитанным."""
        await self.repo.mark_read(notification_id, user_id)
        await self._invalidate_unread_cache(user_id)

    async def mark_unread(self, notification_id: str, user_id: str) -> None:
        """Возвращает уведомление в непрочитанное."""
        await self.repo.mark_unread(notification_id, user_id)
        await self._invalidate_unread_cache(user_id)

    async def mark_all_read(self, user_id: str) -> None:
        """Помечает все видимые уведомления пользователя прочитанными."""
        await self.repo.mark_all_read(user_id)
        await self._invalidate_unread_cache(user_id)

    async def dismiss(self, notification_id: str, user_id: str) -> None:
        """Скрывает уведомление для пользователя."""
        await self.repo.dismiss(notification_id, user_id)
        await self._invalidate_unread_cache(user_id)

    async def push(
        self,
        *,
        source: str,
        title: str,
        severity: str = "info",
        body: str | None = None,
        link: str | None = None,
        element_ref: str | None = None,
        recipient_user_id: str | None = None,
        created_by: str = "system",
    ) -> str:
        """Создаёт уведомление и возвращает его id.

        ``recipient_user_id=None`` → broadcast всем. id генерится здесь
        (``str(uuid.uuid4())``); ``created_by`` по умолчанию ``'system'``
        (продьюсеры передают свой источник, API — текущий username).
        """
        notification_id = await self.repo.create(
            id=str(uuid.uuid4()),
            source=source,
            title=title,
            severity=severity,
            body=body,
            link=link,
            element_ref=element_ref,
            recipient_user_id=recipient_user_id,
            created_by=created_by,
        )
        await self._invalidate_after_push(recipient_user_id)
        return notification_id

    async def _unread_cache_key(self, redis: RedisAdapter, user_id: str) -> str:
        """Ключ unread-агрегата пользователя в текущей эпохе broadcast-инвалидации."""
        epoch = await redis.get(self._EPOCH_KEY) or "0"
        return f"{self._UNREAD_KEY_PREFIX}{user_id}:v{epoch}"

    async def _invalidate_unread_cache(self, user_id: str) -> None:
        """DEL кэш-ключа пользователя — адресная инвалидация после его мутации."""
        redis = get_redis()
        try:
            key = await self._unread_cache_key(redis, user_id)
            await redis.delete(key)
        except Exception as e:
            logger.warning("Redis недоступен при инвалидации unread-кэша: %s", e)

    async def _invalidate_after_push(self, recipient_user_id: str | None) -> None:
        """Адресный push — DEL ключа получателя; broadcast — INCR эпохи целиком."""
        redis = get_redis()
        try:
            if recipient_user_id is not None:
                key = await self._unread_cache_key(redis, recipient_user_id)
                await redis.delete(key)
            else:
                await redis.incr(self._EPOCH_KEY)
        except Exception as e:
            logger.warning("Redis недоступен при инвалидации после push: %s", e)
