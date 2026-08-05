"""Репозиторий audit-лога жизненного цикла беседы."""

import json
import logging
from dataclasses import dataclass

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.domains.chat.settings import resolve_chat_schema

logger = logging.getLogger(
    "audit_workstation.domains.chat.repo.audit_log"
)


@dataclass(frozen=True, slots=True)
class ChatAuditLogRecord:
    """Одна запись audit-лога для bulk-записи через ``log_many``."""
    username: str
    action: str
    conversation_id: str | None = None
    details: dict | None = None


class ChatAuditLogRepository(BaseRepository):
    """Append-only журнал действий пользователей в чате."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.table = self.adapter.get_table_name("chat_audit_log", schema=resolve_chat_schema())

    async def log(
        self,
        *,
        username: str,
        action: str,
        conversation_id: str | None = None,
        details: dict | None = None,
    ) -> None:
        """Записывает одну строку audit-лога.

        :param username: имя пользователя, выполнившего действие.
        :param action: одно из значений из ``app.core.chat.names`` (``AUDIT_*``).
        :param conversation_id: id беседы (если применимо).
        :param details: произвольный dict, сериализуется в JSONB.
        """
        details_json = (
            json.dumps(details, ensure_ascii=False, default=str)
            if details is not None
            else None
        )
        await self.conn.execute(
            f"""
            INSERT INTO {self.table}
                (username, action, conversation_id, details_json)
            VALUES ($1, $2, $3, $4::jsonb)
            """,
            username,
            action,
            conversation_id,
            details_json,
        )

    async def log_many(self, records: list[ChatAuditLogRecord]) -> None:
        """Bulk-INSERT пакета audit-записей одним ``executemany`` в транзакции.

        Пустой список — no-op. ``details`` каждой записи сериализуется в JSON
        по тем же правилам, что и в ``log()``.
        """
        if not records:
            return
        params = []
        for r in records:
            details_json = (
                json.dumps(r.details, ensure_ascii=False, default=str)
                if r.details is not None
                else None
            )
            params.append(
                (r.username, r.action, r.conversation_id, details_json)
            )
        async with self.conn.transaction():
            await self.conn.executemany(
                f"""
                INSERT INTO {self.table}
                    (username, action, conversation_id, details_json)
                VALUES ($1, $2, $3, $4::jsonb)
                """,
                params,
            )
