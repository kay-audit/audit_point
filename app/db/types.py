"""
Типы слоя БД: структурный контракт соединения.

``DbConn`` описывает ровно тот набор операций, который приложение реально
использует поверх соединения: шесть методов (``fetch``/``fetchrow``/
``fetchval``/``execute``/``executemany``/``transaction``). Его удовлетворяют и
``asyncpg.Connection`` (транзиентные места — батчеры, поллер, health-check'и),
и ``DbExecutor`` (``app/db/executor.py``, соединение на операцию), который
повторяет тот же API, но не является ``asyncpg.Connection``.

Протокол — не косметика: аннотация ``asyncpg.Connection`` там, куда фактически
приходит исполнитель, обещает IDE и типчекеру весь API соединения
(``cursor()``, ``copy_records_to_table()``, ``prepare()``), которого у
исполнителя нет — вызов такого метода упадёт ``AttributeError`` в рантайме.

Модуль сознательно не импортирует ничего из ``app.db``: его тянут и
``repositories/base.py``, и доменные фабрики, поэтому любая зависимость отсюда
создала бы цикл импортов.
"""

from typing import Any, Protocol

import asyncpg


class _TransactionContext(Protocol):
    """Асинхронный контекст-менеджер транзакции (``BEGIN``/``SAVEPOINT``)."""

    async def __aenter__(self) -> Any: ...

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> Any: ...


class DbConn(Protocol):
    """Структурный контракт соединения БД: то, что умеют и Connection, и DbExecutor.

    Реализации не наследуют протокол явно (structural subtyping, PEP 544):
    ``asyncpg.Connection`` — сторонний класс, ``DbExecutor`` — самостоятельный
    фасад. Добавлять сюда метод можно только тогда, когда его поддерживают
    ОБЕ реализации.
    """

    async def fetch(
        self, query: str, *args: Any, timeout: float | None = None
    ) -> list[asyncpg.Record]: ...

    async def fetchrow(
        self, query: str, *args: Any, timeout: float | None = None
    ) -> asyncpg.Record | None: ...

    async def fetchval(
        self, query: str, *args: Any, column: int = 0, timeout: float | None = None
    ) -> Any: ...

    async def execute(self, query: str, *args: Any, timeout: float | None = None) -> Any: ...

    async def executemany(
        self, command: str, args: Any, *, timeout: float | None = None
    ) -> Any: ...

    def transaction(self) -> _TransactionContext: ...
