"""Тесты LLM-транспорта redis-bridge (без реального воркера).

Redis — fakeredis через autouse-фикстуру ``fake_redis`` (tests/conftest.py).
Роль воркера играют прямые записи в стримы через адаптер.
"""
import json

import pytest
from openai import APIConnectionError

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
