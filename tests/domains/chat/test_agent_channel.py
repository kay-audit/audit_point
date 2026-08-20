"""Тесты сервиса agent_channel.py.

Покрывают: map_answer_to_blocks, build_bus_media_from_file_blocks,
build_timeout_error_block, AgentChannelService.submit,
AgentChannelService.poll_once, AgentChannelService.get_queue_details.
"""

import base64
import uuid

import asyncpg
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.domains.chat.exceptions import ChatLimitError
from app.domains.chat.services.agent_channel import (
    AgentChannelService,
    build_bus_media_from_file_blocks,
    build_timeout_error_block,
    map_answer_to_blocks,
    materialize_media_entries,
    parse_media_items,
)
from app.domains.chat.settings import ChatDomainSettings


# ── Фикстуры ─────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _patch_adapter():
    """Подменяет get_adapter, чтобы BaseRepository работал вне init_db()."""
    adapter = MagicMock()
    adapter.get_table_name = lambda name, schema='': name
    with patch("app.db.repositories.base.get_adapter", return_value=adapter):
        yield


@pytest.fixture
def settings():
    """ChatDomainSettings с дефолтными значениями."""
    return ChatDomainSettings()


@pytest.fixture
def mock_conn():
    """Mock asyncpg.Connection."""
    conn = AsyncMock()
    conn.fetchrow = AsyncMock()
    conn.fetchval = AsyncMock()
    conn.fetch = AsyncMock()
    conn.execute = AsyncMock()
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)
    return conn


@pytest.fixture
def service(mock_conn, settings):
    return AgentChannelService(mock_conn, settings)


# ── map_answer_to_blocks ──────────────────────────────────────────────────────


class TestMapAnswerToBlocks:

    def test_text_and_thinking_produces_reasoning_then_text(self):
        """reasoning (из thinking) идёт первым, затем text."""
        row = {
            "id": "a1",
            "content": "Ответ агента",
            "metadata": {"thinking": "Рассуждение агента"},
            "buttons": None,
            "media": None,
        }
        blocks = map_answer_to_blocks(row)
        assert len(blocks) == 2
        assert blocks[0]["type"] == "reasoning"
        assert blocks[0]["content"] == "Рассуждение агента"
        assert blocks[0]["block_id"] == "a1:reasoning:0"
        assert blocks[1]["type"] == "text"
        assert blocks[1]["content"] == "Ответ агента"

    def test_reasoning_key_from_owner_spec(self):
        """Рассуждения читаются из metadata.reasoning (ключ по спеке владельца
        шины); metadata.thinking — legacy-fallback."""
        row = {
            "id": "a1",
            "content": "Ответ",
            "metadata": {"reasoning": "Стримленные рассуждения агента"},
            "buttons": None,
            "media": None,
        }
        blocks = map_answer_to_blocks(row)
        assert blocks[0]["type"] == "reasoning"
        assert blocks[0]["content"] == "Стримленные рассуждения агента"

    def test_reasoning_key_takes_precedence_over_thinking(self):
        """При обоих ключах приоритет у reasoning (актуальная спека)."""
        row = {
            "id": "a1",
            "content": "",
            "metadata": {"reasoning": "новый ключ", "thinking": "старый ключ"},
            "buttons": None,
            "media": None,
        }
        blocks = map_answer_to_blocks(row)
        assert blocks[0]["content"] == "новый ключ"

    def test_buttons_get_block_id(self):
        """Кнопки получают block_id вида «{id}:btn:0» и нормализуются."""
        row = {
            "id": "a1",
            "content": "",
            "metadata": {},
            "buttons": [
                {"action_id": "act_1", "label": "Да", "params": {"key": "v"}},
                {"action_id": "act_2", "label": "Нет"},
            ],
            "media": None,
        }
        blocks = map_answer_to_blocks(row)
        btn_blocks = [b for b in blocks if b["type"] == "buttons"]
        assert len(btn_blocks) == 1
        assert btn_blocks[0]["block_id"] == "a1:btn:0"
        assert btn_blocks[0]["buttons"][0]["params"] == {"key": "v"}
        assert btn_blocks[0]["buttons"][1]["params"] == {}  # дефолт

    def test_media_image_by_mime(self):
        """media с image/* mime и валидным (uuid) file_id → блок type='image'."""
        file_id = str(uuid.uuid4())
        row = {
            "id": "a2",
            "content": None,
            "metadata": {},
            "buttons": None,
            "media": [{"file_id": file_id, "filename": "photo.jpg", "mime_type": "image/jpeg"}],
        }
        blocks = map_answer_to_blocks(row)
        assert len(blocks) == 1
        assert blocks[0]["type"] == "image"
        assert blocks[0]["file_id"] == file_id
        assert blocks[0]["alt"] == "photo.jpg"

    def test_media_non_image_file_block(self):
        """media с не-image/* mime → блок type='file'."""
        row = {
            "id": "a3",
            "content": None,
            "metadata": {},
            "buttons": None,
            "media": [{
                "file_id": "f2",
                "filename": "report.pdf",
                "mime_type": "application/pdf",
                "file_size": 1024,
            }],
        }
        blocks = map_answer_to_blocks(row)
        assert len(blocks) == 1
        assert blocks[0]["type"] == "file"
        assert blocks[0]["filename"] == "report.pdf"
        assert blocks[0]["mime_type"] == "application/pdf"
        assert blocks[0]["file_size"] == 1024

    def test_single_media_dict_wrapped_in_list(self):
        """Одиночный dict в media → оборачивается в список."""
        row = {
            "id": "a4",
            "content": None,
            "metadata": {},
            "buttons": None,
            "media": {"file_id": str(uuid.uuid4()), "filename": "x.png", "mime_type": "image/png"},
        }
        blocks = map_answer_to_blocks(row)
        assert len(blocks) == 1
        assert blocks[0]["type"] == "image"

    def test_empty_fields_skipped(self):
        """Пустые/None поля не создают блоки."""
        row = {
            "id": "a5",
            "content": "",
            "metadata": {},
            "buttons": None,
            "media": None,
        }
        blocks = map_answer_to_blocks(row)
        assert blocks == []

    def test_none_content_skipped(self):
        """None content не создаёт блок text."""
        row = {
            "id": "a6",
            "content": None,
            "metadata": {},
            "buttons": [],
            "media": None,
        }
        blocks = map_answer_to_blocks(row)
        assert blocks == []

    def test_order_reasoning_text_buttons_media(self):
        """Порядок: reasoning → text → buttons → media."""
        row = {
            "id": "ord",
            "content": "Текст",
            "metadata": {"thinking": "Рассуждение"},
            "buttons": [{"action_id": "a", "label": "Кнопка"}],
            "media": [{"file_id": str(uuid.uuid4()), "filename": "pic.png", "mime_type": "image/png"}],
        }
        blocks = map_answer_to_blocks(row)
        types = [b["type"] for b in blocks]
        assert types == ["reasoning", "text", "buttons", "image"]

    def test_long_text_trimmed(self):
        """Длинный текст обрезается до max_block_text_size байт + маркер."""
        long_text = "А" * 1000  # каждый символ — 2 байта в UTF-8
        row = {
            "id": "trim",
            "content": long_text,
            "metadata": {},
            "buttons": None,
            "media": None,
        }
        blocks = map_answer_to_blocks(row, max_block_text_size=50)
        assert len(blocks) == 1
        result = blocks[0]["content"]
        assert result.endswith("…[обрезано]")
        assert len(result.encode("utf-8")) <= 50

    def test_long_thinking_trimmed(self):
        """Длинный thinking обрезается."""
        long_thinking = "Б" * 500
        row = {
            "id": "trim2",
            "content": None,
            "metadata": {"thinking": long_thinking},
            "buttons": None,
            "media": None,
        }
        blocks = map_answer_to_blocks(row, max_block_text_size=30)
        assert blocks[0]["type"] == "reasoning"
        assert blocks[0]["content"].endswith("…[обрезано]")
        assert len(blocks[0]["content"].encode("utf-8")) <= 30


