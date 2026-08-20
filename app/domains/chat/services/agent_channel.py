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

bus.media: транспорт — массив ``{file_id, filename, mime_type, file_size}``
в формате Nanobot, где ``file_id`` это ``data:<mime>;base64,<payload>``
(inline-payload). Блок формата chat_messages.content ({type:"file",
file_id:<UUID>, ...}) сюда НЕ подходит — лишний ``type``, и file_id это UUID,
а не data:URL.

Транспорт отделён от хранения в обе стороны:
  исходящее — ``build_bus_media_from_file_blocks`` читает байты из chat_files
    по UUID и кодирует их в data-URL (вложение сверх max_media_file_size
    пропускается с warning);
  входящее — ``parse_media_items`` классифицирует каждый элемент
    (data/http/uuid/other/empty), ``materialize_media_entries`` сохраняет
    data-URL в chat_files и отдаёт блоки чата с UUID. История беседы
    data-URL'ами не раздувается, скачивание идёт через защищённый эндпоинт.
"""

import asyncio
import base64
import binascii
import logging
import mimetypes
import re
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


_DATA_URL_HEAD_RE = re.compile(r"^data:([^;,]*)(?:;[^,]*)*,", re.DOTALL)


def _classify_file_id(value) -> str:
    """Вид file_id: 'data' | 'http' | 'uuid' | 'other' | 'empty'."""
    if not value or not isinstance(value, str):
        return "empty"
    if value.startswith("data:"):
        return "data"
    if value.startswith(("http://", "https://")):
        return "http"
    try:
        uuid.UUID(value)
        return "uuid"
    except (ValueError, AttributeError, TypeError):
        return "other"


def _data_url_mime_and_size(data_url: str) -> tuple[str, int]:
    """(mime, приблизительный размер байт) из data-URL без декодирования payload.

    Размер оценивается как len(base64)*3/4 — точность достаточна для
    отображения и лимитов, а декодировать сотни МБ ради длины не нужно.
    """
    m = _DATA_URL_HEAD_RE.match(data_url)
    mime = (m.group(1).strip().lower() if m else "") or "application/octet-stream"
    comma = data_url.find(",")
    payload_len = max(len(data_url) - comma - 1, 0) if comma >= 0 else 0
    return mime, payload_len * 3 // 4


def parse_media_items(media) -> list[dict]:
    """Нормализует bus.media в список записей единой формы (best-effort).

    Принимает список/одиночный объект/строку; элемент — dict схемы NanoBot
    ({file_id|url, filename|name, mime_type, file_size}) либо строка-data-URL
    (runtime-формат NanoBot). Кривой элемент пропускается с warning — один
    битый файл не должен ронять весь ответ (H3 аудита).
    """
    if media is None:
        return []
    if isinstance(media, (dict, str)):
        media = [media]
    if not isinstance(media, list):
        logger.warning("parse_media_items: media неожиданного типа %s — пропускаем", type(media).__name__)
        return []
    out: list[dict] = []
    for i, item in enumerate(media):
        try:
            if isinstance(item, str):
                if not item.startswith("data:"):
                    logger.warning("parse_media_items: строковый элемент media[%d] не data-URL — пропускаем", i)
                    continue
                mime, size = _data_url_mime_and_size(item)
                out.append({"file_id": item, "filename": "", "mime_type": mime,
                            "file_size": size, "kind": "data"})
                continue
            if not isinstance(item, dict):
                logger.warning("parse_media_items: элемент media[%d] типа %s — пропускаем", i, type(item).__name__)
                continue
            file_id = item.get("file_id") or item.get("url") or ""
            kind = _classify_file_id(file_id)
            mime = str(item.get("mime_type") or "")
            try:
                size = int(item.get("file_size") or 0)
            except (TypeError, ValueError):
                size = 0
            if kind == "data" and (not mime or not size):
                d_mime, d_size = _data_url_mime_and_size(file_id)
                mime = mime or d_mime
                size = size or d_size
            out.append({
                "file_id": file_id if isinstance(file_id, str) else "",
                "filename": str(item.get("filename") or item.get("name") or ""),
                "mime_type": mime,
                "file_size": size,
                "kind": kind,
            })
        except Exception:
            logger.warning("parse_media_items: не удалось разобрать media[%d] — пропускаем", i, exc_info=True)
    return out


def _entry_to_block(entry: dict) -> dict:
    """Запись parse_media_items → блок чата (без материализации).

    kind='other'/'empty' → карточка без file_id (фронт не рисует кнопок —
    битые пути агента не превращаются в 404-ссылки, M2 аудита).
    """
    file_id = entry["file_id"] if entry["kind"] in ("data", "http", "uuid") else ""
    if entry["mime_type"].startswith("image/") and file_id:
        return {"type": "image", "file_id": file_id, "alt": entry["filename"]}
    block = {
        "type": "file",
        "filename": entry["filename"],
        "mime_type": entry["mime_type"],
        "file_size": entry["file_size"],
    }
    if file_id:
        block["file_id"] = file_id
    return block


def _sanitize_agent_filename(name: str, mime: str, idx: int) -> str:
    """Имя входящего файла агента: без разделителей пути и null-byte.

    Те же правила, что FileService.validate_file для аплоада; пустое или
    служебное имя заменяется на file_<idx> с расширением по MIME.

    Имя обрезается до 500 символов — ширина колонки chat_files.filename.
    Переполнение уронило бы INSERT, и весь ответ агента дошёл бы до
    пользователя только по таймауту (тот же класс отказа, что H3).
    """
    name = (name or "").strip()
    for ch in ("/", "\\", "\x00"):
        name = name.replace(ch, "_")
    if name in ("", ".", ".."):
        ext = mimetypes.guess_extension(mime or "") or ""
        name = f"file_{idx}{ext}"
    return name[:500]


def _file_error_block(code: str, message: str) -> dict:
    """Error-блок про конкретное вложение агента (остальные блоки не страдают)."""
    return {"type": "error", "code": code, "message": message}


def _decode_base64_payload(payload: str) -> bytes:
    """Декодирует payload data-URL. Исполняется в потоке — вызов блокирующий.

    Строгий режим (validate=True): при ленивом декодировании «лишние» символы
    молча выбрасываются, и пользователь получил бы обрезанный файл вместо
    честной ошибки. Пробелы и переводы строк вычищаются заранее — агенты
    вполне могут переносить base64 по строкам, такой payload валиден.
    """
    return base64.b64decode("".join(payload.split()), validate=True)


async def materialize_media_entries(
    entries: list[dict],
    *,
    answer_uid: str,
    conversation_id: str,
    message_id: str,
    file_repo: FileRepository,
    max_size: int,
) -> list[dict]:
    """Материализует входящие data-URL вложения агента в chat_files (H2, вариант A).

    Транспорт (base64 в шине) отделяется от хранения: в блок чата уходит UUID
    из chat_files, историю беседы data-URL больше не раздувает, скачивание идёт
    через GET /chat/files/{id} (octet-stream + nosniff).

    Идемпотентность ретраев финализации: id файла детерминирован —
    uuid5(NAMESPACE_URL, "agent-media:{answer_uid}:{idx}"); повторный INSERT
    падает UniqueViolation и просто переиспользует существующую запись.

    MIME не проверяется по whitelist аплоада (решение владельца): файл всё
    равно отдаётся только как application/octet-stream. Размер сверяется с
    max_size по оценке из САМОГО payload (len*3//4) — объявленному агентом
    file_size страж не верит. Превышение лимита, битый/пустой base64 и любой
    сбой записи в chat_files дают error-блок про конкретный файл; остальные
    вложения и текст ответа при этом целы.
    """
    blocks: list[dict] = []
    for idx, entry in enumerate(entries):
        kind = entry["kind"]
        if kind != "data":
            blocks.append(_entry_to_block(entry))
            if kind in ("other", "empty"):
                logger.warning(
                    "materialize_media_entries: file_id вида %r (media[%d] ответа %s) — карточка без кнопок",
                    kind, idx, answer_uid,
                )
            continue
        filename = _sanitize_agent_filename(entry["filename"], entry["mime_type"], idx)
        payload = entry["file_id"].partition(",")[2]
        # Страж считает размер по САМОМУ payload, а не по объявленному агентом
        # file_size: тот приходит с чужой стороны и может врать в обе стороны —
        # «1 байт» при гигабайтном data-URL пустил бы гиганта в декодирование
        # и в INTEGER-колонку file_size, а завышенное объявление дало бы ложный
        # too_large на крошечном файле. Объявленный размер остаётся только
        # метаданными карточки.
        estimated_size = len(payload) * 3 // 4
        if estimated_size > max_size:
            logger.warning(
                "materialize_media_entries: файл %r (~%d байт по payload) превышает лимит %d — error-блок",
                filename, estimated_size, max_size,
            )
            blocks.append(_file_error_block(
                "agent_file_too_large",
                f"Файл «{filename}» от агента превышает лимит {max_size // (1024 * 1024)} МБ и не был сохранён.",
            ))
            continue
        try:
            raw = await asyncio.to_thread(_decode_base64_payload, payload)
        except (binascii.Error, ValueError):
            logger.warning("materialize_media_entries: битый base64 в media[%d] ответа %s", idx, answer_uid)
            blocks.append(_file_error_block(
                "agent_file_invalid",
                f"Файл «{filename}» от агента повреждён и не был сохранён.",
            ))
            continue
        if not raw:
            # chat_files.file_size под CHECK (> 0), как и аплоад («Файл пуст»).
            # Без этой ветки пустое вложение уронило бы всю финализацию
            # CheckViolation'ом, и ответ агента дошёл бы только по таймауту.
            logger.warning(
                "materialize_media_entries: пустое вложение %r (media[%d] ответа %s)",
                filename, idx, answer_uid,
            )
            blocks.append(_file_error_block(
                "agent_file_invalid",
                f"Файл «{filename}» от агента пуст и не был сохранён.",
            ))
            continue
        mime = entry["mime_type"] or "application/octet-stream"
        file_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"agent-media:{answer_uid}:{idx}"))
        try:
            await file_repo.create(
                id=file_id, conversation_id=conversation_id, filename=filename,
                mime_type=mime, file_size=len(raw), file_data=raw, message_id=message_id,
            )
        except asyncpg.exceptions.UniqueViolationError:
            logger.info("materialize_media_entries: файл %s уже сохранён (ретрай финализации)", file_id)
        except Exception:
            # Принцип «один битый файл не роняет ответ» распространяется и на
            # запись: любая другая ошибка БД (исчезнувшая беседа, переполнение
            # колонки) иначе вылетела бы из poll_once, и текст ответа дошёл бы
            # до пользователя только по таймауту.
            logger.warning(
                "materialize_media_entries: не удалось сохранить файл %s (media[%d] ответа %s) — error-блок",
                file_id, idx, answer_uid, exc_info=True,
            )
            blocks.append(_file_error_block(
                "agent_file_invalid",
                f"Файл «{filename}» от агента не удалось сохранить.",
            ))
            continue
        if mime.startswith("image/"):
            blocks.append({"type": "image", "file_id": file_id, "alt": filename,
                           "mime_type": mime, "filename": filename})
        else:
            blocks.append({"type": "file", "file_id": file_id, "filename": filename,
                           "mime_type": mime, "file_size": len(raw)})
    return blocks


def map_answer_to_blocks(
    row: dict, max_block_text_size: int = 262144, media_blocks: list[dict] | None = None
) -> list[dict]:
    """Маппит строку-ответ chat_agent_messages_bus в блоки чата.

    Порядок: reasoning (metadata.reasoning, legacy metadata.thinking) →
    text (content) → buttons → media.
    block_id кнопок и reasoning: ``f"{row['id']}:btn:0"`` / ``f"{row['id']}:reasoning:0"``.
    Тексты обрезаются через _trim_text_if_oversized.
    ``media_blocks`` — готовые блоки от материализатора (Task 4); при
    ``None`` секция media строится best-effort из ``row["media"]`` через
    ``parse_media_items`` (passthrough, как раньше).
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

    # 4. media: готовые блоки от материализатора (Task 4) либо passthrough.
    if media_blocks is not None:
        blocks.extend(media_blocks)
    else:
        for entry in parse_media_items(row.get("media")):
            blocks.append(_entry_to_block(entry))

    return blocks


async def build_bus_media_from_file_blocks(
    file_blocks: list[dict] | None,
    *,
    conversation_id: str,
    file_repo: FileRepository,
    max_size: int,
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
    кодируются в base64. Если file_block без ``file_id``, запись не найдена
    или файл больше ``max_size`` — пропускается (best-effort: потеря одного
    файла не должна ронять вопрос целиком).

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
        if len(raw) > max_size:
            logger.warning(
                "build_bus_media_from_file_blocks: файл %s (%d байт) превышает "
                "лимит вложения шины %d — не отправляем агенту",
                file_id, len(raw), max_size,
            )
            continue
        encoded = (await asyncio.to_thread(base64.b64encode, raw)).decode("ascii")
        out.append({
            "file_id": f"data:{mime};base64,{encoded}",
            "filename": row["filename"],
            "mime_type": mime,
            "file_size": len(raw),
        })
    return out or None


async def build_bus_media_for_submit(
    file_blocks: list[dict] | None,
    *,
    conversation_id: str,
    max_size: int,
) -> list[dict] | None:
    """Единая точка конверсии file_blocks → bus.media для messages.py и agent_loop.py.

    Работает на DbExecutor (соединение на операцию): чтение байт из chat_files
    не удерживает соединение на время base64-кодирования. Без файлов — None
    без обращений к БД.
    """
    if not file_blocks:
        return None
    from app.db.executor import get_executor

    return await build_bus_media_from_file_blocks(
        file_blocks,
        conversation_id=conversation_id,
        file_repo=FileRepository(get_executor()),
        max_size=max_size,
    )


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
        # подкладываем разовым чтением ровно на финализации. data-URL из шины
        # сразу материализуем в chat_files: в блоки уходят UUID, а не base64.
        media_entries = parse_media_items(
            await agent_repo.get_media_by_uid(str(answer["id"]))
        )
        media_blocks = await materialize_media_entries(
            media_entries,
            answer_uid=str(answer["id"]),
            conversation_id=str(question.get("chat_id") or ""),
            message_id=assistant_message_id,
            file_repo=FileRepository(self._conn),
            max_size=self._settings.agent_channel.max_media_file_size,
        )

        blocks = map_answer_to_blocks(
            answer,
            max_block_text_size=self._settings.agent_channel.max_block_text_size,
            media_blocks=media_blocks,
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
