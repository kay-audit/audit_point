"""Тесты LLM-транспорта redis-bridge (без реального воркера).

Redis — fakeredis через autouse-фикстуру ``fake_redis`` (tests/conftest.py).
Роль воркера играют прямые записи в стримы через адаптер.
"""
import asyncio
import json

import pytest
from openai import APIConnectionError, APIStatusError, APITimeoutError, NOT_GIVEN

from app.domains.chat.services.redis_bridge_adapter import (
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

    async def test_silence_raises_timeout(self, fake_redis):
        await put_heartbeat(fake_redis, ["openai"])
        client = make_client("openai", timeout=0.5)  # короткий дедлайн
        with pytest.raises(APITimeoutError):
            await client.chat.completions.create(
                model="m", messages=[], tools=NOT_GIVEN, temperature=0.1,
            )

    async def test_explicit_timeout_kwarg_wins(self, fake_redis):
        await put_heartbeat(fake_redis, ["openai"])
        client = make_client("openai", timeout=30.0)
        started = asyncio.get_event_loop().time()
        with pytest.raises(APITimeoutError):
            await client.chat.completions.create(
                model="m", messages=[], tools=NOT_GIVEN,
                temperature=0.1, timeout=0.4,
            )
        assert asyncio.get_event_loop().time() - started < 5.0
