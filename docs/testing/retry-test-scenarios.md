# Retry: сценарии для тестов (Волна 3)

Документ описывает поведение `retry_on_transient`
(`app/domains/chat/services/retry.py`) после расширения coverage (Stream 3.8).

Конфигурация по умолчанию: `on_429=True, on_5xx=True, max_attempts=N, connect_max_attempts=M, backoff_base=B`.

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

| # | Сценарий | Исключение / HTTP | Класс | Ожидание |
|---|----------|-------------------|-------|----------|
| 1 | Rate-limit повторяемый | `APIStatusError(429)` | transient | Ретрай, успех на 2-3 попытке |
| 2 | Rate-limit отключён | `APIStatusError(429)`, `on_429=False` | — | Без ретрая, проброс |
| 3 | Server error 500 | `APIStatusError(500)` | transient | Ретрай |
| 4 | Server error 502 Bad Gateway | `APIStatusError(502)` | transient | Ретрай |
| 5 | Server error 503 Service Unavailable | `APIStatusError(503)` | transient | Ретрай |
| 6 | Server error 504 Gateway Timeout | `APIStatusError(504)` | transient | Ретрай |
| 7 | 5xx отключены | `APIStatusError(503)`, `on_5xx=False` | — | Без ретрая |
| 8 | 408 Request Timeout | `APIStatusError(408)` | transient | Ретрай (всегда, независимо от флагов) |
| 9 | 400 Bad Request | `APIStatusError(400)` | — | Без ретрая, проброс |
| 10 | 401 Unauthorized | `APIStatusError(401)` | — | Без ретрая |
| 11 | 403 Forbidden | `APIStatusError(403)` | — | Без ретрая |
| 12 | 404 Not Found | `APIStatusError(404)` | — | Без ретрая |
| 13 | 422 Unprocessable Entity | `APIStatusError(422)` | — | Без ретрая |
| 14 | Сеть: `httpx.ConnectError` | подключение оборвано | **connect** | Ретрай |
| 15 | Сеть: `httpx.ReadTimeout` | чтение зависло | transient | Ретрай |
| 16 | Сеть: `httpx.WriteTimeout` | запись зависла | transient | Ретрай |
| 17 | Сеть: `httpx.RemoteProtocolError` | сервер закрыл соединение преждевременно | transient | Ретрай |
| 18 | Сеть: `httpx.PoolTimeout` | исчерпан пул соединений | **connect** | Ретрай |
| 19 | OpenAI SDK: `APITimeoutError` | обёртка над `httpx.ReadTimeout`; подкласс `APIConnectionError`, но ловится первым как transient | transient | Ретрай |
| 20 | OpenAI SDK: `APIConnectionError` | «чистый» обрыв без таймаута; обёртка над `httpx.ConnectError` | **connect** | Ретрай |
| 21 | Доменное: `ChatLimitError` | лимит токенов/сообщений | — | Без ретрая |
| 22 | Доменное: `ChatFileValidationError` | невалидный файл | — | Без ретрая |
| 23 | Доменное: `ChatRateLimitError` | per-user rate-limit | — | Без ретрая |
| 24 | Произвольное `ValueError` / `RuntimeError` | бизнес-логика | — | Без ретрая |
| 25 | Исчерпание попыток | retryable, не успело — `max_attempts=2`, всегда 429 | transient | Проброс последнего исключения |
| 26 | Без ошибок | функция возвращает результат сразу | — | Один вызов, результат отдан |
| 27 | Backoff растёт экспоненциально | retryable 3 раза подряд | transient | Задержки `B*1`, `B*2`, `B*4` (+ jitter), capped at 60s |

## Пример теста

Минимальный сценарий — 5xx ретраится, успех на N-й попытке (см. `tests/domains/chat/test_retry.py`):

```python
from openai import APIStatusError
from httpx import Request, Response
from app.domains.chat.services.retry import retry_on_transient

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

Ключевое: `backoff_base=0.0` убирает реальный sleep (остаётся только jitter `[0, 0.5)`), счётчик `calls["n"]` проверяет ровно столько обращений, сколько ожидаем. Для негативных сценариев (типа «404 не ретраится») вместо счётчика — `pytest.raises(APIStatusError)`.

## Edge-cases

- `code is None` в `APIStatusError` — не ретраить (на всякий случай защищены).
- `backoff_base=0.0` в тестах — задержка фактически равна jitter `[0, 0.5)`, тесты должны
  моки `asyncio.sleep`, чтобы не тормозили pytest.
- `_NEVER_RETRY_EXC` имеет приоритет над `_RETRYABLE_NETWORK_EXC`: если доменное
  исключение наследует `httpx.HTTPError`, оно всё равно не ретраится (на данный
  момент таких пересечений нет, проверка для будущего).

## Что НЕ покрыто (намеренно)

- Тесты, где провайдер возвращает 200 с пустым телом / битым JSON — это
  не retry-зона, а парсинг-логика оркестратора.
- Поллинг канала к внешнему агенту (`AgentChannelPoller`) — у него собственный
  механизм adaptive-backoff и таймаута ответа (`ANSWER_TIMEOUT_SEC`), а не
  `retry_on_transient`, см. `app/domains/chat/services/agent_channel_poller.py`.
