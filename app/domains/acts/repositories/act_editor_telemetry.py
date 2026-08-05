"""
Репозиторий телеметрии здоровья редактора (§6.8).

Пишет батч агрегированных счётчиков событий редактора одним ``executemany``.
Только запись — чтения (Read-API) нет, данные смотрят SQL'ем.
"""

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn


class ActEditorTelemetryRepository(BaseRepository):
    """Пакетная запись счётчиков событий редактора."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.table = self.adapter.get_table_name("act_editor_telemetry")

    async def insert_many(self, rows: list[tuple]) -> None:
        """Bulk-INSERT счётчиков одним ``executemany`` в транзакции.

        Args:
            rows: список кортежей ``(id, act_id, username, event_type,
                  event_count)``. ``id`` — сгенерированный вызывающим
                  ``str(uuid.uuid4())`` (колонка VARCHAR(36)).

        Пустой список — no-op.
        """
        if not rows:
            return
        async with self.conn.transaction():
            await self.conn.executemany(
                f"""
                INSERT INTO {self.table}
                    (id, act_id, username, event_type, event_count)
                VALUES ($1, $2, $3, $4, $5)
                """,
                rows,
            )
