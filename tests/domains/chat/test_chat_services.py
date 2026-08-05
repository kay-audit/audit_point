"""Тесты сервисов домена чата."""

from contextlib import asynccontextmanager

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.domains.chat.exceptions import (
    ChatFileNotFoundError,
    ChatFileValidationError,
    ChatLimitError,
    ConversationNotFoundError,
)
from app.domains.chat.services.conversation_service import ConversationService
from app.domains.chat.services.file_service import FileService
from app.domains.chat.services.message_service import MessageService
from app.domains.chat.settings import ChatDomainSettings


# -------------------------------------------------------------------------
# Общие фикстуры
# -------------------------------------------------------------------------


@pytest.fixture
def settings():
    """Настройки чата с дефолтными значениями."""
    return ChatDomainSettings()


def _make_mock_repo_with_conn():
    """Создаёт мок репозитория с привязанным conn, поддерживающим transaction().

    MessageService теперь оборачивает create+touch в
    ``async with msg_repo.conn.transaction()`` — поэтому мокам репозиториев
    нужен валидный async-context-manager на ``.conn.transaction()``.

    **Защита от mock drift**: AsyncMock по умолчанию возвращает truthy
    MagicMock на любой await; для методов вида ``get_*`` / ``count_*`` /
    ``find_*`` это ломает тесты, которые ожидают None/0/False. При
    добавлении новых ``get_*``/``count_*`` методов в репозитории — добавь
    им явный дефолт здесь.
    """
    repo = AsyncMock()
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    repo.conn = MagicMock()
    repo.conn.transaction = MagicMock(return_value=tx)
    repo.get_by_id = AsyncMock(return_value=None)
    repo.count_by_user = AsyncMock(return_value=0)
    # Phase 0 «D» streaming-методы MessageRepository — дефолты, чтобы новые
    # тесты могли monkey-patchить лишь то, что реально нужно для конкретного
    # кейса, а вызывающие сервисы не получали truthy-MagicMock по умолчанию.
    repo.create_streaming = AsyncMock(return_value={
        "id": "msg-stub",
        "conversation_id": "conv-stub",
        "role": "assistant",
        "content": [],
        "model": None,
        "token_usage": None,
        "status": "streaming",
    })
    repo.append_block = AsyncMock(return_value=True)
    repo.upsert_block = AsyncMock(return_value=True)
    repo.finalize = AsyncMock(return_value=True)
    repo.mark_failed = AsyncMock(return_value=True)
    # get_streaming_drafts: пустой список — безопасный дефолт для всех тестов,
    # которым не важны висящие drafts.
    repo.get_streaming_drafts = AsyncMock(return_value=[])
    return repo


@pytest.fixture
def conv_repo():
    """Mock ConversationRepository."""
    return _make_mock_repo_with_conn()


@pytest.fixture
def msg_repo():
    """Mock MessageRepository."""
    return _make_mock_repo_with_conn()


@pytest.fixture
def file_repo():
    """Mock FileRepository."""
    return AsyncMock()


# -------------------------------------------------------------------------
# ConversationService
# -------------------------------------------------------------------------


class TestConversationServiceCreate:

    @pytest.fixture
    def service(self, conv_repo, settings):
        return ConversationService(conv_repo=conv_repo, settings=settings)

    async def test_create_success(self, service, conv_repo):
        """Создание беседы при наличии свободного лимита."""
        conv_repo.count_by_user.return_value = 0
        conv_repo.create.return_value = {
            "id": "abc-123",
            "user_id": "user1",
            "title": "Тест",
        }

        result = await service.create(user_id="user1", title="Тест")

        assert result["title"] == "Тест"
        conv_repo.count_by_user.assert_called_once_with("user1")
        conv_repo.create.assert_called_once()

    async def test_create_exceeds_limit(self, service, conv_repo, settings):
        """Превышение лимита бесед вызывает ChatLimitError (status_code=422)."""
        conv_repo.count_by_user.return_value = settings.max_conversations_per_user

        with pytest.raises(ChatLimitError) as exc_info:
            await service.create(user_id="user1")
        assert exc_info.value.status_code == 422
        assert "лимит" in str(exc_info.value).lower()


