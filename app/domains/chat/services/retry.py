"""Декоратор повторных попыток для transient-ошибок LLM-провайдера.

Сценарии retry (для agent-tests Волны 3 — см. docs/testing/retry-test-scenarios.md):
  - Ретраится: HTTP 408 (Request Timeout), 429 (Rate Limit, если on_429),
    500..599 (server errors, если on_5xx), сетевые ошибки httpx
    (ConnectError, ReadTimeout, WriteTimeout, RemoteProtocolError, PoolTimeout).
  - НЕ ретраится: HTTP 400/401/403/404/422 и прочие 4xx, доменные исключения
    чата (ChatLimitError, ChatFileValidationError, ChatRateLimitError и т.п.),
    BridgeDeadlineError redis-моста (дедлайн = полный request_timeout,
    повтор породил бы дубль-заявку в stream), BridgeSchemaError redis-моста
    (разбор ответа детерминирован — повтор даст тот же результат ценой
    нового вызова LLM), любые иные исключения.

Два класса ретраябельных ошибок с разными лимитами попыток:
  - **connect-class** (сервер недоступен, обрыв соединения) — fast-fail с
    лимитом `connect_max_attempts` (обычно меньше), чтобы при лежащем primary-LLM
    быстро упасть на fallback, а не выжидать полный цикл. Сюда входят:
    httpx.ConnectError, httpx.PoolTimeout, openai.APIConnectionError (только
    «чистый», без таймаута).
  - **transient-class** (сервер жив, но занят/медленный) — лимит `max_attempts`.
    Сюда входят: HTTP 408/429/5xx, httpx.ReadTimeout, httpx.WriteTimeout,
    httpx.RemoteProtocolError, openai.APITimeoutError.

ВАЖНО: openai.APITimeoutError — подкласс openai.APIConnectionError, но это
«сервер медленный», а не «лёг», поэтому относится к transient-классу и ловится
раньше APIConnectionError.

Backoff: экспоненциальный с джиттером —
  delay_n = min(backoff_base * 2 ** (n-1) + random.uniform(0, 0.5), 60.0).
"""
from __future__ import annotations

import asyncio
import logging
import random
from functools import wraps
from typing import Any, Callable, TypeVar

import httpx
from openai import APIStatusError, APITimeoutError, APIConnectionError

from app.domains.chat.exceptions import (
    ChatFileValidationError,
    ChatLimitError,
    ChatRateLimitError,
)
from app.domains.chat.services.redis_bridge_adapter import (
    BridgeDeadlineError,
    BridgeSchemaError,
)

logger = logging.getLogger("audit_workstation.chat.retry")

F = TypeVar("F", bound=Callable[..., Any])

# HTTP-коды, ретраящиеся независимо от других флагов.
# 408 Request Timeout — сервер сам говорит, что не уложился, повтор уместен.
_ALWAYS_RETRY_STATUS = frozenset({408})

# Сетевые ошибки httpx «сервер недоступен / обрыв соединения» — connect-класс
# (fast-fail с лимитом connect_max_attempts).
_CONNECT_NETWORK_EXC: tuple[type[BaseException], ...] = (
    httpx.ConnectError,
    httpx.PoolTimeout,
)

# Сетевые ошибки httpx «сервер жив, но медленный / оборвал ответ» —
# transient-класс (лимит max_attempts).
_TRANSIENT_NETWORK_EXC: tuple[type[BaseException], ...] = (
    httpx.ReadTimeout,
    httpx.WriteTimeout,
    httpx.RemoteProtocolError,
)

# Исключения, которые НЕ должны ретраиться:
# - доменные исключения чата — валидационные/бизнес-ошибки, повтор не поможет;
# - BridgeDeadlineError — дедлайн redis-моста уже равен полному
#   request_timeout; повтор клал бы в stream новую заявку (воркер исполнял
#   бы дубли против LLM) и умножал бы время ожидания пользователя.
#   Ловится ЗДЕСЬ, до APITimeoutError (он её подкласс). Fallback при этом
#   срабатывает как обычно (llm_call._is_provider_failure видит
#   APITimeoutError-иерархию);
# - BridgeSchemaError — ответ воркера не разобрался в ChatCompletion.
#   Разбор детерминирован: тот же ответ не станет валидным со второй попытки,
#   а каждый повтор = новая заявка в stream = новый реальный вызов LLM.
#   Ловится ЗДЕСЬ, до APIStatusError (он её подкласс, статус 502 иначе попал
#   бы под on_5xx). Переход на следующий маршрут при этом работает как обычно.
_NEVER_RETRY_EXC: tuple[type[BaseException], ...] = (
    ChatLimitError,
    ChatFileValidationError,
    ChatRateLimitError,
    BridgeDeadlineError,
    BridgeSchemaError,
)


