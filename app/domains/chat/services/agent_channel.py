"""Сервис канала к внешнему агенту через bus-таблицу chat_agent_messages_bus.

Поток (подтверждённая спека владельца шины — стороны агента):
  AW → submit() → INSERT вопрос (role='user', status='pending')
                  + create_streaming draft (status='streaming', agent_ref=uid)
  Агент → claim вопроса (status='processing') → INSERT ответ (role='assistant',
          reply_to = id ВОПРОСА) → стримит reasoning-дельты в metadata.reasoning
          → пишет финальный content и терминальный status ('completed'/'failed')
  AW → poll_once() → ищет ответ по reply_to = id вопроса; инкрементально
        upsert'ит частичный reasoning-блок пока ответ нетерминальный; финализирует
        draft, когда статус ответа терминальный.

Словарь status владельца (NanoBot 2.3): pending | processing | completed |
error | failed; role: user | assistant | system | tool. 'error' —
ПОВТОРЯЕМАЯ ошибка: агент вернёт вопрос в пул и переобработает его (до
max_stuck_retries раз), удалив свою строку-ответ; терминален только 'failed'.
Записи статуса от AW — best-effort: CheckViolation логируется и глотается,
финализацию/таймаут это не ломает (защита от смены словаря владельцем).

bus.media: AW пишет сюда в формате Nanobot — массив
``{file_id, filename, mime_type, file_size}``, где ``file_id`` это
``data:<mime>;base64,<payload>`` (inline-payload). Агент-читатель
(map_answer_to_blocks) извлекает данные из data:URL напрямую, не ходя в
chat_files. Блок формата chat_messages.content ({type:"file", file_id:<UUID>,
...}) сюда НЕ подходит — лишний ``type``, и file_id это UUID, а не data:URL.
Хелпер ``build_bus_media_from_file_blocks`` приводит формат к спеке шины.
"""

import base64
import logging
import uuid
from datetime import datetime, timedelta, timezone

import asyncpg

from app.db.types import DbConn
from app.domains.chat.exceptions import AgentChannelUnavailableError, ChatLimitError
from app.domains.chat.repositories.agent_message_repository import AgentMessageRepository
from app.domains.chat.repositories.file_repository import FileRepository
from app.domains.chat.repositories.message_repository import MessageRepository
from app.domains.chat.services.button_translator import translate_buttons
from app.domains.chat.settings import ChatDomainSettings

logger = logging.getLogger("audit_workstation.domains.chat.service.agent_channel")

_TRIM_MARKER = " …[обрезано]"
_TRIM_MARKER_BYTES = len(_TRIM_MARKER.encode("utf-8"))

# Нетерминальные статусы строки шины: ответ с таким статусом ещё пишется
# агентом — финализировать рано. Словарь владельца: 'processing' (агент создаёт
# строку-ответ сразу при claim'е и стримит reasoning-дельты в metadata, пока не
# запишет финальный content); 'in_progress' — legacy-синоним для старых dev-строк.
# 'error' — повторяемая ошибка NanoBot 2.3 (_mark_failed: пока
# retry_count < max_stuck_retries задача вернётся в пул через
# error_retry_delay; assistant-строка при этом удаляется). Терминальным
# остаётся только 'failed'.
# Любой другой статус при наличии строки-ответа считаем терминальным.
_BUS_PENDING_STATUSES = ("pending", "processing", "in_progress", "error")

# Терминальный статус ошибки — словарь владельца шины.
_BUS_ERROR_STATUSES = ("failed",)


# ── Pure-функции ─────────────────────────────────────────────────────────────


def _trim_text_if_oversized(*, text: str, max_size: int, uid: str, block_type: str) -> str:
    """Обрезает ``text`` до ``max_size`` UTF-8 байт + маркер «…[обрезано]».

    UTF-8-safe: режем по байтам, затем откатываемся до начала предыдущего
    code-point (0b10xxxxxx — continuation byte; 0b11xxxxxx — lead без хвоста).
    Если ``text`` помещается — быстрый путь без encode.
    """
    if not text:
        return text
    encoded = text.encode("utf-8")
    if len(encoded) <= max_size:
        return text
    original_size = len(encoded)
    cut_at = max_size - _TRIM_MARKER_BYTES
    if cut_at <= 0:
        return _TRIM_MARKER.strip()
    truncated_bytes = encoded[:cut_at]
    # Откат с continuation bytes (10xxxxxx).
    while truncated_bytes and (truncated_bytes[-1] & 0xC0) == 0x80:
        truncated_bytes = truncated_bytes[:-1]
    # Откат с lead byte без хвоста (11xxxxxx).
    if truncated_bytes and (truncated_bytes[-1] & 0xC0) == 0xC0:
        truncated_bytes = truncated_bytes[:-1]
    truncated_text = truncated_bytes.decode("utf-8", errors="ignore")
    result = truncated_text + _TRIM_MARKER
    logger.warning(
        "agent_channel: блок обрезан с %d до %d байт, uid=%s, type=%s",
        original_size,
        len(result.encode("utf-8")),
        uid,
        block_type,
    )
    return result