class TestConversationServiceGet:

    @pytest.fixture
    def service(self, conv_repo, settings):
        return ConversationService(conv_repo=conv_repo, settings=settings)

    async def test_get_not_found(self, service, conv_repo):
        """Несуществующая беседа вызывает ConversationNotFoundError (404)."""
        conv_repo.get_by_id.return_value = None

        with pytest.raises(ConversationNotFoundError) as exc_info:
            await service.get("nonexistent-id", "user1")
        assert exc_info.value.status_code == 404

    async def test_get_found(self, service, conv_repo):
        """Возвращает беседу при наличии."""
        conv_repo.get_by_id.return_value = {"id": "abc", "user_id": "user1"}

        result = await service.get("abc", "user1")
        assert result["id"] == "abc"


# -------------------------------------------------------------------------
# MessageService
# -------------------------------------------------------------------------


class TestMessageServiceSaveUser:

    @pytest.fixture
    def service(self, msg_repo, conv_repo, settings):
        return MessageService(
            msg_repo=msg_repo, conv_repo=conv_repo, settings=settings,
        )

    async def test_save_user_message(self, service, msg_repo, conv_repo):
        """Сохранение пользовательского сообщения."""
        msg_repo.count_by_conversation.return_value = 0
        msg_repo.create.return_value = {
            "id": "msg-1",
            "role": "user",
            "content": [{"type": "text", "content": "Привет"}],
        }

        result = await service.save_user_message(
            conversation_id="conv-1",
            content="Привет",
            user_id="user1",
        )

        assert result["role"] == "user"
        msg_repo.create.assert_called_once()
        conv_repo.touch.assert_called_once_with("conv-1")

    async def test_save_exceeds_length_limit(self, service, msg_repo):
        """Слишком длинное сообщение вызывает ChatLimitError (422)."""
        long_content = "A" * (service.settings.max_message_content_length + 1)

        with pytest.raises(ChatLimitError) as exc_info:
            await service.save_user_message(
                conversation_id="conv-1",
                content=long_content,
                user_id="user1",
            )
        assert exc_info.value.status_code == 422
        assert "длинное" in str(exc_info.value).lower()

    async def test_save_exceeds_message_count_limit(self, service, msg_repo, settings):
        """Превышение лимита сообщений вызывает ChatLimitError (422)."""
        msg_repo.count_by_conversation.return_value = settings.max_messages_per_conversation

        with pytest.raises(ChatLimitError) as exc_info:
            await service.save_user_message(
                conversation_id="conv-1",
                content="Текст",
                user_id="user1",
            )
        assert exc_info.value.status_code == 422
        assert "лимит" in str(exc_info.value).lower()


class _FakeExecutor:
    """Мини-имитация ``DbExecutor`` (см. ``app/db/executor.py``): считает
    захваты «соединения» и входы в explicit-транзакцию.

    Семантика зеркалит реальный исполнитель: любой вызов вне активной
    транзакции — отдельный захват; ``transaction()`` захватывает соединение
    один раз на весь блок, вложенный ``transaction()`` — SAVEPOINT того же
    соединения (новых захватов нет).
    """

    def __init__(self):
        self.acquires = 0
        self.transaction_enters = 0
        self.fetchval_return = 0
        self._depth = 0

    def _mark(self):
        if self._depth == 0:
            self.acquires += 1

    async def fetchval(self, query, *args, timeout=None):
        self._mark()
        return self.fetchval_return

    async def fetchrow(self, query, *args, timeout=None):
        self._mark()
        return None

    async def execute(self, query, *args, timeout=None):
        self._mark()
        return "OK"

    @asynccontextmanager
    async def transaction(self):
        if self._depth == 0:
            self.acquires += 1
            self.transaction_enters += 1
        self._depth += 1
        try:
            yield
        finally:
            self._depth -= 1