# ── parse_media_items (H3: устойчивый парсинг media) ──────────────────────────


class TestParseMediaItemsRobustness:

    def test_mime_none_does_not_crash(self):
        items = parse_media_items([{"file_id": "data:image/png;base64,QQ==", "mime_type": None, "filename": "a.png", "file_size": 1}])
        assert items[0]["mime_type"].startswith("image/")  # взят из data-URL

    def test_file_size_none_and_str(self):
        items = parse_media_items([
            {"file_id": "data:text/plain;base64,QQ==", "file_size": None},
            {"file_id": "data:text/plain;base64,QQ==", "file_size": "неизвестно"},
        ])
        assert [i["file_size"] for i in items] == [0, 0] or all(isinstance(i["file_size"], int) for i in items)

    def test_one_broken_item_does_not_drop_others(self):
        items = parse_media_items([object(), {"file_id": "data:text/plain;base64,QQ==", "filename": "ok.txt"}])
        assert len(items) == 1 and items[0]["filename"] == "ok.txt"

    def test_string_data_url_item_accepted(self):
        items = parse_media_items(["data:image/png;base64,QQ=="])
        assert items[0]["kind"] == "data" and items[0]["mime_type"] == "image/png"

    def test_string_non_data_item_skipped_with_warning(self, caplog):
        assert parse_media_items(["/home/agent/report.xlsx"]) == []
        assert "media" in caplog.text.lower() or caplog.records

    def test_http_and_local_path_and_uuid_classified(self):
        kinds = [parse_media_items([{"file_id": v}])[0]["kind"] for v in (
            "https://example.org/f.xlsx", str(uuid.uuid4()), "C:/tmp/f.xlsx")]
        assert kinds == ["http", "uuid", "other"]


class TestMapAnswerToBlocksMediaKind:

    def test_other_kind_file_block_has_no_file_id(self):
        """kind='other' (не uuid/data/http) → карточка без file_id (M2)."""
        row = {
            "id": "a7",
            "content": None,
            "metadata": {},
            "buttons": None,
            "media": [{"file_id": "C:/tmp/report.xlsx", "filename": "report.xlsx", "mime_type": "application/octet-stream"}],
        }
        blocks = map_answer_to_blocks(row)
        assert len(blocks) == 1
        assert blocks[0]["type"] == "file"
        assert "file_id" not in blocks[0]

    def test_http_kind_file_block_has_file_id(self):
        """kind='http' → file-блок с file_id=URL."""
        row = {
            "id": "a8",
            "content": None,
            "metadata": {},
            "buttons": None,
            "media": [{"file_id": "https://example.org/report.xlsx", "filename": "report.xlsx", "mime_type": "application/octet-stream"}],
        }
        blocks = map_answer_to_blocks(row)
        assert len(blocks) == 1
        assert blocks[0]["type"] == "file"
        assert blocks[0]["file_id"] == "https://example.org/report.xlsx"


# ── build_timeout_error_block ─────────────────────────────────────────────────


class TestBuildTimeoutErrorBlock:

    def test_default_reason_answer(self):
        """Без аргумента (reason='answer') — код agent_timeout (старое поведение)."""
        block = build_timeout_error_block()
        assert block["type"] == "error"
        assert block["code"] == "agent_timeout"
        assert isinstance(block["message"], str)

    def test_reason_claim(self):
        """reason='claim' — код agent_claim_timeout."""
        block = build_timeout_error_block(reason="claim")
        assert block["type"] == "error"
        assert block["code"] == "agent_claim_timeout"
        assert isinstance(block["message"], str)


# ── build_bus_media_from_file_blocks ──────────────────────────────────────────


