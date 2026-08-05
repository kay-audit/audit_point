"""
Unit-тесты ExportService (happy-path и выбор форматера).

Покрывает то, что НЕ покрыто в test_export_exceptions.py:
- успешный save_act для всех трёх форматов (txt, md, docx)
- корректный выбор форматера по типу
- передача данных и вызов storage.save / storage.save_docx
- структура ActSaveResponse
"""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.config import Settings
from app.domains.acts.exceptions import UnsupportedFormatError
from app.domains.acts.schemas.act_content import ActSaveResponse
from app.domains.acts.services.export_service import ExportService
from app.domains.acts.settings import ActsSettings


# ── Хелперы ────────────────────────────────────────────────────────────────


def _make_export_service(storage=None):
    """Создаёт ExportService с заглушками форматеров, storage и сервисов БД."""
    mock_settings = MagicMock(spec=Settings)
    mock_settings.storage_dir = Path("/tmp/test_storage_export")
    acts_settings = ActsSettings()

    if storage is None:
        storage = MagicMock()
        storage.save.return_value = "act_20260101_120000_abcd.txt"
        storage.save_docx.return_value = "act_20260101_120000_abcd.docx"

    mock_crud = AsyncMock()
    mock_content_svc = AsyncMock()

    with patch("app.domains.acts.services.export_service.TextFormatter"), \
         patch("app.domains.acts.services.export_service.MarkdownFormatter"), \
         patch("app.domains.acts.services.export_service.DocxFormatter"):
        svc = ExportService(
            storage=storage,
            settings=mock_settings,
            acts_settings=acts_settings,
            act_crud_service=mock_crud,
            act_content_service=mock_content_svc,
        )
    return svc


def _minimal_content_dict() -> dict:
    return {
        "tree": {"id": "root", "label": "Акт", "children": []},
        "tables": {},
        "textBlocks": {},
        "violations": {},
    }


def _make_mock_metadata():
    """Минимальный metadata-объект с model_dump."""
    from datetime import date
    meta = MagicMock()
    meta.km_number = "КМ-01-0000001"
    meta.model_dump.return_value = {"km_number": "КМ-01-0000001"}
    return meta


# ── Кэширование и состав форматеров ────────────────────────────────────────


def test_export_service_caches_three_formatters():
    """ExportService предкэширует именно 3 форматера: txt/md/docx."""
    svc = _make_export_service()
    assert set(svc._formatters.keys()) == {"txt", "md", "docx"}


# ── save_act: успешные сценарии ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_export_to_text_success():
    """save_act(fmt='txt') вызывает TextFormatter.format и storage.save."""
    storage = MagicMock()
    storage.save.return_value = "act_test.txt"
    svc = _make_export_service(storage=storage)
    svc._formatters["txt"] = MagicMock()
    svc._formatters["txt"].format.return_value = "TXT-CONTENT"

    # Настраиваем mock-сервисы
    svc.act_crud_service.get_act = AsyncMock(return_value=_make_mock_metadata())
    svc.act_content_service.get_content = AsyncMock(return_value=_minimal_content_dict())

    with patch(
        "app.domains.acts.services.export_service.get_format_thread_pool",
        return_value=None,
    ):
        result = await svc.save_act(42, "testuser", fmt="txt")

    svc._formatters["txt"].format.assert_called_once()
    storage.save.assert_called_once_with("TXT-CONTENT", prefix="act", extension="txt")
    storage.save_docx.assert_not_called()
    assert isinstance(result, ActSaveResponse)
    assert result.status == "success"
    assert result.filename == "act_test.txt"
    assert "TXT" in result.message


@pytest.mark.asyncio
async def test_export_to_markdown_success():
    """save_act(fmt='md') использует MarkdownFormatter."""
    storage = MagicMock()
    storage.save.return_value = "act_test.md"
    svc = _make_export_service(storage=storage)
    svc._formatters["md"] = MagicMock()
    svc._formatters["md"].format.return_value = "# Markdown"

    svc.act_crud_service.get_act = AsyncMock(return_value=_make_mock_metadata())
    svc.act_content_service.get_content = AsyncMock(return_value=_minimal_content_dict())

    with patch(
        "app.domains.acts.services.export_service.get_format_thread_pool",
        return_value=None,
    ):
        result = await svc.save_act(42, "testuser", fmt="md")

    svc._formatters["md"].format.assert_called_once()
    storage.save.assert_called_once_with("# Markdown", prefix="act", extension="md")
    assert result.filename == "act_test.md"
    assert "MD" in result.message


@pytest.mark.asyncio
async def test_export_to_docx_success():
    """save_act(fmt='docx') вызывает DocxFormatter и storage.save_docx (не save)."""
    storage = MagicMock()
    storage.save_docx.return_value = "act_test.docx"
    svc = _make_export_service(storage=storage)
    svc._formatters["docx"] = MagicMock()
    docx_doc = MagicMock()
    svc._formatters["docx"].format.return_value = docx_doc

    svc.act_crud_service.get_act = AsyncMock(return_value=_make_mock_metadata())
    svc.act_content_service.get_content = AsyncMock(return_value=_minimal_content_dict())

    with patch(
        "app.domains.acts.services.export_service.get_format_thread_pool",
        return_value=None,
    ):
        result = await svc.save_act(42, "testuser", fmt="docx")

    # save_docx вызван (НЕ save)
    storage.save_docx.assert_called_once_with(docx_doc, prefix="act")
    storage.save.assert_not_called()
    assert result.filename == "act_test.docx"
    assert "DOCX" in result.message


# ── Неподдерживаемый формат ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_export_with_invalid_format_raises():
    """save_act с неподдерживаемым форматом бросает UnsupportedFormatError."""
    svc = _make_export_service()
    with pytest.raises(UnsupportedFormatError) as exc_info:
        await svc.save_act(42, "testuser", fmt="pdf")  # type: ignore[arg-type]
    assert exc_info.value.status_code == 400
    assert "pdf" in exc_info.value.message.lower()


@pytest.mark.asyncio
async def test_export_with_empty_format_raises():
    """Пустая строка как формат также → UnsupportedFormatError."""
    svc = _make_export_service()
    with pytest.raises(UnsupportedFormatError):
        await svc.save_act(42, "testuser", fmt="")  # type: ignore[arg-type]


# ── Выбор форматера: txt/md/docx используют разные инстансы ─────────────────


@pytest.mark.asyncio
async def test_export_uses_correct_formatter_per_type():
    """Каждый формат вызывает только свой форматер, остальные не трогаются."""
    storage = MagicMock()
    storage.save.return_value = "x.txt"
    storage.save_docx.return_value = "x.docx"
    svc = _make_export_service(storage=storage)

    txt_mock = MagicMock()
    md_mock = MagicMock()
    docx_mock = MagicMock()
    txt_mock.format.return_value = "txt"
    md_mock.format.return_value = "md"
    docx_mock.format.return_value = MagicMock()
    svc._formatters["txt"] = txt_mock
    svc._formatters["md"] = md_mock
    svc._formatters["docx"] = docx_mock

    svc.act_crud_service.get_act = AsyncMock(return_value=_make_mock_metadata())
    svc.act_content_service.get_content = AsyncMock(return_value=_minimal_content_dict())

    with patch(
        "app.domains.acts.services.export_service.get_format_thread_pool",
        return_value=None,
    ):
        await svc.save_act(42, "testuser", fmt="md")

    md_mock.format.assert_called_once()
    txt_mock.format.assert_not_called()
    docx_mock.format.assert_not_called()
