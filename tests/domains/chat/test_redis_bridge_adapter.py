"""Тесты LLM-транспорта redis-bridge (без реального воркера).

Redis — fakeredis через autouse-фикстуру ``fake_redis`` (tests/conftest.py).
Роль воркера играют прямые записи в стримы через адаптер.
"""
import asyncio
import json
from unittest.mock import patch

import pytest
from openai import APIConnectionError, APIStatusError, APITimeoutError, NOT_GIVEN

from app.domains.chat.services.redis_bridge_adapter import (
    BridgeDeadlineError,
    BridgePollError,
    RedisBridgeClient,
)

ALIVE_KEY = "llm:bridge:worker:alive"


def make_client(target: str = "openai", timeout: float = 5.0) -> RedisBridgeClient:
    return RedisBridgeClient(
        target=target, key_prefix="llm:bridge:", timeout=timeout,
    )


async def put_heartbeat(fake_redis, targets: list[str]) -> None:
    await fake_redis.set(
        ALIVE_KEY,
        json.dumps({"worker_id": "test", "targets": targets}),
        ex=45,
    )


class TestWorkerAvailability:
    async def test_models_list_ok_when_alive_with_target(self, fake_redis):
        await put_heartbeat(fake_redis, ["openai", "gigachat"])
        assert await make_client("openai").models.list() == []

    async def test_no_heartbeat_raises_connection_error(self, fake_redis):
        with pytest.raises(APIConnectionError):
            await make_client("openai").models.list()

    async def test_target_missing_raises_connection_error(self, fake_redis):
        await put_heartbeat(fake_redis, ["gigachat"])  # openai не заявлен
        with pytest.raises(APIConnectionError):
            await make_client("openai").models.list()

    async def test_broken_heartbeat_json_raises(self, fake_redis):
        await fake_redis.set(ALIVE_KEY, "не json", ex=45)
        with pytest.raises(APIConnectionError):
            await make_client("openai").models.list()

    async def test_heartbeat_json_not_object_raises_connection_error(
        self, fake_redis,
    ):
        """Валидный JSON, но не объект ('[]', '"ok"') — контракт модуля
        обязывает APIConnectionError, а не AttributeError мимо retry/fallback."""
        for raw in ("[]", '"ok"', "42"):
            await fake_redis.set(ALIVE_KEY, raw, ex=45)
            with pytest.raises(APIConnectionError):
                await make_client("openai").models.list()

    async def test_unhealthy_target_fails_probe_but_not_create(
        self, fake_redis,
    ):
        """target_health=false: probe (models.list) видит отказ, а
        пользовательский create работает — ложноотрицательный health-check
        воркера не должен блокировать реальные запросы."""
        await fake_redis.set(
            ALIVE_KEY,
            json.dumps({
                "worker_id": "test",
                "targets": ["openai"],
                "target_health": {"openai": False},
            }),
            ex=45,
        )
        with pytest.raises(APIConnectionError):
            await make_client("openai").models.list()

        client = make_client("openai", timeout=5.0)
        task = asyncio.create_task(client.chat.completions.create(
            model="m", messages=[{"role": "user", "content": "q"}],
            tools=NOT_GIVEN, temperature=0.1,
        ))
        await worker_reply(
            fake_redis, kind="final",
            extra={"status_code": "200",
                   "body": json.dumps(OPENAI_RESPONSE_BODY)},
        )
        result = await task
        assert result.choices[0].message.content == "Привет!"

    async def test_healthy_target_passes_probe(self, fake_redis):
        await fake_redis.set(
            ALIVE_KEY,
            json.dumps({
                "worker_id": "test",
                "targets": ["openai"],
                "target_health": {"openai": True},
            }),
            ex=45,
        )
        assert await make_client("openai").models.list() == []

    async def test_missing_target_health_treated_as_healthy(self, fake_redis):
        """Совместимость: heartbeat без target_health (старый воркер) —
        probe проходит по одному наличию цели в targets."""
        await put_heartbeat(fake_redis, ["openai"])
        assert await make_client("openai").models.list() == []

    async def test_aclose_is_noop(self, fake_redis):
        await make_client().aclose()  # не бросает


OPENAI_RESPONSE_BODY = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 1700000000,
    "model": "qwen-8b",
    "choices": [{
        "index": 0,
        "finish_reason": "stop",
        "message": {"role": "assistant", "content": "Привет!"},
    }],
    "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
}


