"""Накопитель метрик с двойным триггером flush (по размеру буфера и по таймеру).

Снижает нагрузку на БД при высокочастотной записи метрик: вместо одной
INSERT-транзакции на запись — пакет до ``max_batch_size`` записей за один
``executemany`` внутри одной транзакции.

Триггеры flush:

- Размер буфера достиг ``max_batch_size`` — flush запускается сразу, но
  отдельным task'ом и без ожидания (см. ниже про «мягкий» порог).
- Прошло ``flush_interval_sec`` секунд после последнего flush — flush даже
  если буфер не полный (фоновая задача в ``start()``).
- Вызван ``stop()`` — финальный flush (например, при shutdown).

Порог ``max_batch_size`` — **мягкий**. Flush по порогу исполняется в
собственном task'е по принципу fire-and-forget: ``add()`` не ждёт его
завершения, потому что вызывающий может сам сидеть в транзакции и держать
соединение, а flush берёт из пула второе (пул на 2 слота — ожидание
привело бы к упору в ACQUIRE_TIMEOUT). Из-за этого записи, добавленные,
пока flush-task ещё не стартовал, попадают в тот же пакет: фактический
размер пакета может превысить ``max_batch_size``. Для ``executemany``
это безвредно.

Как следствие: гарантии «запись уже в БД к возврату ``add()``» нет.
Единственная точка ожидания — ``stop()``: он дожидается активных flush'ей
по порогу и делает финальный flush.

Защита от переполнения: если ``max_buffer_size`` превышен (например,
БД недоступна и фоновый flush падает) — старые записи дропаются с одной
warning-записью, чтобы не съесть память процесса.

Класс — generic по типу записи: каждый поток метрик создаёт собственный
батчер со своим ``flush_callback``. Глобального singleton'а нет.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Generic, TypeVar

T = TypeVar("T")

logger = logging.getLogger("audit_workstation.metrics_batcher")


class MetricsBatcher(Generic[T]):
    """Асинхронный аккумулятор метрик с двойным триггером flush."""

    def __init__(
        self,
        flush_callback: Callable[[list[T]], Awaitable[None]],
        max_batch_size: int = 100,
        flush_interval_sec: float = 5.0,
        max_buffer_size: int = 10000,
        name: str = "metrics_batcher",
    ):
        """Инициализирует батчер.

        :param flush_callback: корутина, принимающая список записей и
            записывающая их в БД (например, ``repo.record_many``).
        :param max_batch_size: размер пакета для мгновенного flush.
        :param flush_interval_sec: интервал фонового flush в секундах.
        :param max_buffer_size: защитный потолок буфера; при превышении
            старые записи дропаются (вместо OOM).
        :param name: имя батчера для логов.
        """
        self._flush_callback = flush_callback
        self._max_batch_size = max_batch_size
        self._flush_interval_sec = flush_interval_sec
        self._max_buffer_size = max_buffer_size
        self._name = name

        self._buffer: list[T] = []
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        # Живые task'и flush-по-порогу (см. add): держим сильные ссылки,
        # иначе event loop может собрать ещё не стартовавший task.
        self._threshold_flushes: set[asyncio.Task] = set()
        self._shutdown = False
        # Серилизует stop() относительно текущего flush, чтобы финальный
        # flush не пересекался с фоновым.
        self._flush_in_progress = asyncio.Lock()

        # Observability-счётчики. Доступны через get_status() — endpoint
        # /admin/diagnostics возвращает снимок состояния всех батчеров.
        # Общее число дропнутых записей за всё время жизни батчера.
        self._dropped_count: int = 0
        # Монотонное время последнего успешного flush'а
        # (asyncio.get_event_loop().time()). None — flush'ей ещё не было.
        self._last_flush_at: float | None = None
        # Текст последнего исключения flush_callback'а; обнуляется при
        # следующем успешном flush'е.
        self._last_error: str | None = None

    async def add(self, record: T) -> None:
        """Добавляет запись в буфер; при достижении ``max_batch_size`` — flush.

        Под локом: добавление + проверка размера + защитный дроп старых
        записей при превышении ``max_buffer_size``. Сам flush по порогу
        исполняется в отдельном task'е (``_flush_by_size``) и НЕ ожидается:
        к возврату ``add()`` записи ещё не в БД, а порог — «мягкий»
        (см. докстринг модуля).
        """
        flush_needed = False
        async with self._lock:
            self._buffer.append(record)
            if len(self._buffer) > self._max_buffer_size:
                dropped = len(self._buffer) - self._max_buffer_size
                self._buffer = self._buffer[-self._max_buffer_size:]
                self._dropped_count += dropped
                logger.warning(
                    "Батчер %s: буфер переполнен, дропнуто %d старых записей",
                    self._name,
                    dropped,
                    extra={
                        "batcher_name": self._name,
                        "buffer_size": len(self._buffer),
                        "dropped_now": dropped,
                        "dropped_count_total": self._dropped_count,
                    },
                )
            if len(self._buffer) >= self._max_batch_size:
                flush_needed = True
        if flush_needed:
            # Flush — в СОБСТВЕННОМ task'е и БЕЗ ожидания (fire-and-forget).
            # Вызывающий add() код может держать соединение и открытую
            # транзакцию (аудит внутри save-content), а flush_callback берёт
            # СВОЁ соединение из пула. Ждать здесь — значит держать
            # соединение №1, пока добывается №2: на пуле в 2 слота два
            # конкурентных сохранения упирались бы в ACQUIRE_TIMEOUT, теряя
            # пакет и подвешивая запрос пользователя. Отдельный task — ещё и
            # отдельный контекст для стража get_db (инвариант 2): его захват
            # соединения легален, а не «повторный».
            task = asyncio.create_task(
                self._flush_by_size(),
                name=f"metrics_batcher:{self._name}:size_flush",
            )
            # Сильная ссылка обязательна: без неё GC может собрать ещё не
            # стартовавший task (asyncio docs, asyncio.create_task).
            # Снимается своим же done-callback'ом, чтобы реестр не рос.
            self._threshold_flushes.add(task)
            task.add_done_callback(self._threshold_flushes.discard)

    async def _flush_by_size(self) -> None:
        """Flush по достижении порога — берёт лок сам (работает в своём task'е)."""
        async with self._lock:
            await self._flush_locked()

    async def start(self) -> None:
        """Стартует фоновую задачу периодического flush.

        Идемпотентно: повторный вызов после старта — no-op.
        """
        if self._task is not None and not self._task.done():
            return
        self._shutdown = False
        self._task = asyncio.create_task(
            self._run_periodic(),
            name=f"metrics_batcher:{self._name}",
        )

    async def stop(self) -> None:
        """Останавливает фоновую задачу и делает финальный flush.

        Идемпотентно: повторный вызов после остановки — no-op. Если ``start()``
        не вызывался — тоже работает (просто финальный flush).
        """
        if self._shutdown:
            return
        self._shutdown = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        # Дожидаемся flush'ей по порогу, стартовавших из add(), — финальный
        # flush ниже должен видеть согласованный буфер.
        await self._drain_threshold_flushes()
        # Финальный flush — под общим flush-локом, чтобы не пересечься с
        # последним фоновым тиком, если он уже стартовал.
        async with self._flush_in_progress:
            async with self._lock:
                await self._flush_locked()

    async def _drain_threshold_flushes(self) -> None:
        """Дожидается активных пороговых flush'ей.

        Точка синхронизации для ``stop()`` и для тестов: после перевода flush'а
        по порогу в fire-and-forget ``add()`` возвращается ДО завершения
        flush'а, и другого честного способа дождаться записи нет. Вызов из
        теста — штатный способ, а не обход инкапсуляции; публичного ``drain()``
        сознательно не заводим, чтобы не расширять API ради тестов.

        ``gather(return_exceptions=True)``: падение или ОТМЕНА отдельного
        flush-task'а возвращается как элемент результата и наружу не
        пробрасывается (отмена ребёнка не отменяет сам gather). Это важно на
        жёстком завершении процесса: иначе ``CancelledError`` (наследник
        ``BaseException``, обычным ``except Exception`` не ловится) прошибал
        бы ``stop()`` первого батчера, и финальные flush'и остальных батчеров
        не выполнялись бы — буферы терялись бы молча.

        Отмена **самого** вызывающего при этом проходит насквозь: гасить
        собственную отмену нельзя, иначе shutdown зависает.
        """
        tasks = list(self._threshold_flushes)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _run_periodic(self) -> None:
        """Фоновый цикл: спим интервал, потом flush."""
        try:
            while not self._shutdown:
                await asyncio.sleep(self._flush_interval_sec)
                if self._shutdown:
                    break
                async with self._flush_in_progress:
                    async with self._lock:
                        await self._flush_locked()
        except asyncio.CancelledError:
            raise
        except Exception:
            # Фоновая задача не должна молча умирать — логируем и выходим.
            # stop() закроет батчер штатно.
            logger.exception(
                "Батчер %s: фоновая задача упала", self._name,
            )

    async def _flush_locked(self) -> None:
        """Сбрасывает буфер через ``flush_callback``.

        Вызывается под ``self._lock``. Копирует буфер локально, очищает его
        ДО вызова callback'а — чтобы новые ``add()`` не ждали БД-операцию.

        Если callback бросает исключение — лог warning, записи НЕ возвращаются
        в буфер (упало = упало, ретраи не плодим, иначе при стабильном падении
        БД буфер раздуется до OOM).

        Отмена callback'а (жёсткое завершение процесса) теряет пакет ровно так
        же — поэтому учитывается в тех же счётчиках, но саму отмену мы
        пробрасываем дальше.
        """
        if not self._buffer:
            return
        batch = self._buffer
        self._buffer = []
        try:
            await self._flush_callback(batch)
        except BaseException as exc:
            # Каждая запись из batch'а потеряна — учитываем как дроп.
            # Ловим BaseException, а не Exception: при отмене flush-task'а
            # пакет уже вынут из буфера и теряется точно так же, а
            # /admin/diagnostics обязан это показать, а не отрапортовать
            # «всё хорошо».
            self._dropped_count += len(batch)
            self._last_error = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "Батчер %s: flush_callback упал, %d записей потеряно",
                self._name,
                len(batch),
                exc_info=True,
                extra={
                    "batcher_name": self._name,
                    "lost_now": len(batch),
                    "dropped_count_total": self._dropped_count,
                },
            )
            if not isinstance(exc, Exception):
                # CancelledError и прочие BaseException: потерю учли, а саму
                # отмену пробрасываем — глушить её нельзя.
                raise
        else:
            self._last_flush_at = asyncio.get_event_loop().time()
            self._last_error = None

    # ------------------------------------------------------------------
    # Observability — публичные геттеры состояния
    # ------------------------------------------------------------------

    @property
    def name(self) -> str:
        """Имя батчера (как передано в конструктор)."""
        return self._name

    @property
    def buffer_size(self) -> int:
        """Текущий размер буфера (число накопленных записей)."""
        return len(self._buffer)

    @property
    def dropped_count(self) -> int:
        """Сколько записей потеряно за всё время жизни батчера.

        Включает и записи, дропнутые при переполнении ``max_buffer_size``,
        и записи batch'ей, на которых упал ``flush_callback``.
        """
        return self._dropped_count

    @property
    def last_flush_at(self) -> float | None:
        """Монотонное время последнего успешного flush'а или ``None``."""
        return self._last_flush_at

    @property
    def last_error(self) -> str | None:
        """Текст последнего исключения flush'а; ``None`` если последний flush
        прошёл успешно.
        """
        return self._last_error

    def get_status(self) -> dict:
        """Снимок состояния батчера для diagnostics-endpoint'а.

        Поля:

        * ``name`` — имя батчера;
        * ``buffer_size`` — текущая длина буфера;
        * ``max_buffer_size`` / ``max_batch_size`` / ``flush_interval_sec`` —
          сконфигурированные пороги;
        * ``dropped_count`` — суммарно потеряно записей;
        * ``last_flush_ago_sec`` — сколько секунд назад был последний
          успешный flush; ``None`` если flush'ей ещё не было;
        * ``last_error`` — текст последнего исключения или ``None``;
        * ``running`` — жива ли фоновая задача периодического flush'а.
        """
        if self._last_flush_at is not None:
            now = asyncio.get_event_loop().time()
            last_flush_ago: float | None = now - self._last_flush_at
        else:
            last_flush_ago = None
        return {
            "name": self._name,
            "buffer_size": len(self._buffer),
            "max_buffer_size": self._max_buffer_size,
            "max_batch_size": self._max_batch_size,
            "flush_interval_sec": self._flush_interval_sec,
            "dropped_count": self._dropped_count,
            "last_flush_ago_sec": last_flush_ago,
            "last_error": self._last_error,
            "running": self._task is not None and not self._task.done(),
        }