class TestBuildBusMediaFromFileBlocks:
    """Спека шины: ``{file_id, filename, mime_type, file_size}``, без ``type``.

    file_id — inline data-URL (``data:<mime>;base64,<payload>``), как пишет
    Nanobot — не UUID (UUID ищется в chat_files агентом-читателем, data-URL
    декодируется напрямую). Хелпер приводит формат ``chat_messages.content``
    блоков к спеке ``bus.media``.
    """

    async def test_none_returns_none(self):
        """На None — None (insert_question сериализует как '{}')."""
        fake_repo = AsyncMock()
        result = await build_bus_media_from_file_blocks(
            None,
            conversation_id="c1",
            file_repo=fake_repo,
            max_size=512 * 1024 * 1024,
        )
        assert result is None
        fake_repo.get_file_content.assert_not_called()

    async def test_empty_list_returns_none(self):
        """На пустой список — None."""
        fake_repo = AsyncMock()
        result = await build_bus_media_from_file_blocks(
            [],
            conversation_id="c1",
            file_repo=fake_repo,
            max_size=512 * 1024 * 1024,
        )
        assert result is None
        fake_repo.get_file_content.assert_not_called()

    async def test_single_file_block_to_data_url(self):
        """file_block с UUID → item с data-URL (Nanobot-формат), без 'type'."""
        file_data = b"\x00# \xd0\x9f\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82"
        file_repo = AsyncMock()
        file_repo.get_file_content = AsyncMock(return_value={
            "filename": "hello.md",
            "mime_type": "text/markdown",
            "file_data": file_data,
        })

        result = await build_bus_media_from_file_blocks(
            [{"file_id": "uuid-1", "filename": "hello.md",
              "mime_type": "text/markdown", "file_size": len(file_data)}],
            conversation_id="conv-1",
            file_repo=file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert result is not None
        assert len(result) == 1
        item = result[0]
        # Структура Nanobot: НЕТ поля type, есть file_id/filename/mime_type/file_size.
        assert "type" not in item
        assert set(item.keys()) == {"file_id", "filename", "mime_type", "file_size"}
        assert item["filename"] == "hello.md"
        assert item["mime_type"] == "text/markdown"
        assert item["file_size"] == len(file_data)
        assert item["file_id"].startswith("data:text/markdown;base64,")
        b64_payload = item["file_id"].split(",", 1)[1]
        assert base64.b64decode(b64_payload) == file_data

    async def test_skip_block_without_file_id(self):
        """file_block без file_id пропускается (best-effort: один битый не роняет)."""
        file_repo = AsyncMock()
        file_repo.get_file_content = AsyncMock(return_value={
            "filename": "x.md",
            "mime_type": "text/markdown",
            "file_data": b"x",
        })

        result = await build_bus_media_from_file_blocks(
            [{"filename": "y", "mime_type": "text/plain", "file_size": 1}],
            conversation_id="conv-1",
            file_repo=file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert result is None
        file_repo.get_file_content.assert_not_called()

    async def test_skip_block_when_file_not_found_in_chat_files(self):
        """Не найден в chat_files → пропуск с warning. Если все пропущены → None."""
        file_repo = AsyncMock()
        file_repo.get_file_content = AsyncMock(return_value=None)

        result = await build_bus_media_from_file_blocks(
            [{"file_id": "uuid-missing", "filename": "x", "mime_type": "t", "file_size": 1}],
            conversation_id="conv-1",
            file_repo=file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert result is None

    async def test_preserves_only_first_match_when_one_missing_other_ok(self):
        """Частично битый список: один UUID пропал, второй есть — выдаём только валидный."""
        file_repo = AsyncMock()

        async def _side_effect(*, file_id, conversation_id):
            if file_id == "uuid-good":
                return {
                    "filename": "ok.md",
                    "mime_type": "text/markdown",
                    "file_data": b"ok",
                }
            return None
        file_repo.get_file_content = AsyncMock(side_effect=_side_effect)

        result = await build_bus_media_from_file_blocks(
            [
                {"file_id": "uuid-good", "filename": "ok.md",
                 "mime_type": "text/markdown", "file_size": 2},
                {"file_id": "uuid-missing", "filename": "bad.md",
                 "mime_type": "text/markdown", "file_size": 3},
            ],
            conversation_id="conv-1",
            file_repo=file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert result is not None
        assert len(result) == 1
        assert result[0]["filename"] == "ok.md"

    async def test_skip_non_dict_entries(self):
        """Защита от мусорных элементов в списке (None/строки/числа) — пропускаются."""
        file_repo = AsyncMock()
        file_repo.get_file_content = AsyncMock(return_value={
            "filename": "ok.txt",
            "mime_type": "text/plain",
            "file_data": b"hi",
        })

        result = await build_bus_media_from_file_blocks(
            [
                None,
                "string-not-dict",
                42,
                {"file_id": "uuid-good", "filename": "ok.txt",
                 "mime_type": "text/plain", "file_size": 2},
            ],
            conversation_id="conv-1",
            file_repo=file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert result is not None
        assert len(result) == 1
        assert result[0]["filename"] == "ok.txt"


    async def test_skip_file_larger_than_max_size(self):
        """Файл сверх лимита вложения шины не отправляется агенту (skip + warning)."""
        file_repo = AsyncMock()
        file_repo.get_file_content = AsyncMock(return_value={
            "filename": "big.bin",
            "mime_type": "application/octet-stream",
            "file_data": b"x" * 200,
        })

        result = await build_bus_media_from_file_blocks(
            [{"file_id": "uuid-big", "filename": "big.bin",
              "mime_type": "application/octet-stream", "file_size": 200}],
            conversation_id="conv-1",
            file_repo=file_repo,
            max_size=100,
        )

        assert result is None


# ── materialize_media_entries ─────────────────────────────────────────────────


@pytest.fixture
def mock_file_repo():
    """FileRepository-мок: create отдаёт метаданные, как настоящий репозиторий."""
    repo = AsyncMock()
    repo.create = AsyncMock(return_value={"id": "saved"})
    return repo


def _data_url(mime: str, raw: bytes) -> str:
    """data-URL из сырых байт — формат inline-вложения шины."""
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


class TestMaterializeMediaEntries:
    """H2 вариант A: входящий data-URL сохраняется в chat_files, в блок уходит UUID."""

    async def test_data_url_saved_to_chat_files_and_block_has_uuid(self, mock_file_repo):
        """Транспорт (base64) отделён от хранения (BYTEA): блок ссылается на UUID."""
        entries = parse_media_items([
            {"file_id": "data:text/plain;base64,0J/RgNC40LLQtdGC", "filename": "привет.txt"}
        ])
        blocks = await materialize_media_entries(
            entries,
            answer_uid="a1",
            conversation_id="c1",
            message_id="m1",
            file_repo=mock_file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert blocks[0]["type"] == "file"
        uuid.UUID(blocks[0]["file_id"])  # UUID, не data-URL
        saved = mock_file_repo.create.call_args.kwargs
        assert saved["id"] == blocks[0]["file_id"]
        assert saved["conversation_id"] == "c1"
        assert saved["message_id"] == "m1"
        assert saved["filename"] == "привет.txt"
        assert saved["mime_type"] == "text/plain"
        assert saved["file_data"] == "Привет".encode("utf-8")
        assert saved["file_size"] == len("Привет".encode("utf-8"))

    async def test_deterministic_id_idempotent_on_retry(self, mock_file_repo):
        """Повторная финализация (ретрай тика) не плодит дубликаты: id = uuid5(answer_uid:idx)."""
        mock_file_repo.create.side_effect = asyncpg.exceptions.UniqueViolationError("dup")
        entries = parse_media_items([
            {"file_id": "data:text/plain;base64,0J/RgNC40LLQtdGC", "filename": "привет.txt"}
        ])

        blocks = await materialize_media_entries(
            entries,
            answer_uid="a1",
            conversation_id="c1",
            message_id="m1",
            file_repo=mock_file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert blocks[0]["file_id"] == str(
            uuid.uuid5(uuid.NAMESPACE_URL, "agent-media:a1:0")
        )

    async def test_oversized_becomes_error_block_and_rest_survives(self, mock_file_repo):
        """Файл сверх лимита → error-блок про него, остальные вложения целы."""
        entries = parse_media_items([
            {"file_id": _data_url("application/pdf", b"x" * 300), "filename": "big.pdf"},
            {"file_id": "data:text/plain;base64,0J/RgNC40LLQtdGC", "filename": "ok.txt"},
        ])

        blocks = await materialize_media_entries(
            entries,
            answer_uid="a1",
            conversation_id="c1",
            message_id="m1",
            file_repo=mock_file_repo,
            max_size=100,
        )

        assert blocks[0]["type"] == "error"
        assert blocks[0]["code"] == "agent_file_too_large"
        assert "big.pdf" in blocks[0]["message"]
        assert blocks[1]["type"] == "file"
        assert mock_file_repo.create.await_count == 1

    async def test_broken_base64_becomes_error_block(self, mock_file_repo):
        """Битый payload → error-блок agent_file_invalid, в chat_files ничего не пишем."""
        entries = parse_media_items([
            {"file_id": "data:text/plain;base64,!!!", "filename": "broken.txt"}
        ])

        blocks = await materialize_media_entries(
            entries,
            answer_uid="a1",
            conversation_id="c1",
            message_id="m1",
            file_repo=mock_file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert blocks[0]["type"] == "error"
        assert blocks[0]["code"] == "agent_file_invalid"
        assert "broken.txt" in blocks[0]["message"]
        mock_file_repo.create.assert_not_awaited()

    async def test_empty_payload_becomes_error_block(self, mock_file_repo):
        """Пустое вложение → error-блок: chat_files.file_size под CHECK (> 0)."""
        entries = parse_media_items([
            {"file_id": "data:text/plain;base64,", "filename": "empty.txt"}
        ])

        blocks = await materialize_media_entries(
            entries,
            answer_uid="a1",
            conversation_id="c1",
            message_id="m1",
            file_repo=mock_file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert blocks[0]["type"] == "error"
        assert blocks[0]["code"] == "agent_file_invalid"
        assert "пуст" in blocks[0]["message"]
        mock_file_repo.create.assert_not_awaited()

    async def test_image_mime_gives_image_block_with_uuid(self, mock_file_repo):
        """image/* → блок image с UUID из chat_files (а не с data-URL)."""
        entries = parse_media_items([
            {"file_id": _data_url("image/png", b"\x89PNG\r\n\x1a\n"), "filename": "pic.png"}
        ])

        blocks = await materialize_media_entries(
            entries,
            answer_uid="a1",
            conversation_id="c1",
            message_id="m1",
            file_repo=mock_file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert blocks[0]["type"] == "image"
        uuid.UUID(blocks[0]["file_id"])
        assert blocks[0]["alt"] == "pic.png"

    async def test_uuid_and_http_entries_pass_through(self, mock_file_repo):
        """kind='uuid' и 'http' в chat_files не пишутся — блок как в _entry_to_block."""
        known_uuid = str(uuid.uuid4())
        entries = parse_media_items([
            {"file_id": known_uuid, "filename": "att.png", "mime_type": "image/png"},
            {"file_id": "https://example.com/doc.pdf", "filename": "doc.pdf",
             "mime_type": "application/pdf", "file_size": 10},
        ])

        blocks = await materialize_media_entries(
            entries,
            answer_uid="a1",
            conversation_id="c1",
            message_id="m1",
            file_repo=mock_file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert blocks[0] == {"type": "image", "file_id": known_uuid, "alt": "att.png"}
        assert blocks[1]["type"] == "file"
        assert blocks[1]["file_id"] == "https://example.com/doc.pdf"
        mock_file_repo.create.assert_not_awaited()

    async def test_other_and_empty_kinds_give_card_without_file_id(self, mock_file_repo):
        """kind='other'/'empty' → карточка без file_id (битый путь агента не станет 404-ссылкой)."""
        entries = parse_media_items([
            {"file_id": "/tmp/agent/out.txt", "filename": "out.txt", "mime_type": "text/plain"},
            {"file_id": "", "filename": "nofile.txt", "mime_type": "text/plain"},
        ])

        blocks = await materialize_media_entries(
            entries,
            answer_uid="a1",
            conversation_id="c1",
            message_id="m1",
            file_repo=mock_file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert all(b["type"] == "file" and "file_id" not in b for b in blocks)
        mock_file_repo.create.assert_not_awaited()

    async def test_any_mime_accepted(self, mock_file_repo):
        """Whitelist аплоада НЕ применяется ко входящим: application/zip сохраняется."""
        entries = parse_media_items([
            {"file_id": _data_url("application/zip", b"PK\x03\x04"), "filename": "arc.zip"}
        ])

        blocks = await materialize_media_entries(
            entries,
            answer_uid="a1",
            conversation_id="c1",
            message_id="m1",
            file_repo=mock_file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert blocks[0]["type"] == "file"
        assert mock_file_repo.create.call_args.kwargs["mime_type"] == "application/zip"

    async def test_filename_sanitized(self, mock_file_repo):
        """Разделители пути и null-byte вычищаются; пустое имя → file_<idx> по MIME."""
        entries = parse_media_items([
            {"file_id": _data_url("text/plain", b"a"), "filename": "..\\..\\evil\x00.txt"},
            {"file_id": _data_url("text/plain", b"b"), "filename": ""},
        ])

        blocks = await materialize_media_entries(
            entries,
            answer_uid="a1",
            conversation_id="c1",
            message_id="m1",
            file_repo=mock_file_repo,
            max_size=512 * 1024 * 1024,
        )

        first = mock_file_repo.create.await_args_list[0].kwargs["filename"]
        assert "\\" not in first and "/" not in first and "\x00" not in first
        second = mock_file_repo.create.await_args_list[1].kwargs["filename"]
        assert second.startswith("file_1")
        assert blocks[1]["filename"] == second

    async def test_empty_entries_give_no_blocks(self, mock_file_repo):
        """Пустой вход — пустой список блоков, БД не трогаем."""
        blocks = await materialize_media_entries(
            [],
            answer_uid="a1",
            conversation_id="c1",
            message_id="m1",
            file_repo=mock_file_repo,
            max_size=512 * 1024 * 1024,
        )

        assert blocks == []
        mock_file_repo.create.assert_not_awaited()


# ── Дефолты лимитов вложений ──────────────────────────────────────────────────


class TestFileSizeDefaults:
    """Потолок вложений согласован с шиной агента: 512 МБ."""

    def test_upload_and_bus_limits_are_512mb(self):
        s = ChatDomainSettings()
        assert s.max_file_size == 536870912
        assert s.max_total_file_size == 536870912
        assert s.agent_channel.max_media_file_size == 536870912


# ── AgentChannelService.submit ────────────────────────────────────────────────


class TestAgentChannelServiceSubmit:

    async def test_submit_calls_insert_question_and_create_streaming(
        self, mock_conn, settings
    ):
        """submit вызывает insert_question с pending-семантикой и create_streaming с agent_ref."""
        fake_agent_repo = AsyncMock()
        fake_agent_repo.insert_question = AsyncMock(return_value={"id": "q-1"})
        fake_agent_repo.count_active_for_user = AsyncMock(return_value=0)

        fake_msg_repo = AsyncMock()
        fake_msg_repo.create_streaming = AsyncMock(return_value={"id": "msg-1", "status": "streaming"})

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        question_uid = await svc.submit(
            conversation_id="conv-1",
            user_id="user1",
            assistant_message_id="msg-1",
            text="Вопрос агенту",
            mode="qa",
            kb="oarb",
        )

        # insert_question вызван с корректными параметрами
        fake_agent_repo.insert_question.assert_called_once()
        call_kwargs = fake_agent_repo.insert_question.call_args.kwargs
        assert call_kwargs["content"] == "Вопрос агенту"
        assert call_kwargs["user_id"] == "user1"
        assert call_kwargs["chat_id"] == "conv-1"
        assert call_kwargs["metadata"]["mode"] == "qa"
        assert call_kwargs["metadata"]["kb"] == "oarb"

        # question_uid — это id строки-вопроса в шине
        assert call_kwargs["id"] == question_uid

        # create_streaming вызван с agent_ref = question_uid
        fake_msg_repo.create_streaming.assert_called_once()
        streaming_kwargs = fake_msg_repo.create_streaming.call_args.kwargs
        assert streaming_kwargs["message_id"] == "msg-1"
        assert streaming_kwargs["conversation_id"] == "conv-1"
        assert streaming_kwargs["agent_ref"] == question_uid

        # R2: оба INSERT'а обёрнуты в одну транзакцию (атомарность — иначе
        # осиротевшая bus-строка вечно съедала бы слот лимита).
        mock_conn.transaction.assert_called_once()

    async def test_submit_returns_question_uid(self, mock_conn, settings):
        """submit возвращает question_uid (строку UUID)."""
        fake_agent_repo = AsyncMock()
        fake_agent_repo.insert_question = AsyncMock(return_value={"id": "q-1"})
        fake_agent_repo.count_active_for_user = AsyncMock(return_value=0)
        fake_msg_repo = AsyncMock()
        fake_msg_repo.create_streaming = AsyncMock(return_value={"id": "m-1"})

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        result = await svc.submit(
            conversation_id="c",
            user_id="u",
            assistant_message_id="m",
            text="q",
            mode="qa",
        )
        # Результат — строка в формате UUID
        import uuid
        uuid.UUID(result)  # выброс ValueError если неверный формат

    async def test_submit_check_violation_raises_friendly_domain_error(
        self, mock_conn, settings
    ):
        """CHECK владельца шины отклонил INSERT вопроса → доменная ошибка.

        Имя констрейнта владельца на ПРОМе чужое (нет в
        CHECK_CONSTRAINT_MESSAGES) — без конвертации пользователь увидел бы
        технический fallback вместо понятного сообщения."""
        import asyncpg

        from app.domains.chat.exceptions import AgentChannelUnavailableError

        fake_agent_repo = AsyncMock()
        fake_agent_repo.count_active_for_user = AsyncMock(return_value=0)
        fake_agent_repo.insert_question = AsyncMock(
            side_effect=asyncpg.exceptions.CheckViolationError(
                'violates check constraint "42_alexe_conversation_messages_status_check"'
            )
        )
        fake_msg_repo = AsyncMock()

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        with pytest.raises(AgentChannelUnavailableError) as exc_info:
            await svc.submit(
                conversation_id="c",
                user_id="u",
                assistant_message_id="m",
                text="q",
                mode="qa",
            )
        assert exc_info.value.status_code == 502


# ── AgentChannelService.poll_once ────────────────────────────────────────────


def _make_poll_svc(mock_conn, settings, *, question, answer,
                   count_pending_before=0, upsert_block_return=True):
    """Вспомогательный хелпер: собирает сервис с инжектированными репо."""
    fake_agent_repo = AsyncMock()
    fake_agent_repo.get_by_uid = AsyncMock(return_value=question)
    fake_agent_repo.get_answer_for_question = AsyncMock(return_value=answer)
    fake_agent_repo.get_media_by_uid = AsyncMock(
        return_value=(answer or {}).get("media")
    )
    fake_agent_repo.count_pending_before = AsyncMock(return_value=count_pending_before)

    fake_msg_repo = AsyncMock()
    fake_msg_repo.finalize = AsyncMock(return_value=True)
    fake_msg_repo.mark_failed = AsyncMock(return_value=True)
    fake_msg_repo.upsert_block = AsyncMock(return_value=upsert_block_return)

    svc = AgentChannelService(mock_conn, settings)
    svc._agent_repo = lambda: fake_agent_repo
    svc._message_repo = lambda: fake_msg_repo
    return svc, fake_agent_repo, fake_msg_repo


class TestPollOnce:

    async def test_question_not_found_returns_pending_with_none_status(
        self, mock_conn, settings
    ):
        """Вопроса нет → outcome 'pending', question_status None; ничего не записано."""
        fake_agent_repo = AsyncMock()
        fake_agent_repo.get_by_uid = AsyncMock(return_value=None)

        fake_msg_repo = AsyncMock()

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        res = await svc.poll_once(assistant_message_id="msg-1", question_uid="q-uid")

        assert res["outcome"] == "pending"
        assert res["question_status"] is None
        assert res["answer_exists"] is False
        fake_msg_repo.upsert_block.assert_not_called()
        fake_msg_repo.finalize.assert_not_called()
        fake_msg_repo.mark_failed.assert_not_called()

    async def test_pending_question_no_answer_want_queue_true(
        self, mock_conn, settings
    ):
        """Вопрос pending, ответа нет, want_queue_position=True → queue_ahead из count_pending_before."""
        import datetime
        created = datetime.datetime(2024, 1, 1, 12, 0, 0)
        question = {"id": "q-uid", "status": "pending", "created_at": created}

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings,
            question=question,
            answer=None,
            count_pending_before=3,
        )

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
            want_queue_position=True,
        )

        assert res["outcome"] == "pending"
        assert res["queue_ahead"] == 3
        fake_agent_repo.count_pending_before.assert_awaited_once_with(created)

    async def test_pending_question_no_answer_want_queue_false(
        self, mock_conn, settings
    ):
        """want_queue_position=False → queue_ahead None и count_pending_before НЕ вызван."""
        question = {"id": "q-uid", "status": "pending", "created_at": None}

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings,
            question=question,
            answer=None,
        )

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
            want_queue_position=False,
        )

        assert res["outcome"] == "pending"
        assert res["queue_ahead"] is None
        fake_agent_repo.count_pending_before.assert_not_called()

    async def test_processing_question_no_answer_queue_ahead_none(
        self, mock_conn, settings
    ):
        """Вопрос со status='processing', ответа нет, want_queue_position=True →
        queue_ahead is None и count_pending_before НЕ вызван
        (queue_ahead имеет смысл только в pending)."""
        question = {"id": "q-uid", "status": "processing", "created_at": None}

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings,
            question=question,
            answer=None,
        )

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
            want_queue_position=True,
        )

        assert res["outcome"] == "pending"
        assert res["queue_ahead"] is None
        fake_agent_repo.count_pending_before.assert_not_called()

    async def test_answer_processing_reasoning_grows_upserts_block(
        self, mock_conn, settings
    ):
        """Ответ status='processing', reasoning длиннее last_reasoning_len →
        upsert_block вызван с block_id от id ОТВЕТА; outcome 'pending'; reasoning_len корректен."""
        import datetime
        upd = datetime.datetime(2024, 1, 1, 12, 5, 0)
        question = {"id": "q-uid", "status": "processing"}
        answer = {
            "id": "a-uid",
            "status": "processing",
            "metadata": {"reasoning": "Думаю..."},
            "content": None,
            "buttons": None,
            "media": None,
            "updated_at": upd,
        }

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=answer
        )

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
            last_reasoning_len=0,
        )

        assert res["outcome"] == "pending"
        assert res["answer_exists"] is True
        assert res["reasoning_len"] == len("Думаю...")
        assert res["answer_updated_at"] == upd
        fake_msg_repo.upsert_block.assert_called_once()
        block_kwargs = fake_msg_repo.upsert_block.call_args.kwargs
        assert block_kwargs["message_id"] == "msg-1"
        assert block_kwargs["block"]["type"] == "reasoning"
        assert block_kwargs["block"]["block_id"] == "a-uid:reasoning:0"
        assert "Думаю..." in block_kwargs["block"]["content"]

    async def test_answer_processing_reasoning_not_grown_no_upsert(
        self, mock_conn, settings
    ):
        """reasoning НЕ вырос (len == last_reasoning_len) → upsert_block НЕ вызван."""
        question = {"id": "q-uid", "status": "processing"}
        text = "Думаю..."
        answer = {
            "id": "a-uid",
            "status": "processing",
            "metadata": {"reasoning": text},
            "content": None,
            "buttons": None,
            "media": None,
            "updated_at": None,
        }

        svc, _, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=answer
        )

        await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
            last_reasoning_len=len(text),  # равно текущей длине — не растёт
        )

        fake_msg_repo.upsert_block.assert_not_called()

    async def test_answer_processing_legacy_thinking_key(
        self, mock_conn, settings
    ):
        """metadata.thinking (legacy) тоже читается как reasoning."""
        question = {"id": "q-uid", "status": "processing"}
        answer = {
            "id": "a-uid",
            "status": "processing",
            "metadata": {"thinking": "legacy рассуждение"},
            "content": None,
            "buttons": None,
            "media": None,
            "updated_at": None,
        }

        svc, _, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=answer
        )

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
            last_reasoning_len=0,
        )

        assert res["reasoning_len"] == len("legacy рассуждение")
        fake_msg_repo.upsert_block.assert_called_once()
        block = fake_msg_repo.upsert_block.call_args.kwargs["block"]
        assert "legacy рассуждение" in block["content"]

    async def test_answer_completed_finalizes_and_returns_done(
        self, mock_conn, settings
    ):
        """Ответ терминальный успех → finalize + set_status('completed'), outcome 'done'."""
        question = {"id": "q-uid", "status": "completed", "reply_to": None}
        answer = {
            "id": "a-uid",
            "role": "assistant",
            "content": "Ответ от агента",
            "metadata": {},
            "buttons": None,
            "media": None,
            "reply_to": "q-uid",
            "status": "completed",
        }

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=answer
        )

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.finalize.assert_called_once()
        blocks = fake_msg_repo.finalize.call_args.kwargs["final_blocks"]
        text_blocks = [b for b in blocks if b["type"] == "text"]
        assert text_blocks[0]["content"] == "Ответ от агента"
        fake_agent_repo.set_status.assert_awaited_once_with(
            uid="q-uid", status="completed",
        )

    async def test_answer_completed_wires_media_from_get_media_by_uid(
        self, mock_conn, settings
    ):
        """C1: media в финальных блоках приходит из get_media_by_uid(answer id), не из
        get_answer_for_question (узкая проекция её больше не отдаёт). Готовый UUID
        агента проходит насквозь — материализовать нечего."""
        question = {"id": "q-uid", "status": "completed", "reply_to": None}
        answer = {
            "id": "a-uid",
            "role": "assistant",
            "content": "Ответ от агента",
            "metadata": {},
            "buttons": None,
            "media": None,
            "reply_to": "q-uid",
            "status": "completed",
        }

        file_id = str(uuid.uuid4())
        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=answer
        )
        fake_agent_repo.get_media_by_uid = AsyncMock(
            return_value=[
                {"file_id": file_id, "filename": "att.png", "mime_type": "image/png"}
            ]
        )

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_agent_repo.get_media_by_uid.assert_awaited_once_with("a-uid")
        blocks = fake_msg_repo.finalize.call_args.kwargs["final_blocks"]
        media_blocks = [b for b in blocks if b["type"] == "image"]
        assert len(media_blocks) == 1
        assert media_blocks[0]["file_id"] == file_id

    async def test_answer_completed_materializes_data_url_media(
        self, mock_conn, settings
    ):
        """data-URL из шины материализуется в chat_files, в финальный блок уходит UUID."""
        question = {"id": "q-uid", "chat_id": "conv-7", "status": "completed", "reply_to": None}
        answer = {
            "id": "a-uid",
            "role": "assistant",
            "content": "Ответ с файлом",
            "metadata": {},
            "buttons": None,
            "media": None,
            "reply_to": "q-uid",
            "status": "completed",
        }

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=answer
        )
        fake_agent_repo.get_media_by_uid = AsyncMock(
            return_value=[{
                "file_id": "data:text/plain;base64,0J/RgNC40LLQtdGC",
                "filename": "привет.txt",
            }]
        )
        fake_file_repo = AsyncMock()
        fake_file_repo.create = AsyncMock(return_value={"id": "saved"})

        with patch(
            "app.domains.chat.services.agent_channel.FileRepository",
            return_value=fake_file_repo,
        ):
            res = await svc.poll_once(
                assistant_message_id="msg-1",
                question_uid="q-uid",
            )

        assert res["outcome"] == "done"
        saved = fake_file_repo.create.call_args.kwargs
        assert saved["conversation_id"] == "conv-7"
        assert saved["message_id"] == "msg-1"
        assert saved["file_data"] == "Привет".encode("utf-8")
        blocks = fake_msg_repo.finalize.call_args.kwargs["final_blocks"]
        file_blocks = [b for b in blocks if b["type"] == "file"]
        assert len(file_blocks) == 1
        assert file_blocks[0]["file_id"] == saved["id"]
        uuid.UUID(file_blocks[0]["file_id"])

    async def test_answer_failed_marks_failed_and_returns_done(
        self, mock_conn, settings
    ):
        """Ответ status='failed' → mark_failed + set_status('failed'), outcome 'done'."""
        question = {"id": "q-uid", "status": "completed", "reply_to": None}
        answer = {
            "id": "a-uid",
            "role": "assistant",
            "content": "Ошибка в агенте",
            "metadata": {},
            "buttons": None,
            "media": None,
            "reply_to": "q-uid",
            "status": "failed",
        }

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=answer
        )

        res = await svc.poll_once(
            assistant_message_id="msg-2",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.mark_failed.assert_called_once()
        call_kwargs = fake_msg_repo.mark_failed.call_args.kwargs
        assert call_kwargs["message_id"] == "msg-2"
        assert call_kwargs["error_block"]["code"] == "agent_error"
        fake_msg_repo.finalize.assert_not_called()
        fake_agent_repo.set_status.assert_awaited_once_with(
            uid="q-uid", status="failed",
        )

    async def test_question_failed_no_answer_marks_failed_and_returns_done(
        self, mock_conn, settings
    ):
        """Вопрос status='failed', строки-ответа нет → mark_failed, outcome 'done'."""
        question = {"id": "q-uid", "role": "user", "status": "failed"}

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=None
        )

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.mark_failed.assert_called_once()
        error_block = fake_msg_repo.mark_failed.call_args.kwargs["error_block"]
        assert error_block["code"] == "agent_error"
        fake_msg_repo.finalize.assert_not_called()

    async def test_question_error_status_keeps_waiting(self, mock_conn, settings):
        """NanoBot 2.3: 'error' на вопросе = повторяемая ошибка, подписку не снимаем.

        Агент вернёт задачу в пул после error_retry_delay и повторит её
        (пока retry_count < max_stuck_retries), поэтому AW обязан продолжать
        ждать: mark_failed не вызывается, вопрос в шине не закрывается.
        """
        question = {
            "id": "q-uid",
            "status": "error",
            "metadata": {"retry_count": 1, "error": "dispatch_error"},
            "created_at": None,
        }

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=None
        )

        res = await svc.poll_once(assistant_message_id="msg-1", question_uid="q-uid")

        assert res["outcome"] == "pending"
        assert res["question_status"] == "error"
        assert res["answer_exists"] is False
        fake_msg_repo.mark_failed.assert_not_awaited()
        fake_msg_repo.finalize.assert_not_called()
        fake_agent_repo.set_status.assert_not_awaited()

    async def test_question_failed_status_terminates(self, mock_conn, settings):
        """'failed' — терминальный: mark_failed + outcome='done' (в контраст с 'error')."""
        question = {"id": "q-uid", "status": "failed", "created_at": None}

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=None
        )

        res = await svc.poll_once(assistant_message_id="msg-1", question_uid="q-uid")

        assert res["outcome"] == "done"
        assert res["question_status"] == "failed"
        fake_msg_repo.mark_failed.assert_awaited_once()
        assert (
            fake_msg_repo.mark_failed.call_args.kwargs["error_block"]["code"]
            == "agent_error"
        )

    async def test_answer_error_status_keeps_waiting(self, mock_conn, settings):
        """Строка-ответ со status='error' — нетерминальная (агент повторит).

        NanoBot при повторяемой ошибке удаляет свою строку-ответ, но если она
        всё же наблюдается со статусом 'error' — финализировать нельзя.
        """
        question = {"id": "q-uid", "status": "error", "metadata": {}}
        answer = {
            "id": "a-uid",
            "role": "assistant",
            "content": "",
            "metadata": {},
            "buttons": None,
            "media": None,
            "reply_to": "q-uid",
            "status": "error",
            "updated_at": None,
        }

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=answer
        )

        res = await svc.poll_once(assistant_message_id="msg-1", question_uid="q-uid")

        assert res["outcome"] == "pending"
        assert res["answer_exists"] is True
        fake_msg_repo.mark_failed.assert_not_awaited()
        fake_msg_repo.finalize.assert_not_called()
        fake_agent_repo.set_status.assert_not_awaited()

    async def test_poll_once_calls_translate_buttons_when_answer_has_buttons(
        self, mock_conn, settings
    ):
        """poll_once вызывает translate_buttons для ответа с кнопками."""
        question = {"id": "q-uid", "status": "completed", "reply_to": None}
        answer = {
            "id": "a-uid",
            "role": "assistant",
            "content": "Нашёл",
            "metadata": {},
            "buttons": [{"action_id": "acts.open_act_page", "label": "Открыть", "params": {"km_number": "КМ-23-001"}}],
            "media": None,
            "reply_to": "q-uid",
            "status": "completed",
        }

        svc, _, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=answer
        )

        original_buttons = answer["buttons"].copy()
        translated = [{"action_id": "open_url", "label": "Открыть", "params": {"url": "/constructor?act_id=1"}}]
        with patch(
            "app.domains.chat.services.agent_channel.translate_buttons",
            new=AsyncMock(return_value=translated),
        ) as mock_translate:
            res = await svc.poll_once(
                assistant_message_id="msg-3",
                question_uid="q-uid",
            )

        assert res["outcome"] == "done"
        mock_translate.assert_called_once_with(original_buttons)
        call_kwargs = fake_msg_repo.finalize.call_args.kwargs
        btn_blocks = [b for b in call_kwargs["final_blocks"] if b["type"] == "buttons"]
        assert len(btn_blocks) == 1
        assert btn_blocks[0]["buttons"][0]["action_id"] == "open_url"

    async def test_poll_once_skips_translate_buttons_when_no_buttons(
        self, mock_conn, settings
    ):
        """poll_once НЕ вызывает translate_buttons если кнопок нет."""
        question = {"id": "q-uid", "status": "completed", "reply_to": None}
        answer = {
            "id": "a-uid",
            "role": "assistant",
            "content": "Ответ без кнопок",
            "metadata": {},
            "buttons": None,
            "media": None,
            "reply_to": "q-uid",
            "status": "completed",
        }

        svc, _, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=answer
        )

        with patch(
            "app.domains.chat.services.agent_channel.translate_buttons",
            new=AsyncMock(),
        ) as mock_translate:
            await svc.poll_once(
                assistant_message_id="msg-4",
                question_uid="q-uid",
            )

        mock_translate.assert_not_called()

    async def test_answer_legacy_terminal_status_finalizes(
        self, mock_conn, settings
    ):
        """Legacy-терминальный статус ответа ('complete') тоже финализирует:
        терминальным считается любой статус вне явно нетерминальных."""
        question = {"id": "q-uid", "status": "complete", "reply_to": None}
        answer = {
            "id": "a-uid",
            "role": "assistant",
            "content": "Ответ от агента",
            "metadata": {},
            "buttons": None,
            "media": None,
            "reply_to": "q-uid",
            "status": "complete",
        }

        svc, fake_agent_repo, fake_msg_repo = _make_poll_svc(
            mock_conn, settings, question=question, answer=answer
        )

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.finalize.assert_called_once()
        call_kwargs = fake_msg_repo.finalize.call_args.kwargs
        assert call_kwargs["message_id"] == "msg-1"
        blocks = call_kwargs["final_blocks"]
        text_blocks = [b for b in blocks if b["type"] == "text"]
        assert len(text_blocks) == 1
        assert text_blocks[0]["content"] == "Ответ от агента"
        fake_agent_repo.set_status.assert_awaited_once_with(
            uid="q-uid", status="completed",
        )