class _FakeMessageRepo:
    """Фейковый MessageRepository: методы делегируют в ``conn``, как настоящий
    репозиторий, без SQL и парсинга — нужен только для проверки, что
    ``save_user_message`` укладывается в один захват соединения.
    """

    def __init__(self, conn):
        self.conn = conn

    async def count_by_conversation(self, conversation_id):
        return await self.conn.fetchval("SELECT COUNT(*) FROM chat_messages WHERE conversation_id = $1")

    async def create(self, *, id, conversation_id, role, content, model=None, token_usage=None):
        await self.conn.fetchrow("INSERT INTO chat_messages ... RETURNING *")
        return {"id": id, "role": role, "content": content}


class _FakeConversationRepo:
    """Фейковый ConversationRepository — см. ``_FakeMessageRepo``."""

    def __init__(self, conn):
        self.conn = conn

    async def touch(self, conversation_id):
        await self.conn.execute("UPDATE chat_conversations SET updated_at = now() WHERE id = $1")


class TestMessageServiceSingleAcquisition:
    """Регрессия код-ревью (п.7, ветка connection-per-operation):
    ``count_by_conversation`` перенесён внутрь ``msg_repo.conn.transaction()``
    вместе с create+touch — раньше это были два отдельных захвата соединения
    (count — до транзакции, insert+touch — внутри неё).
    """

    async def test_save_user_message_single_connection_acquisition(self, settings):
        """Успешный путь: один захват соединения на весь save_user_message."""
        conn = _FakeExecutor()
        msg_repo = _FakeMessageRepo(conn)
        conv_repo = _FakeConversationRepo(conn)
        service = MessageService(msg_repo=msg_repo, conv_repo=conv_repo, settings=settings)

        await service.save_user_message(
            conversation_id="conv-1", content="Привет", user_id="user1",
        )

        assert conn.transaction_enters == 1
        assert conn.acquires == 1

    async def test_save_user_message_limit_exceeded_single_acquisition(self, settings):
        """При превышении лимита ChatLimitError долетает без изменений,
        а транзакция всё равно открывается только один раз (откат пустой —
        INSERT/touch до неё не доходят)."""
        conn = _FakeExecutor()
        conn.fetchval_return = settings.max_messages_per_conversation
        msg_repo = _FakeMessageRepo(conn)
        conv_repo = _FakeConversationRepo(conn)
        service = MessageService(msg_repo=msg_repo, conv_repo=conv_repo, settings=settings)

        with pytest.raises(ChatLimitError) as exc_info:
            await service.save_user_message(
                conversation_id="conv-1", content="Текст", user_id="user1",
            )

        assert exc_info.value.status_code == 422
        assert conn.transaction_enters == 1
        assert conn.acquires == 1