async def worker_reply(fake_redis, *, kind: str, extra: dict) -> dict:
    """Мини-воркер: дождаться заявки, ответить терминальным куском."""
    entries = []
    for _ in range(200):  # до ~2 сек
        entries = await fake_redis.xrange("llm:bridge:requests")
        if entries:
            break
        await asyncio.sleep(0.01)
    assert entries, "заявка не появилась в стриме"
    fields = entries[-1][1]
    resp_key = "llm:bridge:resp:" + fields["id"]
    await fake_redis.xadd(resp_key, {"v": "1", "seq": "0", "kind": kind, **extra})
    return fields


class TestCreateOpenAI:
    async def test_happy_path_returns_chat_completion(self, fake_redis):
        await put_heartbeat(fake_redis, ["openai"])
        client = make_client("openai", timeout=5.0)

        async def call():
            return await client.chat.completions.create(
                model="qwen-8b",
                messages=[{"role": "user", "content": "привет"}],
                tools=NOT_GIVEN,
                temperature=0.1,
            )

        task = asyncio.create_task(call())
        await worker_reply(
            fake_redis, kind="final",
            extra={
                "status_code": "200",
                "body": json.dumps(OPENAI_RESPONSE_BODY),
                "received_ts": "1", "started_ts": "2", "finished_ts": "3",
            },
        )
        result = await task
        assert result.choices[0].message.content == "Привет!"
        assert result.usage.total_tokens == 8

    async def test_request_envelope_fields(self, fake_redis):
        await put_heartbeat(fake_redis, ["openai"])
        client = make_client("openai", timeout=5.0)
        task = asyncio.create_task(client.chat.completions.create(
            model="qwen-8b",
            messages=[{"role": "user", "content": "q"}],
            tools=NOT_GIVEN,
            temperature=0.2,
        ))
        fields = await worker_reply(
            fake_redis, kind="final",
            extra={"status_code": "200", "body": json.dumps(OPENAI_RESPONSE_BODY)},
        )
        await task
        assert fields["v"] == "1"
        assert fields["target"] == "openai"
        assert fields["path"] == "/chat/completions"
        assert float(fields["deadline_ts"]) > 0
        body = json.loads(fields["body"])
        assert body["model"] == "qwen-8b"
        assert body["messages"] == [{"role": "user", "content": "q"}]
        assert body["temperature"] == 0.2
        assert "tools" not in body       # NOT_GIVEN отброшен
        assert "stream" not in body

    async def test_error_5xx_maps_to_api_status_error(self, fake_redis):
        await put_heartbeat(fake_redis, ["openai"])
        client = make_client("openai", timeout=5.0)
        task = asyncio.create_task(client.chat.completions.create(
            model="m", messages=[], tools=NOT_GIVEN, temperature=0.1,
        ))
        await worker_reply(
            fake_redis, kind="error",
            extra={"status_code": "502", "message": "GigaChat недоступен"},
        )
        with pytest.raises(APIStatusError) as exc_info:
            await task
        assert exc_info.value.status_code == 502

    async def test_error_4xx_maps_to_api_status_error(self, fake_redis):
        await put_heartbeat(fake_redis, ["openai"])
        client = make_client("openai", timeout=5.0)
        task = asyncio.create_task(client.chat.completions.create(
            model="m", messages=[], tools=NOT_GIVEN, temperature=0.1,
        ))
        await worker_reply(
            fake_redis, kind="error",
            extra={"status_code": "422", "message": "валидация"},
        )
        with pytest.raises(APIStatusError) as exc_info:
            await task
        assert exc_info.value.status_code == 422

    async def test_silence_raises_deadline_error(self, fake_redis):
        """Тишина до дедлайна — BridgeDeadlineError (подкласс APITimeoutError,
        fallback срабатывает), а не голый APITimeoutError (тот бы ретраился)."""
        await put_heartbeat(fake_redis, ["openai"])
        client = make_client("openai", timeout=0.5)  # короткий дедлайн
        with pytest.raises(BridgeDeadlineError):
            await client.chat.completions.create(
                model="m", messages=[], tools=NOT_GIVEN, temperature=0.1,
            )
        assert issubclass(BridgeDeadlineError, APITimeoutError)

    async def test_explicit_timeout_kwarg_wins(self, fake_redis):
        await put_heartbeat(fake_redis, ["openai"])
        client = make_client("openai", timeout=30.0)
        started = asyncio.get_event_loop().time()
        with pytest.raises(BridgeDeadlineError):
            await client.chat.completions.create(
                model="m", messages=[], tools=NOT_GIVEN,
                temperature=0.1, timeout=0.4,
            )
        assert asyncio.get_event_loop().time() - started < 5.0

    async def test_malformed_final_body_maps_to_502_not_redis_error(
        self, fake_redis,
    ):
        """Тело final-конверта не по схеме ChatCompletion → APIStatusError 502
        с причиной разбора, а НЕ APIConnectionError «сбой Redis»."""
        await put_heartbeat(fake_redis, ["openai"])
        client = make_client("openai", timeout=5.0)
        task = asyncio.create_task(client.chat.completions.create(
            model="m", messages=[], tools=NOT_GIVEN, temperature=0.1,
        ))
        await worker_reply(
            fake_redis, kind="final",
            extra={"status_code": "200", "body": "{это не json"},
        )
        with pytest.raises(APIStatusError) as exc_info:
            await task
        assert exc_info.value.status_code == 502
        assert "Redis" not in str(exc_info.value.message)

    async def test_schema_mismatch_final_body_maps_to_502(self, fake_redis):
        await put_heartbeat(fake_redis, ["openai"])
        client = make_client("openai", timeout=5.0)
        task = asyncio.create_task(client.chat.completions.create(
            model="m", messages=[], tools=NOT_GIVEN, temperature=0.1,
        ))
        await worker_reply(
            fake_redis, kind="final",
            extra={"status_code": "200",
                   "body": json.dumps({"совсем": "не ChatCompletion"})},
        )
        with pytest.raises(APIStatusError) as exc_info:
            await task
        assert exc_info.value.status_code == 502


