"""Тесты MetricsBatcher — generic-аккумулятора метрик с двойным триггером flush."""

from __future__ import annotations

import asyncio
import logging

import pytest

from app.core.metrics_batcher import MetricsBatcher


@pytest.fixture(autouse=True)
def _propagate_metrics_batcher_logger():
    """Включает propagate на batcher-логгере и его родителе.

    В app.core.logging.setup_logging выставляется propagate=False на
    `audit_workstation` (избежать дублей с uvicorn). В тестах нам нужны
    записи в caplog (root), поэтому временно включаем propagation на всём
    пути до root.
    """
    names = ("audit_workstation", "audit_workstation.metrics_batcher")
    originals: dict[str, bool] = {}
    for name in names:
        log = logging.getLogger(name)
        originals[name] = log.propagate
        log.propagate = True
    yield
    for name, val in originals.items():
        logging.getLogger(name).propagate = val


class _CallbackTracker:
    """Хелпер: накапливает вызовы callback'а для проверки в тестах."""

    def __init__(self):
        self.batches: list[list] = []
        # Управляемая задержка внутри callback'а — для теста stop-во-время-flush.
        self.delay_sec: float = 0.0
        # Если True — callback бросает исключение.
        self.raise_exc: bool = False

    async def __call__(self, batch: list) -> None:
        if self.delay_sec > 0:
            await asyncio.sleep(self.delay_sec)
        if self.raise_exc:
            raise RuntimeError("flush failed")
        # Сохраняем копию — иначе batcher может переиспользовать список.
        self.batches.append(list(batch))


async def test_flush_by_size_triggers_callback():
    """Достижение max_batch_size — мгновенный flush."""
    tracker = _CallbackTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=5,
        flush_interval_sec=1000.0,  # таймер не должен сработать
        name="t1",
    )
    # Добавляем ровно 5 — должен быть один flush.
    for i in range(5):
        await batcher.add(i)
    assert tracker.batches == [[0, 1, 2, 3, 4]]
    # Добавляем ещё 1 — не должно быть нового flush.
    await batcher.add(99)
    assert len(tracker.batches) == 1


async def test_flush_by_size_with_overflow():
    """max_batch_size + 1 записей: 1 flush с max_batch_size, 1 в буфере."""
    tracker = _CallbackTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=3,
        flush_interval_sec=1000.0,
        name="t2",
    )
    for i in range(4):
        await batcher.add(i)
    # Первый flush на 3-й записи; четвёртая осталась в буфере.
    assert tracker.batches == [[0, 1, 2]]
    # Финальный flush — оставшийся 1.
    await batcher.stop()
    assert tracker.batches == [[0, 1, 2], [3]]


async def test_flush_by_timer():
    """Если буфер не наполнен — фоновый таймер всё равно делает flush."""
    tracker = _CallbackTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=100,
        flush_interval_sec=0.05,
        name="t3",
    )
    await batcher.start()
    await batcher.add(1)
    await batcher.add(2)
    # Ждём один цикл таймера.
    await asyncio.sleep(0.15)
    await batcher.stop()
    # Минимум один flush должен был случиться по таймеру.
    flushed = [item for batch in tracker.batches for item in batch]
    assert flushed == [1, 2]


async def test_max_buffer_size_drops_old_records(caplog):
    """При переполнении max_buffer_size старые записи дропаются с warning-логом."""
    tracker = _CallbackTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=1000,  # не триггерится по размеру
        flush_interval_sec=1000.0,
        max_buffer_size=5,
        name="t4",
    )
    caplog.set_level(logging.WARNING, logger="audit_workstation.metrics_batcher")
    # Добавляем 10 записей при max_buffer=5: первые 5 должны дропнуться.
    for i in range(10):
        await batcher.add(i)
    # Финальный flush — только последние 5.
    await batcher.stop()
    assert tracker.batches == [[5, 6, 7, 8, 9]]
    # Должен быть хотя бы один warning о дропе.
    drop_warnings = [
        r for r in caplog.records
        if "буфер переполнен" in r.getMessage()
    ]
    assert len(drop_warnings) >= 1


async def test_final_flush_on_stop():
    """stop() сбрасывает остаток буфера через callback."""
    tracker = _CallbackTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=100,
        flush_interval_sec=1000.0,
        name="t5",
    )
    for i in range(3):
        await batcher.add(i)
    # До stop() ничего не записалось.
    assert tracker.batches == []
    await batcher.stop()
    assert tracker.batches == [[0, 1, 2]]