class TestMessageServiceSaveAssistant:

    @pytest.fixture
    def service(self, msg_repo, conv_repo, settings):
        return MessageService(
            msg_repo=msg_repo, conv_repo=conv_repo, settings=settings,
        )

    async def test_save_assistant_message(self, service, msg_repo, conv_repo):
        """Сохранение сообщения ассистента."""
        msg_repo.create.return_value = {
            "id": "msg-2",
            "role": "assistant",
            "content": [{"type": "text", "content": "Ответ"}],
        }

        result = await service.save_assistant_message(
            conversation_id="conv-1",
            content=[{"type": "text", "content": "Ответ"}],
            model="gpt-4o",
        )

        assert result["role"] == "assistant"
        conv_repo.touch.assert_called_once_with("conv-1")

    async def test_create_and_touch_in_single_transaction(
        self, service, msg_repo, conv_repo,
    ):
        """1.2: create() и touch() выполняются в одной транзакции.

        Проверяем, что async-context-manager ``msg_repo.conn.transaction()``
        был открыт ровно один раз и обёртывает оба вызова.
        """
        msg_repo.create.return_value = {"id": "m", "role": "assistant"}

        await service.save_assistant_message(
            conversation_id="conv-tx",
            content=[{"type": "text", "content": "x"}],
        )

        # Транзакция открывалась ровно один раз
        assert msg_repo.conn.transaction.call_count == 1
        msg_repo.create.assert_awaited_once()
        conv_repo.touch.assert_awaited_once_with("conv-tx")

    async def test_touch_failure_rolls_back_create(
        self, service, msg_repo, conv_repo,
    ):
        """1.2: Если touch() падает, транзакция откатывается.

        Проверяем именно поведение исключения: ``save_assistant_message``
        должен пробросить ошибку наружу, а не проглотить (иначе вызывающий
        код решит, что сообщение успешно сохранено).
        """
        msg_repo.create.return_value = {"id": "m", "role": "assistant"}
        conv_repo.touch.side_effect = RuntimeError("touch упал")

        with pytest.raises(RuntimeError, match="touch упал"):
            await service.save_assistant_message(
                conversation_id="conv-tx-fail",
                content=[{"type": "text", "content": "x"}],
            )

        # Транзакция была открыта, но __aexit__ получит exception → BEGIN/ROLLBACK
        assert msg_repo.conn.transaction.call_count == 1
        msg_repo.create.assert_awaited_once()


class TestMessageServiceStreamingLifecycle:
    """Phase 1 «D»: streaming-методы для forward'а к внешнему агенту."""

    @pytest.fixture
    def service(self, msg_repo, conv_repo, settings):
        return MessageService(
            msg_repo=msg_repo, conv_repo=conv_repo, settings=settings,
        )

    async def test_start_streaming_assistant_message_creates_record(
        self, service, msg_repo,
    ):
        """start_streaming делегирует в репозиторий и возвращает запись."""
        msg_repo.create_streaming.return_value = {
            "id": "msg-stream",
            "conversation_id": "conv-1",
            "role": "assistant",
            "content": [],
            "status": "streaming",
            "model": "gpt-4o",
        }

        result = await service.start_streaming_assistant_message(
            message_id="msg-stream",
            conversation_id="conv-1",
            model="gpt-4o",
        )

        assert result["status"] == "streaming"
        assert result["id"] == "msg-stream"
        msg_repo.create_streaming.assert_awaited_once_with(
            message_id="msg-stream",
            conversation_id="conv-1",
            model="gpt-4o",
        )

    async def test_start_streaming_recovers_on_unique_violation(
        self, service, msg_repo,
    ):
        """Crash-recovery: UniqueViolation ловится в репозитории, сервис
        прозрачно получает существующую запись.

        Сам сервис не реализует recovery — он делегирует в репозиторий,
        который при UniqueViolation возвращает existing row. Этот тест
        фиксирует контракт: сервис передаёт прежний message_id и не
        падает, даже если запись уже была.
        """
        existing = {
            "id": "msg-existing",
            "conversation_id": "conv-1",
            "role": "assistant",
            "content": [{"type": "reasoning", "content": "уже было"}],
            "status": "streaming",
        }
        msg_repo.create_streaming.return_value = existing

        result = await service.start_streaming_assistant_message(
            message_id="msg-existing",
            conversation_id="conv-1",
        )

        assert result is existing
        assert result["content"] == [
            {"type": "reasoning", "content": "уже было"},
        ]

    async def test_finalize_assistant_message_happy_path(
        self, service, msg_repo, conv_repo,
    ):
        """finalize мержит финальные блоки и тригерит touch беседы."""
        msg_repo.finalize.return_value = True

        final_blocks = [{"type": "text", "content": "Готовый ответ"}]
        ok = await service.finalize_assistant_message(
            message_id="msg-1",
            conversation_id="conv-1",
            final_blocks=final_blocks,
            model="gpt-4o",
            token_usage={"prompt": 10, "completion": 20},
        )

        assert ok is True
        msg_repo.finalize.assert_awaited_once_with(
            message_id="msg-1",
            final_blocks=final_blocks,
            model="gpt-4o",
            token_usage={"prompt": 10, "completion": 20},
        )
        conv_repo.touch.assert_awaited_once_with("conv-1")
        # Финализация в одной транзакции с touch
        assert msg_repo.conn.transaction.call_count == 1

    async def test_finalize_returns_false_when_already_complete(
        self, service, msg_repo, conv_repo,
    ):
        """Повторный finalize (race с другим runner'ом) — лог WARNING + False,
        без touch и без падения."""
        msg_repo.finalize.return_value = False

        ok = await service.finalize_assistant_message(
            message_id="msg-1",
            conversation_id="conv-1",
            final_blocks=[],
        )

        assert ok is False
        msg_repo.finalize.assert_awaited_once()
        conv_repo.touch.assert_not_awaited()

    async def test_fail_assistant_message_happy_path(
        self, service, msg_repo, conv_repo,
    ):
        """fail помечает запись failed + дописывает error-блок + touch."""
        msg_repo.mark_failed.return_value = True
        error_block = {
            "type": "error",
            "message": "timeout",
            "block_id": "msg-1:error:1",
        }

        ok = await service.fail_assistant_message(
            message_id="msg-1",
            conversation_id="conv-1",
            error_block=error_block,
        )

        assert ok is True
        msg_repo.mark_failed.assert_awaited_once_with(
            message_id="msg-1",
            error_block=error_block,
        )
        conv_repo.touch.assert_awaited_once_with("conv-1")

    async def test_fail_assistant_message_returns_false_when_not_streaming(
        self, service, msg_repo, conv_repo,
    ):
        """Race-сценарий: finalize уже сработал, fail — no-op."""
        msg_repo.mark_failed.return_value = False

        ok = await service.fail_assistant_message(
            message_id="msg-1",
            conversation_id="conv-1",
            error_block={"type": "error", "message": "x"},
        )

        assert ok is False
        conv_repo.touch.assert_not_awaited()


