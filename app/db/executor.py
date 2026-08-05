"""
Исполнитель БД: соединение на операцию (connection-per-operation).

``DbExecutor`` реализует протокол ``DbConn`` (``app/db/types.py``: fetch/
fetchrow/fetchval/execute/executemany/transaction — то же подмножество API, что
и у ``asyncpg.Connection``) и под каждый вызов берёт соединение из пула через
``get_db()``, возвращая его сразу после выполнения. Явная транзакция
(``async with executor.transaction():``) привязывает соединение к contextvar
на время блока — все вызовы исполнителя внутри блока идут через это
соединение, в том числе из других репозиториев (они держат тот же синглтон).

Инварианты (спека 2026-08-04-connection-per-operation-design.md):
1. Соединение не удерживается на время await'ов сети/LLM/файлов.
2. Внутри явной транзакции нет новых захватов пула: вложенный
   ``transaction()`` делегируется в ``conn.transaction()`` (SAVEPOINT asyncpg).
3. DI-слой не держит соединений.
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any, AsyncIterator, Awaitable, Callable

import asyncpg

# Импорт модулем (не именем): тесты патчат app.db.connection.get_db, и вызов
# через атрибут модуля видит патч (принятая в проекте патч-точка БД).
from app.db import connection as _connection
from app.db.types import DbConn

logger = logging.getLogger(__name__)


class _BoundTx:
    """Соединение, привязанное явной транзакцией к текущему task."""

    __slots__ = ("conn", "task")

    def __init__(self, conn: Any, task: "asyncio.Task[Any] | None") -> None:
        self.conn = conn
        self.task = task


# Активная явная транзакция. Contextvar наследуется дочерними task'ами
# (create_task копирует контекст), поэтому каждое чтение сверяет владельца:
# чужой task получает свежее соединение из пула, а не bound-соединение.
_bound_tx: ContextVar[_BoundTx | None] = ContextVar("db_bound_tx", default=None)


def _current_bound() -> _BoundTx | None:
    """Возвращает bound-транзакцию, если её владелец — текущий task."""
    bound = _bound_tx.get()
    if bound is None:
        return None
    if bound.task is not asyncio.current_task():
        logger.warning(
            "Обращение к БД из чужого task при активной транзакции — "
            "выдано отдельное соединение (create_task внутри транзакции?)",
            stack_info=True,
        )
        return None
    return bound


class DbExecutor:
    """Фасад соединения БД: каждый вызов берёт соединение из пула на время SQL."""

    async def _run(self, op: Callable[[DbConn], Awaitable[Any]]) -> Any:
        """Единственная точка ветвления «bound-соединение или свежее из пула».

        Публичные методы — тонкие типизированные обёртки над ней: правка
        ветвления (метрики захватов, диагностика) вносится в одном месте.
        ``op`` получает соединение и возвращает ещё не выполненную корутину —
        она await'ится строго внутри выбранной ветки.
        """
        bound = _current_bound()
        if bound is not None:
            return await op(bound.conn)
        async with _connection.get_db() as conn:
            return await op(conn)

    async def fetch(
        self, query: str, *args: Any, timeout: float | None = None
    ) -> list[asyncpg.Record]:
        """Возвращает все строки запроса."""
        return await self._run(lambda c: c.fetch(query, *args, timeout=timeout))

    async def fetchrow(
        self, query: str, *args: Any, timeout: float | None = None
    ) -> asyncpg.Record | None:
        """Возвращает первую строку запроса либо None."""
        return await self._run(lambda c: c.fetchrow(query, *args, timeout=timeout))

    async def fetchval(
        self, query: str, *args: Any, column: int = 0, timeout: float | None = None
    ) -> Any:
        """Возвращает одно значение из первой строки (колонка ``column``)."""
        return await self._run(
            lambda c: c.fetchval(query, *args, column=column, timeout=timeout)
        )

    async def execute(self, query: str, *args: Any, timeout: float | None = None) -> Any:
        """Выполняет команду, возвращает статус-строку asyncpg."""
        return await self._run(lambda c: c.execute(query, *args, timeout=timeout))

    async def executemany(
        self, command: str, args: Any, *, timeout: float | None = None
    ) -> Any:
        """Выполняет команду для каждого набора аргументов из ``args``."""
        return await self._run(lambda c: c.executemany(command, args, timeout=timeout))

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        """Явная транзакция: привязывает соединение к текущему task на время блока.

        Вложенный вызов на том же task делегируется в ``conn.transaction()``
        того же соединения — asyncpg открывает SAVEPOINT (семантика вложенных
        транзакций сохраняется, см. ``act_content.py``). Параметры asyncpg
        (isolation и т.п.) сознательно не поддерживаются.

        Инвариант: блок открывается и закрывается в ОДНОМ task — закрытие из
        другого task (shield, отложенное завершение) не поддерживается.
        """
        bound = _current_bound()
        if bound is not None:
            async with bound.conn.transaction():
                yield
            return
        async with _connection.get_db() as conn:
            token = _bound_tx.set(_BoundTx(conn, asyncio.current_task()))
            try:
                async with conn.transaction():
                    yield
            finally:
                try:
                    _bound_tx.reset(token)
                except ValueError:
                    # Закрытие из другого Context (нарушение инварианта выше) —
                    # не роняем основную операцию, но фиксируем в логе.
                    logger.warning(
                        "transaction() закрыт вне Context'а открытия — "
                        "bound-соединение сброшено небезопасно",
                        stack_info=True,
                    )
                    _bound_tx.set(None)


_executor = DbExecutor()


def get_executor() -> DbExecutor:
    """Возвращает процесс-синглтон исполнителя БД."""
    return _executor
