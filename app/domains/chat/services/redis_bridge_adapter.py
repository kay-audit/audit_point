"""LLM-транспорт redis-bridge: заявки и ответы через Redis Streams.

Запрос сериализуется в проводной формат цели (openai | gigachat, имя цели
совпадает с форматом) и кладётся в stream заявок; асинхронный ipynb-воркер на
Jupyter DataLab (scripts/llm_redis_worker.ipynb) исполняет его против
целевого LLM-бэкенда и пишет ответ в stream ответа. Протокол —
docs/integrations/redis-llm-bridge.md.

Тело final-конверта — сырой ответ бэкенда, поэтому перед валидацией оно
нормализуется (_normalize_completion_payload). Прямой HTTP-маршрут разбирает
ответ ленивым конструктором openai-SDK и переживает отсутствие полей,
обязательных по схеме, но необязательных для бэкенда; ChatCompletion —
нет. GigaChat, например, не присылает "id" и умеет finish_reason="blacklist":
без нормализации штатный успешный ответ падал бы как «не соответствует
схеме», ретраился как 5xx и открывал circuit breaker.

Нормализация только ДОЗАПОЛНЯЕТ отсутствующее и приводит значения вне схемы:
поля, реально присланные бэкендом (model, created, id), сохраняются как есть —
иначе в ответе оказались бы выдуманные данные.

Ошибки транслируются в иерархию ``openai.*`` — иначе существующие
retry (retry.py), circuit breaker и fallback (llm_call.py) их не увидят:
- воркер мёртв / цель недоступна / Redis лёг → APIConnectionError;
- дедлайн ожидания истёк → BridgeDeadlineError (подкласс APITimeoutError:
  fallback срабатывает, но retry его НЕ повторяет — см. docstring класса);
- error-конверт воркера → APIStatusError с тем же status_code;
- невалидное тело final-конверта → BridgeSchemaError (подкласс APIStatusError
  со статусом 502: не маскируется под сбой Redis, тригерит следующий маршрут,
  но НЕ ретраится — разбор детерминирован, см. docstring класса).
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
from openai.types.chat import ChatCompletion

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

# --- Нормализация тела final-конверта ---
# finish_reason, допустимые схемой openai. GigaChat отдаёт сверх этого
# "blacklist" (сработал цензор) и "error"; неизвестное значение приводим
# к допустимому, а не роняем из-за него весь ответ.
_ALLOWED_FINISH_REASONS = frozenset({
    "stop", "length", "tool_calls", "content_filter", "function_call",
})
_FINISH_REASON_ALIASES = {"blacklist": "content_filter"}
_FINISH_REASON_DEFAULT = "stop"
# finish_reason, означающий «генерация не состоялась». Приводить его к "stop"
# нельзя: ответ выглядел бы успешным, breaker получил бы record_success,
# следующий маршрут не пробовался бы, а пользователь увидел бы пустое
# сообщение без error-блока. Такой ответ — сбой бэкенда (BridgeBackendError).
_FAILED_FINISH_REASONS = frozenset({"error"})
# Длина детали ошибки валидации в сообщении APIStatusError: полный вывод
# pydantic многострочный и уходит в лог целиком, а в сообщении нужен
# опознаваемый хвост (имя поля), а не простыня.
_VALIDATION_MESSAGE_LIMIT = 300


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


class BridgeSchemaError(APIStatusError):
    """Тело final-конверта не разобралось в ChatCompletion.

    status_code=502, поэтому llm_call считает это сбоем провайдера и уходит
    на следующий маршрут. Но retry_on_transient его НЕ повторяет
    (см. _NEVER_RETRY_EXC в retry.py): разбор детерминирован — тот же ответ
    не станет валидным со второй попытки, а каждый повтор клал бы в stream
    новую заявку, то есть новый реальный (и платный) вызов LLM плюс
    ожидание rate-limit цели. Ровно это и произошло на ПРОМе 11.08.2026:
    один невалидный ответ GigaChat превращался в 5 вызовов подряд.
    """


class BridgeBackendError(APIStatusError):
    """LLM-бэкенд за воркером не выполнил запрос, и воркер уже отработал своё.

    Два источника:

    - ``error``-конверт со статусом 429/5xx: воркер такие ответы **уже**
      повторял сам (``MAX_ATTEMPTS=3`` с паузами 5/10/20 сек). Повтор на
      стороне приложения множится на воркерский: 5 попыток приложения × 3
      воркера = до 15 реальных вызовов LLM на одно сообщение пользователя;
    - ``finish_reason="error"`` в успешном по статусу ответе: генерация не
      состоялась, и отдавать это пользователю как готовый (обычно пустой)
      ответ нельзя.

    Поэтому НЕ ретраится (см. _NEVER_RETRY_EXC в retry.py), но остаётся
    APIStatusError: 5xx считается provider-failure, и переход на следующий
    маршрут работает как обычно. 408 и прочие 4xx сюда не попадают — их
    воркер не повторял, решение о повторе остаётся за retry-политикой
    приложения (см. §5 в docs/integrations/redis-llm-bridge.md).
    """


def _status_error(status_code: int, message: str) -> APIStatusError:
    """APIStatusError с заданным кодом (для error-конвертов воркера)."""
    response = httpx.Response(
        status_code=status_code, request=_make_request(), text=message,
    )
    return APIStatusError(message, response=response, body=None)


def _schema_error(message: str) -> BridgeSchemaError:
    """BridgeSchemaError 502 (не ретраится, но тригерит следующий маршрут)."""
    response = httpx.Response(
        status_code=502, request=_make_request(), text=message,
    )
    return BridgeSchemaError(message, response=response, body=None)


def _backend_error(status_code: int, message: str) -> BridgeBackendError:
    """BridgeBackendError (не ретраится: воркер уже повторял сам)."""
    response = httpx.Response(
        status_code=status_code, request=_make_request(), text=message,
    )
    return BridgeBackendError(message, response=response, body=None)


async def read_worker_heartbeat(key_prefix: str) -> dict:
    """Читает и разбирает ``{prefix}worker:alive``.

    Единственное место, которое знает формат heartbeat'а: им пользуются и
    проверка перед запросом (_ensure_worker_available), и планировщик
    маршрутов (llm_routing), чтобы не заводить второй разбор того же JSON.

    Ключа нет / Redis недоступен → APIConnectionError (connect-класс retry:
    быстрый отказ, срабатывает переход на следующий маршрут). Кривой JSON
    или валидный JSON, но не объект (массив/строка) → пустой dict: контракт
    модуля обязывает остаться в иерархии openai.*, а не падать
    AttributeError мимо retry/breaker/fallback.
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
        return {}
    return info if isinstance(info, dict) else {}