class TestBridgeErrorsNotRetried:
    """Исключения моста, возникшие ПОСЛЕ постановки заявки в stream,
    ретраю не подлежат: повтор положил бы дубль-конверт."""

    async def test_retry_does_not_repeat_bridge_deadline(self):
        """retry_on_transient не повторяет BridgeDeadlineError: дедлайн моста
        равен полному request_timeout, повтор клал бы дубль-заявку в stream."""
        import httpx

        from app.domains.chat.services.retry import retry_on_transient

        calls = {"n": 0}

        @retry_on_transient(
            on_429=True, on_5xx=True, max_attempts=5,
            connect_max_attempts=2, backoff_base=0.0,
        )
        async def failing():
            calls["n"] += 1
            raise BridgeDeadlineError(
                request=httpx.Request("POST", "http://x/chat/completions"),
            )

        with pytest.raises(BridgeDeadlineError):
            await failing()
        assert calls["n"] == 1

    async def test_retry_does_not_repeat_bridge_poll_error(self):
        """BridgePollError — подкласс APIConnectionError (connect-класс
        ретраится), но ловится раньше него и не повторяется."""
        import httpx

        from app.domains.chat.services.retry import retry_on_transient

        calls = {"n": 0}

        @retry_on_transient(
            on_429=True, on_5xx=True, max_attempts=5,
            connect_max_attempts=3, backoff_base=0.0,
        )
        async def failing():
            calls["n"] += 1
            raise BridgePollError(
                message="redis лёг",
                request=httpx.Request("POST", "http://x/chat/completions"),
            )

        with pytest.raises(BridgePollError):
            await failing()
        assert calls["n"] == 1
        assert issubclass(BridgePollError, APIConnectionError)


class _FlakyRedis:
    """Заглушка Redis: heartbeat живой, xadd/xrange падают по сценарию."""

    def __init__(self, *, xadd_exc=None, xrange_exc=None):
        self._xadd_exc = xadd_exc
        self._xrange_exc = xrange_exc
        self.xadd_calls = 0

    async def get(self, key):
        return json.dumps({"worker_id": "test", "targets": ["openai"]})

    async def xadd(self, *args, **kwargs):
        self.xadd_calls += 1
        if self._xadd_exc is not None:
            raise self._xadd_exc
        return "1-1"

    async def xrange(self, key):
        if self._xrange_exc is not None:
            raise self._xrange_exc
        return []


def _retry_wrapped(coro_factory):
    """create() под тем же retry, что и в проде (connect-лимит 3)."""
    from app.domains.chat.services.retry import retry_on_transient

    return retry_on_transient(
        on_429=True, on_5xx=True, max_attempts=5,
        connect_max_attempts=3, backoff_base=0.0,
    )(coro_factory)


