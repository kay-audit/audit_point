"""Тесты бэкендов блокировок актов: Redis (TTL ключа) и in-memory.

Оба бэкенда проходят ОДИН набор проверок — в этом смысл общего интерфейса:
захват свободного акта и повторный захват своим держателем, отказ на чужом
локе, продление, снятие и пачечное чтение. Разъехавшееся поведение сразу
видно по параметру ``backend``.

Redis-бэкенд работает на fakeredis, который исполняет Lua через ``lupa``:
скрипты проверяются настоящим интерпретатором (включая ``cjson``), а не
сравнением их текста с ожидаемым.

Истечение проверяется коротким TTL и реальным ожиданием, без подмены часов:
у Redis срок считает сервер, у in-memory — ``time.monotonic()``, общей точки
для monkeypatch у них нет.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from unittest.mock import patch

import fakeredis.aioredis
import pytest

from app.core.config import RedisSettings
from app.core.redis import RedisAdapter
from app.domains.acts.repositories import act_lock
from app.domains.acts.repositories.act_lock_backends import (
    InMemoryLockBackend,
    RedisLockBackend,
)

USERNAME = "22494524"
OTHER_USER = "11111111"
ACT_ID = 42

# 0.002 мин = 120 мс — блокировка живёт заведомо меньше паузы EXPIRY_WAIT_SEC.
SHORT_MINUTES = 0.002
EXPIRY_WAIT_SEC = 0.25
# Половина короткого TTL: пауза, после которой блокировка ещё жива.
HALF_LIFE_SEC = 0.08


def _make_redis_backend() -> RedisLockBackend:
    """Redis-бэкенд поверх in-memory fakeredis (Lua исполняется по-настоящему)."""
    adapter = RedisAdapter(RedisSettings())
    adapter._client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    return RedisLockBackend(adapter)


@pytest.fixture(params=["memory", "redis"])
def backend(request):
    """Оба бэкенда под одним именем — набор тестов у них общий."""
    if request.param == "memory":
        return InMemoryLockBackend()
    return _make_redis_backend()


# ── захват ───────────────────────────────────────────────────────────────────


class TestAcquire:

    async def test_free_act_is_locked(self, backend):
        info = await backend.acquire(ACT_ID, USERNAME, 15)

        assert info["locked_by"] == USERNAME
        assert isinstance(info["locked_at"], datetime)
        assert info["lock_expires_at"] > info["locked_at"]

    async def test_repeated_acquire_by_owner_extends(self, backend):
        """Повторный захват своим держателем разрешён и продлевает срок."""
        await backend.acquire(ACT_ID, USERNAME, SHORT_MINUTES)
        await asyncio.sleep(HALF_LIFE_SEC)

        again = await backend.acquire(ACT_ID, USERNAME, 15)
        await asyncio.sleep(HALF_LIFE_SEC)

        assert again is not None
        # Первый (короткий) срок уже прошёл — значит TTL действительно обновлён.
        assert await backend.info(ACT_ID) is not None

    async def test_foreign_live_lock_rejects(self, backend):
        await backend.acquire(ACT_ID, OTHER_USER, 15)

        assert await backend.acquire(ACT_ID, USERNAME, 15) is None
        # Диагностика отказа: держатель остался прежним
        assert (await backend.info(ACT_ID))["locked_by"] == OTHER_USER

    async def test_acquire_after_expiry_succeeds(self, backend):
        await backend.acquire(ACT_ID, OTHER_USER, SHORT_MINUTES)
        await asyncio.sleep(EXPIRY_WAIT_SEC)

        info = await backend.acquire(ACT_ID, USERNAME, 15)

        assert info["locked_by"] == USERNAME


# ── продление ────────────────────────────────────────────────────────────────


class TestExtend:

    async def test_own_lock_is_extended(self, backend):
        first = await backend.acquire(ACT_ID, USERNAME, 15)

        result = await backend.extend(ACT_ID, USERNAME, 30)

        assert result["extended"] is True
        assert result["locked_by"] == USERNAME
        assert result["lock_expires_at"] > first["lock_expires_at"]

    async def test_extend_refreshes_ttl(self, backend):
        await backend.acquire(ACT_ID, USERNAME, SHORT_MINUTES)
        await asyncio.sleep(HALF_LIFE_SEC)

        await backend.extend(ACT_ID, USERNAME, 15)
        await asyncio.sleep(HALF_LIFE_SEC)

        assert await backend.info(ACT_ID) is not None

    async def test_foreign_lock_reports_holder(self, backend):
        """Отказ в продлении приходит с состоянием чужого лока — без второго запроса."""
        await backend.acquire(ACT_ID, OTHER_USER, 15)

        result = await backend.extend(ACT_ID, USERNAME, 15)

        assert result["extended"] is False
        assert result["locked_by"] == OTHER_USER
        assert isinstance(result["lock_expires_at"], datetime)

    async def test_expired_lock_reports_no_holder(self, backend):
        """Истёкшая блокировка неотличима от отсутствующей: ключа больше нет."""
        await backend.acquire(ACT_ID, USERNAME, SHORT_MINUTES)
        await asyncio.sleep(EXPIRY_WAIT_SEC)

        result = await backend.extend(ACT_ID, USERNAME, 15)

        assert result == {
            "extended": False, "locked_by": None, "lock_expires_at": None,
        }

    async def test_missing_lock_reports_no_holder(self, backend):
        result = await backend.extend(ACT_ID, USERNAME, 15)

        assert result["extended"] is False
        assert result["locked_by"] is None


# ── снятие ───────────────────────────────────────────────────────────────────


class TestRelease:

    async def test_owner_releases_lock(self, backend):
        await backend.acquire(ACT_ID, USERNAME, 15)

        assert await backend.release(ACT_ID, USERNAME) is True
        assert await backend.info(ACT_ID) is None

    async def test_foreign_lock_survives_release(self, backend):
        await backend.acquire(ACT_ID, OTHER_USER, 15)

        assert await backend.release(ACT_ID, USERNAME) is False
        assert (await backend.info(ACT_ID))["locked_by"] == OTHER_USER

    async def test_release_of_missing_lock_is_false(self, backend):
        assert await backend.release(ACT_ID, USERNAME) is False


# ── чтение ───────────────────────────────────────────────────────────────────


class TestInfo:

    async def test_live_lock_shape(self, backend):
        await backend.acquire(ACT_ID, USERNAME, 15)

        info = await backend.info(ACT_ID)

        assert info["locked_by"] == USERNAME
        assert isinstance(info["lock_expires_at"], datetime)
        # Живой лок по определению не истёк — признак сохранён для AccessGuard
        assert info["lock_expired"] is False

    async def test_expired_lock_is_gone(self, backend):
        await backend.acquire(ACT_ID, USERNAME, SHORT_MINUTES)
        await asyncio.sleep(EXPIRY_WAIT_SEC)

        assert await backend.info(ACT_ID) is None

    async def test_missing_lock_is_none(self, backend):
        assert await backend.info(ACT_ID) is None


class TestBulkInfo:

    async def test_returns_only_locked_acts(self, backend):
        await backend.acquire(1, USERNAME, 15)
        await backend.acquire(3, OTHER_USER, 15)

        result = await backend.bulk_info([1, 2, 3])

        assert set(result) == {1, 3}
        assert result[1]["locked_by"] == USERNAME
        assert result[3]["locked_by"] == OTHER_USER

    async def test_expired_lock_not_reported(self, backend):
        await backend.acquire(1, USERNAME, SHORT_MINUTES)
        await asyncio.sleep(EXPIRY_WAIT_SEC)

        assert await backend.bulk_info([1]) == {}

    async def test_empty_list(self, backend):
        assert await backend.bulk_info([]) == {}


# ── Redis: формат ключа ──────────────────────────────────────────────────────


class TestRedisKeyFormat:
    """Контракт хранения: ключ lock:act:{id}, значение JSON, срок — TTL ключа."""

    async def test_value_is_json_with_ttl(self):
        backend = _make_redis_backend()
        client = backend._redis._client

        await backend.acquire(ACT_ID, USERNAME, 15)

        payload = json.loads(await client.get(f"lock:act:{ACT_ID}"))
        assert payload["locked_by"] == USERNAME
        assert datetime.fromisoformat(payload["locked_until"]) > datetime.fromisoformat(
            payload["locked_at"]
        )
        assert 0 < await client.pttl(f"lock:act:{ACT_ID}") <= 15 * 60_000

    async def test_release_deletes_key(self):
        backend = _make_redis_backend()
        client = backend._redis._client
        await backend.acquire(ACT_ID, USERNAME, 15)

        await backend.release(ACT_ID, USERNAME)

        assert await client.exists(f"lock:act:{ACT_ID}") == 0


# ── выбор бэкенда ────────────────────────────────────────────────────────────


class TestBackendSelection:
    """Бэкенд выбирается один раз: с Redis — Redis, без него — память."""

    @pytest.fixture(autouse=True)
    def _reset_backend(self):
        act_lock._backend = None
        yield
        act_lock._backend = None

    def test_redis_available_selects_redis(self):
        adapter = RedisAdapter(RedisSettings())
        with patch.object(act_lock, "get_redis", return_value=adapter):
            assert isinstance(act_lock.get_lock_backend(), RedisLockBackend)

    def test_no_redis_selects_memory(self):
        with patch.object(act_lock, "get_redis", return_value=None):
            assert isinstance(act_lock.get_lock_backend(), InMemoryLockBackend)

    def test_backend_is_not_reselected(self):
        """Появившийся позже Redis не подменяет бэкенд: живые локи потерялись бы."""
        with patch.object(act_lock, "get_redis", return_value=None):
            first = act_lock.get_lock_backend()

        with patch.object(act_lock, "get_redis", return_value=RedisAdapter(RedisSettings())):
            assert act_lock.get_lock_backend() is first
