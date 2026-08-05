"""Юнит-тесты DbExecutor: соединение на операцию, ambient-транзакция, стражи."""

import asyncio
import logging
from contextlib import asynccontextmanager

import asyncpg
import pytest

import app.db.connection as dbconn
from app.core.exceptions import ServiceUnavailableError
from app.db.executor import DbExecutor, _current_bound, get_executor


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
            depth = conn.tx_depth
            conn.calls.append(("tx_begin", depth))
            try:
                yield
            except BaseException:
                # Ошибка в теле блока — asyncpg откатывает транзакцию/savepoint
                conn.calls.append(("tx_rollback", depth))
                raise
            else:
                conn.calls.append(("tx_commit", depth))
            finally:
                conn.calls.append(("tx_end", depth))
                conn.tx_depth -= 1

        return _tx()


class FakePool:
    """Фейковый пул: считает захваты, пиковую занятость и следит за release."""

    def __init__(self):
        self.live = 0
        self.peak = 0
        self.acquires = 0
        self.conns = []
        self.released = []

    async def acquire(self, timeout=None):
        self.live += 1
        self.peak = max(self.peak, self.live)
        self.acquires += 1
        conn = FakeConn(self)
        self.conns.append(conn)
        return conn

    async def release(self, conn):
        # Пул реального asyncpg на таком ломается тихо и позже — ловим сразу
        if conn not in self.conns:
            raise AssertionError("release чужого соединения")
        if conn in self.released:
            raise AssertionError("повторный release одного соединения")
        self.released.append(conn)
        self.live -= 1


@pytest.fixture
def fake_pool(monkeypatch):
    pool = FakePool()
    monkeypatch.setattr(dbconn, "_pool", pool)
    monkeypatch.setattr(dbconn, "_acquire_timeout", 1.0)
    # setup_logging() ставит логгеру audit_workstation propagate=False, и если
    # его вызвал любой предыдущий тест (через create_app), caplog на root'е
    # перестаёт видеть WARNING'и стража. Возвращаем распространение на тест.
    monkeypatch.setattr(logging.getLogger("audit_workstation"), "propagate", True)
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


async def test_cancelled_call_releases_connection(fake_pool, monkeypatch):
    """Отмена task'а посреди SQL не теряет соединение (release в finally)."""
    started = asyncio.Event()
    hang = asyncio.Event()

    async def hanging_fetch(query, *args, timeout=None):
        started.set()
        await hang.wait()

    orig_acquire = fake_pool.acquire

    async def acquire(timeout=None):
        conn = await orig_acquire(timeout=timeout)
        conn.fetch = hanging_fetch
        return conn

    monkeypatch.setattr(fake_pool, "acquire", acquire)

    task = asyncio.create_task(DbExecutor().fetch("SELECT hang"))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert fake_pool.live == 0


async def test_cancelled_transaction_releases_and_unbinds(fake_pool):
    """Отмена внутри transaction(): соединение отдано, bound-состояние снято."""
    started = asyncio.Event()
    hang = asyncio.Event()
    ex = DbExecutor()

    async def work():
        async with ex.transaction():
            started.set()
            await hang.wait()

    task = asyncio.create_task(work())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert fake_pool.live == 0
    await ex.fetch("SELECT after")          # не падает и берёт свежее соединение
    assert fake_pool.acquires == 2


async def test_sql_error_in_transaction_releases_and_unbinds(fake_pool, monkeypatch):
    """Ошибка SQL на втором операторе транзакции не «залипает» на соединении.

    Путь, который держит инвариант «после сбоя соединение возвращено в пул,
    а привязка снята»: иначе одно упавшее сохранение выводило бы из строя
    соединение пула (max_size=2) до конца жизни процесса.
    """
    ex = DbExecutor()
    boom = asyncpg.UniqueViolationError("дубль (km_number_digit, part_number)")

    orig_acquire = fake_pool.acquire

    async def acquire(timeout=None):
        conn = await orig_acquire(timeout=timeout)
        if fake_pool.acquires == 1:         # падающее — только первое соединение
            async def failing_execute(query, *args, timeout=None):
                conn.calls.append(("execute", query))
                raise boom

            conn.execute = failing_execute
        return conn

    monkeypatch.setattr(fake_pool, "acquire", acquire)

    with pytest.raises(asyncpg.UniqueViolationError):
        async with ex.transaction():
            await ex.fetch("SELECT 1")                  # первый оператор — ок
            await ex.execute("INSERT INTO acts ...")    # второй — падает

    conn = fake_pool.conns[0]
    assert _current_bound() is None                     # (3) привязка снята
    assert fake_pool.released == [conn]                 # (2) соединение отдано пулу
    assert fake_pool.live == 0
    assert ("tx_rollback", 1) in conn.calls             # транзакция откачена,
    assert ("tx_commit", 1) not in conn.calls           # а не закоммичена

    await ex.fetch("SELECT after")                      # (4) исполнитель работоспособен
    assert fake_pool.acquires == 2                      # и берёт свежее соединение
    assert ("fetch", "SELECT after") in fake_pool.conns[1].calls


async def test_nested_get_db_warns_by_default(fake_pool, caplog, monkeypatch):
    monkeypatch.setattr(dbconn, "_strict_acquire_guard", False)
    async with dbconn.get_db():
        async with dbconn.get_db():
            pass
    assert fake_pool.acquires == 2
    assert any("Повторный захват" in r.message for r in caplog.records)


async def test_nested_get_db_raises_in_strict_mode(fake_pool, monkeypatch):
    monkeypatch.setattr(dbconn, "_strict_acquire_guard", True)
    with pytest.raises(RuntimeError, match="Повторный захват"):
        async with dbconn.get_db():
            async with dbconn.get_db():
                pass


async def test_child_task_acquire_not_flagged_by_guard(fake_pool, monkeypatch, caplog):
    """Наследованная через create_task глубина родителя — не «повторный захват».

    Дочерний task получает копию contextvar'а с ненулевой глубиной родителя,
    но его собственное первое соединение — отдельное и легальное: страж
    обязан считать глубину в рамках одного task (регрессия к задаче #13).
    """
    monkeypatch.setattr(dbconn, "_strict_acquire_guard", True)

    async def child():
        async with dbconn.get_db():
            pass

    async with dbconn.get_db():
        await asyncio.create_task(child())

    assert fake_pool.acquires == 2
    assert not any("Повторный захват" in r.message for r in caplog.records)
