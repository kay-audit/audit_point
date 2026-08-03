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

    # Обе инвалидации — INCR эпохи, а не DEL ключа: сброс перебором ключей для
    # broadcast'а недопустим (сотни адресатов), а DEL адресного ключа проигрывал
    # бы гонку — запрос, начавший считать агрегат до сброса, дописал бы
    # устаревшее число уже после него, и оно жило бы весь TTL.
    # Глобальная эпоха обесценивает ключи всех пользователей (broadcast-push),
    # персональная — только своего (его собственные мутации). Сами эпохи живут
    # без TTL: истеки они — счётчик вернулся бы к «0» при ещё живых ключах
    # старых эпох, и чтения снова увидели бы устаревшее число.
    _EPOCH_KEY = "cache:notif:epoch"
    _USER_EPOCH_KEY_PREFIX = "cache:notif:uver:"
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
        """Ключ unread-агрегата пользователя в текущих эпохах — общей и своей.

        Обе эпохи забираются одним MGET (имена ключей известны заранее);
        отсутствующая эпоха — «0». Ключ обязан фиксироваться ДО подсчёта по
        БД: тогда параллельный INCR уводит запоздавшую запись в ключ прошлой
        эпохи, который больше никто не читает и который умрёт по TTL.
        """
        epoch, user_epoch = await redis.mget(
            [self._EPOCH_KEY, f"{self._USER_EPOCH_KEY_PREFIX}{user_id}"]
        )
        return (
            f"{self._UNREAD_KEY_PREFIX}{user_id}"
            f":v{epoch or '0'}:u{user_epoch or '0'}"
        )

    async def _invalidate_unread_cache(self, user_id: str) -> None:
        """INCR персональной эпохи — адресная инвалидация после мутации юзера."""
        redis = get_redis()
        try:
            await redis.incr(f"{self._USER_EPOCH_KEY_PREFIX}{user_id}")
        except Exception as e:
            logger.warning("Redis недоступен при инвалидации unread-кэша: %s", e)

    async def _invalidate_after_push(self, recipient_user_id: str | None) -> None:
        """Адресный push — эпоха получателя; broadcast — общая эпоха целиком."""
        if recipient_user_id is not None:
            await self._invalidate_unread_cache(recipient_user_id)
            return

        redis = get_redis()
        try:
            await redis.incr(self._EPOCH_KEY)
        except Exception as e:
            logger.warning("Redis недоступен при инвалидации после push: %s", e)
