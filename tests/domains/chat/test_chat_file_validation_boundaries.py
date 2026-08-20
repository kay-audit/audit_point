"""Граничные тесты валидации файлов чата.

Покрывает:
- Точные границы ``max_file_size``: размер == max — проходит,
  размер == max+1 — падает с ``ChatFileValidationError``.
- UTF-8 charset fallback: text/plain с ``charset=invalid`` остаётся валидным
  text/plain, парсер падать не должен.
- Битый PDF (.pdf без сигнатуры ``%PDF-``): извлечение текста возвращает
  понятное сообщение, не 500.
- Битый DOCX/ZIP (.docx без ZIP-сигнатуры): обработчик не падает, отдаёт
  пояснительную строку.
"""

from __future__ import annotations

import io
from unittest.mock import AsyncMock

import pytest

from app.core.chat.tools import reset as reset_tools
from app.core.domain_registry import reset_registry
from app.core.settings_registry import reset as reset_settings
from app.domains.chat.exceptions import ChatFileValidationError
from app.domains.chat.services.file_extraction import extract_text
from app.domains.chat.services.file_service import FileService
from app.domains.chat.settings import ChatDomainSettings


# -------------------------------------------------------------------------
# Сброс глобального состояния доменных реестров между тестами
# -------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clean_registries():
    """Сброс реестров для изоляции глобального состояния."""
    reset_registry()
    reset_settings()
    reset_tools()
    yield
    reset_registry()
    reset_settings()
    reset_tools()


# -------------------------------------------------------------------------
# Фикстуры file_service
# -------------------------------------------------------------------------


@pytest.fixture
def settings() -> ChatDomainSettings:
    """Настройки чата с дефолтным max_file_size (512 МБ)."""
    return ChatDomainSettings()


@pytest.fixture
def file_service(settings: ChatDomainSettings) -> FileService:
    """FileService с mock-репозиториями."""
    return FileService(
        file_repo=AsyncMock(),
        conv_repo=AsyncMock(),
        settings=settings,
    )


# -------------------------------------------------------------------------
# 1. Граница max_file_size — ровно и +1
# -------------------------------------------------------------------------


class TestFileSizeBoundary:
    """Точные границы ``max_file_size``."""

    def test_exact_max_size_passes(
        self, file_service: FileService, settings: ChatDomainSettings,
    ):
        """Размер ровно ``max_file_size`` — проходит валидацию."""
        # Ровно лимит — допустимо
        file_service.validate_file(
            filename="exact.pdf",
            mime_type="application/pdf",
            file_size=settings.max_file_size,
        )

    def test_max_size_plus_one_rejected(
        self, file_service: FileService, settings: ChatDomainSettings,
    ):
        """Размер ``max_file_size + 1`` — отклоняется с понятным сообщением."""
        with pytest.raises(ChatFileValidationError) as exc_info:
            file_service.validate_file(
                filename="overflow.pdf",
                mime_type="application/pdf",
                file_size=settings.max_file_size + 1,
            )

        # Сообщение содержит "большой" и упоминает лимит
        msg = str(exc_info.value).lower()
        assert "большой" in msg
        # Статус-код — 422 (validation error)
        assert exc_info.value.status_code == 422

    def test_one_byte_passes(self, file_service: FileService):
        """Минимально допустимый размер — 1 байт — проходит."""
        file_service.validate_file(
            filename="tiny.txt",
            mime_type="text/plain",
            file_size=1,
        )

    def test_zero_size_rejected(self, file_service: FileService):
        """Размер 0 — отклоняется как 'пуст или некорректный'."""
        with pytest.raises(ChatFileValidationError) as exc_info:
            file_service.validate_file(
                filename="empty.txt",
                mime_type="text/plain",
                file_size=0,
            )
        assert "пуст" in str(exc_info.value).lower()


# -------------------------------------------------------------------------
# 2. UTF-8 charset fallback при извлечении текста
# -------------------------------------------------------------------------


class TestUtf8CharsetFallback:
    """Поведение ``extract_text`` для текстовых файлов с разными кодировками."""

    def test_utf8_text_decoded_correctly(self):
        """Валидный UTF-8 декодируется корректно."""
        data = "Привет, мир".encode("utf-8")
        result = extract_text(data, "text/plain", "hello.txt")
        assert "Привет" in result

    def test_cp1251_fallback(self):
        """Текст в CP1251 декодируется через fallback после неудачи UTF-8."""
        data = "Тест кодировки".encode("cp1251")
        result = extract_text(data, "text/plain", "cp1251.txt")
        # CP1251 fallback внутри _extract_plain_text
        assert "Тест" in result

    def test_text_plain_with_unusual_mime_param_routes_to_plain(self):
        """MIME с параметрами (charset) роутится как text/* через startswith.

        Это поведение ``extract_text``: проверка ``mime_type.startswith("text/")``
        не зависит от параметров — даже ``"text/plain; charset=invalid"``
        попадёт в текстовую ветку.
        """
        data = b"Plain ASCII content"
        result = extract_text(
            data, "text/plain; charset=invalid", "weird.txt",
        )
        # Не падаем с исключением, отдаём декодированный текст
        assert "Plain ASCII" in result

    def test_invalid_utf8_bytes_fall_back_to_other_encoding(self):
        """Невалидные UTF-8 байты декодируются через cp1251/latin-1 без 500."""
        # Байты, которые невалидны как UTF-8, но валидны как cp1251/latin-1.
        # Используем cp1251-кодирование для русского текста.
        data = b"\xff\xfe\xfd" + "Партиал".encode("cp1251")
        result = extract_text(data, "text/plain", "broken.txt")
        # _extract_plain_text не должен бросить исключение — извлекли что-то
        assert isinstance(result, str)
        assert len(result) > 0