# ── AgentChannelService.mark_timeout ─────────────────────────────────────────


class TestMarkTimeout:

    async def test_mark_timeout_reason_claim_uses_claim_block(
        self, mock_conn, settings
    ):
        """mark_timeout(reason='claim') → mark_failed получил claim-блок."""
        fake_agent_repo = AsyncMock()
        fake_msg_repo = AsyncMock()
        fake_msg_repo.mark_failed = AsyncMock(return_value=True)

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        await svc.mark_timeout(
            assistant_message_id="msg-1",
            question_uid="q-uid",
            reason="claim",
        )

        fake_msg_repo.mark_failed.assert_called_once()
        error_block = fake_msg_repo.mark_failed.call_args.kwargs["error_block"]
        assert error_block["code"] == "agent_claim_timeout"

    async def test_mark_timeout_completes_even_if_check_constraint_rejects_status(
        self, mock_conn, settings
    ):
        """CHECK владельца отклонил статус → mark_timeout не падает."""
        import asyncpg

        fake_agent_repo = AsyncMock()
        fake_agent_repo.set_status = AsyncMock(
            side_effect=asyncpg.exceptions.CheckViolationError(
                "violates check constraint"
            )
        )
        fake_msg_repo = AsyncMock()
        fake_msg_repo.mark_failed = AsyncMock(return_value=True)

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        await svc.mark_timeout(
            assistant_message_id="msg-1",
            question_uid="q-uid",
        )

        fake_msg_repo.mark_failed.assert_called_once()
        fake_agent_repo.set_status.assert_awaited_once_with(
            uid="q-uid", status="failed",
        )

    async def test_transient_db_error_in_set_status_propagates(
        self, mock_conn, settings
    ):
        """Транзиентная ошибка БД (не CheckViolation) пробрасывается."""
        import asyncpg

        fake_agent_repo = AsyncMock()
        fake_agent_repo.set_status = AsyncMock(
            side_effect=asyncpg.PostgresConnectionError("connection lost")
        )
        fake_msg_repo = AsyncMock()
        fake_msg_repo.mark_failed = AsyncMock(return_value=True)

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        with pytest.raises(asyncpg.PostgresConnectionError):
            await svc.mark_timeout(
                assistant_message_id="msg-1",
                question_uid="q-uid",
            )


