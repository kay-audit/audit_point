"""Репозиторий бесед чата."""

import json
import logging

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.domains.chat.settings import resolve_chat_schema

logger = logging.getLogger("audit_workstation.domains.chat.repo.conversation")


class ConversationRepository(BaseRepository):
    """CRUD-операции с беседами чата."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self._schema = resolve_chat_schema()
        self.table = self.adapter.get_table_name("chat_conversations", schema=self._schema)

    @staticmethod
    def _parse_row(row: dict) -> dict:
        """Парсит JSONB-поля из строк в Python-объекты."""
        result = dict(row)
        val = result.get("context")
        if isinstance(val, str):
            try:
                result["context"] = json.loads(val)
            except json.JSONDecodeError:
                result["context"] = None
        return result

    async def create(
        self,
        *,
        id: str,
        user_id: str,
        title: str | None = None,
        domain_name: str | None = None,
        context: dict | None = None,
    ) -> dict:
        """Создаёт новую беседу и возвращает запись."""
        row = await self.conn.fetchrow(
            f"""
            INSERT INTO {self.table} (id, user_id, title, domain_name, context)
            VALUES ($1, $2, $3, $4, $5::jsonb)
            RETURNING *
            """,
            id,
            user_id,
            title,
            domain_name,
            json.dumps(context, ensure_ascii=False) if context else None,
        )
        return self._parse_row(row)

    async def get_by_id(self, conversation_id: str, user_id: str) -> dict | None:
        """Возвращает беседу по ID с проверкой владельца."""
        row = await self.conn.fetchrow(
            f"""
            SELECT * FROM {self.table}
            WHERE id = $1 AND user_id = $2
            """,
            conversation_id,
            user_id,
        )
        return self._parse_row(row) if row else None

    async def get_by_user(
        self,
        user_id: str,
        *,
        domain_name: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        """Возвращает беседы пользователя, отсортированные по дате обновления."""
        if domain_name:
            rows = await self.conn.fetch(
                f"""
                SELECT * FROM {self.table}
                WHERE user_id = $1 AND domain_name = $2
                ORDER BY updated_at DESC
                LIMIT $3 OFFSET $4
                """,
                user_id,
                domain_name,
                limit,
                offset,
            )
        else:
            rows = await self.conn.fetch(
                f"""
                SELECT * FROM {self.table}
                WHERE user_id = $1
                ORDER BY updated_at DESC
                LIMIT $2 OFFSET $3
                """,
                user_id,
                limit,
                offset,
            )
        return [self._parse_row(r) for r in rows]

    async def update_title(
        self, conversation_id: str, user_id: str, title: str,
    ) -> bool:
        """Обновляет заголовок беседы. Возвращает True если запись обновлена."""
        result = await self.conn.execute(
            f"""
            UPDATE {self.table}
            SET title = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND user_id = $3
            """,
            title,
            conversation_id,
            user_id,
        )
        return result == "UPDATE 1"

    async def touch(self, conversation_id: str) -> None:
        """Обновляет updated_at беседы."""
        await self.conn.execute(
            f"""
            UPDATE {self.table}
            SET updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            """,
            conversation_id,
        )

    async def delete(self, conversation_id: str, user_id: str) -> bool:
        """Удаляет беседу со всеми связанными данными. Возвращает True если удалена."""
        if self.adapter.supports_cascade_delete():
            result = await self.conn.execute(
                f"DELETE FROM {self.table} WHERE id = $1 AND user_id = $2",
                conversation_id,
                user_id,
            )
            return result == "DELETE 1"

        # Greenplum: явное удаление дочерних записей
        files_table = self.adapter.get_table_name("chat_files", schema=self._schema)
        messages_table = self.adapter.get_table_name("chat_messages", schema=self._schema)
        async with self.conn.transaction():
            await self.conn.execute(
                f"DELETE FROM {files_table} WHERE conversation_id = $1",
                conversation_id,
            )
            await self.conn.execute(
                f"DELETE FROM {messages_table} WHERE conversation_id = $1",
                conversation_id,
            )
            result = await self.conn.execute(
                f"DELETE FROM {self.table} WHERE id = $1 AND user_id = $2",
                conversation_id,
                user_id,
            )
        return result == "DELETE 1"

    async def count_by_user(
        self, user_id: str, *, domain_name: str | None = None,
    ) -> int:
        """Возвращает количество бесед пользователя (опционально по домену)."""
        if domain_name:
            return await self.conn.fetchval(
                f"""
                SELECT COUNT(*) FROM {self.table}
                WHERE user_id = $1 AND domain_name = $2
                """,
                user_id,
                domain_name,
            )
        return await self.conn.fetchval(
            f"SELECT COUNT(*) FROM {self.table} WHERE user_id = $1",
            user_id,
        )
