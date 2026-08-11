"""LLM-транспорт redis-bridge: заявки и ответы через Redis Streams.

Запрос сериализуется в проводной формат цели (openai | gigachat, имя цели
совпадает с форматом) и кладётся в stream заявок; асинхронный ipynb-воркер на
Jupyter DataLab (scripts/llm_redis_worker.ipynb) исполняет его против
целевого LLM-бэкенда и пишет ответ в stream ответа. Протокол —
docs/integrations/redis-llm-bridge.md.

Ошибки транслируются в иерархию ``openai.*`` — иначе существующие
retry (retry.py), circuit breaker и fallback (llm_call.py) их не увидят:
- воркер мёртв / цель недоступна / Redis лёг до постановки заявки →
  APIConnectionError;
- Redis лёг ПОСЛЕ постановки заявки (на поллинге) → BridgePollError
  (подкласс APIConnectionError: fallback срабатывает, но retry его НЕ
  повторяет — см. docstring класса);
- дедлайн ожидания истёк → BridgeDeadlineError (подкласс APITimeoutError:
  fallback срабатывает, но retry его НЕ повторяет — см. docstring класса);
- error-конверт воркера → APIStatusError с тем же status_code;
- невалидное тело final-конверта → APIStatusError 502 (не маскируется
  под сбой Redis).
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

import httpx
from openai import APIConnectionError, APIStatusError, APITimeoutError
from openai.types.chat import ChatCompletion

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


class BridgeDeadlineError(APITimeoutError):
    """Дедлайн ожидания ответа воркера истёк.

    Подкласс APITimeoutError, поэтому llm_call считает его сбоем провайдера
    и уходит на fallback. Но retry_on_transient его НЕ повторяет
    (см. _NEVER_RETRY_EXC в retry.py): дедлайн моста равен полному
    request_timeout, а каждый повтор клал бы в stream НОВУЮ заявку —
    воркер исполнял бы дубли против LLM, а пользователь ждал бы кратно
    дольше (max_attempts × request_timeout).
    """


class BridgePollError(APIConnectionError):
    """Сбой Redis на поллинге ответа — заявка УЖЕ поставлена в stream.

    Подкласс APIConnectionError, поэтому llm_call считает его сбоем
    провайдера и уходит на fallback. Но retry_on_transient его НЕ повторяет
    (см. _NEVER_RETRY_EXC в retry.py): конверт лежит в стриме и воркер его
    исполняет — повтор положил бы ВТОРУЮ заявку с новым request_id, и LLM
    отработал бы дубль.

    Сбой ДО/ВО ВРЕМЯ xadd остаётся обычным APIConnectionError: заявки в
    стриме нет, повтор безопасен и нужен.
    """


def _status_error(status_code: int, message: str) -> APIStatusError:
    """APIStatusError с заданным кодом (для error-конвертов воркера)."""
    response = httpx.Response(
        status_code=status_code, request=_make_request(), text=message,
    )
    return APIStatusError(message, response=response, body=None)


async def _ensure_worker_available(
    target: str, key_prefix: str, *, require_healthy: bool = False,
) -> None:
    """Проверяет heartbeat воркера и доступность цели.

    Ключа нет / цель не заявлена / Redis недоступен → APIConnectionError
    (connect-класс retry: быстрый отказ, срабатывает fallback).

    require_healthy=True (health probe): дополнительно требует, чтобы воркер
    не пометил цель нездоровой в ``target_health`` heartbeat'а. Пользовательские
    запросы (create) этот флаг НЕ используют — ложноотрицательный health-check
    воркера не должен блокировать реальные вызовы; он лишь мешает probe
    преждевременно закрыть breaker, пока LLM-бэкенд за воркером лежит.
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
    if not isinstance(info, dict):
        # Валидный JSON, но не объект (массив/строка) — контракт модуля
        # обязывает остаться в иерархии openai.*, а не упасть AttributeError.
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
    if require_healthy:
        health = info.get("target_health")
        # Отсутствие поля / не-dict = «здорова» (совместимость со старым воркером).
        if isinstance(health, dict) and health.get(target) is False:
            raise APIConnectionError(
                message=(
                    f"redis-bridge: цель {target!r} нездорова по данным "
                    "воркера (LLM-бэкенд не отвечает)"
                ),
                request=_make_request(),
            )


def _build_wire_body(kwargs: dict, *, wire_format: str) -> dict:
    """Собирает проводное тело запроса из OpenAI-style kwargs.

    NOT_GIVEN/None-значения отбрасываются. Для формата gigachat — трансляция
    существующими функциями gigachat_adapter (см. _build_gigachat_body).
    """
    from openai import NOT_GIVEN

    clean = {
        k: v for k, v in kwargs.items()
        if v is not NOT_GIVEN and v is not None
    }
    messages = clean.pop("messages", [])
    tools = clean.pop("tools", None)

    if wire_format == "gigachat":
        return _build_gigachat_body(clean, messages, tools)

    body = dict(clean)
    body["messages"] = list(messages)
    from app.domains.chat.services.gigachat_adapter import _is_tools_provided
    if _is_tools_provided(tools):
        body["tools"] = tools
    return body


def _find_terminal(entries: list[tuple[str, dict]]) -> dict | None:
    """Первый терминальный кусок (final|error) в ленте ответа, иначе None."""
    for _entry_id, fields in entries:
        if fields.get("kind") in ("final", "error"):
            return fields
    return None


