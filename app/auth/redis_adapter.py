"""Асинхронный адаптер Redis для хранения OTP-кодов."""

from __future__ import annotations

from typing import Self

import redis.asyncio as aioredis
from pydantic import BaseModel


class RedisConfig(BaseModel):
    """Конфигурация подключения к Redis."""

    # IPv4 явно: на Windows "localhost" резолвится в IPv6 ::1 первым,
    # redis-py не фолбэкает на IPv4 — connection refused/timeout.
    host: str = "127.0.0.1"
    port: int = 6379
    db: int = 0
    password: str = ""
    max_connections: int = 10
    socket_timeout: float = 5.0
    decode_responses: bool = True


class RedisAdapter:
    """Асинхронный клиент Redis с ленивым подключением."""

    def __init__(self, config: RedisConfig) -> None:
        self._config = config
        self._client: aioredis.Redis | None = None

    async def connect(self) -> aioredis.Redis:
        if self._client is not None:
            return self._client
        self._client = aioredis.Redis(
            host=self._config.host,
            port=self._config.port,
            db=self._config.db,
            password=self._config.password or None,
            decode_responses=self._config.decode_responses,
            max_connections=self._config.max_connections,
            socket_timeout=self._config.socket_timeout,
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
    ) -> bool:
        client = await self._get_client()
        result = await client.set(key, value, ex=ex)
        return bool(result)

    async def delete(self, *keys: str) -> int:
        client = await self._get_client()
        return await client.delete(*keys)

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
