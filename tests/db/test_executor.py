"""Юнит-тесты DbExecutor: соединение на операцию, ambient-транзакция, стражи."""

import asyncio
from contextlib import asynccontextmanager

import pytest

import app.db.connection as dbconn
from app.core.exceptions import ServiceUnavailableError
from app.db.executor import DbExecutor, get_executor


class FakeConn:
    """Фейковое соединение: пишет вызовы, эмулирует savepoint-глубину."""

    def __init__(self, pool):
        self.pool = pool
        self.calls = []
        self.tx_depth = 0

    async def fetch(self, query, *args, timeout=None):
        self.calls.append(("fetch", query))
        return [query]

    async def fetchrow(self, query, *args, timeout=None):
        self.calls.append(("fetchrow", query))
        return {"q": query}

    async def fetchval(self, query, *args, column=0, timeout=None):
        self.calls.append(("fetchval", query))
        return 1

    async def execute(self, query, *args, timeout=None):
        self.calls.append(("execute", query))
        return "OK"

    async def executemany(self, command, args, timeout=None):
        self.calls.append(("executemany", command))

    def transaction(self):
        conn = self

        @asynccontextmanager
        async def _tx():
            conn.tx_depth += 1
            conn.calls.append(("tx_begin", conn.tx_depth))
            try:
                yield
            finally:
                conn.calls.append(("tx_end", conn.tx_depth))
                conn.tx_depth -= 1

        return _tx()


class FakePool:
    """Фейковый пул: считает захваты и пиковую занятость."""

    def __init__(self):
        self.live = 0
        self.peak = 0
        self.acquires = 0
        self.conns = []

    async def acquire(self, timeout=None):
        self.live += 1
        self.peak = max(self.peak, self.live)
        self.acquires += 1
        conn = FakeConn(self)
        self.conns.append(conn)
        return conn

    async def release(self, conn):
        self.live -= 1


@pytest.fixture
def fake_pool(monkeypatch):
    pool = FakePool()
    monkeypatch.setattr(dbconn, "_pool", pool)
    monkeypatch.setattr(dbconn, "_acquire_timeout", 1.0)
    return pool


async def test_fetch_acquires_and_releases_per_call(fake_pool):
    ex = DbExecutor()
    await ex.fetch("SELECT 1")
    await ex.execute("UPDATE x")
    assert fake_pool.acquires == 2
    assert fake_pool.live == 0
    assert fake_pool.peak == 1


async def test_transaction_binds_connection(fake_pool):
    ex = DbExecutor()
    async with ex.transaction():
        await ex.fetch("SELECT 1")
        await ex.execute("UPDATE x")
    assert fake_pool.acquires == 1          # всё — на одном соединении
    assert fake_pool.live == 0              # после блока соединение отдано
    conn = fake_pool.conns[0]
    assert ("fetch", "SELECT 1") in conn.calls
    assert ("execute", "UPDATE x") in conn.calls
    assert conn.calls[0] == ("tx_begin", 1)
    assert conn.calls[-1] == ("tx_end", 1)


async def test_nested_transaction_delegates_to_savepoint(fake_pool):
    ex = DbExecutor()
    async with ex.transaction():
        async with ex.transaction():
            await ex.fetch("SELECT 1")
    assert fake_pool.acquires == 1
    conn = fake_pool.conns[0]
    assert ("tx_begin", 2) in conn.calls    # savepoint = вторая глубина


async def test_unbound_after_transaction(fake_pool):
    ex = DbExecutor()
    async with ex.transaction():
        await ex.fetch("SELECT 1")
    await ex.fetch("SELECT 2")
    assert fake_pool.acquires == 2          # второй вызов — новое соединение


async def test_foreign_task_gets_own_connection(fake_pool, caplog):
    ex = DbExecutor()
    async with ex.transaction():
        task = asyncio.create_task(ex.fetch("SELECT child"))
        await task
    assert fake_pool.acquires == 2          # ребёнок НЕ сел на bound-соединение
    assert ("fetch", "SELECT child") in fake_pool.conns[1].calls
    assert any("чужого task" in r.message for r in caplog.records)


async def test_pool_timeout_maps_to_service_unavailable(monkeypatch):
    class TimeoutPool:
        async def acquire(self, timeout=None):
            raise asyncio.TimeoutError

        async def release(self, conn):  # pragma: no cover
            pass

    monkeypatch.setattr(dbconn, "_pool", TimeoutPool())
    monkeypatch.setattr(dbconn, "_acquire_timeout", 0.1)
    with pytest.raises(ServiceUnavailableError):
        await DbExecutor().fetch("SELECT 1")


def test_get_executor_singleton():
    assert get_executor() is get_executor()
