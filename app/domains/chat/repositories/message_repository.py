"""Репозиторий сообщений чата."""

import json
import logging

import asyncpg

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.domains.chat.settings import resolve_chat_schema

logger = logging.getLogger("audit_workstation.domains.chat.repo.message")


class MessageRepository(BaseRepository):
    """CRUD-операции с сообщениями чата."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.table = self.adapter.get_table_name("chat_messages", schema=resolve_chat_schema())

    @staticmethod
    def _parse_row(row: dict) -> dict:
        """Парсит JSONB-поля из строк в Python-объекты."""
        result = dict(row)
        for key in ("content", "token_usage"):
            val = result.get(key)
            if isinstance(val, str):
                try:
                    result[key] = json.loads(val)
                except json.JSONDecodeError:
                    result[key] = None
        return result

    @staticmethod
    def _content_list(raw_content) -> list:
        """Колонка content из строки БД → список блоков.

        JSONB может прийти как str (без codec'а) или как уже распарсенный
        список. Битый JSON → пустой список (streaming-методы начинают
        накопление заново). Общий хелпер append_block/upsert_block/
        finalize/mark_failed.
        """
        if isinstance(raw_content, str):
            try:
                return json.loads(raw_content)
            except json.JSONDecodeError:
                return []
        return list(raw_content or [])

    async def create(
        self,
        *,
        id: str,
        conversation_id: str,
        role: str,
        content: list[dict],
        model: str | None = None,
        token_usage: dict | None = None,
    ) -> dict:
        """Создаёт новое сообщение и возвращает запись."""
        row = await self.conn.fetchrow(
            f"""
            INSERT INTO {self.table}
                (id, conversation_id, role, content, model, token_usage)
            VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
            RETURNING *
            """,
            id,
            conversation_id,
            role,
            json.dumps(content, ensure_ascii=False),
            model,
            json.dumps(token_usage, ensure_ascii=False) if token_usage else None,
        )
        return self._parse_row(row)

    async def get_by_conversation(
        self,
        conversation_id: str,
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """Возвращает сообщения беседы в хронологическом порядке."""
        rows = await self.conn.fetch(
            f"""
            SELECT * FROM {self.table}
            WHERE conversation_id = $1
            ORDER BY created_at ASC
            LIMIT $2 OFFSET $3
            """,
            conversation_id,
            limit,
            offset,
        )
        return [self._parse_row(r) for r in rows]

    async def count_by_conversation(self, conversation_id: str) -> int:
        """Возвращает количество сообщений в беседе."""
        return await self.conn.fetchval(
            f"SELECT COUNT(*) FROM {self.table} WHERE conversation_id = $1",
            conversation_id,
        )

    async def get_by_id(self, message_id: str) -> dict | None:
        """Возвращает одно сообщение по id или None, если не найдено."""
        row = await self.conn.fetchrow(
            f"SELECT * FROM {self.table} WHERE id = $1",
            message_id,
        )
        return self._parse_row(row) if row else None

    # ── streaming-методы (Phase 0 «D»: server-authoritative state) ──────────
    # Стратегия: read-modify-write под FOR UPDATE — на GP 6.x / PG 9.4 нет
    # jsonb_set и оператора `||` для jsonb. Транзакция гарантирует, что
    # параллельный append/finalize не перетрёт друг друга.

    async def create_streaming(
        self,
        *,
        message_id: str,
        conversation_id: str,
        role: str = "assistant",
        model: str | None = None,
        agent_ref: str | None = None,
    ) -> dict:
        """Создаёт пустое сообщение со status='streaming'.

        Идемпотентен на crash-recovery: при UniqueViolation на id (рестарт
        процесса между генерацией id и сохранением) делает SELECT
        существующей записи и возвращает её — runner продолжит
        материализацию того же message_id, а не создаст новый.

        agent_ref — conversation_id строки-вопроса в chat_agent_messages_bus (uid
        сообщения); если передан, связывает draft-сообщение с bus-таблицей.
        """
        try:
            row = await self.conn.fetchrow(
                f"""
                INSERT INTO {self.table}
                    (id, conversation_id, role, content, model, status, agent_ref)
                VALUES ($1, $2, $3, '[]'::jsonb, $4, 'streaming', $5)
                RETURNING *
                """,
                message_id,
                conversation_id,
                role,
                model,
                agent_ref,
            )
            return self._parse_row(row)
        except asyncpg.UniqueViolationError:
            # Crash-recovery: запись уже есть (например, после рестарта
            # uvicorn между genuid и save). Возвращаем существующую.
            logger.info(
                "MessageRepository.create_streaming: запись %s уже существует, "
                "возвращаем существующую (crash-recovery)",
                message_id,
            )
            row = await self.conn.fetchrow(
                f"SELECT * FROM {self.table} WHERE id = $1",
                message_id,
            )
            return self._parse_row(row)

    async def append_block(self, *, message_id: str, block: dict) -> bool:
        """Дописывает блок в content streaming-сообщения.

        Возвращает True если блок добавлен (или уже был — идемпотентно
        по block_id), False если сообщение не в статусе 'streaming'
        (гонка с finalize / mark_failed).
        """
        async with self.conn.transaction():
            row = await self.conn.fetchrow(
                f"SELECT content, status FROM {self.table} WHERE id = $1 FOR UPDATE",
                message_id,
            )
            if not row or row["status"] != "streaming":
                return False
            content = self._content_list(row["content"])
            # Дедуп по block_id: повторный append того же блока — no-op.
            block_id = block.get("block_id") if isinstance(block, dict) else None
            if block_id and any(
                isinstance(b, dict) and b.get("block_id") == block_id
                for b in content
            ):
                return True
            content.append(block)
            await self.conn.execute(
                f"UPDATE {self.table} SET content = $1::jsonb WHERE id = $2",
                json.dumps(content, ensure_ascii=False),
                message_id,
            )
        return True

    async def upsert_block(self, *, message_id: str, block: dict) -> bool:
        """Обновляет блок с тем же block_id в content streaming-сообщения
        (или дописывает, если такого ещё нет).

        Используется поллером агент-канала для инкрементального reasoning:
        агент НАКАПЛИВАЕТ текст в metadata.reasoning, поэтому блок надо
        заменять целиком, а не дописывать вторым экземпляром.

        Возвращает False, если сообщение не в 'streaming' (гонка с
        finalize/mark_failed) или у блока нет block_id.
        """
        block_id = block.get("block_id") if isinstance(block, dict) else None
        if not block_id:
            return False
        async with self.conn.transaction():
            row = await self.conn.fetchrow(
                f"SELECT content, status FROM {self.table} WHERE id = $1 FOR UPDATE",
                message_id,
            )
            if not row or row["status"] != "streaming":
                return False
            content = self._content_list(row["content"])
            for i, b in enumerate(content):
                if isinstance(b, dict) and b.get("block_id") == block_id:
                    content[i] = block
                    break
            else:
                content.append(block)
            await self.conn.execute(
                f"UPDATE {self.table} SET content = $1::jsonb WHERE id = $2",
                json.dumps(content, ensure_ascii=False),
                message_id,
            )
        return True

    async def finalize(
        self,
        *,
        message_id: str,
        final_blocks: list[dict],
        model: str | None = None,
        token_usage: dict | None = None,
    ) -> bool:
        """Переводит сообщение из 'streaming' в 'complete' и мержит финальные блоки.

        MERGE-логика: накопленные через upsert_block/append_block блоки
        сохраняются. Финальный блок с тем же block_id замещает накопленный
        на его позиции (финальная версия полнее), новые дописываются в конец.

        Возвращает False если сообщение уже не 'streaming' (повторный вызов —
        idempotent no-op).
        """
        async with self.conn.transaction():
            row = await self.conn.fetchrow(
                f"SELECT content, status FROM {self.table} WHERE id = $1 FOR UPDATE",
                message_id,
            )
            if not row or row["status"] != "streaming":
                return False
            existing = self._content_list(row["content"])
            # MERGE: финальные блоки с уже встречавшимся block_id ЗАМЕЩАЮТ
            # накопленные (финальная версия reasoning полнее инкрементальной),
            # остальные — дописываются в конец.
            # Предполагается, что existing не содержит дублей по block_id (инвариант upsert_block/append_block).
            existing_by_id = {
                b["block_id"]: i
                for i, b in enumerate(existing)
                if isinstance(b, dict) and b.get("block_id")
            }
            merged = list(existing)
            for b in final_blocks or []:
                bid = b.get("block_id") if isinstance(b, dict) else None
                if bid and bid in existing_by_id:
                    merged[existing_by_id[bid]] = b
                else:
                    merged.append(b)
            await self.conn.execute(
                f"""
                UPDATE {self.table}
                SET content = $1::jsonb,
                    status = 'complete',
                    model = COALESCE($2, model),
                    token_usage = $3::jsonb
                WHERE id = $4
                """,
                json.dumps(merged, ensure_ascii=False),
                model,
                json.dumps(token_usage, ensure_ascii=False) if token_usage else None,
                message_id,
            )
        return True

    async def mark_failed(self, *, message_id: str, error_block: dict) -> bool:
        """Дописывает error-блок и переводит сообщение в 'failed' одной транзакцией.

        Возвращает False если сообщение уже не 'streaming' (повторный вызов
        или race с finalize — idempotent).
        """
        async with self.conn.transaction():
            row = await self.conn.fetchrow(
                f"SELECT content, status FROM {self.table} WHERE id = $1 FOR UPDATE",
                message_id,
            )
            if not row or row["status"] != "streaming":
                return False
            content = self._content_list(row["content"])
            content.append(error_block)
            await self.conn.execute(
                f"""
                UPDATE {self.table}
                SET content = $1::jsonb,
                    status = 'failed'
                WHERE id = $2
                """,
                json.dumps(content, ensure_ascii=False),
                message_id,
            )
        return True

    async def get_streaming_drafts(self) -> list[dict]:
        """Draft-сообщения, ждущие ответа агента (для reconcile при старте).

        Возвращает все сообщения со status='streaming' и непустым agent_ref.
        """
        rows = await self.conn.fetch(
            f"SELECT * FROM {self.table} WHERE status = 'streaming' AND agent_ref IS NOT NULL"
        )
        return [self._parse_row(r) for r in rows]

    async def has_streaming_message(self, conversation_id: str) -> bool:
        """True, если в беседе есть сообщение со status='streaming'.

        Используется ConversationService.delete для защиты от удаления беседы,
        пока фоновый поллер ещё дозаполняет ответ ассистента (BUG #15). Запрос
        опирается на составной индекс (conversation_id, status).
        """
        val = await self.conn.fetchval(
            f"SELECT 1 FROM {self.table} "
            f"WHERE conversation_id = $1 AND status = 'streaming' LIMIT 1",
            conversation_id,
        )
        return val is not None