async def try_read_worker_heartbeat(key_prefix: str) -> dict | None:
    """Мягкое чтение heartbeat'а: None вместо исключения.

    Для планировщика маршрутов: отсутствие воркера для него — не ошибка,
    а причина не предлагать redis-маршруты (и написать в лог, почему).
    """
    try:
        return await read_worker_heartbeat(key_prefix)
    except APIConnectionError as exc:
        logger.debug("redis-bridge: heartbeat недоступен (%s)", exc)
        return None


def worker_targets(info: dict | None) -> list[str]:
    """Список целей, заявленных воркером в heartbeat'е."""
    if not isinstance(info, dict):
        return []
    targets = info.get("targets")
    return [t for t in targets if isinstance(t, str)] if isinstance(
        targets, list,
    ) else []


def target_is_healthy(info: dict | None, target: str) -> bool:
    """False, только если воркер ЯВНО пометил цель нездоровой.

    Отсутствие поля / не-dict = «здорова» (совместимость со старым воркером,
    который ещё не публиковал target_health).
    """
    if not isinstance(info, dict):
        return True
    health = info.get("target_health")
    if not isinstance(health, dict):
        return True
    return health.get(target) is not False


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
    info = await read_worker_heartbeat(key_prefix)
    targets = worker_targets(info)
    if target not in targets:
        raise APIConnectionError(
            message=(
                f"redis-bridge: цель {target!r} недоступна "
                f"(воркер заявляет {targets!r})"
            ),
            request=_make_request(),
        )
    if require_healthy and not target_is_healthy(info, target):
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