# ── Best-effort запись статуса — poll_once ────────────────────────────────────


class TestSetStatusBestEffortPollOnce:

    async def test_poll_once_done_even_if_check_constraint_rejects_status(
        self, mock_conn, settings
    ):
        """CHECK владельца отклонил наш статус → poll_once всё равно outcome='done'.

        Регрессия ПРОМа: CheckViolationError из set_status поднимался в
        поллер, подписка не снималась, ответ не отрисовывался.
        """
        import asyncpg

        question = {"id": "q-uid", "user_id": "u1", "status": "completed", "reply_to": None}
        answer = {
            "id": "a-uid",
            "role": "assistant",
            "content": "Ответ",
            "metadata": {},
            "buttons": None,
            "media": None,
            "reply_to": "q-uid",
            "status": "completed",
        }
        fake_agent_repo = AsyncMock()
        fake_agent_repo.get_by_uid = AsyncMock(return_value=question)
        fake_agent_repo.get_answer_for_question = AsyncMock(return_value=answer)
        fake_agent_repo.set_status = AsyncMock(
            side_effect=asyncpg.exceptions.CheckViolationError(
                "violates check constraint"
            )
        )
        fake_msg_repo = AsyncMock()
        fake_msg_repo.finalize = AsyncMock(return_value=True)

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        res = await svc.poll_once(
            assistant_message_id="msg-1",
            question_uid="q-uid",
        )

        assert res["outcome"] == "done"
        fake_msg_repo.finalize.assert_called_once()