# -------------------------------------------------------------------------
# FileService
# -------------------------------------------------------------------------


class TestFileServiceValidate:

    @pytest.fixture
    def service(self, file_repo, conv_repo, settings):
        return FileService(
            file_repo=file_repo, conv_repo=conv_repo, settings=settings,
        )

    def test_validate_ok(self, service):
        """Валидный файл проходит проверку без ошибок."""
        service.validate_file(
            filename="report.pdf",
            mime_type="application/pdf",
            file_size=1024,
        )

    def test_validate_text_wildcard(self, service):
        """Текстовые типы проходят по шаблону text/*."""
        service.validate_file(
            filename="data.csv",
            mime_type="text/csv",
            file_size=100,
        )

    def test_validate_too_large(self, service, settings):
        """Слишком большой файл вызывает ChatFileValidationError (422)."""
        with pytest.raises(ChatFileValidationError) as exc_info:
            service.validate_file(
                filename="huge.pdf",
                mime_type="application/pdf",
                file_size=settings.max_file_size + 1,
            )
        assert exc_info.value.status_code == 422
        assert "большой" in str(exc_info.value).lower()

    def test_validate_wrong_mime_type(self, service):
        """Неподдерживаемый MIME-тип вызывает ChatFileValidationError (422)."""
        with pytest.raises(ChatFileValidationError) as exc_info:
            service.validate_file(
                filename="malware.exe",
                mime_type="application/x-msdownload",
                file_size=100,
            )
        assert exc_info.value.status_code == 422
        assert "не поддерживается" in str(exc_info.value).lower()

    def test_validate_text_html_rejected(self, service):
        """text/html не входит в whitelist — отклоняется (защита от XSS)."""
        with pytest.raises(ChatFileValidationError) as exc_info:
            service.validate_file(
                filename="page.html",
                mime_type="text/html",
                file_size=100,
            )
        assert exc_info.value.status_code == 422
        assert "не поддерживается" in str(exc_info.value).lower()

    def test_validate_mime_with_parameters_rejected(self, service):
        """MIME-тип с параметрами ('text/plain; charset=utf-8') не проходит — точное сравнение."""
        with pytest.raises(ChatFileValidationError) as exc_info:
            service.validate_file(
                filename="note.txt",
                mime_type="text/plain; charset=utf-8",
                file_size=100,
            )
        assert exc_info.value.status_code == 422
        assert "не поддерживается" in str(exc_info.value).lower()


