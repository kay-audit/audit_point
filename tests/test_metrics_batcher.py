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


async def _settle(batcher: MetricsBatcher) -> None:
    """Дожидается fire-and-forget flush'ей по порогу — точка синхронизации.

    Flush по порогу к возврату ``add()`` ещё не исполнен, поэтому тестам
    нужна явная точка ожидания. ``asyncio.sleep(0)`` не годится: число тиков
    до завершения callback'а не определено — получились бы флаки. Ждём сами
    task'и (тем же способом, что и ``stop()``), это детерминированно.
    """
    await batcher._drain_threshold_flushes()


async def test_flush_by_size_triggers_callback():
    """Достижение max_batch_size — flush ровно на этих записях."""
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
    await _settle(batcher)
    assert tracker.batches == [[0, 1, 2, 3, 4]]
    # Добавляем ещё 1 — не должно быть нового flush.
    await batcher.add(99)
    await _settle(batcher)
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
    for i in range(3):
        await batcher.add(i)
    # Первый flush — ровно на 3 записях.
    await _settle(batcher)
    assert tracker.batches == [[0, 1, 2]]
    # Четвёртая остаётся в буфере: порог не достигнут.
    await batcher.add(3)
    # Финальный flush — оставшийся 1.
    await batcher.stop()
    assert tracker.batches == [[0, 1, 2], [3]]


async def test_size_threshold_is_soft_under_burst():
    """Порог «мягкий»: пачка add() без уступки циклу уходит одним пакетом.

    Flush по порогу — fire-and-forget, буфер он забирает уже в своём task'е.
    Записи, добавленные до его старта, попадают в тот же пакет, поэтому
    фактический размер пакета может превысить ``max_batch_size``.
    """
    tracker = _CallbackTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=3,
        flush_interval_sec=1000.0,
        name="t_soft_threshold",
    )
    for i in range(5):
        await batcher.add(i)
    await _settle(batcher)
    assert tracker.batches == [[0, 1, 2, 3, 4]]
    # Ничего не потеряно и не задвоено.
    await batcher.stop()
    assert tracker.batches == [[0, 1, 2, 3, 4]]


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
    await _settle(batcher)
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
    await _settle(batcher)
    assert tracker.batches == [[0, 1, 2]]
    # Flush исполнялся в собственном task'е, не в task'е вызывающего.
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
    """stop() ждёт завершения активного flush, не теряет уже стартовавший callback.

    Единственная точка ожидания fire-and-forget flush'ей — ``stop()``.
    """
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


async def test_stop_survives_cancelled_threshold_flush():
    """Отменённый flush-task не роняет stop() — финальный flush всё равно идёт.

    Имитация жёсткого завершения процесса: оркестратор отменяет shutdown-хуки
    по таймауту. ``CancelledError`` — наследник ``BaseException``, обычным
    ``except Exception`` он бы не поймался и прошиб бы ``stop()``, оставив
    буферы остальных батчеров несброшенными.
    """
    tracker = _CallbackTracker()
    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=tracker,
        max_batch_size=2,
        flush_interval_sec=1000.0,
        name="t_cancelled_task",
    )
    await batcher.add(1)
    await batcher.add(2)  # стартовал fire-and-forget flush
    flush_tasks = list(batcher._threshold_flushes)
    assert flush_tasks, "ожидался хотя бы один flush-task по порогу"
    for task in flush_tasks:
        task.cancel()  # отменяем до того, как он успел исполниться
    # stop() не должен упасть...
    await batcher.stop()
    assert flush_tasks[0].cancelled()
    # ...и должен дожать буфер финальным flush'ем: записи не потеряны.
    assert tracker.batches == [[1, 2]]


async def test_cancelled_callback_counts_as_dropped():
    """Отмена внутри callback'а: dropped_count растёт, last_error заполняется.

    Пакет к этому моменту уже вынут из буфера — значит потерян, и
    диагностика обязана это показать, а не отрапортовать «всё хорошо».
    Саму отмену батчер пробрасывает дальше.
    """
    started = asyncio.Event()

    async def _hanging_flush(batch: list) -> None:
        started.set()
        await asyncio.sleep(3600)

    batcher: MetricsBatcher[int] = MetricsBatcher(
        flush_callback=_hanging_flush,
        max_batch_size=2,
        flush_interval_sec=1000.0,
        name="t_cancelled_callback",
    )
    await batcher.add(1)
    await batcher.add(2)
    flush_tasks = list(batcher._threshold_flushes)
    await started.wait()  # callback реально стартовал и забрал пакет
    for task in flush_tasks:
        task.cancel()
    await asyncio.gather(*flush_tasks, return_exceptions=True)

    assert batcher.dropped_count == 2
    assert batcher.last_error is not None
    assert "CancelledError" in batcher.last_error
    assert batcher.buffer_size == 0
    # Отмена не проглочена — task действительно отменён.
    assert flush_tasks[0].cancelled()


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
    await _settle(batcher)
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
    await _settle(batcher)
    await batcher.add(3)
    await batcher.add(4)  # flush
    await _settle(batcher)
    assert tracker.batches == [[1, 2], [3, 4]]
    await batcher.stop()
    # Stop с пустым буфером — ничего нового.
    assert tracker.batches == [[1, 2], [3, 4]]
