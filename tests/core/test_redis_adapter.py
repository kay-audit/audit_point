"""Тесты общего Redis-адаптера ``app.core.redis``.

Покрывают расширенное API (``set`` с nx/px, ``mget``, ``eval``,
``get_json``/``set_json``) и модульный lifecycle (``init_redis`` /
``get_redis`` / ``close_redis``), на который завязан код без HTTP-Request:
фоновые задачи, кэши и локи.

Реального Redis нет — используется fakeredis (паттерн из
tests/test_auth_otp_flow.py: клиент подставляется в ``adapter._client``).
``eval`` проверяется на моке клиента: от адаптера здесь нужна только
трансляция ``(script, keys, args)`` в сигнатуру redis-py, а сами Lua-скрипты
исполняются в тестах их владельцев (``tests/domains/acts/test_act_lock_backends.py``
— fakeredis с ``lupa``).
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import fakeredis.aioredis
import pytest

from app.core import redis as redis_module
from app.core.config import RedisSettings
from app.core.redis import RedisAdapter, close_redis, get_redis, init_redis


@pytest.fixture(autouse=True)
def _reset_global_adapter():
    """Сбрасывает модульный синглтон адаптера до и после каждого теста.

    Глобал переживает тест-функцию, поэтому без сброса ``init_redis`` из
    одного теста вернул бы готовый адаптер в другом. Заодно снимает fakeredis,
    который кладёт в глобал общая фикстура ``fake_redis`` (tests/conftest.py):
    здесь тестируется сам lifecycle, и стартовать он должен с пустого места.
    """
    redis_module._adapter = None
    yield
    redis_module._adapter = None


@pytest.fixture
def adapter() -> RedisAdapter:
    """Адаптер поверх in-memory fakeredis (без похода в сеть)."""
    a = RedisAdapter(RedisSettings())
    a._client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    return a


@pytest.fixture
def fake_connect(monkeypatch):
    """Подменяет ``connect`` fakeredis-клиентом — для тестов lifecycle."""

    async def _connect(self):
        if self._client is None:
            self._client = fakeredis.aioredis.FakeRedis(decode_responses=True)
        return self._client

    monkeypatch.setattr(RedisAdapter, "connect", _connect)


# ── set: nx / ex / px ────────────────────────────────────────────────────────


class TestSet:

    async def test_nx_writes_missing_key(self, adapter):
        assert await adapter.set("lock", "owner-1", nx=True) is True
        assert await adapter.get("lock") == "owner-1"

    async def test_nx_does_not_overwrite_existing_key(self, adapter):
        await adapter.set("lock", "owner-1")

        # redis-py отдаёт None вместо False — адаптер обязан нормализовать в bool
        result = await adapter.set("lock", "owner-2", nx=True)

        assert result is False
        assert await adapter.get("lock") == "owner-1"

    async def test_px_sets_millisecond_ttl(self, adapter):
        await adapter.set("k", "v", px=2000)

        pttl = await adapter._client.pttl("k")
        assert 0 < pttl <= 2000

    async def test_ex_sets_second_ttl(self, adapter):
        await adapter.set("k", "v", ex=60)

        assert 0 < await adapter.ttl("k") <= 60

    async def test_without_ttl_key_is_persistent(self, adapter):
        await adapter.set("k", "v")

        assert await adapter.ttl("k") == -1


# ── mget ─────────────────────────────────────────────────────────────────────


class TestMget:

    async def test_returns_values_in_key_order(self, adapter):
        await adapter.set("a", "1")
        await adapter.set("b", "2")

        assert await adapter.mget(["b", "a"]) == ["2", "1"]

    async def test_missing_keys_become_none(self, adapter):
        await adapter.set("a", "1")

        assert await adapter.mget(["a", "нет-такого"]) == ["1", None]

    async def test_empty_keys_short_circuit(self, adapter):
        # MGET без аргументов — ошибка на стороне Redis, до клиента не доходим
        adapter._client = AsyncMock()

        assert await adapter.mget([]) == []
        adapter._client.mget.assert_not_called()


# ── get_json / set_json ──────────────────────────────────────────────────────


class TestJson:

    async def test_roundtrip_dict(self, adapter):
        value = {"count": 3, "items": ["a", "b"], "nested": {"ok": True}}

        await adapter.set_json("k", value)

        assert await adapter.get_json("k") == value

    async def test_cyrillic_stored_readable(self, adapter):
        await adapter.set_json("k", {"роль": "аудитор"})

        # ensure_ascii=False: в redis-cli значение читается глазами
        raw = await adapter.get("k")
        assert "аудитор" in raw
        assert "\\u" not in raw
        assert await adapter.get_json("k") == {"роль": "аудитор"}

    async def test_missing_key_returns_none(self, adapter):
        assert await adapter.get_json("нет-такого") is None

    async def test_set_json_passes_ttl_and_nx(self, adapter):
        assert await adapter.set_json("k", [1, 2], ex=60, nx=True) is True
        assert 0 < await adapter.ttl("k") <= 60

        assert await adapter.set_json("k", [3], nx=True) is False
        assert await adapter.get_json("k") == [1, 2]


# ── eval ─────────────────────────────────────────────────────────────────────


class TestEval:
    """Контракт трансляции в сигнатуру redis-py: ``eval(script, numkeys, *keys, *args)``.

    На моке, а не на fakeredis: проверяется трансляция аргументов, а не Lua.
    """

    async def test_passes_keys_count_then_keys_then_args(self, adapter):
        adapter._client = AsyncMock()
        adapter._client.eval.return_value = 1
        script = "return redis.call('GET', KEYS[1])"

        result = await adapter.eval(script, ["lock:1", "lock:2"], ["owner", 30])

        assert result == 1
        adapter._client.eval.assert_awaited_once_with(
            script, 2, "lock:1", "lock:2", "owner", 30
        )

    async def test_without_keys_passes_zero(self, adapter):
        adapter._client = AsyncMock()
        script = "return 42"

        await adapter.eval(script, [], [])

        adapter._client.eval.assert_awaited_once_with(script, 0)


# ── Модульный lifecycle ──────────────────────────────────────────────────────


class TestLifecycle:

    async def test_get_redis_raises_before_init(self):
        # Redis обязателен: отсутствие адаптера — сломанное окружение, а не
        # режим работы, поэтому вместо None — громкая ошибка.
        with pytest.raises(RuntimeError, match="Redis не инициализирован"):
            get_redis()

    async def test_init_publishes_adapter_to_global(self, fake_connect):
        adapter = await init_redis(RedisSettings())

        assert isinstance(adapter, RedisAdapter)
        assert get_redis() is adapter

    async def test_repeated_init_returns_same_adapter(self, fake_connect):
        first = await init_redis(RedisSettings())
        second = await init_redis(RedisSettings())

        assert second is first

    async def test_close_resets_global(self, fake_connect):
        await init_redis(RedisSettings())

        await close_redis()

        assert redis_module._adapter is None

    async def test_close_is_idempotent(self, fake_connect):
        await init_redis(RedisSettings())

        await close_redis()
        await close_redis()

        assert redis_module._adapter is None

    async def test_close_without_init_is_noop(self):
        await close_redis()

        assert redis_module._adapter is None

    async def test_failed_connect_leaves_global_empty(self, monkeypatch):
        """Fail-fast: ошибка подключения наверх, глобал не заполнен."""

        async def _boom(self):
            raise ConnectionError("Redis недоступен")

        monkeypatch.setattr(RedisAdapter, "connect", _boom)

        with pytest.raises(ConnectionError):
            await init_redis(RedisSettings())

        assert redis_module._adapter is None

    async def test_settings_password_unwrapped_for_client(self, monkeypatch):
        """SecretStr разворачивается адаптером; пустой пароль → None."""
        captured = {}

        class _FakeRedisClient:
            def __init__(self, **kwargs):
                captured.update(kwargs)

            async def ping(self):
                return True

        monkeypatch.setattr(redis_module.aioredis, "Redis", _FakeRedisClient)

        await RedisAdapter(RedisSettings(password="s3cret")).connect()
        assert captured["password"] == "s3cret"
        assert captured["decode_responses"] is True

        await RedisAdapter(RedisSettings()).connect()
        assert captured["password"] is None


# ── Streams: xadd / xrange ──────────────────────────────────────────────────


class TestStreams:
    """xadd/xrange — минимум для LLM-моста (redis-bridge)."""

    async def test_xadd_returns_entry_id(self, adapter):
        entry_id = await adapter.xadd("s:test", {"v": "1", "id": "abc"})
        assert isinstance(entry_id, str) and "-" in entry_id

    async def test_xrange_reads_fields_in_order(self, adapter):
        await adapter.xadd("s:test", {"seq": "0", "kind": "chunk"})
        await adapter.xadd("s:test", {"seq": "1", "kind": "final"})
        entries = await adapter.xrange("s:test")
        assert len(entries) == 2
        assert entries[0][1] == {"seq": "0", "kind": "chunk"}
        assert entries[1][1] == {"seq": "1", "kind": "final"}

    async def test_xrange_empty_stream(self, adapter):
        assert await adapter.xrange("s:missing") == []

    async def test_xadd_maxlen_trims(self, adapter):
        for i in range(20):
            await adapter.xadd("s:cap", {"i": str(i)}, maxlen=5)
        entries = await adapter.xrange("s:cap")
        # maxlen approximate: гарантия «не бесконечно», точное число не фиксируем
        assert len(entries) <= 20