def _normalize_button(btn: dict, idx: int) -> dict:
    """Нормализует одну кнопку из ответа агента с дефолтами."""
    return {
        "action_id": btn.get("action_id", f"btn_{idx}"),
        "label": btn.get("label", ""),
        "params": btn.get("params") or {},
    }


def map_answer_to_blocks(row: dict, max_block_text_size: int = 262144) -> list[dict]:
    """Маппит строку-ответ chat_agent_messages_bus в блоки чата.

    Порядок: reasoning (metadata.reasoning, legacy metadata.thinking) →
    text (content) → buttons → media.
    block_id кнопок и reasoning: ``f"{row['id']}:btn:0"`` / ``f"{row['id']}:reasoning:0"``.
    Тексты обрезаются через _trim_text_if_oversized.
    """
    row_id = row.get("id", "unknown")
    blocks: list[dict] = []

    # 1. reasoning из metadata.reasoning (ключ по спеке владельца шины;
    #    'thinking' — legacy-fallback для старых строк и dev-имитаций)
    metadata = row.get("metadata") or {}
    if isinstance(metadata, dict):
        thinking = metadata.get("reasoning") or metadata.get("thinking")
        if thinking and isinstance(thinking, str) and thinking.strip():
            trimmed = _trim_text_if_oversized(
                text=thinking.strip(),
                max_size=max_block_text_size,
                uid=row_id,
                block_type="reasoning",
            )
            blocks.append({
                "type": "reasoning",
                "content": trimmed,
                "block_id": f"{row_id}:reasoning:0",
            })

    # 2. text из content
    content = row.get("content")
    if content and isinstance(content, str) and content.strip():
        trimmed = _trim_text_if_oversized(
            text=content.strip(),
            max_size=max_block_text_size,
            uid=row_id,
            block_type="text",
        )
        blocks.append({"type": "text", "content": trimmed})

    # 3. buttons
    buttons = row.get("buttons")
    if buttons and isinstance(buttons, list) and len(buttons) > 0:
        normalized = [_normalize_button(b, i) for i, b in enumerate(buttons)]
        blocks.append({
            "type": "buttons",
            "buttons": normalized,
            "block_id": f"{row_id}:btn:0",
        })

    # 4. media
    media = row.get("media")
    if media is not None:
        # Одиночный объект → оборачиваем в список.
        if isinstance(media, dict):
            media = [media]
        if isinstance(media, list):
            for item in media:
                if not isinstance(item, dict):
                    continue
                mime = item.get("mime_type", "")
                file_id = item.get("file_id", item.get("url", ""))
                filename = item.get("filename", item.get("name", ""))
                if mime.startswith("image/"):
                    blocks.append({
                        "type": "image",
                        "file_id": file_id,
                        "alt": filename,
                    })
                else:
                    blocks.append({
                        "type": "file",
                        "file_id": file_id,
                        "filename": filename,
                        "mime_type": mime,
                        "file_size": int(item.get("file_size", 0)),
                    })

    return blocks