def _handle_terminal(fields: dict, *, wire_format: str):
    """Терминальный кусок → ChatCompletion либо APIStatusError.

    Нечитаемое/несовместимое со схемой тело final-конверта — это ответ
    LLM-бэкенда, а не сбой транспорта, поэтому APIStatusError 502
    (server-класс: ретраится по on_5xx, тригерит fallback), а не
    APIConnectionError с вводящим в заблуждение текстом про Redis.
    """
    if fields.get("kind") == "error":
        try:
            code = int(fields.get("status_code") or 502)
        except (TypeError, ValueError):
            code = 502
        raise _status_error(
            code, fields.get("message") or "redis-bridge: ошибка воркера",
        )
    try:
        raw = json.loads(fields["body"])
    except (KeyError, TypeError, ValueError) as exc:
        raise _status_error(
            502, f"redis-bridge: нечитаемое тело ответа воркера ({exc})",
        ) from exc
    try:
        if wire_format == "gigachat":
            # Нормализация: GigaChat отдаёт function_call.arguments как dict,
            # но SDK ожидает строку. Преобразуем dict в JSON-строку ДО
            # model_validate, затем _translate_response получит строку
            # (он умеет обе).
            for choice in raw.get("choices") or []:
                fc = (choice.get("message") or {}).get("function_call")
                if fc and not isinstance(fc.get("arguments"), str):
                    fc["arguments"] = json.dumps(
                        fc.get("arguments") or {}, ensure_ascii=False,
                    )
        completion = ChatCompletion.model_validate(raw)
        if wire_format == "gigachat":
            from app.domains.chat.services.gigachat_adapter import (
                _translate_response,
            )
            completion = _translate_response(completion)
    except Exception as exc:
        raise _status_error(
            502,
            "redis-bridge: тело ответа воркера не соответствует схеме "
            f"ChatCompletion ({type(exc).__name__})",
        ) from exc
    return completion


class _Completions:
    """Прокси ``chat.completions``; ``create`` — заявка в stream + поллинг ответа."""

    def __init__(self, client: "RedisBridgeClient") -> None:
        self._client = client

    async def create(self, **kwargs: Any):
        """Отправляет заявку в stream и поллит ленту ответа до дедлайна."""
        from app.core.redis import get_redis

        client = self._client
        await _ensure_worker_available(client._target, client._key_prefix)

        kwargs.pop("stream", None)      # стриминга в v1 нет
        kwargs.pop("tool_choice", None)  # как в gigachat_adapter
        explicit_timeout = kwargs.pop("timeout", None)
        timeout = float(explicit_timeout or client._timeout)

        body = _build_wire_body(kwargs, wire_format=client._target)
        request_id = str(uuid.uuid4())
        deadline = time.monotonic() + timeout
        resp_key = client._key_prefix + RESP_KEY_SUFFIX + request_id
        redis = get_redis()
        terminal: dict | None = None
        # Постановка заявки и ожидание ответа — РАЗНЫЕ try: до успешного
        # xadd заявки в стриме нет и повтор безопасен (APIConnectionError,
        # ретраится как connect-класс), после — повтор породил бы дубль
        # (BridgePollError, ретрай запрещён).
        try:
            await redis.xadd(
                client._key_prefix + REQUESTS_STREAM_SUFFIX,
                {
                    "v": ENVELOPE_VERSION,
                    "id": request_id,
                    "target": client._target,
                    "path": "/chat/completions",
                    "body": json.dumps(body, ensure_ascii=False),
                    "deadline_ts": str(time.time() + timeout),
                },
                maxlen=REQUEST_STREAM_MAXLEN,
            )
        except Exception as exc:  # ошибки redis-py — connect-класс
            raise APIConnectionError(
                message="redis-bridge: не удалось поставить заявку в stream",
                request=_make_request(),
            ) from exc
        # В try — только обмен с Redis: ошибки разбора терминального куска
        # не должны маскироваться под сбой Redis (_handle_terminal — снаружи).
        try:
            while time.monotonic() < deadline:
                entries = await redis.xrange(resp_key)
                terminal = _find_terminal(entries)
                if terminal is not None:
                    break
                await asyncio.sleep(POLL_INTERVAL_SEC)
        except Exception as exc:
            raise BridgePollError(
                message="redis-bridge: сбой Redis при ожидании ответа воркера",
                request=_make_request(),
            ) from exc
        if terminal is None:
            raise BridgeDeadlineError(request=_make_request())
        return _handle_terminal(terminal, wire_format=client._target)


class _Chat:
    def __init__(self, client: "RedisBridgeClient") -> None:
        self.completions = _Completions(client)


class _Models:
    """``models.list()`` — проверка heartbeat, используется health probe.

    require_healthy=True: воркер сам пингует свои LLM-бэкенды и публикует
    ``target_health`` в heartbeat, поэтому probe закрывает breaker только
    когда жив не только воркер, но и цель за ним.
    """

    def __init__(self, client: "RedisBridgeClient") -> None:
        self._client = client

    async def list(self) -> list:
        await _ensure_worker_available(
            self._client._target, self._client._key_prefix,
            require_healthy=True,
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


def _build_gigachat_body(clean: dict, messages: list, tools) -> dict:
    """Native GigaChat-тело: messages через трансляцию, tools → functions.

    Переиспользует оттестированные функции gigachat_adapter — все quirks
    (arguments-DICT в запросе, content="" при function_call, 1 вызов за
    раунд, mapping tool→function по имени) остаются в одном месте.
    """
    from app.domains.chat.services.gigachat_adapter import (
        _is_tools_provided,
        _tools_to_functions,
        _translate_messages,
    )

    body = dict(clean)
    body["messages"] = _translate_messages(messages)
    if _is_tools_provided(tools):
        body["functions"] = _tools_to_functions(tools)
    return body