def retry_on_transient(
    *,
    on_429: bool,
    on_5xx: bool,
    max_attempts: int,
    connect_max_attempts: int,
    backoff_base: float,
) -> Callable[[F], F]:
    """Повторяет async-вызов на transient-ошибках провайдера LLM.

    Какие ошибки повторяются и с каким лимитом попыток:
      - **transient-класс** (лимит max_attempts) — сервер жив, но занят/медленный:
        - HTTP 408 (request timeout) — всегда
        - HTTP 429 (rate limit) — если on_429=True
        - HTTP 500..599 (server errors, включая 503 Service Unavailable) —
          если on_5xx=True
        - httpx.ReadTimeout / WriteTimeout / RemoteProtocolError
        - openai.APITimeoutError (обёртка над httpx.ReadTimeout)
      - **connect-класс** (лимит connect_max_attempts, fast-fail) — сервер
        недоступен / обрыв соединения:
        - httpx.ConnectError / httpx.PoolTimeout
        - openai.APIConnectionError (только «чистый», без таймаута)
      - Прочие 4xx (400, 401, 403, 404, 422 и т.п.) — НЕ повторяются;
        это клиентские ошибки, повтор не поможет.
      - Доменные исключения чата (ChatLimitError, ChatFileValidationError,
        ChatRateLimitError) — НЕ повторяются, это бизнес-ошибки.

    ВАЖНО: openai.APITimeoutError — подкласс openai.APIConnectionError, но это
    «сервер медленный», поэтому ловится ПЕРВЫМ и идёт по transient-классу
    (лимит max_attempts), а не по connect-классу.

    Меньший connect_max_attempts позволяет при лежащем primary-LLM быстро упасть
    на fallback, не выжидая полный transient-цикл.

    Между попытками: exponential backoff с небольшим джиттером,
    delay_n = backoff_base * 2 ** (n-1) + random.uniform(0, 0.5), не больше 60с.
    """
    def decorator(func: F) -> F:
        @wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            last_exc: BaseException | None = None
            upper_bound = max(max_attempts, connect_max_attempts)
            for attempt in range(1, upper_bound + 1):
                # is_connect_class определяет лимит попыток для пойманной ошибки.
                is_connect_class = False
                try:
                    return await func(*args, **kwargs)
                except _NEVER_RETRY_EXC:
                    # Доменные ошибки — пробрасываем без повтора.
                    raise
                except APIStatusError as exc:
                    code = getattr(exc, "status_code", None)
                    transient = _is_status_retryable(code, on_429=on_429, on_5xx=on_5xx)
                    if not transient:
                        raise
                    last_exc = exc
                    reason = f"HTTP {code}"
                except APITimeoutError as exc:
                    # APITimeoutError — подкласс APIConnectionError, но это
                    # «сервер медленный» → transient-класс. Ловим ПЕРВЫМ.
                    last_exc = exc
                    reason = type(exc).__name__
                except APIConnectionError as exc:
                    # «Чистый» обрыв соединения (без таймаута) → connect-класс.
                    last_exc = exc
                    reason = type(exc).__name__
                    is_connect_class = True
                except _TRANSIENT_NETWORK_EXC as exc:
                    last_exc = exc
                    reason = type(exc).__name__
                except _CONNECT_NETWORK_EXC as exc:
                    last_exc = exc
                    reason = type(exc).__name__
                    is_connect_class = True

                limit = connect_max_attempts if is_connect_class else max_attempts
                if attempt >= limit:
                    break
                delay = backoff_base * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
                delay = min(delay, 60.0)
                logger.warning(
                    "Временная ошибка LLM (%s, класс=%s), попытка %d/%d, пауза %.2fс",
                    reason,
                    "connect" if is_connect_class else "transient",
                    attempt, limit, delay,
                )
                await asyncio.sleep(delay)
            assert last_exc is not None
            raise last_exc
        return wrapper  # type: ignore[return-value]
    return decorator


def _is_status_retryable(
    code: int | None,
    *,
    on_429: bool,
    on_5xx: bool,
) -> bool:
    """Решает, является ли HTTP-статус повторяемым."""
    if code is None:
        return False
    if code in _ALWAYS_RETRY_STATUS:
        return True
    if code == 429:
        return on_429
    if 500 <= code < 600:
        # Включает 503 Service Unavailable, 502 Bad Gateway, 504 Gateway Timeout
        # и прочие server errors.
        return on_5xx
    return False
