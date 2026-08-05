"""Общие фикстуры для тестов."""

import fakeredis.aioredis
import pytest
from unittest.mock import AsyncMock, MagicMock

from app.core import domain_registry
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

    Патчим и следствие (``dbconn._strict_acquire_guard`` — то, что реально
    читает ``get_db()``), и источник (``DATABASE__STRICT_ACQUIRE_GUARD`` в
    окружении): ``init_db()`` перезаписывает следствие значением из
    настоящего ``Settings``, а тот читает окружение — без ``setenv`` тест,
    зовущий ``init_db(Settings())`` (не mock, как сегодняшние вызовы),
    получил бы строгость по локальному ``.env`` разработчика вместо
    гарантированного ``True``. ``get_settings()`` кэширует ``Settings`` через
    ``lru_cache`` — сбрасываем кэш до и после теста: без этого ``setenv`` не
    подействует на уже закэшированный инстанс, а инстанс, закэшированный
    внутри этого теста, протечёт в следующий уже после отката monkeypatch.
    """
    import app.db.connection as dbconn
    from app.core.config import get_settings

    monkeypatch.setattr(dbconn, "_strict_acquire_guard", True)
    monkeypatch.setenv("DATABASE__STRICT_ACQUIRE_GUARD", "true")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


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


def register_fake_push_factory(push_mock: AsyncMock | None = None) -> MagicMock:
    """Регистрирует фейковую фабрику ``notifications.push`` в реестре доменов.

    Общий хелпер для продьюсеров уведомлений (acts, chat, core) — раньше был
    побайтовой копией в трёх тест-файлах. Фабрика — callable без аргументов,
    отдающий сервис напрямую (зеркало реального контракта ``_push_factory``).

    ``push_mock`` — готовый мок для ``svc.push``, если вызывающему тесту нужна
    прямая ссылка на него (например, чтобы задать ``side_effect`` до
    регистрации, как делают тесты chat). Без аргумента создаётся свежий
    ``AsyncMock(return_value="notif-id-1")``.

    Возвращает мок-сервиса — на его ``svc.push`` проверяют вызов. Реестр
    фабрик (``app.core.domain_registry``) глобальный: сброс — на вызывающем
    тест-файле (autouse-фикстура ``domain_registry.reset_registry()`` до и
    после теста), эта функция сама ничего не откатывает.
    """
    svc = MagicMock()
    svc.push = push_mock if push_mock is not None else AsyncMock(return_value="notif-id-1")

    domain_registry.register_factory("notifications.push", lambda: svc)
    return svc