async def build_bus_media_from_file_blocks(
    file_blocks: list[dict] | None,
    *,
    conversation_id: str,
    file_repo: FileRepository,
) -> list[dict] | None:
    """Преобразует file_blocks (UUID-формат chat_messages.content) в bus.media.

    Спека шины (docs/guides/chat-files-data-requirements.md §6.3): элемент
    ``{file_id, filename, mime_type, file_size}``, где ``file_id`` это либо
    UUID из chat_files, либо ``data:<mime>;base64,<payload>``. Nanobot пишет
    именно data-URL (см. пример из задачи: бинарь инлайнится в base64).
    Формат ``chat_messages.content`` (``{type:"file", file_id:<UUID>, ...}``)
    сюда не подходит: лишний ``type`` — поле блока контента, а не шины;
    file_id должен быть data-URL, иначе агент-читатель потеряет payload.

    Каждый файл подтягивается из chat_files по ``file_id`` UUID и его байты
    кодируются в base64. Если file_block без ``file_id`` или запись не
    найдена — пропускается (best-effort: потеря одного файла не должна
    ронять вопрос целиком).

    Возвращает ``None`` при пустом входе — это формальный «нет файлов»
    для insert_question и совпадает с поведением caller'ов, которые
    передают ``None`` при отсутствии вложений.
    """
    if not file_blocks:
        return None
    out: list[dict] = []
    for fb in file_blocks:
        if not isinstance(fb, dict):
            continue
        file_id = fb.get("file_id")
        if not file_id:
            continue
        row = await file_repo.get_file_content(
            file_id=file_id,
            conversation_id=conversation_id,
        )
        if not row:
            logger.warning(
                "build_bus_media_from_file_blocks: файл %s не найден "
                "в chat_files для conversation=%s — пропускаем",
                file_id, conversation_id,
            )
            continue
        mime = row["mime_type"]
        raw = bytes(row["file_data"])
        encoded = base64.b64encode(raw).decode("ascii")
        out.append({
            "file_id": f"data:{mime};base64,{encoded}",
            "filename": row["filename"],
            "mime_type": mime,
            "file_size": len(raw),
        })
    return out or None


def _extract_reasoning(answer: dict) -> str:
    """Текст рассуждений из строки-ответа: metadata.reasoning, legacy metadata.thinking."""
    metadata = answer.get("metadata") or {}
    if not isinstance(metadata, dict):
        return ""
    val = metadata.get("reasoning") or metadata.get("thinking")
    return val.strip() if isinstance(val, str) else ""


# Коды причин таймаута агента. Единые константы для поллера (выбор reason
# по фазе) и build_timeout_error_block (текст error-блока) — вместо строковых
# литералов, расползающихся по двум файлам.
TIMEOUT_REASON_CLAIM = "claim"
TIMEOUT_REASON_ANSWER = "answer"


def build_timeout_error_block(reason: str = TIMEOUT_REASON_ANSWER) -> dict:
    """Error-блок таймаута агента. reason: 'answer' — агент не дописал ответ;
    'claim' — агент не взял вопрос в работу (очередь не двигалась claim_timeout)."""
    if reason == TIMEOUT_REASON_CLAIM:
        return {
            "type": "error",
            "code": "agent_claim_timeout",
            "message": "Внешний агент не взял вопрос в работу за отведённое время. Попробуйте позже.",
        }
    return {
        "type": "error",
        "code": "agent_timeout",
        "message": "Внешний агент не ответил вовремя. Попробуйте позже.",
    }


# ── Сервис ───────────────────────────────────────────────────────────────────


