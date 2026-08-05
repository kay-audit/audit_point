"""Тесты observability-полей ``MetricsBatcher`` — ``get_status()``,
``dropped_count``, ``last_flush_at``, ``last_error``.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from app.core.metrics_batcher import MetricsBatcher


@pytest.fixture(autouse=True)
def _propagate_metrics_batcher_logger():
    """Включает propagate на batcher-логгере и его родителе для caplog."""
    names = ("audit_workstation", "audit_workstation.metrics_batcher")
    originals: dict[str, bool] = {}
    for name in names:
        log = logging.getLogger(name)
        originals[name] = log.propagate
        log.propagate = True
    yield
    for name, val in originals.items():
        logging.getLogger(name).propagate = val


async def _noop_flush(batch: list) -> None:
    """Идемпотентный flush, ничего не делает."""
    return None


async def test_get_status_initial_state():
    """До flush'ей: buffer пуст, dropped=0, last_flush_at=None, running=False."""
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=_noop_flush,
        max_batch_size=10,
        flush_interval_sec=1000.0,
        max_buffer_size=100,
        name="status_initial",
    )
    status = batcher.get_status()
    assert status["name"] == "status_initial"
    assert status["buffer_size"] == 0
    assert status["max_buffer_size"] == 100
    assert status["max_batch_size"] == 10
    assert status["flush_interval_sec"] == 1000.0
    assert status["dropped_count"] == 0
    assert status["last_flush_ago_sec"] is None
    assert status["last_error"] is None
    assert status["running"] is False


async def test_get_status_after_successful_flush():
    """После успешного flush'а last_flush_at заполнен, last_error=None."""
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=_noop_flush,
        max_batch_size=2,
        flush_interval_sec=1000.0,
        name="status_flushed",
    )
    await batcher.add(1)
    await batcher.add(2)  # триггерит flush по размеру
    await batcher._drain_threshold_flushes()  # flush по порогу — fire-and-forget
    status = batcher.get_status()
    assert status["last_flush_ago_sec"] is not None
    assert status["last_flush_ago_sec"] >= 0.0
    assert status["last_error"] is None
    assert status["dropped_count"] == 0
    # Буфер должен быть пуст после flush'а.
    assert status["buffer_size"] == 0


async def test_dropped_count_increments_on_overflow():
    """При переполнении ``max_buffer_size`` ``dropped_count`` растёт."""
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=_noop_flush,
        max_batch_size=1000,  # flush по размеру не триггерится
        flush_interval_sec=1000.0,
        max_buffer_size=3,
        name="status_overflow",
    )
    # 10 записей при буфере 3: 7 должны дропнуться.
    for i in range(10):
        await batcher.add(i)
    status = batcher.get_status()
    assert status["dropped_count"] == 7
    assert status["buffer_size"] == 3


async def test_last_error_set_on_flush_failure(caplog):
    """При падении ``flush_callback`` ``last_error`` содержит текст исключения."""

    async def _failing_flush(batch: list) -> None:
        raise RuntimeError("boom")

    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=_failing_flush,
        max_batch_size=2,
        flush_interval_sec=1000.0,
        name="status_failure",
    )
    caplog.set_level(
        logging.WARNING, logger="audit_workstation.metrics_batcher",
    )
    await batcher.add(1)
    await batcher.add(2)  # flush → исключение
    await batcher._drain_threshold_flushes()  # flush по порогу — fire-and-forget
    status = batcher.get_status()
    assert status["last_error"] is not None
    assert "RuntimeError" in status["last_error"]
    assert "boom" in status["last_error"]
    # Записи batch'а считаются потерянными.
    assert status["dropped_count"] == 2


async def test_last_error_cleared_after_successful_flush():
    """После успешного flush'а ``last_error`` сбрасывается в None."""
    call_count = {"n": 0}

    async def _sometimes_failing(batch: list) -> None:
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("first fails")
        # последующие — успешны

    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=_sometimes_failing,
        max_batch_size=1,
        flush_interval_sec=1000.0,
        name="status_recover",
    )
    await batcher.add(1)  # упадёт
    await batcher._drain_threshold_flushes()  # flush по порогу — fire-and-forget
    assert batcher.get_status()["last_error"] is not None
    await batcher.add(2)  # успех
    await batcher._drain_threshold_flushes()
    status = batcher.get_status()
    assert status["last_error"] is None
    assert status["last_flush_ago_sec"] is not None


async def test_get_status_running_field_reflects_task_state():
    """``running`` — True пока фоновый таск жив, False после ``stop()``."""
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=_noop_flush,
        max_batch_size=100,
        flush_interval_sec=1000.0,
        name="status_running",
    )
    assert batcher.get_status()["running"] is False
    await batcher.start()
    # Дать чуть времени, чтобы задача гарантированно встала на await sleep.
    await asyncio.sleep(0)
    assert batcher.get_status()["running"] is True
    await batcher.stop()
    assert batcher.get_status()["running"] is False


async def test_public_properties_match_status():
    """Свойства ``name``/``buffer_size``/``dropped_count``/``last_error`` =
    значениям из ``get_status()``.
    """
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=_noop_flush,
        max_batch_size=100,
        flush_interval_sec=1000.0,
        max_buffer_size=2,
        name="props",
    )
    # Переполним буфер чтобы dropped_count > 0.
    for i in range(5):
        await batcher.add(i)
    status = batcher.get_status()
    assert batcher.name == status["name"] == "props"
    assert batcher.buffer_size == status["buffer_size"]
    assert batcher.dropped_count == status["dropped_count"]
    assert batcher.last_flush_at == batcher._last_flush_at
    assert batcher.last_error == status["last_error"]


async def test_overflow_log_includes_dropped_total(caplog):
    """WARNING-лог при overflow содержит общий счётчик дропов."""
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=_noop_flush,
        max_batch_size=1000,
        flush_interval_sec=1000.0,
        max_buffer_size=2,
        name="overflow_log",
    )
    caplog.set_level(
        logging.WARNING, logger="audit_workstation.metrics_batcher",
    )
    for i in range(5):
        await batcher.add(i)
    drop_records = [
        r for r in caplog.records if "буфер переполнен" in r.getMessage()
    ]
    assert drop_records, "ожидался хотя бы один warning об overflow"
    # extra-поля должны быть доступны через record.__dict__
    rec = drop_records[-1]
    assert getattr(rec, "batcher_name", None) == "overflow_log"
    assert getattr(rec, "dropped_count_total", None) == batcher.dropped_count