def _normalize_message(message: dict, *, wire_format: str) -> dict:
    """Копия message с дозаполненным role и строковым function_call.arguments.

    GigaChat отдаёт arguments как dict, а SDK ожидает строку. Конвертируем
    ДО валидации, чтобы дальше _translate_response получил строку
    (он умеет обе).
    """
    out = dict(message)
    if not out.get("role"):
        out["role"] = "assistant"
    fc = out.get("function_call")
    if (
        wire_format == "gigachat"
        and isinstance(fc, dict)
        and not isinstance(fc.get("arguments"), str)
    ):
        out["function_call"] = {
            **fc,
            "arguments": json.dumps(
                fc.get("arguments") or {}, ensure_ascii=False,
            ),
        }
    return out


def _failed_finish_reason(raw: Any) -> str | None:
    """finish_reason, означающий несостоявшуюся генерацию, если он есть.

    Проверяется ДО нормализации: иначе значение схлопнулось бы в "stop"
    и провал бэкенда выглядел бы успешным ответом.
    """
    if not isinstance(raw, dict):
        return None
    choices = raw.get("choices")
    if not isinstance(choices, list):
        return None
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        reason = choice.get("finish_reason")
        if reason in _FAILED_FINISH_REASONS:
            return reason
    return None


def _normalize_choice(choice: Any, *, index: int, wire_format: str) -> Any:
    """Копия choice с дозаполненным index и допустимым схемой finish_reason."""
    if not isinstance(choice, dict):
        return choice
    out = dict(choice)
    if not isinstance(out.get("index"), int):
        out["index"] = index
    reason = out.get("finish_reason")
    if reason not in _ALLOWED_FINISH_REASONS:
        out["finish_reason"] = _FINISH_REASON_ALIASES.get(
            reason, _FINISH_REASON_DEFAULT,
        )
        logger.warning(
            "redis-bridge: finish_reason=%r вне схемы openai, приведён к %r",
            reason, out["finish_reason"],
        )
    message = out.get("message")
    if isinstance(message, dict):
        out["message"] = _normalize_message(message, wire_format=wire_format)
    return out


def _normalize_completion_payload(
    raw: Any, *, wire_format: str, request_id: str | None,
) -> Any:
    """Возвращает копию тела ответа, пригодную для валидации ChatCompletion.

    Дозаполняются ТОЛЬКО отсутствующие/непригодные по типу поля — присланное
    бэкендом (model, created, id) сохраняется: иначе в ответе оказались бы
    выдуманные данные, а логи и метрики врали бы про модель.

    - ``id`` — GigaChat его не возвращает; синтезируем из request_id моста,
      заодно получая сквозную корреляцию логов СДП ↔ воркер;
    - ``object`` / ``created`` / ``model`` — подставляются, если их нет;
    - ``choices[].index`` / ``finish_reason`` / ``message.role`` —
      см. _normalize_choice.

    Не-dict возвращается как есть: подменять форму ответа не наша задача,
    пусть падает на валидации с внятной ошибкой.
    """
    if not isinstance(raw, dict):
        return raw

    out = dict(raw)
    if not isinstance(out.get("id"), str) or not out["id"]:
        out["id"] = f"redis-bridge-{request_id or uuid.uuid4().hex}"
    if not isinstance(out.get("object"), str) or not out["object"]:
        out["object"] = "chat.completion"
    if not isinstance(out.get("model"), str):
        out["model"] = ""
    if not isinstance(out.get("created"), int):
        try:
            out["created"] = int(out["created"])
        except (KeyError, TypeError, ValueError):
            out["created"] = int(time.time())
    if isinstance(out.get("choices"), list):
        out["choices"] = [
            _normalize_choice(choice, index=index, wire_format=wire_format)
            for index, choice in enumerate(out["choices"])
        ]
    return out


