"""Репозиторий файлов чата."""

import logging

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.domains.chat.settings import resolve_chat_schema

logger = logging.getLogger("audit_workstation.domains.chat.repo.file")


class FileRepository(BaseRepository):
    """CRUD-операции с файлами чата."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        schema = resolve_chat_schema()
        self.table = self.adapter.get_table_name("chat_files", schema=schema)
        self.conversations_table = self.adapter.get_table_name("chat_conversations", schema=schema)

    async def create(
        self,
        *,
        id: str,
        conversation_id: str,
        filename: str,
        mime_type: str,
        file_size: int,
        file_data: bytes,
        message_id: str | None = None,
    ) -> dict:
        """Создаёт запись файла и возвращает метаданные (без file_data)."""
        row = await self.conn.fetchrow(
            f"""
            INSERT INTO {self.table}
                (id, conversation_id, message_id, filename, mime_type, file_size, file_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, conversation_id, message_id, filename, mime_type, file_size, created_at
            """,
            id,
            conversation_id,
            message_id,
            filename,
            mime_type,
            file_size,
            file_data,
        )
        return dict(row)

    async def get_file_data(
        self, *, file_id: str, user_id: str,
    ) -> dict | None:
        """Возвращает файл с данными, проверяя принадлежность пользователю."""
        row = await self.conn.fetchrow(
            f"""
            SELECT f.id, f.filename, f.mime_type, f.file_size, f.file_data
            FROM {self.table} f
            JOIN {self.conversations_table} c ON c.id = f.conversation_id
            WHERE f.id = $1 AND c.user_id = $2
            """,
            file_id,
            user_id,
        )
        return dict(row) if row else None

    async def get_file_content(
        self, *, file_id: str, conversation_id: str,
    ) -> dict | None:
        """Возвращает содержимое файла, проверяя принадлежность к беседе."""
        row = await self.conn.fetchrow(
            f"""
            SELECT filename, mime_type, file_data
            FROM {self.table}
            WHERE id = $1 AND conversation_id = $2
            """,
            file_id,
            conversation_id,
        )
        return dict(row) if row else None

    async def link_to_message(self, file_id: str, message_id: str) -> None:
        """Привязывает файл к сообщению."""
        await self.conn.execute(
            f"""
            UPDATE {self.table}
            SET message_id = $1
            WHERE id = $2
            """,
            message_id,
            file_id,
        )
