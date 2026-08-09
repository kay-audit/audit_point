"""Сквозные сценарии redis-bridge: create() против фейкового воркера.

Фейковый воркер — корутина на fakeredis: читает stream заявок, отвечает
терминальным куском. Проверяется контракт целиком: конверт → обработка →
ChatCompletion / исключение, плюс переключение primary→fallback breaker'ом.
"""
import asyncio
import json

import pytest
from openai import NOT_GIVEN, APIConnectionError

from app.domains.chat.services.llm_client import (
    _clients_cache,
    build_fallback_client,
    build_llm_client,
)
from app.domains.chat.settings import ChatDomainSettings

ALIVE_KEY = "llm:bridge:worker:alive"
REQUESTS = "llm:bridge:requests"

OPENAI_BODY = {
    "id": "c1", "object": "chat.completion", "created": 1,
    "model": "m", "choices": [{
        "index": 0, "finish_reason": "stop",
        "message": {"role": "assistant", "content": "ok"},
    }],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}


@pytest.fixture(autouse=True)
def clean_clients():
    _clients_cache.clear()
    yield
    _clients_cache.clear()


async def fake_worker(fake_redis, *, targets, behavior):
    """behavior(fields) -> dict полей терминального куска."""
    await fake_redis.set(
        ALIVE_KEY, json.dumps({"worker_id": "w", "targets": targets}), ex=45,
    )
    seen: set[str] = set()
    while True:
        for _eid, fields in await fake_redis.xrange(REQUESTS):
            if fields["id"] in seen:
                continue
            seen.add(fields["id"])
            resp = behavior(fields)
            await fake_redis.xadd(
                "llm:bridge:resp:" + fields["id"],
                {"v": "1", "seq": "0", **resp},
            )
        await asyncio.sleep(0.02)


def ok_behavior(fields):
    return {"kind": "final", "status_code": "200",
            "body": json.dumps(OPENAI_BODY),
            "received_ts": "1", "started_ts": "2", "finished_ts": "3"}


class TestEndToEnd:
    async def test_full_cycle_openai(self, fake_redis):
        worker = asyncio.create_task(fake_worker(
            fake_redis, targets=["openai"], behavior=ok_behavior,
        ))
        await asyncio.sleep(0)  # дать воркеру выставить heartbeat до create()
        try:
            client = build_llm_client(
                ChatDomainSettings(profile="redis-bridge,openai"),
            )
            result = await client.chat.completions.create(
                model="m", messages=[{"role": "user", "content": "q"}],
                tools=NOT_GIVEN, temperature=0.1, timeout=5.0,
            )
            assert result.choices[0].message.content == "ok"
        finally:
            worker.cancel()

    async def test_dead_worker_fast_connection_error(self, fake_redis):
        client = build_llm_client(
            ChatDomainSettings(profile="redis-bridge,openai"),
        )
        started = asyncio.get_event_loop().time()
        with pytest.raises(APIConnectionError):
            await client.chat.completions.create(
                model="m", messages=[], tools=NOT_GIVEN,
                temperature=0.1, timeout=30.0,
            )
        # отказ мгновенный (heartbeat-чек), не ожидание таймаута
        assert asyncio.get_event_loop().time() - started < 1.0

    async def test_primary_gigachat_fallback_openai_same_worker(
        self, fake_redis,
    ):
        """Цель gigachat не заявлена воркером → primary падает
        connection-ошибкой; fallback-клиент (openai-цель) отрабатывает."""
        worker = asyncio.create_task(fake_worker(
            fake_redis, targets=["openai"], behavior=ok_behavior,
        ))
        await asyncio.sleep(0)  # дать воркеру выставить heartbeat до create()
        try:
            settings = ChatDomainSettings(
                profile="redis-bridge,gigachat",
                fallback_profile="redis-bridge,openai",
            )
            primary = build_llm_client(settings)
            with pytest.raises(APIConnectionError):
                await primary.chat.completions.create(
                    model="m", messages=[], tools=NOT_GIVEN,
                    temperature=0.1, timeout=5.0,
                )
            fallback = build_fallback_client(settings)
            result = await fallback.chat.completions.create(
                model="m", messages=[], tools=NOT_GIVEN,
                temperature=0.1, timeout=5.0,
            )
            assert result.choices[0].message.content == "ok"
        finally:
            worker.cancel()
