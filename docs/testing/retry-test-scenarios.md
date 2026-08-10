# Retry: сценарии для тестов (Волна 3)

Документ описывает поведение `retry_on_transient`
(`app/domains/chat/services/retry.py`) после расширения coverage (Stream 3.8).

Конфигурация по умолчанию (`RetryPolicy` в `app/domains/chat/settings.py`,
env-префикс `CHAT__RETRY__`): `on_429=True`, `on_5xx=True`, `max_attempts=5`,
`connect_max_attempts=2`, `backoff_base_sec=2.0`. В таблице ниже эти значения
обозначены как `N` (transient-лимит), `M` (connect-лимит) и `B` (база backoff'а).

| Параметр | Описание |
|---|---|
| `max_attempts` | Лимит попыток для **transient-класса** (сервер жив, но медленный/занят): HTTP 408/429/5xx, ReadTimeout, WriteTimeout, RemoteProtocolError, APITimeoutError |
| `connect_max_attempts` | Лимит попыток для **connect-класса** (сервер недоступен): ConnectError, PoolTimeout, APIConnectionError (только «чистый», без таймаута). Обычно меньше `max_attempts` для быстрого fallback при лежащем primary-LLM |

## Таблица сценариев

> Колонка «Класс» указывает лимит попыток: **transient** → `max_attempts`, **connect** → `connect_max_attempts`.
> `APITimeoutError` — подкласс `APIConnectionError`, но является transient-классом и перехватывается первым.
>
> Исключение: `BridgeDeadlineError` (redis-мост, подкласс `APITimeoutError`) НЕ ретраится —
> дедлайн моста равен полному `CHAT__REQUEST_TIMEOUT`, повтор клал бы дубль-заявку в stream;
> fallback при этом срабатывает как обычно. Тест — `tests/domains/chat/test_redis_bridge_adapter.py::TestDeadlineNotRetried`.

Колонка «Тест» — фактическое покрытие в `tests/domains/chat/test_retry.py`
(если не указан другой файл); `—` означает, что сценарий описан, но теста на
него сейчас нет.

| # | Сценарий | Исключение / HTTP | Класс | Ожидание | Тест |
|---|----------|-------------------|-------|----------|------|
| 1 | Rate-limit повторяемый | `APIStatusError(429)` | transient | Ретрай, успех на 2-3 попытке | `test_retries_on_429_when_enabled` |
| 2 | Rate-limit отключён | `APIStatusError(429)`, `on_429=False` | — | Без ретрая, проброс | `test_does_not_retry_on_429_when_disabled` |
| 3 | Server error 500 | `APIStatusError(500)` | transient | Ретрай | `test_retries_on_5xx_codes[500]` |
| 4 | Server error 502 Bad Gateway | `APIStatusError(502)` | transient | Ретрай | `test_retries_on_5xx_codes[502]` |
| 5 | Server error 503 Service Unavailable | `APIStatusError(503)` | transient | Ретрай | `test_retries_on_5xx_when_enabled`, `test_retries_on_5xx_codes[503]` |
| 6 | Server error 504 Gateway Timeout | `APIStatusError(504)` | transient | Ретрай | `test_retries_on_5xx_codes[504]` |
| 7 | 5xx отключены | `APIStatusError(503)`, `on_5xx=False` | — | Без ретрая | — |
| 8 | 408 Request Timeout | `APIStatusError(408)` | transient | Ретрай (всегда, независимо от флагов) | `test_retries_on_408_always` |
| 9 | 400 Bad Request | `APIStatusError(400)` | — | Без ретрая, проброс | `test_does_not_retry_on_non_retryable_4xx[400]`, `test_does_not_retry_on_4xx_other_than_429` |
| 10 | 401 Unauthorized | `APIStatusError(401)` | — | Без ретрая | `test_does_not_retry_on_non_retryable_4xx[401]` |
| 11 | 403 Forbidden | `APIStatusError(403)` | — | Без ретрая | `test_does_not_retry_on_non_retryable_4xx[403]`, `test_does_not_retry_on_403` |
| 12 | 404 Not Found | `APIStatusError(404)` | — | Без ретрая | `test_does_not_retry_on_non_retryable_4xx[404]` |
| 13 | 422 Unprocessable Entity | `APIStatusError(422)` | — | Без ретрая | `test_does_not_retry_on_non_retryable_4xx[422]` |
| 14 | Сеть: `httpx.ConnectError` | подключение оборвано | **connect** | Ретрай | `test_retries_on_network_errors[httpx.ConnectError]`, `test_connect_class_uses_connect_max_attempts` |
| 15 | Сеть: `httpx.ReadTimeout` | чтение зависло | transient | Ретрай | `test_retries_on_network_errors[httpx.ReadTimeout]`, `test_transient_class_read_timeout_uses_max_attempts` |
| 16 | Сеть: `httpx.WriteTimeout` | запись зависла | transient | Ретрай | `test_retries_on_network_errors[httpx.WriteTimeout]` |
| 17 | Сеть: `httpx.RemoteProtocolError` | сервер закрыл соединение преждевременно | transient | Ретрай | `test_retries_on_network_errors[httpx.RemoteProtocolError]` |
| 18 | Сеть: `httpx.PoolTimeout` | исчерпан пул соединений | **connect** | Ретрай | `test_retries_on_network_errors[httpx.PoolTimeout]`, `test_connect_class_pool_timeout_uses_connect_max_attempts` |
| 19 | OpenAI SDK: `APITimeoutError` | обёртка над `httpx.ReadTimeout`; подкласс `APIConnectionError`, но ловится первым как transient | transient | Ретрай | `test_retries_on_openai_api_timeout_error`, `test_api_timeout_error_goes_transient_path_not_connect` |
| 20 | OpenAI SDK: `APIConnectionError` | «чистый» обрыв без таймаута; обёртка над `httpx.ConnectError` | **connect** | Ретрай | `test_retries_on_openai_api_connection_error`, `test_openai_api_connection_error_uses_connect_max_attempts` |
| 21 | Доменное: `ChatLimitError` | лимит токенов/сообщений | — | Без ретрая | `test_does_not_retry_chat_limit_error` |
| 22 | Доменное: `ChatFileValidationError` | невалидный файл | — | Без ретрая | `test_does_not_retry_chat_file_validation_error` |
| 23 | Доменное: `ChatRateLimitError` | per-user rate-limit | — | Без ретрая | `test_does_not_retry_chat_rate_limit_error` |
| 24 | Произвольное `ValueError` / `RuntimeError` | бизнес-логика | — | Без ретрая | `test_does_not_retry_arbitrary_value_error` |
| 25 | Исчерпание попыток | retryable, не успело — `max_attempts=2`, всегда 429 | transient | Проброс последнего исключения | `test_max_attempts_exhausted_reraises` |
| 26 | Без ошибок | функция возвращает результат сразу | — | Один вызов, результат отдан | `test_returns_immediately_when_no_error` |
| 27 | Backoff растёт экспоненциально | retryable 3 раза подряд | transient | Задержки `B*1`, `B*2`, `B*4` (+ jitter), capped at 60s | `test_backoff_grows_exponentially`, `test_backoff_capped_at_60_seconds` |
| 28 | `status_code` не определён | `APIStatusError` с `status_code=None` | — | Без ретрая (защитный кейс) | `test_status_error_with_none_code_does_not_retry` |
| 29 | 5xx идёт по transient-лимиту | `APIStatusError(500)`, `max_attempts` > `connect_max_attempts` | transient | Попыток ровно `max_attempts` | `test_transient_class_5xx_uses_max_attempts` |
| 30 | Обрыв, затем успех | `httpx.ConnectError` один раз | **connect** | Успех на второй попытке, счётчик не исчерпан | `test_mixed_connect_then_success` |
| 31 | Дедлайн redis-моста | `BridgeDeadlineError` (подкласс `APITimeoutError`) | — | Без ретрая, проброс (fallback при этом работает) | `test_redis_bridge_adapter.py::TestDeadlineNotRetried::test_retry_does_not_repeat_bridge_deadline` |

## Пример теста

Минимальный сценарий — 5xx ретраится, успех на N-й попытке (см. `tests/domains/chat/test_retry.py`):

```python
from openai import APIStatusError
from httpx import Request, Response
from app.domains.chat.services.retry import retry_on_transient as _retry_on_transient


# Тестовый враппер из test_retry.py: production-функция дефолта для
# connect_max_attempts НЕ имеет (все пять параметров keyword-only и
# обязательны), а старым сценариям этот лимит не важен — берём заведомо
# больший, чтобы попытки ограничивал max_attempts.
def retry_on_transient(*, connect_max_attempts: int = 10, **kwargs):
    return _retry_on_transient(connect_max_attempts=connect_max_attempts, **kwargs)


def _fake_status_error(code: int) -> APIStatusError:
    resp = Response(code, request=Request("POST", "http://x"))
    return APIStatusError(message="x", response=resp, body=None)

async def test_retries_on_5xx_then_succeeds():
    calls = {"n": 0}

    @retry_on_transient(on_429=False, on_5xx=True, max_attempts=3, backoff_base=0.0)
    async def fn():
        calls["n"] += 1
        if calls["n"] < 2:
            raise _fake_status_error(503)
        return "ok"

    assert await fn() == "ok"
    assert calls["n"] == 2   # одна неудачная попытка + одна успешная
```

Ключевое: `backoff_base=0.0` убирает реальный sleep (остаётся только jitter `[0, 0.5)`), счётчик `calls["n"]` проверяет ровно столько обращений, сколько ожидаем. Для негативных сценариев (типа «404 не ретраится») вместо счётчика — `pytest.raises(APIStatusError)`. Тесты connect-класса передают `connect_max_attempts` явно и мокают `asyncio.sleep`, чтобы считать задержки.

## Edge-cases

- `code is None` в `APIStatusError` — не ретраить (защитный кейс, сценарий 28).
- `backoff_base=0.0` в тестах — задержка фактически равна jitter `[0, 0.5)`; там, где
  важен сам факт и величина пауз, `asyncio.sleep` мокается, чтобы не тормозить pytest.
- `_NEVER_RETRY_EXC` (`ChatLimitError`, `ChatFileValidationError`, `ChatRateLimitError`,
  `BridgeDeadlineError`) ловится ПЕРВЫМ — раньше `APIStatusError`, `APITimeoutError`,
  `_TRANSIENT_NETWORK_EXC` и `_CONNECT_NETWORK_EXC`. Поэтому подкласс ретраябельного
  исключения (как `BridgeDeadlineError` от `APITimeoutError`) не ретраится, даже если
  базовый класс ретраится.

## Что НЕ покрыто (намеренно)

- Тесты, где провайдер возвращает 200 с пустым телом / битым JSON — это
  не retry-зона, а парсинг-логика оркестратора.
- Поллинг канала к внешнему агенту (`AgentChannelPoller`) — у него собственный
  механизм adaptive-backoff и таймаута ответа (`ANSWER_TIMEOUT_SEC`), а не
  `retry_on_transient`, см. `app/domains/chat/services/agent_channel_poller.py`.
