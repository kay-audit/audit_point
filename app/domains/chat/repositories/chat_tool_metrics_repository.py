"""Репозиторий метрик выполнения ChatTool'ов."""

import logging
from dataclasses import dataclass

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.domains.chat.settings import resolve_chat_schema

logger = logging.getLogger(
    "audit_workstation.domains.chat.repo.tool_metrics"
)


@dataclass(frozen=True, slots=True)
class ChatToolMetricRecord:
    """Одна tool-метрика для bulk-записи через ``record_many``."""
    tool_name: str
    status: str
    latency_ms: int
    username: str | None = None
    conversation_id: str | None = None
    error_message: str | None = None


class ChatToolMetricsRepository(BaseRepository):
    """Append-only журнал latency / status / ошибок для каждого вызова tool'а."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.table = self.adapter.get_table_name("chat_tool_metrics", schema=resolve_chat_schema())

    async def record(
        self,
        *,
        tool_name: str,
        status: str,
        latency_ms: int,
        username: str | None = None,
        conversation_id: str | None = None,
        error_message: str | None = None,
    ) -> None:
        """Записывает одну метрику выполнения tool'а.

        :param tool_name: имя ChatTool (например, ``chat.list_pages``).
        :param status: ``success`` / ``error`` / ``validation_error``.
        :param latency_ms: длительность выполнения tool-handler'а в миллисекундах.
        :param username: имя пользователя, инициировавшего вызов (опционально).
        :param conversation_id: id беседы, в рамках которой выполнен tool.
        :param error_message: текст ошибки (обрезается на стороне вызывающего).
        """
        await self.conn.execute(
            f"""
            INSERT INTO {self.table}
                (tool_name, status, latency_ms, username,
                 conversation_id, error_message)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            tool_name,
            status,
            int(latency_ms),
            username,
            conversation_id,
            error_message,
        )

    async def record_many(self, records: list[ChatToolMetricRecord]) -> None:
        """Bulk-INSERT пакета tool-метрик одним ``executemany`` в транзакции.

        Пустой список — no-op.
        """
        if not records:
            return
        params = [
            (
                r.tool_name,
                r.status,
                int(r.latency_ms),
                r.username,
                r.conversation_id,
                r.error_message,
            )
            for r in records
        ]
        async with self.conn.transaction():
            await self.conn.executemany(
                f"""
                INSERT INTO {self.table}
                    (tool_name, status, latency_ms, username,
                     conversation_id, error_message)
                VALUES ($1, $2, $3, $4, $5, $6)
                """,
                params,
            )
