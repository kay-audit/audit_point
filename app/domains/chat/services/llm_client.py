"""Фабрика LLM-клиента по маршруту профиля (см. parse_route).

Маршрут определяет транспорт (http | redis) и проводной формат
(openai | gigachat). Транспорт http создаёт AsyncOpenAI/GigaChatAdapterClient
с прямым HTTP-соединением к провайдеру; транспорт redis — RedisBridgeClient
поверх Redis Streams (см. redis_bridge_adapter.py). OpenRouter — не отдельный
профиль, а конкретный сервер за проводным форматом openai (адрес — в api_base).

**Кэш клиентов**: каждый клиент несёт под капотом httpx.AsyncClient
с собственным connection pool (для redis-маршрута соединений нет, но кэш
всё равно экономит на пересоздании объекта). Если создавать клиент
per-request, сокеты копятся (особенно при долгих запросах к LLM). Чтобы
этого избежать, ``build_llm_client`` кэширует клиентов по ключу (profile,
api_base, api_key, headers, timeout, redis key_prefix);
``close_cached_clients()`` зовётся из ``on_shutdown`` chat-домена и закрывает
httpx-клиентов.
"""
from __future__ import annotations

import logging
from typing import Any

from openai import AsyncOpenAI

from app.domains.chat.settings import ChatDomainSettings

logger = logging.getLogger("audit_workstation.domains.chat.services.llm_client")

# Ключ кэша: профильно-неизменяемые поля, по которым httpx.AsyncClient
# и connection pool остаются совместимы. Если settings меняются на лету
# (например, в тестах) — будет новый клиент, старый осиротеет, но
# close_cached_clients() закроет всех.
_clients_cache: dict[tuple[Any, ...], Any] = {}


def _make_client(settings: ChatDomainSettings):
    """Создаёт новый LLM-клиент по маршруту профиля (без кэша)."""
    from app.domains.chat.settings import parse_route

    transport, wire_format = parse_route(settings.profile)
    if transport == "redis":
        from app.domains.chat.services.redis_bridge_adapter import (
            RedisBridgeClient,
        )
        return RedisBridgeClient(
            target=wire_format,
            key_prefix=settings.redis_bridge.key_prefix,
            timeout=settings.request_timeout,
        )
    headers = dict(settings.extra_headers)
    if wire_format == "gigachat":
        from app.domains.chat.services.gigachat_adapter import (
            GigaChatAdapterClient,
        )
        return GigaChatAdapterClient(
            base_url=settings.api_base,
            api_key=settings.api_key.get_secret_value(),
            default_headers=headers,
            timeout=settings.request_timeout,
        )
    return AsyncOpenAI(
        base_url=settings.api_base,
        api_key=settings.api_key.get_secret_value(),
        default_headers=headers,
        timeout=settings.request_timeout,
    )


def build_llm_client(settings: ChatDomainSettings):
    """Возвращает LLM-клиент из кэша или создаёт нового.

    Один клиент на (profile, api_base, api_key, headers, timeout)
    держится в памяти на всё время жизни процесса; закрывается через
    :func:`close_cached_clients` в on_shutdown.

    Для большинства профилей — AsyncOpenAI.
    Для profile=gigachat — GigaChatAdapterClient, который проксирует
    AsyncOpenAI с переводом форматов tools↔functions (см. gigachat_adapter.py).
    """
    headers_key = tuple(sorted(settings.extra_headers.items()))
    cache_key: tuple[Any, ...] = (
        settings.profile,
        settings.api_base,
        settings.api_key.get_secret_value(),
        headers_key,
        settings.request_timeout,
        settings.redis_bridge.key_prefix,
    )
    client = _clients_cache.get(cache_key)
    if client is not None:
        return client

    client = _make_client(settings)
    _clients_cache[cache_key] = client
    logger.debug(
        "LLM клиент создан: профиль=%s, base_url=%s, model=%s, timeout=%s",
        settings.profile, settings.api_base, settings.model,
        settings.request_timeout,
    )
    return client


def build_fallback_client(settings: ChatDomainSettings):
    """Возвращает LLM-клиент для fallback-провайдера.

    Требует чтобы ``settings.fallback_profile`` и ``fallback_api_base``,
    ``fallback_api_key`` были заданы. Кэшируется отдельным ключом, как
    primary. При несоответствии настроек — возвращает None (caller сам
    решает, что делать).

    Использовать ТОЛЬКО когда primary недоступен (circuit open).
    Для GigaChat-fallback ВАЖНО: streaming не поддерживается; вызывающий
    код обязан переключиться на non-streaming-ветку оркестратора.
    """
    if not settings.fallback_profile:
        return None

    from app.domains.chat.settings import parse_route

    transport, wire_format = parse_route(settings.fallback_profile)
    timeout = settings.request_timeout

    if transport == "redis":
        cache_key: tuple[Any, ...] = (
            "fallback",
            settings.fallback_profile,
            settings.redis_bridge.key_prefix,
            timeout,
        )
        client = _clients_cache.get(cache_key)
        if client is not None:
            return client
        from app.domains.chat.services.redis_bridge_adapter import (
            RedisBridgeClient,
        )
        client = RedisBridgeClient(
            target=wire_format,
            key_prefix=settings.redis_bridge.key_prefix,
            timeout=timeout,
        )
        _clients_cache[cache_key] = client
        logger.debug(
            "LLM fallback клиент создан: маршрут=%s", settings.fallback_profile,
        )
        return client

    if not settings.fallback_api_base:
        return None
    if settings.fallback_api_key is None:
        return None

    headers = dict(settings.fallback_extra_headers)
    api_key_value = settings.fallback_api_key.get_secret_value()
    headers_key = tuple(sorted(headers.items()))
    cache_key = (
        "fallback",
        settings.fallback_profile,
        settings.fallback_api_base,
        api_key_value,
        headers_key,
        timeout,
    )
    client = _clients_cache.get(cache_key)
    if client is not None:
        return client

    if wire_format == "gigachat":
        from app.domains.chat.services.gigachat_adapter import (
            GigaChatAdapterClient,
        )
        client = GigaChatAdapterClient(
            base_url=settings.fallback_api_base,
            api_key=api_key_value,
            default_headers=headers,
            timeout=timeout,
        )
    else:
        client = AsyncOpenAI(
            base_url=settings.fallback_api_base,
            api_key=api_key_value,
            default_headers=headers,
            timeout=timeout,
        )
    _clients_cache[cache_key] = client
    logger.debug(
        "LLM fallback клиент создан: профиль=%s, base_url=%s, model=%s",
        settings.fallback_profile,
        settings.fallback_api_base,
        settings.fallback_model,
    )
    return client


async def close_cached_clients() -> int:
    """Закрывает кэшированные LLM-клиенты (httpx.AsyncClient под капотом).

    Возвращает количество закрытых клиентов. Зовётся из on_shutdown
    chat-домена; в тестах можно использовать `_clients_cache.clear()`.
    """
    count = 0
    for client in list(_clients_cache.values()):
        underlying = getattr(client, "_underlying", client)
        close = getattr(underlying, "close", None) or getattr(
            underlying, "aclose", None,
        )
        if close is not None:
            try:
                await close()
                count += 1
            except Exception:
                logger.exception("Не удалось закрыть LLM-клиента")
    _clients_cache.clear()
    if count:
        logger.info("LLM-клиенты закрыты: %d", count)
    return count