# ── AgentChannelService.get_queue_details ─────────────────────────────────────


class TestGetQueueDetails:

    async def test_pending_with_queue_position(self, mock_conn, settings):
        """Статус pending → queue_ahead из count_pending_before."""
        import datetime
        created = datetime.datetime(2024, 1, 1, 12, 0, 0)
        question = {"id": "q-uid", "status": "pending", "created_at": created}

        fake_agent_repo = AsyncMock()
        fake_agent_repo.get_status_by_uid = AsyncMock(return_value=question)
        fake_agent_repo.count_pending_before = AsyncMock(return_value=2)

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo

        result = await svc.get_queue_details("q-uid")

        assert result == {"bus_status": "pending", "queue_ahead": 2}
        fake_agent_repo.count_pending_before.assert_awaited_once_with(created)

    async def test_processing_queue_ahead_is_none(self, mock_conn, settings):
        """Статус processing → queue_ahead None (позиция в очереди не имеет смысла)."""
        question = {"id": "q-uid", "status": "processing", "created_at": None}

        fake_agent_repo = AsyncMock()
        fake_agent_repo.get_status_by_uid = AsyncMock(return_value=question)
        fake_agent_repo.count_pending_before = AsyncMock(return_value=0)

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo

        result = await svc.get_queue_details("q-uid")

        assert result == {"bus_status": "processing", "queue_ahead": None}
        fake_agent_repo.count_pending_before.assert_not_called()

    async def test_question_not_found_returns_none(self, mock_conn, settings):
        """Строки-вопроса нет → None."""
        fake_agent_repo = AsyncMock()
        fake_agent_repo.get_status_by_uid = AsyncMock(return_value=None)

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo

        result = await svc.get_queue_details("q-uid")

        assert result is None


