"""Общие фикстуры для тестов."""

import fakeredis.aioredis
import pytest
from unittest.mock import AsyncMock, MagicMock

from app.core import redis as redis_module
from app.core.config import RedisSettings
from app.core.redis import RedisAdapter


@pytest.fixture(autouse=True)
def fake_redis():
    """Подставляет fakeredis в модульный синглтон ``app.core.redis._adapter``.

    Redis обязателен во всех окружениях, включая pytest: ``get_redis()`` больше
    не отдаёт None, а бросает RuntimeError. Фикстура — тест-эквивалент
    startup-хука: без неё упал бы любой код, трогающий кэши или блокировки.

    Свежий инстанс на каждый тест — изоляция ключей: без неё блокировка акта
    из одного теста жила бы 15 минут и ломала соседний. Клиент подставляется
    в ``_client`` напрямую (``connect()`` не зовётся, сети нет) — этот приём
    уже используют тесты ОТП-флоу и бэкенда блокировок. Lua исполняется
    по-настоящему благодаря ``lupa``.
    """
    adapter = RedisAdapter(RedisSettings())
    adapter._client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    redis_module._adapter = adapter
    yield adapter
    redis_module._adapter = None


@pytest.fixture(autouse=True)
def strict_acquire_guard(monkeypatch):
    """Повторный захват соединения в одном task в тестах — всегда ошибка.

    DI больше не держит соединений (ветка connection-per-operation) — любой
    вложенный ``get_db()`` в том же task теперь либо баг, либо забытый
    перевод на ``get_executor()``. Тесты, которые намеренно проверяют
    warning-режим стража, локально возвращают ``False`` через monkeypatch
    (см. ``tests/db/test_executor.py::test_nested_get_db_warns_by_default``).
    """
    import app.db.connection as dbconn

    monkeypatch.setattr(dbconn, "_strict_acquire_guard", True)
    yield


@pytest.fixture
def mock_conn():
    """Mock asyncpg.Connection для unit-тестов репозиториев."""
    conn = AsyncMock()
    conn.fetchrow = AsyncMock()
    conn.fetchval = AsyncMock()
    conn.fetch = AsyncMock()
    conn.execute = AsyncMock()
    conn.executemany = AsyncMock()

    # Mock менеджера транзакций
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)

    return conn


@pytest.fixture
def mock_adapter():
    """Mock DatabaseAdapter для unit-тестов."""
    adapter = MagicMock()
    adapter.get_table_name = lambda name, schema="": name
    adapter.qualify_table_name = lambda name, schema="": name
    adapter.supports_on_conflict = MagicMock(return_value=True)
    return adapter
