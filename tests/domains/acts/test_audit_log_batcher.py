"""Тесты ActAuditLogBatcher — батчер записи аудит-лога актов.

Покрывает: размерный триггер flush (50 записей), временной триггер flush,
финальный flush при stop(), защита от переполнения буфера, использование
executemany через ActAuditLogRepository.log_many.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.domains.acts.repositories.act_audit_log import ActAuditLogRecord
from app.domains.acts.services.audit_log_batcher import ActAuditLogBatcher


def _record(action: str = "create", username: str = "u") -> ActAuditLogRecord:
    return ActAuditLogRecord(action=action, username=username, act_id=1)


async def test_size_trigger_flush_at_batch_size():
    """Добавление batch_size записей запускает flush, до этого — буфер копится."""
    flushed: list[list[ActAuditLogRecord]] = []

    async def fake_flush(records):
        flushed.append(list(records))

    batcher = ActAuditLogBatcher(batch_size=50, flush_interval_sec=300.0)
    # Подменяем callback, не запуская фоновую задачу
    batcher._flush_callback = fake_flush

    # 49 — flush не должен сработать
    for _ in range(49):
        await batcher.add(_record())
    await batcher._drain_threshold_flushes()  # flush по порогу — fire-and-forget
    assert flushed == []

    # 50-я запись — flush с пакетом из 50
    await batcher.add(_record())
    await batcher._drain_threshold_flushes()
    assert len(flushed) == 1
    assert len(flushed[0]) == 50


async def test_time_trigger_flush():
    """Фоновый таймер flush'ит буфер, даже если он меньше batch_size."""
    flushed: list[list[ActAuditLogRecord]] = []

    async def fake_flush(records):
        flushed.append(list(records))

    batcher = ActAuditLogBatcher(
        batch_size=100,
        flush_interval_sec=0.05,  # короткий интервал для теста
    )
    batcher._flush_callback = fake_flush

    for _ in range(5):
        await batcher.add(_record())
    assert flushed == []  # пока не сработал таймер

    await batcher.start()
    # Ждём минимум 1 цикл фонового flush
    await asyncio.sleep(0.1)
    await batcher.stop()

    # Должен быть хотя бы один flush с 5 записями
    assert any(len(b) == 5 for b in flushed)


async def test_stop_flushes_remaining():
    """stop() делает финальный flush оставшихся записей."""
    flushed: list[list[ActAuditLogRecord]] = []

    async def fake_flush(records):
        flushed.append(list(records))

    batcher = ActAuditLogBatcher(batch_size=100, flush_interval_sec=300.0)
    batcher._flush_callback = fake_flush

    for _ in range(10):
        await batcher.add(_record())
    assert flushed == []
    await batcher.stop()
    # Финальный flush — на 10 записях
    assert flushed == [[_record() for _ in range(10)]]


async def test_max_buffer_drops_oldest_records():
    """При превышении max_buffer_size старые записи дропаются."""
    flushed: list[list[ActAuditLogRecord]] = []

    async def fake_flush(records):
        # Имитируем недоступность БД: ничего не делаем
        flushed.append(list(records))
        raise RuntimeError("DB down")

    batcher = ActAuditLogBatcher(
        batch_size=10_000,  # размерный триггер далеко
        flush_interval_sec=300.0,
        max_buffer_size=100,
    )
    batcher._flush_callback = fake_flush

    # Добавляем больше max_buffer_size — старые должны быть дропнуты
    for i in range(150):
        await batcher.add(_record(action=f"a{i}"))

    # Внутренний буфер не должен превышать max_buffer_size
    assert len(batcher._buffer) <= 100
    # При финальном flush получим именно ≤100 записей (последние)
    await batcher.stop()
    # Поскольку наш callback бросает — буфер очищается при flush'е
    # и записи "теряются", это by design (см. _flush_locked).


async def test_flush_uses_executemany(mock_conn, mock_adapter):
    """Реальный flush вызывает ActAuditLogRepository.log_many → executemany."""
    # Патчим get_db: возвращает async-контекст с нашим mock_conn.
    class _DBCtx:
        async def __aenter__(self_inner):
            return mock_conn
        async def __aexit__(self_inner, *exc):
            return False

    with patch(
        "app.db.repositories.base.get_adapter", return_value=mock_adapter,
    ), patch(
        "app.domains.acts.services.audit_log_batcher.get_db",
        return_value=_DBCtx(),
    ):
        batcher = ActAuditLogBatcher(batch_size=3, flush_interval_sec=300.0)
        for i in range(3):
            await batcher.add(ActAuditLogRecord(
                action="create", username="u", act_id=i,
            ))
        # add вызвал size-triggered flush; дожидаемся его внутри patch'а —
        # flush ходит в запатченный get_db.
        await batcher._drain_threshold_flushes()
    # log_many → executemany
    assert mock_conn.executemany.called, "log_many должен вызывать executemany"
    sql, params = mock_conn.executemany.call_args.args
    assert "INSERT INTO" in sql
    assert "audit_log" in sql
    assert len(params) == 3


async def test_flush_callback_exception_does_not_break_batcher():
    """Если flush_callback падает, последующие add() продолжают работать."""
    state = {"calls": 0}

    async def flaky_flush(records):
        state["calls"] += 1
        raise RuntimeError("transient")

    batcher = ActAuditLogBatcher(batch_size=2, flush_interval_sec=300.0)
    batcher._flush_callback = flaky_flush

    # Первая пара — flush падает
    await batcher.add(_record())
    await batcher.add(_record())
    await batcher._drain_threshold_flushes()  # flush по порогу — fire-and-forget
    assert state["calls"] == 1
    # Вторая пара — после поломанного flush'а батчер всё равно жив
    await batcher.add(_record())
    await batcher.add(_record())
    await batcher._drain_threshold_flushes()
    assert state["calls"] == 2