# ── AgentChannelService.submit — лимит ───────────────────────────────────────


class TestAgentChannelServiceSubmitLimit:

    async def test_submit_raises_chat_limit_error_when_active_at_limit(
        self, mock_conn, settings
    ):
        """submit кидает ChatLimitError если active >= max_parallel_streams_per_user."""
        fake_agent_repo = AsyncMock()
        fake_agent_repo.count_active_for_user = AsyncMock(
            return_value=settings.max_parallel_streams_per_user
        )
        fake_agent_repo.insert_question = AsyncMock()
        fake_msg_repo = AsyncMock()
        fake_msg_repo.create_streaming = AsyncMock()

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        with pytest.raises(ChatLimitError) as exc_info:
            await svc.submit(
                conversation_id="conv-1",
                user_id="user1",
                assistant_message_id="msg-1",
                text="Вопрос",
                mode="always",
            )

        assert "лимит" in str(exc_info.value).lower()
        # insert_question НЕ вызывался
        fake_agent_repo.insert_question.assert_not_called()
        fake_msg_repo.create_streaming.assert_not_called()

    async def test_submit_proceeds_when_active_below_limit(
        self, mock_conn, settings
    ):
        """submit работает как раньше если active < max_parallel_streams_per_user."""
        fake_agent_repo = AsyncMock()
        fake_agent_repo.count_active_for_user = AsyncMock(
            return_value=settings.max_parallel_streams_per_user - 1
        )
        fake_agent_repo.insert_question = AsyncMock(return_value={"id": "q-1"})
        fake_msg_repo = AsyncMock()
        fake_msg_repo.create_streaming = AsyncMock(return_value={"id": "m-1"})

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        result = await svc.submit(
            conversation_id="conv-1",
            user_id="user1",
            assistant_message_id="msg-1",
            text="Вопрос",
            mode="always",
        )

        import uuid
        uuid.UUID(result)  # корректный UUID
        fake_agent_repo.insert_question.assert_called_once()
        fake_msg_repo.create_streaming.assert_called_once()

    async def test_submit_counts_active_with_two_phase_cutoffs(self, mock_conn, settings):
        """Лимит считается с двухфазными отсечками: pending по created_at
        (claim_timeout_sec), processing по updated_at (answer_timeout_sec)."""
        from datetime import datetime, timedelta, timezone

        fake_agent_repo = AsyncMock()
        fake_agent_repo.count_active_for_user = AsyncMock(return_value=0)
        fake_agent_repo.insert_question = AsyncMock(return_value={"id": "q-1"})
        fake_msg_repo = AsyncMock()
        fake_msg_repo.create_streaming = AsyncMock(return_value={"id": "m-1"})

        svc = AgentChannelService(mock_conn, settings)
        svc._agent_repo = lambda: fake_agent_repo
        svc._message_repo = lambda: fake_msg_repo

        before = datetime.now(timezone.utc)
        await svc.submit(
            conversation_id="conv-1",
            user_id="user1",
            assistant_message_id="msg-1",
            text="Вопрос",
            mode="always",
        )
        after = datetime.now(timezone.utc)

        kwargs = fake_agent_repo.count_active_for_user.call_args.kwargs
        claim_timeout = timedelta(seconds=settings.agent_channel.claim_timeout_sec)
        answer_timeout = timedelta(seconds=settings.agent_channel.answer_timeout_sec)
        assert before - claim_timeout <= kwargs["pending_created_after"] <= after - claim_timeout
        assert before - answer_timeout <= kwargs["processing_updated_after"] <= after - answer_timeout