def _handle_terminal(
    fields: dict, *, wire_format: str, request_id: str | None = None,
):
    """Терминальный кусок → ChatCompletion либо APIStatusError.

    Нечитаемое/несовместимое со схемой тело final-конверта — это ответ
    LLM-бэкенда, а не сбой транспорта, поэтому APIStatusError 502
    (server-класс: ретраится по on_5xx, тригерит fallback), а не
    APIConnectionError с вводящим в заблуждение текстом про Redis.
    В сообщение попадает деталь ошибки валидации (какое поле не сошлось):
    без неё по логам СДП причина неотличима от любого другого сбоя схемы.
    """
    if fields.get("kind") == "error":
        # status_code воркера — строка из stream'а; пустая/кривая не должна
        # ронять адаптер голым ValueError мимо иерархии openai.*.
        try:
            code = int(fields.get("status_code") or 502)
        except (TypeError, ValueError):
            code = 502
        message = fields.get("message") or "redis-bridge: ошибка воркера"
        if code == 429 or code >= 500:
            # Эти статусы воркер уже повторял сам — повторять их ещё и здесь
            # значит множить попытки (до 15 реальных вызовов LLM на сообщение).
            raise _backend_error(code, message)
        raise _status_error(code, message)
    try:
        raw = json.loads(fields["body"])
    except (KeyError, TypeError, ValueError) as exc:
        raise _schema_error(
            f"redis-bridge: нечитаемое тело ответа воркера ({exc})",
        ) from exc
    # ДО общего try: это сбой бэкенда, а не разбора, и подменять его
    # BridgeSchemaError'ом нельзя.
    failed_reason = _failed_finish_reason(raw)
    if failed_reason is not None:
        raise _backend_error(
            502,
            "redis-bridge: бэкенд не выполнил генерацию "
            f"(finish_reason={failed_reason!r})",
        )
    try:
        completion = ChatCompletion.model_validate(
            _normalize_completion_payload(
                raw, wire_format=wire_format, request_id=request_id,
            ),
        )
        if wire_format == "gigachat":
            from app.domains.chat.services.gigachat_adapter import (
                _translate_response,
            )
            completion = _translate_response(completion)
    except Exception as exc:
        logger.warning(
            "redis-bridge: тело ответа воркера не прошло валидацию "
            "(request_id=%s, формат=%s, поля тела=%s): %s",
            request_id, wire_format,
            sorted(raw) if isinstance(raw, dict) else type(raw).__name__,
            exc,
        )
        detail = " ".join(str(exc).split())[:_VALIDATION_MESSAGE_LIMIT]
        raise _schema_error(
            "redis-bridge: тело ответа воркера не соответствует схеме "
            f"ChatCompletion ({type(exc).__name__}: {detail})",
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
        # В try — только обмен с Redis: ошибки разбора терминального куска
        # не должны маскироваться под сбой Redis (_handle_terminal — снаружи).
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
            while time.monotonic() < deadline:
                entries = await redis.xrange(resp_key)
                terminal = _find_terminal(entries)
                if terminal is not None:
                    break
                await asyncio.sleep(POLL_INTERVAL_SEC)
        except Exception as exc:  # ошибки redis-py — connect-класс
            raise APIConnectionError(
                message="redis-bridge: сбой Redis при обмене",
                request=_make_request(),
            ) from exc
        if terminal is None:
            raise BridgeDeadlineError(request=_make_request())
        return _handle_terminal(
            terminal, wire_format=client._target, request_id=request_id,
        )


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