# -------------------------------------------------------------------------
# 3. Битый PDF — первые байты не %PDF-
# -------------------------------------------------------------------------


class TestCorruptedPdf:
    """Битый PDF: ``application/pdf`` без сигнатуры ``%PDF-``."""

    def test_corrupted_pdf_returns_error_message_not_raises(self):
        """Битый PDF не приводит к 500 — возвращается сообщение об ошибке.

        ``extract_text`` оборачивает все исключения парсера в строку:
        ``"[Ошибка чтения файла ...]"``. Это намеренно — иначе SSE-стрим
        упал бы посреди ответа от LLM.
        """
        # Файл с расширением .pdf, но первые байты не %PDF-
        fake_pdf = b"NOT_A_PDF" + b"\x00" * 100
        result = extract_text(fake_pdf, "application/pdf", "broken.pdf")

        # Результат — строка-маркер ошибки, не исключение
        assert isinstance(result, str)
        # Либо "Ошибка чтения", либо сообщение об отсутствии библиотеки
        assert (
            "Ошибка чтения" in result
            or "PDF файл" in result
            or "broken.pdf" in result
        )

    def test_empty_pdf_handled(self):
        """Пустой PDF (0 байт) — обработчик не падает."""
        result = extract_text(b"", "application/pdf", "empty.pdf")
        assert isinstance(result, str)
        assert "empty.pdf" in result

    def test_truncated_pdf_signature(self):
        """PDF с обрезанной сигнатурой (только '%PDF') обрабатывается без 500."""
        # Сигнатура есть, но контент полностью обрезан
        data = b"%PDF-1.4\n" + b"\x00\x01\x02"
        result = extract_text(data, "application/pdf", "truncated.pdf")
        assert isinstance(result, str)


# -------------------------------------------------------------------------
# 4. Битый DOCX (не валидный ZIP)
# -------------------------------------------------------------------------


class TestCorruptedDocx:
    """Битый DOCX: расширение .docx, но не валидный ZIP-контейнер."""

    DOCX_MIME = (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )

    def test_corrupted_docx_returns_error_string(self):
        """Битый DOCX не падает с 500 — возвращает понятную строку.

        ``_extract_docx`` падает на ``python-docx.Document(BytesIO(...))``
        для невалидного ZIP. ``extract_text`` ловит исключение и возвращает
        строку-маркер.
        """
        # Не ZIP — произвольные байты с .docx-расширением
        garbage = b"GARBAGE_NOT_A_ZIP" + b"\x00" * 100
        result = extract_text(garbage, self.DOCX_MIME, "broken.docx")

        assert isinstance(result, str)
        # Сообщение упоминает имя файла или ошибку
        assert (
            "Ошибка чтения" in result
            or "Word файл" in result
            or "broken.docx" in result
        )

    def test_empty_docx_handled(self):
        """Пустой DOCX-файл — обработчик возвращает строку, не падает."""
        result = extract_text(b"", self.DOCX_MIME, "empty.docx")
        assert isinstance(result, str)

    def test_zip_without_docx_structure(self):
        """Валидный ZIP без структуры DOCX — извлечение всё равно не 500.

        ``python-docx`` ожидает word/document.xml внутри ZIP. Битый
        контейнер вызовет KeyError или PackageNotFoundError; ловим всё.
        """
        # Минимальный валидный ZIP (пустой архив)
        # Сигнатура EOCD пустого ZIP
        empty_zip = (
            b"PK\x05\x06"
            + b"\x00" * 18  # фиксированная часть EOCD
        )
        result = extract_text(
            io.BytesIO(empty_zip).getvalue(), self.DOCX_MIME, "empty_zip.docx",
        )
        assert isinstance(result, str)


# -------------------------------------------------------------------------
# 5. Дополнительный sanity: невалидное расширение vs валидный whitelist
# -------------------------------------------------------------------------


class TestMimeWhitelistEdges:
    """Контракт жёсткого whitelist MIME из настроек."""

    def test_mime_with_charset_param_rejected(
        self, file_service: FileService,
    ):
        """MIME с параметрами (``text/plain; charset=utf-8``) — отклоняется.

        По комментарию в коде: жёсткое сравнение по whitelist. Это намеренно,
        чтобы клиент не мог замаскировать payload, добавив параметры в MIME.
        """
        with pytest.raises(ChatFileValidationError) as exc_info:
            file_service.validate_file(
                filename="hello.txt",
                mime_type="text/plain; charset=utf-8",
                file_size=10,
            )
        assert "не поддерживается" in str(exc_info.value).lower()

    def test_html_mime_rejected(self, file_service: FileService):
        """``text/html`` не в whitelist — отклоняется (защита от XSS)."""
        with pytest.raises(ChatFileValidationError):
            file_service.validate_file(
                filename="page.html",
                mime_type="text/html",
                file_size=10,
            )

    def test_octet_stream_rejected(self, file_service: FileService):
        """``application/octet-stream`` (universal fallback) — отклоняется.

        Клиент не может скрыть тип файла под общим octet-stream.
        """
        with pytest.raises(ChatFileValidationError):
            file_service.validate_file(
                filename="unknown.bin",
                mime_type="application/octet-stream",
                file_size=10,
            )
