"""LLM-транспорт redis-bridge: заявки и ответы через Redis Streams.

Запрос сериализуется в проводной формат цели (openai | gigachat, имя цели
совпадает с форматом) и кладётся в stream заявок; асинхронный ipynb-воркер на
Jupyter DataLab (scripts/datalab/llm_redis_worker.ipynb) исполняет его против
целевого LLM-бэкенда и пишет ответ в stream ответа. Протокол —
docs/integrations/redis-llm-bridge.md.

Ошибки транслируются в иерархию ``openai.*`` — иначе существующие
retry (retry.py), circuit breaker и fallback (llm_call.py) их не увидят:
- воркер мёртв / цель недоступна / Redis лёг → APIConnectionError;
- дедлайн ожидания истёк → APITimeoutError;
- error-конверт воркера → APIStatusError с тем же status_code.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any

import httpx
from openai import APIConnectionError, APIStatusError, APITimeoutError

logger = logging.getLogger(
    "audit_workstation.domains.chat.services.redis_bridge_adapter",
)

# Версия конверта. v2 зарезервирована под по-кусочный стриминг (kind=chunk).
ENVELOPE_VERSION = "1"
# Суффиксы ключей (полный ключ = key_prefix + суффикс).
REQUESTS_STREAM_SUFFIX = "requests"
ALIVE_KEY_SUFFIX = "worker:alive"
RESP_KEY_SUFFIX = "resp:"  # + request_id
# Константы транспорта — сознательно не настройки (решение спеки).
POLL_INTERVAL_SEC = 0.3
REQUEST_STREAM_MAXLEN = 1000
RESP_TTL_SEC = 300
# Имя consumer group воркеров — здесь для справки и тестов; группу создаёт воркер.
CONSUMER_GROUP = "llm-workers"


def _make_request() -> httpx.Request:
    """Синтетический httpx.Request для конструкторов openai-исключений."""
    return httpx.Request("POST", "http://redis-bridge.local/chat/completions")


def _status_error(status_code: int, message: str) -> APIStatusError:
    """APIStatusError с заданным кодом (для error-конвертов воркера)."""
    response = httpx.Response(
        status_code=status_code, request=_make_request(), text=message,
    )
    return APIStatusError(message, response=response, body=None)


async def _ensure_worker_available(target: str, key_prefix: str) -> None:
    """Проверяет heartbeat воркера и доступность цели.

    Ключа нет / цель не заявлена / Redis недоступен → APIConnectionError
    (connect-класс retry: быстрый отказ, срабатывает fallback).
    """
    from app.core.redis import get_redis

    try:
        raw = await get_redis().get(key_prefix + ALIVE_KEY_SUFFIX)
    except Exception as exc:
        raise APIConnectionError(
            message="redis-bridge: Redis недоступен",
            request=_make_request(),
        ) from exc
    if raw is None:
        raise APIConnectionError(
            message="redis-bridge: воркер не отвечает (heartbeat отсутствует)",
            request=_make_request(),
        )
    try:
        info = json.loads(raw)
    except json.JSONDecodeError:
        info = {}
    targets = info.get("targets") or []
    if target not in targets:
        raise APIConnectionError(
            message=(
                f"redis-bridge: цель {target!r} недоступна "
                f"(воркер заявляет {targets!r})"
            ),
            request=_make_request(),
        )


class _Completions:
    """Прокси ``chat.completions``; ``create`` реализуется в Task 4-5."""

    def __init__(self, client: "RedisBridgeClient") -> None:
        self._client = client

    async def create(self, **kwargs: Any):
        raise NotImplementedError  # Task 4


class _Chat:
    def __init__(self, client: "RedisBridgeClient") -> None:
        self.completions = _Completions(client)


class _Models:
    """``models.list()`` — проверка heartbeat, используется health probe."""

    def __init__(self, client: "RedisBridgeClient") -> None:
        self._client = client

    async def list(self) -> list:
        await _ensure_worker_available(
            self._client._target, self._client._key_prefix,
        )
        return []


class RedisBridgeClient:
    """Duck-typed LLM-клиент поверх Redis Streams (профиль redis-bridge).

    ``target`` — имя цели воркера, совпадает с проводным форматом
    ("openai" | "gigachat"). Собственных соединений не держит: Redis —
    общий модульный синглтон приложения, поэтому ``aclose()`` — no-op.
    """

    def __init__(
        self,
        *,
        target: str,
        key_prefix: str,
        timeout: float | int,
    ) -> None:
        self._target = target
        self._key_prefix = key_prefix
        self._timeout = float(timeout)
        self.chat = _Chat(self)
        self.models = _Models(self)

    async def aclose(self) -> None:
        """Соединений нет; метод существует для close_cached_clients()."""
        return None
