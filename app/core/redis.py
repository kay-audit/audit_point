"""Асинхронный адаптер Redis — общая инфраструктура приложения.

Redis перестал быть auth-специфичным: помимо OTP-кодов и лимитов на нём живут
кэши (уведомления, роли, user-контекст) и локи актов, в том числе в фоновых
задачах, у которых нет HTTP-Request. Поэтому адаптер доступен двумя путями:

* FastAPI-зависимость ``app.auth.dependencies.get_redis_adapter`` — для
  эндпоинтов (позволяет подменить адаптер через ``app.state`` в тестах);
* модульный ``get_redis()`` — для кода без Request, по образцу пула БД в
  ``app/db/connection.py``.

Redis **обязателен во всех окружениях** — ПРОМ, DEV, pytest, Playwright — и
поднимается на старте безусловно, независимо от ``auth.enabled``. Ветки «а если
Redis нет» в потребителях не нужны: без него приложение не стартует
(fail-fast в startup-хуке). Обрабатывается только РАНТАЙМ-сбой уже работающего
Redis, и это авария, а не режим работы: кэши деградируют в сквозной SQL, а
мутации локов актов падают наружу — см. докстринг :class:`RedisAdapter`.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Self

import redis.asyncio as aioredis

from app.core.config import RedisSettings

logger = logging.getLogger("audit_workstation.core.redis")


class RedisAdapter:
    """Асинхронный клиент Redis с ленивым подключением.

    Методы — тонкие обёртки без внутреннего try/except (исключение —
    ``ping``): ошибки redis-py пробрасываются наверх, политику деградации
    выбирает потребитель. Кэш может молча продолжить работу мимо Redis, а
    лок обязан упасть — общего правила здесь нет.
    """

    def __init__(self, settings: RedisSettings) -> None:
        self._settings = settings
        self._client: aioredis.Redis | None = None

    async def connect(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        self._client = aioredis.Redis(
            host=self._settings.host,
            port=self._settings.port,
            db=self._settings.db,
            # Пустой пароль означает «без авторизации», а не пароль ""
            password=self._settings.password.get_secret_value() or None,
            # Весь код работает со str, bytes не ожидает нигде
            decode_responses=True,
            max_connections=self._settings.max_connections,
            socket_timeout=self._settings.socket_timeout,
        )
        await self._client.ping()
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def get(self, key: str) -> str | None:
        client = await self._get_client()
        return await client.get(key)

    async def set(
        self,
        key: str,
        value: str,
        *,
        ex: int | None = None,
        px: int | None = None,
        nx: bool = False,
    ) -> bool:
        """Записывает значение с TTL в секундах (``ex``) или миллисекундах (``px``).

        ``nx=True`` — записать только если ключа ещё нет (основа захвата лока).
        redis-py в этом случае возвращает None вместо False — нормализуем.
        """
        client = await self._get_client()
        result = await client.set(key, value, ex=ex, px=px, nx=nx)
        return bool(result)

    async def delete(self, *keys: str) -> int:
        client = await self._get_client()
        return await client.delete(*keys)

    async def mget(self, keys: list[str]) -> list[str | None]:
        """Значения нескольких ключей одним запросом; отсутствующие — None.

        Пустой список отдаёт пустой результат без похода в Redis: MGET без
        аргументов — синтаксическая ошибка на стороне сервера.
        """
        if not keys:
            return []
        client = await self._get_client()
        return await client.mget(keys)

    async def incr(self, key: str) -> int:
        client = await self._get_client()
        return await client.incr(key)

    async def expire(self, key: str, seconds: int) -> bool:
        client = await self._get_client()
        result = await client.expire(key, seconds)
        return bool(result)

    async def ttl(self, key: str) -> int:
        """Остаток жизни ключа в секундах: -1 — ключ без TTL, -2 — ключа нет."""
        client = await self._get_client()
        return await client.ttl(key)

    async def eval(self, script: str, keys: list[str], args: list) -> Any:
        """Выполняет Lua-скрипт атомарно.

        Нужен там, где «прочитать и решить» обязано быть одной операцией:
        захват-или-продление лока владельцем, снятие и продление только
        своего лока.
        """
        client = await self._get_client()
        return await client.eval(script, len(keys), *keys, *args)

    async def xadd(
        self,
        stream: str,
        fields: dict[str, str],
        *,
        maxlen: int | None = None,
    ) -> str:
        """Добавляет запись в stream; возвращает id записи.

        ``maxlen`` — мягкое (approximate) ограничение длины стрима.
        Используется LLM-мостом (redis-bridge) для очереди заявок.
        """
        client = await self._get_client()
        if maxlen is not None:
            return await client.xadd(stream, fields, maxlen=maxlen, approximate=True)
        return await client.xadd(stream, fields)

    async def xrange(
        self,
        stream: str,
        start: str = "-",
        end: str = "+",
        count: int | None = None,
    ) -> list[tuple[str, dict]]:
        """Читает записи stream в порядке добавления: [(id, {поле: значение})]."""
        client = await self._get_client()
        return await client.xrange(stream, min=start, max=end, count=count)

    async def get_json(self, key: str) -> Any | None:
        """Читает значение, записанное ``set_json``; отсутствующий ключ — None."""
        raw = await self.get(key)
        if raw is None:
            return None
        return json.loads(raw)

    async def set_json(
        self,
        key: str,
        value: Any,
        *,
        ex: int | None = None,
        px: int | None = None,
        nx: bool = False,
    ) -> bool:
        """Пишет значение как JSON; кириллица остаётся читаемой в redis-cli."""
        return await self.set(
            key,
            json.dumps(value, ensure_ascii=False),
            ex=ex,
            px=px,
            nx=nx,
        )

    async def ping(self) -> bool:
        try:
            if self._client is not None:
                return await self._client.ping()
            return False
        except Exception:
            return False

    async def __aenter__(self) -> Self:
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.close()

    async def _get_client(self) -> aioredis.Redis:
        if self._client is None:
            await self.connect()
        assert self._client is not None
        return self._client


# Модульный синглтон: заполняется init_redis на старте приложения.
_adapter: RedisAdapter | None = None


async def init_redis(settings: RedisSettings) -> RedisAdapter:
    """Создаёт адаптер, подключается и сохраняет его в модульном глобале.

    Fail-fast: ошибка подключения пробрасывается наверх — без Redis не работают
    ни локи актов, ни кэши, ни OTP, поэтому стартовать смысла нет. Глобал при
    этом остаётся пустым.

    Args:
        settings: Параметры подключения из ``Settings.redis``

    Returns:
        Подключённый адаптер (при повторном вызове — уже существующий)
    """
    global _adapter

    if _adapter is not None:
        logger.warning("Redis уже инициализирован")
        return _adapter

    adapter = RedisAdapter(settings)
    await adapter.connect()
    _adapter = adapter
    logger.info(
        "Redis подключён: %s:%s/%s", settings.host, settings.port, settings.db
    )
    return adapter


async def close_redis() -> None:
    """Закрывает соединение и обнуляет глобал. Идемпотентна."""
    global _adapter

    if _adapter is None:
        return
    await _adapter.close()
    _adapter = None
    logger.info("Redis отключён")


def get_redis() -> RedisAdapter:
    """Адаптер Redis для кода без HTTP-Request (фоновые задачи, сервисы).

    Returns:
        Подключённый адаптер — он есть всегда, Redis обязателен во всех окружениях

    Raises:
        RuntimeError: ``init_redis`` не вызывался. Это ошибка сборки окружения,
            а не рантайм-режим: в приложении хук старта поднимает Redis до
            первого запроса, в pytest — autouse-фикстура с fakeredis
    """
    if _adapter is None:
        raise RuntimeError(
            "Redis не инициализирован — init_redis не был вызван на старте "
            "приложения (см. app/auth/lifecycle.py; в тестах — autouse-фикстура "
            "_fake_redis в tests/conftest.py)"
        )
    return _adapter
