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
этого избежать, клиенты кэшируются: primary и fallback ходят в общий кэш
через единый ``_cached_client`` и различаются префиксом ключа;
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


def _cached_client(
    *,
    cache_prefix: str,
    profile: str,
    route: tuple[str, str],
    api_base: str | None,
    api_key: str | None,
    headers: dict[str, str],
    timeout: float | int,
    key_prefix: str,
    model: str | None = None,
):
    """Клиент маршрута из общего кэша, иначе создаёт и кладёт туда.

    Единственная точка сборки cache-key и конструирования клиента: primary
    и fallback отличаются только источником настроек и префиксом ключа
    (``cache_prefix``), поэтому обе ветки ходят сюда.

    Для redis-транспорта в ключ идут ``key_prefix`` моста и timeout
    (``api_base``/``api_key`` мосту не нужны — он не ходит в HTTP напрямую),
    для HTTP — base/key/headers/timeout. ``model`` участвует только
    в debug-логе.
    """
    transport, wire_format = route
    if transport == "redis":
        cache_key: tuple[Any, ...] = (cache_prefix, profile, key_prefix, timeout)
    else:
        cache_key = (
            cache_prefix, profile, api_base, api_key,
            tuple(sorted(headers.items())), timeout,
        )
    client = _clients_cache.get(cache_key)
    if client is not None:
        return client

    if transport == "redis":
        from app.domains.chat.services.redis_bridge_adapter import (
            RedisBridgeClient,
        )
        client = RedisBridgeClient(
            target=wire_format, key_prefix=key_prefix, timeout=timeout,
        )
    elif wire_format == "gigachat":
        from app.domains.chat.services.gigachat_adapter import (
            GigaChatAdapterClient,
        )
        client = GigaChatAdapterClient(
            base_url=api_base,
            api_key=api_key,
            default_headers=headers,
            timeout=timeout,
        )
    else:
        client = AsyncOpenAI(
            base_url=api_base,
            api_key=api_key,
            default_headers=headers,
            timeout=timeout,
        )
    _clients_cache[cache_key] = client
    logger.debug(
        "LLM клиент создан (%s): маршрут=%s, base_url=%s, модель=%s, timeout=%s",
        cache_prefix, profile, api_base, model, timeout,
    )
    return client


def build_llm_client(settings: ChatDomainSettings):
    """Возвращает LLM-клиент из кэша или создаёт нового.

    Один клиент на набор профильных настроек (состав ключа — см.
    :func:`_cached_client`) держится в памяти на всё время жизни процесса;
    закрывается через :func:`close_cached_clients` в on_shutdown.

    Для большинства профилей — AsyncOpenAI.
    Для profile=gigachat — GigaChatAdapterClient, который проксирует
    AsyncOpenAI с переводом форматов tools↔functions (см. gigachat_adapter.py).
    Для redis-маршрутов (profile=redis-bridge,*) — RedisBridgeClient поверх
    Redis Streams (см. redis_bridge_adapter.py).
    """
    from app.domains.chat.settings import parse_route

    return _cached_client(
        cache_prefix="primary",
        profile=settings.profile,
        route=parse_route(settings.profile),
        api_base=settings.api_base,
        api_key=settings.api_key.get_secret_value(),
        headers=dict(settings.extra_headers),
        timeout=settings.request_timeout,
        key_prefix=settings.redis_bridge.key_prefix,
        model=settings.model,
    )


def build_fallback_client(settings: ChatDomainSettings):
    """Возвращает LLM-клиент для fallback-провайдера.

    Требует чтобы ``settings.fallback_profile`` был задан. Дальше маршрут
    определяет требования: для ``redis-bridge,*`` этого достаточно —
    ``fallback_api_base``/``fallback_api_key`` не нужны (мост не ходит
    напрямую в HTTP); для HTTP-маршрута (``gigachat``/``openai``) оба поля
    обязательны. Кэшируется отдельным ключом, как primary. При
    несоответствии настроек — возвращает None (caller сам решает, что
    делать).

    Использовать ТОЛЬКО когда primary недоступен (circuit open).
    Для GigaChat-fallback ВАЖНО: streaming не поддерживается; вызывающий
    код обязан переключиться на non-streaming-ветку оркестратора.
    """
    if not settings.fallback_profile:
        return None

    from app.domains.chat.settings import parse_route

    route = parse_route(settings.fallback_profile)
    # HTTP-маршруту нужны base/key; мосту — нет (он не ходит в HTTP напрямую).
    if route[0] != "redis" and (
        not settings.fallback_api_base or settings.fallback_api_key is None
    ):
        return None

    return _cached_client(
        cache_prefix="fallback",
        profile=settings.fallback_profile,
        route=route,
        api_base=settings.fallback_api_base,
        api_key=(
            settings.fallback_api_key.get_secret_value()
            if settings.fallback_api_key is not None
            else None
        ),
        headers=dict(settings.fallback_extra_headers),
        timeout=settings.request_timeout,
        key_prefix=settings.redis_bridge.key_prefix,
        model=settings.fallback_model,
    )


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