async def test_callback_exception_does_not_propagate_and_drops_batch(caplog):
    """Падение callback'а: warning-лог, наружу не пробрасывается, batch НЕ возвращается."""
    tracker = _CallbackTracker()
    tracker.raise_exc = True
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=3,
        flush_interval_sec=1000.0,
        name="t6",
    )
    caplog.set_level(logging.WARNING, logger="audit_workstation.metrics_batcher")
    # Не должно быть исключения.
    for i in range(3):
        await batcher.add(i)
    # Записи в callback ушли, но он упал.
    # Должен быть warning о потере.
    assert any(
        "записей потеряно" in r.getMessage() for r in caplog.records
    )
    # Буфер пуст: записи не возвращены.
    tracker.raise_exc = False
    await batcher.stop()
    # При stop ничего нового — буфер пуст.
    assert tracker.batches == []


async def test_size_flush_runs_outside_caller_task():
    """Flush по порогу не исполняется в task'е вызывающего add().

    Вызывающий может держать соединение/транзакцию (аудит внутри
    save-content), а flush_callback берёт своё соединение из пула — в том же
    task'е страж get_db счёл бы это повторным захватом и flush падал бы
    с потерей пакета. Отдельный task = отдельный контекст.
    """
    caller_task = asyncio.current_task()
    flush_tasks: list[asyncio.Task | None] = []

    class _TaskTracker(_CallbackTracker):
        async def __call__(self, batch: list) -> None:
            flush_tasks.append(asyncio.current_task())
            await super().__call__(batch)

    tracker = _TaskTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=3,
        flush_interval_sec=1000.0,
        name="t_task_identity",
    )
    for i in range(3):
        await batcher.add(i)
    # Контракт сохранён: flush завершён к возврату add()...
    assert tracker.batches == [[0, 1, 2]]
    # ...но исполнялся в собственном task'е, не в task'е вызывающего.
    assert flush_tasks and flush_tasks[0] is not caller_task


async def test_parallel_add_serialised_by_lock():
    """Параллельные add() корректно сериализуются: все записи доходят, нет дублей."""
    tracker = _CallbackTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=10,
        flush_interval_sec=1000.0,
        name="t7",
    )
    # 30 параллельных add() — три flush по 10.
    await asyncio.gather(*(batcher.add(i) for i in range(30)))
    await batcher.stop()
    all_records = [item for batch in tracker.batches for item in batch]
    assert sorted(all_records) == list(range(30))
    assert len(all_records) == 30  # нет дублей и потерь


async def test_stop_waits_for_active_flush():
    """stop() ждёт завершения активного flush, не теряет уже стартовавший callback."""
    tracker = _CallbackTracker()
    tracker.delay_sec = 0.1  # callback искусственно медленный
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=2,
        flush_interval_sec=1000.0,
        name="t8",
    )
    # Добавляем 2 — стартует flush (асинхронно держится delay_sec).
    add_task = asyncio.create_task(batcher.add(1))
    await asyncio.sleep(0)
    add_task2 = asyncio.create_task(batcher.add(2))
    await asyncio.gather(add_task, add_task2)
    # Теперь stop — он должен дождаться текущего callback'а.
    await batcher.stop()
    # Первый batch попал в tracker.
    assert tracker.batches == [[1, 2]]


async def test_start_stop_idempotent():
    """Повторный start() и stop() не падают."""
    tracker = _CallbackTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=100,
        flush_interval_sec=1000.0,
        name="t9",
    )
    # stop() до start() — ok.
    await batcher.stop()
    await batcher.start()
    await batcher.start()  # повторный — no-op.
    await batcher.stop()
    await batcher.stop()  # повторный — no-op.
    assert tracker.batches == []


async def test_empty_buffer_flush_does_not_call_callback():
    """Если буфер пуст — callback НЕ вызывается, в т.ч. при stop()."""
    tracker = _CallbackTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=10,
        flush_interval_sec=0.05,
        name="t10",
    )
    await batcher.start()
    # Не добавляем ничего, ждём пару циклов таймера.
    await asyncio.sleep(0.15)
    await batcher.stop()
    assert tracker.batches == []


async def test_logger_uses_name_parameter(caplog):
    """В warning-логах фигурирует имя батчера (name-параметр)."""
    tracker = _CallbackTracker()
    tracker.raise_exc = True
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=2,
        flush_interval_sec=1000.0,
        name="my_metric_xyz",
    )
    caplog.set_level(logging.WARNING, logger="audit_workstation.metrics_batcher")
    await batcher.add(1)
    await batcher.add(2)
    assert any("my_metric_xyz" in r.getMessage() for r in caplog.records)


async def test_size_flush_clears_buffer_immediately():
    """После flush по размеру буфер пустой — следующая запись начинает новый batch."""
    tracker = _CallbackTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=2,
        flush_interval_sec=1000.0,
        name="t11",
    )
    await batcher.add(1)
    await batcher.add(2)  # flush
    await batcher.add(3)
    await batcher.add(4)  # flush
    assert tracker.batches == [[1, 2], [3, 4]]
    await batcher.stop()
    # Stop с пустым буфером — ничего нового.
    assert tracker.batches == [[1, 2], [3, 4]]