class AgentChannelService:
    """Сервис канала к внешнему агенту через bus-таблицу chat_agent_messages_bus.

    Принимает ``conn`` (``DbConn``) и ``settings`` (ChatDomainSettings). Тип
    именно протокольный, а не ``asyncpg.Connection``: DI-фабрика, поллер и
    ``api/messages.py`` передают сюда ``DbExecutor``, а ``agent_loop.py`` —
    сырое соединение из транзиентного ``get_db()``. Обе реализации
    удовлетворяют ``DbConn``. Паттерн получения settings идентичен
    MessageService / ConversationService: вызывающий код инжектирует
    настройки снаружи.
    """

    def __init__(self, conn: DbConn, settings: ChatDomainSettings):
        self._conn = conn
        self._settings = settings

    def _agent_repo(self) -> AgentMessageRepository:
        return AgentMessageRepository(
            self._conn,
            self._settings.agent_channel.table_name,
        )

    def _message_repo(self) -> MessageRepository:
        return MessageRepository(self._conn)

    async def _set_status_safe(self, *, uid: str, status: str) -> None:
        """Best-effort запись статуса в чужую bus-таблицу.

        На таблице владельца есть CHECK по status; его полный список значений
        нам неизвестен и может меняться. CheckViolation — постоянная ошибка
        (ретрай бесполезен), глотаем с warning'ом: статус в шине — гигиена,
        source-of-truth отображения — chat_messages. Транзиентные ошибки БД
        пробрасываются — поллер повторит операцию на следующем тике.
        """
        try:
            await self._agent_repo().set_status(uid=uid, status=status)
        except asyncpg.exceptions.CheckViolationError:
            logger.warning(
                "agent_channel: CHECK владельца шины отклонил status=%r для uid=%s — пропускаем",
                status,
                uid,
            )

    async def submit(
        self,
        *,
        conversation_id: str,
        user_id: str,
        assistant_message_id: str,
        text: str,
        mode: str,
        kb: str = "oarb",
        media: list | None = None,
    ) -> str:
        """Кладёт вопрос в chat_agent_messages_bus и создаёт draft-сообщение в chat_messages.

        Возвращает ``question_uid`` — id строки-вопроса в bus-таблице.
        Вызывающий может сразу передать его поллеру без дополнительного SELECT;
        draft в chat_messages хранит тот же uid в поле ``agent_ref``.
        """
        # Мягкий лимит: count-then-insert не атомарен, два конкурентных запроса
        # могут оба пройти проверку на границе. Это защита от злоупотребления,
        # а не строгий инвариант — небольшое превышение допустимо.
        # Двухфазные отсечки: pending живёт в окне claim_timeout_sec по
        # created_at; processing и error — в окне answer_timeout_sec по
        # updated_at (агент обновляет updated_at, стримя reasoning и фиксируя
        # повторяемую ошибку).
        limit = self._settings.max_parallel_streams_per_user
        now = datetime.now(timezone.utc)
        active = await self._agent_repo().count_active_for_user(
            user_id,
            pending_created_after=now - timedelta(
                seconds=self._settings.agent_channel.claim_timeout_sec
            ),
            processing_updated_after=now - timedelta(
                seconds=self._settings.agent_channel.answer_timeout_sec
            ),
        )
        if active >= limit:
            raise ChatLimitError(
                f"Достигнут лимит одновременных запросов к агенту ({limit}). "
                "Дождитесь ответа на предыдущие."
            )

        question_uid = str(uuid.uuid4())

        # Оба INSERT'а — в одной транзакции: вопрос в шине без draft'а (или
        # наоборот) оставил бы осиротевшую строку, которая вечно входит в
        # count_active_for_user и съедает слот лимита параллельных запросов.
        try:
            async with self._conn.transaction():
                await self._agent_repo().insert_question(
                    id=question_uid,
                    chat_id=conversation_id,
                    user_id=user_id,
                    content=text,
                    metadata={"mode": mode, "kb": kb},
                    media=media,
                )
                await self._message_repo().create_streaming(
                    message_id=assistant_message_id,
                    conversation_id=conversation_id,
                    agent_ref=question_uid,
                )
        except asyncpg.exceptions.CheckViolationError as exc:
            # CHECK владельца шины отклонил наш вопрос (например, после смены
            # словаря на его стороне). Имя его констрейнта на ПРОМе чужое —
            # глобальный обработчик CheckViolationError не найдёт маппинг в
            # CHECK_CONSTRAINT_MESSAGES, поэтому конвертируем в доменную ошибку
            # с понятным сообщением. Транзакция уже откатила draft.
            logger.error(
                "agent_channel: CHECK владельца шины отклонил вопрос uid=%s: %s",
                question_uid,
                exc,
            )
            raise AgentChannelUnavailableError(
                "Не удалось передать вопрос внешнему агенту. Попробуйте позже."
            ) from exc
        return question_uid

    async def mark_timeout(
        self,
        *,
        assistant_message_id: str,
        question_uid: str,
        reason: str = TIMEOUT_REASON_ANSWER,
    ) -> None:
        """Помечает draft как failed (error-блок таймаута) и закрывает вопрос в шине.

        reason: 'answer' — агент не дописал ответ (дефолт);
                'claim'  — агент не взял вопрос в работу.
        """
        # Закрываем вопрос статусом 'failed' — он есть в словаре CHECK'а
        # владельца ('timeout' там запрещён). Запись всё равно best-effort:
        # если CHECK отклонит, строка останется в pending — побочных эффектов
        # нет: reconcile её не подхватит (chat_message уже failed,
        # get_streaming_drafts отбирает только status='streaming'), а слот
        # лимита освобождает отсечка по возрасту в count_active_for_user.
        await self._message_repo().mark_failed(
            message_id=assistant_message_id,
            error_block=build_timeout_error_block(reason),
        )
        await self._set_status_safe(uid=question_uid, status="failed")
        logger.info(
            "agent_channel: таймаут (%s) — message_id=%s, question_uid=%s",
            reason,
            assistant_message_id,
            question_uid,
        )

    async def _emit_answer_notification(
        self,
        *,
        question: dict | None,
        title: str,
        severity: str,
    ) -> None:
        """Эмитит персистентное уведомление о готовности/ошибке ответа агента.

        Best-effort: вся эмиссия обёрнута в try/except — сбой или отсутствие
        домена notifications НЕ должны ломать финализацию ответа (она уже
        успешно записана в БД к моменту вызова). Фабрика разрешается мягко
        через ``has_factory``/``get_factory`` (импорт локальный, чтобы не
        плодить import-циклы и чтобы тесты могли патчить domain_registry).

        Получатель — автор вопроса (``question.user_id``). Если строки-вопроса
        нет или у неё нет user_id — уведомление не эмитим (broadcast здесь не
        нужен, а адресовать ответ некому).

        Ссылка: чат — это popup без собственного URL, а в метаданных вопроса
        (``{"mode", "kb"}``) надёжного ``act_id`` нет. Поэтому ``link=None``
        (переход из уведомления не предусмотрен — допустимо по спеке). Не
        выдумываем несуществующий URL чата.
        """
        if not question:
            return
        recipient_user_id = question.get("user_id")
        if not recipient_user_id:
            return

        # Делегируем единому ядерному хелперу (резолв фабрики + мягкий
        # try/except). Локальный импорт — без жёсткой зависимости на
        # module-level и для патчинга реестра в тестах.
        from app.core.notifications_emit import push_notification

        await push_notification(
            source="chat",
            title=title,
            severity=severity,
            link=None,
            recipient_user_id=recipient_user_id,
        )

    async def get_queue_details(self, question_uid: str) -> dict | None:
        """Промежуточный статус вопроса в шине для отображения на фронте.

        Возвращает {"bus_status": str, "queue_ahead": int|None} либо None,
        если строки-вопроса нет (например, владелец её удалил).
        queue_ahead считается только для 'pending' — после взятия в работу
        позиция в очереди не имеет смысла.
        """
        agent_repo = self._agent_repo()
        question = await agent_repo.get_status_by_uid(question_uid)
        if not question:
            return None
        status = question.get("status")
        queue_ahead = None
        if status == "pending":
            queue_ahead = await agent_repo.count_pending_before(
                question["created_at"]
            )
        return {"bus_status": status, "queue_ahead": queue_ahead}

    async def poll_once(
        self,
        *,
        assistant_message_id: str,
        question_uid: str,
        last_reasoning_len: int = 0,
        want_queue_position: bool = False,
    ) -> dict:
        """Один тик наблюдения за вопросом: финализация при готовности,
        upsert частичного reasoning, сбор liveness-сигналов для поллера.

        Возвращает dict:
          outcome           — 'done' (подписку снять) | 'pending' (ждать дальше);
          question_status   — статус строки-вопроса (None, если строки нет);
          answer_exists     — появилась ли строка-ответ;
          reasoning_len     — длина (в символах) текста рассуждений на строке-ответе (0 если нет);
          queue_ahead       — pending-вопросов впереди (None вне фазы pending
                              или при want_queue_position=False);
          answer_updated_at — updated_at строки-ответа (liveness-сигнал).
        """
        agent_repo = self._agent_repo()
        message_repo = self._message_repo()

        result = {
            "outcome": "pending",
            "question_status": None,
            "answer_exists": False,
            "reasoning_len": 0,
            "queue_ahead": None,
            "answer_updated_at": None,
        }

        question = await agent_repo.get_by_uid(question_uid)
        if not question:
            logger.warning("poll_once: вопрос %s не найден в bus-таблице", question_uid)
            return result
        result["question_status"] = question.get("status")

        answer = await agent_repo.get_answer_for_question(question_uid)
        if not answer:
            if question.get("status") == "error":
                meta = question.get("metadata") or {}
                logger.info(
                    "poll_once: вопрос %s в состоянии 'error' (retry %s, причина=%s) — "
                    "ждём повторной обработки агентом",
                    question_uid,
                    meta.get("retry_count") if isinstance(meta, dict) else None,
                    meta.get("error") if isinstance(meta, dict) else None,
                )
            # Агент мог закрыть вопрос со status='failed' без строки-ответа.
            if question.get("status") in _BUS_ERROR_STATUSES:
                failed = await message_repo.mark_failed(
                    message_id=assistant_message_id,
                    error_block={
                        "type": "error",
                        "code": "agent_error",
                        "message": "Внешний агент вернул ошибку.",
                    },
                )
                if failed:
                    await self._emit_answer_notification(
                        question=question,
                        title="Ошибка ответа базы знаний",
                        severity="error",
                    )
                result["outcome"] = "done"
                return result
            if question.get("status") == "pending" and want_queue_position:
                result["queue_ahead"] = await agent_repo.count_pending_before(
                    question["created_at"]
                )
            return result

        result["answer_exists"] = True
        result["answer_updated_at"] = answer.get("updated_at")
        reasoning = _extract_reasoning(answer)
        result["reasoning_len"] = len(reasoning)

        if answer.get("status") in _BUS_PENDING_STATUSES:
            # Ответ ещё пишется: стримим частичный reasoning в черновик.
            # block_id строится от id строки-ОТВЕТА — ровно как в
            # map_answer_to_blocks, поэтому финализация заместит блок, а не задвоит.
            if reasoning and len(reasoning) > max(last_reasoning_len, 0):
                trimmed = _trim_text_if_oversized(
                    text=reasoning,
                    max_size=self._settings.agent_channel.max_block_text_size,
                    uid=str(answer.get("id", "unknown")),
                    block_type="reasoning",
                )
                await message_repo.upsert_block(
                    message_id=assistant_message_id,
                    block={
                        "type": "reasoning",
                        "content": trimmed,
                        "block_id": f"{answer.get('id', 'unknown')}:reasoning:0",
                    },
                )
            return result

        if answer.get("status") in _BUS_ERROR_STATUSES:
            error_message = answer.get("content") or "Внешний агент вернул ошибку."
            error_block = {
                "type": "error",
                "code": "agent_error",
                "message": error_message,
            }
            failed = await message_repo.mark_failed(
                message_id=assistant_message_id,
                error_block=error_block,
            )
            if failed:
                # Уведомление об ошибке — ровно один раз, на тике, который
                # реально перевёл сообщение в терминал, и ДО set_status: при
                # сбое set_status поллер повторит poll_once, но mark_failed
                # вернёт False — уведомление не задвоится и не потеряется.
                # best-effort (см. _emit_answer_notification).
                await self._emit_answer_notification(
                    question=question,
                    title="Ошибка ответа базы знаний",
                    severity="error",
                )
            # Закрываем вопрос ('failed' — словарь владельца): не полагаемся
            # на то, что внешний агент проставит терминальный status.
            # CheckViolation глотается (_set_status_safe); транзиентный сбой
            # поднимется в _tick, подписка останется и поллер повторит
            # poll_once на следующем тике (mark_failed идемпотентен —
            # вернёт False на уже не-streaming сообщении).
            await self._set_status_safe(uid=question_uid, status="failed")
            result["outcome"] = "done"
            return result

        # Транслируем кнопки (acts.open_act_page → open_url) перед маппингом в блоки.
        if answer.get("buttons"):
            answer["buttons"] = await translate_buttons(answer["buttons"])

        # C1: media не пришла в узкой проекции get_answer_for_question —
        # подкладываем разовым чтением ровно на финализации.
        answer["media"] = await agent_repo.get_media_by_uid(str(answer["id"]))

        blocks = map_answer_to_blocks(
            answer,
            max_block_text_size=self._settings.agent_channel.max_block_text_size,
        )
        finalized = await message_repo.finalize(
            message_id=assistant_message_id,
            final_blocks=blocks,
        )
        if finalized:
            # Уведомление о готовности — ровно один раз, на тике, который
            # реально финализировал черновик, и ДО set_status: при сбое
            # set_status поллер повторит poll_once, но finalize вернёт False
            # — уведомление не задвоится и не потеряется. best-effort
            # (см. _emit_answer_notification).
            await self._emit_answer_notification(
                question=question,
                title="Готов ответ базы знаний",
                severity="info",
            )
        # Закрываем вопрос в шине, если агент не сделал это сам. Словарь
        # статусов — владельца: 'completed' (наблюдаемо разрешён CHECK'ом),
        # не 'complete'. CheckViolation глотается (_set_status_safe);
        # транзиентный сбой → поллер повторит poll_once на следующем тике
        # (finalize идемпотентен — вернёт False на уже complete-сообщении).
        await self._set_status_safe(uid=question_uid, status="completed")
        result["outcome"] = "done"
        return result