class TestSubmitVersusPollFailure:
    """Сбой Redis ДО постановки заявки ретраится, ПОСЛЕ — нет.

    Регрессия на двойной запрос к LLM: раньше один try накрывал и xadd,
    и поллинг, любой сбой давал ретраибельный APIConnectionError, и повтор
    клал ВТОРОЙ конверт с новым request_id, пока воркер исполнял первый.
    """

    async def _create(self, client):
        return await client.chat.completions.create(
            model="m", messages=[{"role": "user", "content": "q"}],
            tools=NOT_GIVEN, temperature=0.1,
        )

    async def test_xadd_failure_stays_retryable_connection_error(self):
        """Заявка в stream не попала — обычный APIConnectionError, ретрай
        безопасен (дубля не будет) и происходит по connect-лимиту."""
        fake = _FlakyRedis(xadd_exc=RuntimeError("redis лёг на xadd"))
        client = make_client("openai", timeout=5.0)

        call = _retry_wrapped(lambda: self._create(client))
        with patch("app.core.redis.get_redis", return_value=fake):
            with pytest.raises(APIConnectionError) as exc_info:
                await call()

        assert not isinstance(exc_info.value, BridgePollError)
        assert fake.xadd_calls == 3   # connect_max_attempts

    async def test_poll_failure_does_not_resubmit_envelope(self):
        """Заявка уже в stream — BridgePollError, повторного xadd нет."""
        fake = _FlakyRedis(xrange_exc=RuntimeError("redis лёг на поллинге"))
        client = make_client("openai", timeout=5.0)

        call = _retry_wrapped(lambda: self._create(client))
        with patch("app.core.redis.get_redis", return_value=fake):
            with pytest.raises(BridgePollError):
                await call()

        assert fake.xadd_calls == 1


GIGACHAT_RESPONSE_BODY = {
    "id": "chatcmpl-2",
    "object": "chat.completion",
    "created": 1700000000,
    "model": "GigaChat-3-Ultra",
    "choices": [{
        "index": 0,
        "finish_reason": "function_call",
        "message": {
            "role": "assistant",
            "content": "",
            "function_call": {
                "name": "search_acts",
                "arguments": {"query": "КМ-25"},
            },
        },
    }],
    "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
}


class TestCreateGigachat:
    async def test_body_translated_to_native_format(self, fake_redis):
        await put_heartbeat(fake_redis, ["gigachat"])
        client = make_client("gigachat", timeout=5.0)
        task = asyncio.create_task(client.chat.completions.create(
            model="GigaChat-3-Ultra",
            messages=[
                {"role": "user", "content": "найди акт"},
                {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "call_1", "type": "function",
                    "function": {"name": "search_acts",
                                 "arguments": '{"query": "КМ-25"}'},
                }]},
                {"role": "tool", "tool_call_id": "call_1", "content": "нашёл"},
            ],
            tools=[{"type": "function", "function": {
                "name": "search_acts", "description": "Поиск актов",
                "parameters": {"type": "object", "properties": {}},
            }}],
            temperature=0.1,
        ))
        fields = await worker_reply(
            fake_redis, kind="final",
            extra={"status_code": "200",
                   "body": json.dumps(GIGACHAT_RESPONSE_BODY)},
        )
        await task
        body = json.loads(fields["body"])
        assert fields["target"] == "gigachat"
        # tools → плоские functions (native GigaChat)
        assert body["functions"] == [{
            "name": "search_acts", "description": "Поиск актов",
            "parameters": {"type": "object", "properties": {}},
        }]
        assert "tools" not in body
        # assistant tool_calls → function_call c arguments-DICT
        assistant = body["messages"][1]
        assert assistant["function_call"] == {
            "name": "search_acts", "arguments": {"query": "КМ-25"},
        }
        assert assistant["content"] == ""          # не None (422 у GigaChat)
        # tool → role=function c name по mapping
        assert body["messages"][2] == {
            "role": "function", "name": "search_acts", "content": "нашёл",
        }

    async def test_response_function_call_translated_to_tool_calls(
        self, fake_redis,
    ):
        await put_heartbeat(fake_redis, ["gigachat"])
        client = make_client("gigachat", timeout=5.0)
        task = asyncio.create_task(client.chat.completions.create(
            model="GigaChat-3-Ultra",
            messages=[{"role": "user", "content": "найди"}],
            tools=NOT_GIVEN, temperature=0.1,
        ))
        await worker_reply(
            fake_redis, kind="final",
            extra={"status_code": "200",
                   "body": json.dumps(GIGACHAT_RESPONSE_BODY)},
        )
        result = await task
        msg = result.choices[0].message
        assert msg.function_call is None
        assert len(msg.tool_calls) == 1
        assert msg.tool_calls[0].function.name == "search_acts"
        # arguments dict → JSON-строка (контракт OpenAI SDK)
        assert json.loads(msg.tool_calls[0].function.arguments) == {
            "query": "КМ-25",
        }
        assert result.choices[0].finish_reason == "tool_calls"
