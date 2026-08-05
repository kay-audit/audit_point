"""Сервис управления сообщениями чата."""

import logging
import uuid

from app.domains.chat.exceptions import ChatLimitError, ChatMessageNotFoundError
from app.domains.chat.repositories.conversation_repository import ConversationRepository
from app.domains.chat.repositories.message_repository import MessageRepository
from app.domains.chat.services.chat_audit_service import ChatAuditService
from app.domains.chat.services.conversation_service import _get_user_lock
from app.domains.chat.settings import ChatDomainSettings

logger = logging.getLogger("audit_workstation.domains.chat.service.message")


class MessageService:
    """Бизнес-логика сообщений чата."""

    def __init__(
        self,
        *,
        msg_repo: MessageRepository,
        conv_repo: ConversationRepository,
        settings: ChatDomainSettings,
        audit_service: ChatAuditService | None = None,
    ):
        self.msg_repo = msg_repo
        self.conv_repo = conv_repo
        self.settings = settings
        # audit_service опционален; см. ConversationService.__init__.
        self.audit_service = audit_service

    async def save_user_message(
        self,
        *,
        conversation_id: str,
        content: str,
        user_id: str,
        file_blocks: list[dict] | None = None,
    ) -> dict:
        """
        Сохраняет пользовательское сообщение.

        Проверяет длину контента и лимит сообщений в беседе.
        Собирает блоки: текстовый + опциональные файловые.
        """
        if len(content) > self.settings.max_message_content_length:
            raise ChatLimitError(
                f"Сообщение слишком длинное: {len(content)} символов "
                f"(максимум {self.settings.max_message_content_length})."
            )

        # Критическая секция (count + create) обёрнута в per-user lock —
        # устраняет race condition при конкурентных send_message от одного
        # пользователя (BUG #10).
        async with _get_user_lock(user_id):
            # Собираем блоки контента
            blocks: list[dict] = [{"type": "text", "content": content}]
            if file_blocks:
                blocks.extend(file_blocks)

            message_id = str(uuid.uuid4())
            # Один захват соединения на всю критическую секцию: проверка лимита,
            # вставка сообщения и touch беседы — единая транзакция. Если touch
            # падает (например, FK или сетевой сбой), сообщение тоже
            # откатывается, и updated_at не расходится с реальной историей.
            # Заодно лимит считается в согласованном снимке вместе со вставкой,
            # а не отдельным запросом до открытия транзакции.
            async with self.msg_repo.conn.transaction():
                msg_count = await self.msg_repo.count_by_conversation(conversation_id)
                if msg_count >= self.settings.max_messages_per_conversation:
                    raise ChatLimitError(
                        f"Достигнут лимит сообщений в беседе: "
                        f"{self.settings.max_messages_per_conversation}."
                    )

                message = await self.msg_repo.create(
                    id=message_id,
                    conversation_id=conversation_id,
                    role="user",
                    content=blocks,
                )
                await self.conv_repo.touch(conversation_id)
            if self.audit_service is not None:
                await self.audit_service.log_message_sent(
                    username=user_id,
                    conversation_id=conversation_id,
                    message_id=message_id,
                    content_length=len(content),
                    files_count=len(file_blocks or []),
                )
            return message

    async def save_assistant_message(
        self,
        *,
        conversation_id: str,
        content: list[dict],
        model: str | None = None,
        token_usage: dict | None = None,
        message_id: str | None = None,
    ) -> dict:
        """Сохраняет сообщение ассистента.

        ``message_id`` опционален. Если передан — используется как id записи,
        иначе генерируется. Вызывающий должен передать id, если ему нужно,
        чтобы детерминированные ``block_id`` для ClientActionBlock
        (``f"{message_id}:client_action:{i}"``) совпадали с id записи в БД — иначе после
        reload фронт получит новый id и пометит block как «не исполнен»,
        что даст редирект-цикл (см. backend-audit §1.3.1).
        """
        if message_id is None:
            message_id = str(uuid.uuid4())
        # Атомарность: см. комментарий в save_user_message.
        async with self.msg_repo.conn.transaction():
            message = await self.msg_repo.create(
                id=message_id,
                conversation_id=conversation_id,
                role="assistant",
                content=content,
                model=model,
                token_usage=token_usage,
            )
            await self.conv_repo.touch(conversation_id)
        return message

    async def get_history(
        self,
        conversation_id: str,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        """Возвращает страницу сообщений беседы и общее количество.

        Используется API-эндпоинтом GET /messages. Для внутренней загрузки
        истории в LLM-оркестратор используйте ``load_history_for_llm`` —
        он не считает total и возвращает только список сообщений.
        """
        items = await self.msg_repo.get_by_conversation(
            conversation_id, limit=limit, offset=offset,
        )
        total = await self.msg_repo.count_by_conversation(conversation_id)
        return items, total

    async def get_message(
        self,
        conversation_id: str,
        message_id: str,
    ) -> dict:
        """Возвращает одно сообщение, принадлежащее беседе.

        Поднимает ChatMessageNotFoundError (404), если сообщение не найдено
        или принадлежит другой беседе.
        """
        message = await self.msg_repo.get_by_id(message_id)
        if message is None or message.get("conversation_id") != conversation_id:
            raise ChatMessageNotFoundError("Сообщение не найдено.")
        return message

    async def load_history_for_llm(
        self,
        conversation_id: str,
        *,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """Загружает историю сообщений для передачи в LLM-оркестратор.

        В отличие от ``get_history`` не делает COUNT — total для LLM не нужен,
        а лишний запрос увеличивает p95 latency на каждом POST /messages.
        """
        return await self.msg_repo.get_by_conversation(
            conversation_id, limit=limit, offset=offset,
        )

    # ── Phase 1 «D»: инкрементальная запись ассистент-сообщений ────────────
    # Сценарий forward'а к внешнему агенту: вместо накопления reasoning'ов в
    # памяти runner'а и одного save_assistant_message на финале, runner
    # пишет каждый reasoning в БД отдельной короткой транзакцией. Финал
    # мержит финальные блоки агента с уже накопленными reasoning'ами через
    # MessageRepository.finalize (дедуп по block_id внутри репозитория).

    async def start_streaming_assistant_message(
        self,
        *,
        message_id: str,
        conversation_id: str,
        model: str | None = None,
    ) -> dict:
        """Создаёт пустое assistant-сообщение со status='streaming'.

        Идемпотентен на crash-recovery: при гонке (рестарт runner'а между
        генерацией message_id и INSERT'ом) репозиторий ловит
        ``UniqueViolation`` и возвращает существующую запись —
        runner продолжит материализацию того же message_id.
        """
        return await self.msg_repo.create_streaming(
            message_id=message_id,
            conversation_id=conversation_id,
            model=model,
        )

    async def finalize_assistant_message(
        self,
        *,
        message_id: str,
        conversation_id: str,
        final_blocks: list[dict],
        model: str | None = None,
        token_usage: dict | None = None,
    ) -> bool:
        """Финализирует streaming-сообщение: merge финальных блоков + touch беседы.

        MERGE-семантика на стороне репозитория: уже сохранённые через
        ``append_block`` reasoning'и остаются, к ним дописываются финальные
        блоки агента, дедуп по ``block_id``.

        Возвращает True если статус переведён в 'complete'. False — если
        сообщение уже не 'streaming' (повторный вызов — лог WARNING, не
        падаем).
        """
        async with self.msg_repo.conn.transaction():
            success = await self.msg_repo.finalize(
                message_id=message_id,
                final_blocks=final_blocks,
                model=model,
                token_usage=token_usage,
            )
            if not success:
                logger.warning(
                    "finalize_assistant_message: message_id=%s уже не "
                    "в статусе 'streaming' — пропускаем",
                    message_id,
                )
                return False
            await self.conv_repo.touch(conversation_id)
        return True

    async def fail_assistant_message(
        self,
        *,
        message_id: str,
        conversation_id: str,
        error_block: dict,
    ) -> bool:
        """Помечает streaming-сообщение failed + дописывает error-блок.

        Используется при таймауте или ошибке внешнего агента. Возвращает
        False если сообщение уже не 'streaming' (idempotent на повторный
        вызов).
        """
        async with self.msg_repo.conn.transaction():
            success = await self.msg_repo.mark_failed(
                message_id=message_id,
                error_block=error_block,
            )
            if not success:
                logger.warning(
                    "fail_assistant_message: message_id=%s уже не "
                    "в статусе 'streaming' — пропускаем",
                    message_id,
                )
                return False
            await self.conv_repo.touch(conversation_id)
        return True