class TestFileServiceSave:

    @pytest.fixture
    def service(self, file_repo, conv_repo, settings):
        return FileService(
            file_repo=file_repo, conv_repo=conv_repo, settings=settings,
        )

    async def test_save_file_conversation_not_found(self, service, conv_repo):
        """Загрузка файла в несуществующую беседу вызывает ConversationNotFoundError (404)."""
        conv_repo.get_by_id.return_value = None

        with pytest.raises(ConversationNotFoundError) as exc_info:
            await service.save_file(
                conversation_id="nonexistent",
                user_id="user1",
                filename="test.pdf",
                mime_type="application/pdf",
                file_data=b"data",
            )
        assert exc_info.value.status_code == 404

    async def test_save_file_success(self, service, conv_repo, file_repo):
        """Успешное сохранение файла."""
        conv_repo.get_by_id.return_value = {"id": "conv-1", "user_id": "user1"}
        file_repo.create.return_value = {
            "id": "file-1",
            "filename": "test.pdf",
            "mime_type": "application/pdf",
            "file_size": 4,
        }

        result = await service.save_file(
            conversation_id="conv-1",
            user_id="user1",
            filename="test.pdf",
            mime_type="application/pdf",
            file_data=b"data",
        )

        assert result["id"] == "file-1"
        file_repo.create.assert_called_once()


class TestFileServiceGet:

    @pytest.fixture
    def service(self, file_repo, conv_repo, settings):
        return FileService(
            file_repo=file_repo, conv_repo=conv_repo, settings=settings,
        )

    async def test_get_file_not_found(self, service, file_repo):
        """Несуществующий файл вызывает ChatFileNotFoundError (404)."""
        file_repo.get_file_data.return_value = None

        with pytest.raises(ChatFileNotFoundError) as exc_info:
            await service.get_file(file_id="nonexistent", user_id="user1")
        assert exc_info.value.status_code == 404

    async def test_get_file_found(self, service, file_repo):
        """Возвращает данные файла при наличии."""
        file_repo.get_file_data.return_value = {
            "id": "file-1",
            "filename": "test.pdf",
            "file_data": b"content",
        }

        result = await service.get_file(file_id="file-1", user_id="user1")
        assert result["filename"] == "test.pdf"


# -------------------------------------------------------------------------
# Файловый эндпоинт: защитные заголовки при отдаче
# -------------------------------------------------------------------------


class TestDownloadFileResponseHeaders:
    """Защитные заголовки для отдачи файлов (anti-XSS / anti-sniffing)."""

    async def test_download_forces_octet_stream_and_nosniff(self):
        """Content-Type принудительно octet-stream, X-Content-Type-Options: nosniff."""
        from app.domains.chat.api.files import download_file

        # Файл с "доверчивым" mime_type (text/html) — должен быть проигнорирован.
        file_service = MagicMock()
        file_service.get_file = AsyncMock(return_value={
            "id": "file-1",
            "filename": "evil.html",
            "mime_type": "text/html",
            "file_data": b"<script>alert(1)</script>",
        })

        response = await download_file(
            file_id="file-1",
            inline=False,
            username="user1",
            file_service=file_service,
        )

        assert response.media_type == "application/octet-stream"
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["Content-Disposition"].startswith(
            "attachment; filename*=UTF-8''",
        )
        # Имя файла percent-encoded в Content-Disposition.
        assert "evil.html" in response.headers["Content-Disposition"]
