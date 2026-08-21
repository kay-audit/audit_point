"""Тесты оркестратора agent loop для AI-чата."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest

from app.core.chat.tools import ChatTool, ChatToolParam, register_tools, reset as reset_tools
from app.core.domain_registry import reset_registry
from app.core.settings_registry import reset as reset_settings
from app.domains.chat.services.orchestrator import Orchestrator, _convert_param, _safe_args
from app.domains.chat.settings import ChatDomainSettings


# -------------------------------------------------------------------------
# Фикстуры
# -------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clean_registries():
    """Сброс глобального состояния реестров между тестами."""
    reset_registry()
    reset_settings()
    reset_tools()
    yield
    reset_registry()
    reset_settings()
    reset_tools()


@pytest.fixture
def settings():
    """Настройки чата с API для тестов."""
    return ChatDomainSettings(
        api_base="http://test-llm:8000/v1",
        api_key="test-key",
        model="gpt-4o",
        max_tool_rounds=3,
        tool_execution_timeout=5,
    )


@pytest.fixture
def settings_no_api():
    """Настройки чата без API (fallback-режим)."""
    return ChatDomainSettings(api_base="", api_key="")


@pytest.fixture
def msg_service():
    """Mock MessageService."""
    svc = AsyncMock()
    svc.load_history_for_llm = AsyncMock(return_value=[])
    svc.save_assistant_message = AsyncMock(return_value={"id": "msg-1"})
    return svc


@pytest.fixture
def conv_service():
    """Mock ConversationService."""
    return AsyncMock()


@pytest.fixture
def orchestrator(msg_service, conv_service, settings):
    """Оркестратор с тестовыми зависимостями."""
    return Orchestrator(
        msg_service=msg_service,
        conv_service=conv_service,
        settings=settings,
    )


@pytest.fixture
def orchestrator_no_api(msg_service, conv_service, settings_no_api):
    """Оркестратор без настроек LLM API."""
    return Orchestrator(
        msg_service=msg_service,
        conv_service=conv_service,
        settings=settings_no_api,
    )


@pytest.fixture
def orchestrator_default_settings():
    """Оркестратор с дефолтными настройками для проверки системного промпта."""
    return Orchestrator(
        msg_service=AsyncMock(),
        conv_service=AsyncMock(),
        settings=ChatDomainSettings(),
    )


def _make_mock_response(content="Ответ ассистента", tool_calls=None, usage=None):
    """Создаёт mock-ответ OpenAI API."""
    message = MagicMock()
    message.content = content
    message.tool_calls = tool_calls

    choice = MagicMock()
    choice.message = message
    choice.finish_reason = "stop" if not tool_calls else "tool_calls"

    response = MagicMock()
    response.choices = [choice]
    response.usage = usage
    return response


def _make_tool_call(name="test_tool", arguments='{"query": "test"}', tc_id="tc-1"):
    """Создаёт mock tool_call."""
    func = MagicMock()
    func.name = name
    func.arguments = arguments

    tc = MagicMock()
    tc.id = tc_id
    tc.function = func
    return tc


# -------------------------------------------------------------------------
# _convert_param
# -------------------------------------------------------------------------


class TestConvertParam:

    def test_convert_boolean_true(self):
        """Конвертация строки 'true' в булево значение."""
        assert _convert_param("true", "boolean") is True

    def test_convert_boolean_false(self):
        """Конвертация строки 'false' в булево значение."""
        assert _convert_param("false", "boolean") is False

    def test_convert_boolean_native(self):
        """Нативное булево значение возвращается без изменений."""
        assert _convert_param(True, "boolean") is True

    def test_convert_integer(self):
        """Конвертация строки в целое число."""
        assert _convert_param("42", "integer") == 42

    def test_convert_date_string(self):
        """Конвертация ISO-строки в объект date."""
        from datetime import date
        result = _convert_param("2025-01-15", "date")
        assert result == date(2025, 1, 15)

    def test_convert_string(self):
        """Конвертация значения в строку."""
        assert _convert_param(123, "string") == "123"

    def test_convert_none(self):
        """None возвращается без конвертации."""
        assert _convert_param(None, "string") is None

    def test_convert_unknown_type(self):
        """Неизвестный тип возвращает значение как есть."""
        assert _convert_param([1, 2], "array") == [1, 2]


# -------------------------------------------------------------------------
# _safe_args
# -------------------------------------------------------------------------


class TestSafeArgs:
    """Защита эхо-сообщения tool_call от пустых arguments.

    LLM/аккумулятор отдают arguments="" для no-args вызовов; эхо такой
    строки в следующий LLM-вызов ломает Qwen/SGLang chat-template
    (json.loads("") → 400) и GigaChat-proxy (422). _safe_args нормализует
    значение в валидную пустую JSON-строку "{}".
    """

    def test_empty_string_becomes_empty_object(self):
        assert _safe_args("") == "{}"

    def test_none_becomes_empty_object(self):
        assert _safe_args(None) == "{}"

    def test_non_string_becomes_empty_object(self):
        # На случай если в Pydantic-объекте прилетит не строка
        assert _safe_args({"already": "dict"}) == "{}"

    def test_non_empty_string_preserved(self):
        # Не валидируем JSON — оставляем upstream-логику для обработки
        # битого JSON (там свой except JSONDecodeError → {}).
        assert _safe_args('{"q": "x"}') == '{"q": "x"}'
        assert _safe_args("anything") == "anything"


# -------------------------------------------------------------------------
# _build_system_messages
# -------------------------------------------------------------------------


class TestBuildSystemMessages:

    def test_base_prompt_only(self, orchestrator):
        """Без доменов возвращается только базовый системный промпт."""
        messages = orchestrator._build_system_messages(domains=None)
        assert len(messages) == 1
        assert messages[0]["role"] == "system"
        assert "forward_to_knowledge_agent" in messages[0]["content"]

    def test_with_domain_prompts(self, orchestrator):
        """С доменами добавляются доменные промпты."""
        from app.core.domain import DomainDescriptor
        from app.core.domain_registry import _domains

        descriptor = DomainDescriptor(
            name="test_domain",
            chat_system_prompt="Это доменный промпт для тестов.",
        )
        _domains.append(descriptor)

        messages = orchestrator._build_system_messages(domains=["test_domain"])
        assert len(messages) == 1
        assert "Это доменный промпт для тестов." in messages[0]["content"]

    def test_unknown_domain_ignored(self, orchestrator):
        """Неизвестный домен игнорируется без ошибки."""
        messages = orchestrator._build_system_messages(domains=["unknown_domain"])
        assert len(messages) == 1
        # Доменных промптов нет — только базовый
        assert "forward_to_knowledge_agent" in messages[0]["content"]


def test_system_prompt_includes_available_pages_section(orchestrator_default_settings):
    """Системный промпт содержит раздел 'Доступные страницы' с NavItem всех доменов."""
    from app.core.domain import DomainDescriptor, NavItem
    from app.core.domain_registry import _domains

    _domains.append(DomainDescriptor(
        name="dom_with_desc",
        nav_items=[
            NavItem(
                label="Страница A",
                url="/a",
                icon_svg="<svg/>",
                description="Описание A",
            ),
        ],
    ))
    _domains.append(DomainDescriptor(
        name="dom_without_desc",
        nav_items=[
            NavItem(label="Страница B", url="/b", icon_svg="<svg/>"),
        ],
    ))

    msgs = orchestrator_default_settings._build_system_messages(None)
    content = msgs[0]["content"]

    assert "## Доступные страницы" in content
    # С описанием
    assert "- Страница A (/a) — Описание A" in content
    # Без описания — без " — "
    assert "- Страница B (/b)" in content
    assert "- Страница B (/b) —" not in content


def test_system_prompt_includes_open_page_instructions(orchestrator_default_settings):
    """Системный промпт содержит инструкции про list_pages и open_*.

    Инструменты названы проводными именами — теми же, что в схеме tools[]
    (см. ``app/core/chat/tools.py::to_wire_name``).
    """
    msgs = orchestrator_default_settings._build_system_messages(None)
    content = msgs[0]["content"]

    assert "## Открытие страниц" in content
    assert "chat_list_pages" in content
    assert "admin_open_admin_panel" in content
    assert "acts_open_act_page" in content


def test_system_prompt_mentions_forward_priority(orchestrator_default_settings):
    """В system-промпте должно быть правило «по умолчанию forward_to_knowledge_agent»."""
    msgs = orchestrator_default_settings._build_system_messages(None)
    text = msgs[0]["content"]
    assert "forward_to_knowledge_agent" in text
    assert "по умолчанию" in text.lower() or "приоритет" in text.lower()


def test_system_prompt_local_smalltalk_mentions_local(monkeypatch, orchestrator_default_settings):
    orchestrator_default_settings.settings.smalltalk_mode = "local"
    msgs = orchestrator_default_settings._build_system_messages(None)
    assert "локальный" in msgs[0]["content"].lower() or "local" in msgs[0]["content"].lower()


def test_system_prompt_forward_smalltalk_mentions_forwarding(orchestrator_default_settings):
    orchestrator_default_settings.settings.smalltalk_mode = "forward"
    msgs = orchestrator_default_settings._build_system_messages(None)
    assert "forward_to_knowledge_agent" in msgs[0]["content"]


# -------------------------------------------------------------------------
# _build_user_content
# -------------------------------------------------------------------------


class TestBuildUserContent:

    async def test_no_files(self, orchestrator):
        """Без файлов возвращается исходный текст."""
        result = await orchestrator._build_user_content("Привет", None)
        assert result == "Привет"

    async def test_empty_file_blocks(self, orchestrator):
        """Пустой список файлов возвращается как исходный текст."""
        result = await orchestrator._build_user_content("Привет", [])
        assert result == "Привет"

    async def test_with_file_blocks(self, orchestrator):
        """С файлами добавляется извлечённый контент."""
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={
            "filename": "test.txt",
            "mime_type": "text/plain",
            "file_data": b"Hello world",
        })
        ctx = AsyncMock()
        ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        ctx.__aexit__ = AsyncMock(return_value=False)
        mock_adapter = MagicMock(get_table_name=lambda name, schema='': name)

        file_blocks = [{"file_id": "file-1", "filename": "test.txt"}]

        with (
            patch("app.db.connection.get_db", return_value=ctx),
            patch("app.db.repositories.base.get_adapter", return_value=mock_adapter),
        ):
            result = await orchestrator._build_user_content("Вопрос", file_blocks)

        assert "Вопрос" in result
        assert "test.txt" in result

    async def test_file_not_found_skipped(self, orchestrator):
        """Несуществующий файл пропускается без ошибки."""
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)
        ctx = AsyncMock()
        ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        ctx.__aexit__ = AsyncMock(return_value=False)
        mock_adapter = MagicMock(get_table_name=lambda name, schema='': name)

        file_blocks = [{"file_id": "nonexistent"}]

        with (
            patch("app.db.connection.get_db", return_value=ctx),
            patch("app.db.repositories.base.get_adapter", return_value=mock_adapter),
        ):
            result = await orchestrator._build_user_content("Вопрос", file_blocks)

        assert result == "Вопрос"

    async def test_file_block_without_id_skipped(self, orchestrator):
        """Блок файла без file_id пропускается."""
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)
        ctx = AsyncMock()
        ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        ctx.__aexit__ = AsyncMock(return_value=False)
        mock_adapter = MagicMock(get_table_name=lambda name, schema='': name)

        with (
            patch("app.db.connection.get_db", return_value=ctx),
            patch("app.db.repositories.base.get_adapter", return_value=mock_adapter),
        ):
            result = await orchestrator._build_user_content(
                "Текст", [{"type": "file"}],
            )

        assert result == "Текст"

    async def test_file_access_uses_conversation_id(self, orchestrator):
        """_build_user_content получает файлы через репозиторий с проверкой conversation_id."""
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={
            "filename": "secret.pdf",
            "mime_type": "text/plain",
            "file_data": b"Secret data contents",
        })
        ctx = AsyncMock()
        ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        ctx.__aexit__ = AsyncMock(return_value=False)
        mock_adapter = MagicMock(get_table_name=lambda name, schema='': name)

        file_blocks = [{"file_id": "file-id-1"}]

        with (
            patch("app.db.connection.get_db", return_value=ctx),
            patch("app.db.repositories.base.get_adapter", return_value=mock_adapter),
        ):
            result = await orchestrator._build_user_content(
                "Покажи", file_blocks, "conv-123",
            )

        assert "secret.pdf" in result
        # SQL содержит проверку conversation_id
        call_args = mock_conn.fetchrow.call_args
        sql = call_args[0][0]
        assert "conversation_id" in sql


# -------------------------------------------------------------------------
# run() — полный (не стриминговый) agent loop
# -------------------------------------------------------------------------


class TestOrchestratorRun:

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_run_simple_response(self, mock_client_factory, orchestrator):
        """Простой ответ LLM без tool calls."""
        mock_client = AsyncMock()
        usage = MagicMock()
        usage.prompt_tokens = 10
        usage.completion_tokens = 20
        usage.total_tokens = 30

        response = _make_mock_response(
            content="Привет! Чем помочь?",
            usage=usage,
        )
        mock_client.chat.completions.create = AsyncMock(return_value=response)
        mock_client_factory.return_value = mock_client
        orchestrator._save_assistant_message = AsyncMock()

        result = await orchestrator.run(
            message_id="test-msg-id",
            conversation_id="conv-1",
            user_message="Привет",
        )

        assert result["response"] == "Привет! Чем помочь?"
        assert result["model"] == "gpt-4o"
        assert result["token_usage"]["total_tokens"] == 30
        orchestrator._save_assistant_message.assert_called_once()

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_run_with_tool_calls(self, mock_client_factory, orchestrator):
        """Agent loop с вызовом инструмента."""
        # Регистрируем тестовый инструмент
        test_tool = ChatTool(
            name="search_acts",
            domain="acts",
            description="Поиск актов",
            parameters=[
                ChatToolParam(name="query", type="string", description="Запрос"),
            ],
            handler=AsyncMock(return_value="Найден акт КМ-01-00001"),
        )
        register_tools([test_tool])

        mock_client = AsyncMock()
        # Первый вызов — tool_call
        tool_call = _make_tool_call(
            name="search_acts",
            arguments='{"query": "КМ-01"}',
        )
        response1 = _make_mock_response(
            content=None,
            tool_calls=[tool_call],
        )
        # Второй вызов — финальный ответ
        response2 = _make_mock_response(content="Найден акт КМ-01-00001.")
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[response1, response2],
        )
        mock_client_factory.return_value = mock_client
        orchestrator._save_assistant_message = AsyncMock()

        result = await orchestrator.run(
            message_id="test-msg-id",
            conversation_id="conv-1",
            user_message="Найди акт КМ-01",
        )

        assert "search_acts" in result["sources"]
        assert "КМ-01-00001" in result["response"]

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_run_max_tool_rounds_limit(self, mock_client_factory, orchestrator):
        """Agent loop останавливается при достижении лимита раундов."""
        test_tool = ChatTool(
            name="loop_tool",
            domain="test",
            description="Инструмент для теста лимита",
            handler=AsyncMock(return_value="Результат"),
        )
        register_tools([test_tool])

        mock_client = AsyncMock()
        # Всегда возвращаем tool_call — цикл должен остановиться
        tool_call = _make_tool_call(name="loop_tool", arguments="{}")
        response_with_tc = _make_mock_response(content=None, tool_calls=[tool_call])
        # Финальный ответ после лимита раундов
        response_final = _make_mock_response(content="Ответ после лимита")
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[response_with_tc] * 3 + [response_final],
        )
        mock_client_factory.return_value = mock_client
        orchestrator._save_assistant_message = AsyncMock()

        result = await orchestrator.run(
            message_id="test-msg-id",
            conversation_id="conv-1",
            user_message="Тест лимита",
        )

        # max_tool_rounds=3, значит 3 tool_call + 1 финальный = 4 вызова
        assert mock_client.chat.completions.create.call_count == 4

    async def test_run_fallback_no_api(self, orchestrator_no_api):
        """Без настроек API возвращается fallback-ответ."""
        result = await orchestrator_no_api.run(
            message_id="test-msg-id",
            conversation_id="conv-1",
            user_message="Привет",
        )

        assert result["status"] == "fallback"
        assert "Привет" in result["response"]
        assert "режиме заглушки" in result["response"]

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_run_api_error_returns_200_with_error_payload(
        self, mock_client_factory, orchestrator,
    ):
        """1.4 (BUG #7 закрыт как намеренное поведение): при ошибке LLM API
        run() возвращает dict с 'status: error' и нейтральным сообщением;
        для не-стрим режима это допустимо (внутренние детали не утекают).
        Дополнительно: ErrorBlock сохраняется в историю, чтобы пользователь
        увидел причину при перезагрузке страницы.
        """
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=Exception("Connection refused"),
        )
        mock_client_factory.return_value = mock_client
        orchestrator._save_assistant_message = AsyncMock()

        result = await orchestrator.run(
            message_id="test-msg-id",
            conversation_id="conv-1",
            user_message="Привет",
        )

        # Ошибка замаскирована как dict с status='error'
        assert result["status"] == "error"
        assert "Временная ошибка" in result["response"]
        # Нет HTTPException или raise — вызывающий код получит 200 OK
        # ErrorBlock сохранён в историю.
        orchestrator._save_assistant_message.assert_awaited_once()
        kwargs = orchestrator._save_assistant_message.await_args.kwargs
        saved_blocks = kwargs["content_blocks"]
        assert len(saved_blocks) == 1
        assert saved_blocks[0]["type"] == "error"
        assert saved_blocks[0]["code"] == "llm_unavailable"
        assert "Временная ошибка" in saved_blocks[0]["message"]

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_run_timeout_emits_structured_warning(
        self, mock_client_factory, orchestrator, caplog,
    ):
        """5.3.2: при asyncio.TimeoutError в run() логируется warning
        'LLM timeout' с extra-полями stage/model/conversation_id."""
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=asyncio.TimeoutError(),
        )
        mock_client_factory.return_value = mock_client
        orchestrator._save_assistant_message = AsyncMock()

        with caplog.at_level("WARNING"):
            result = await orchestrator.run(
                message_id="test-msg-id",
                conversation_id="conv-timeout",
                user_message="Привет",
            )

        assert result["status"] == "error"

        timeout_records = [
            r for r in caplog.records
            if r.getMessage() == "LLM timeout"
        ]
        assert len(timeout_records) == 1, (
            "Должна быть ровно одна запись 'LLM timeout'"
        )
        record = timeout_records[0]
        assert record.levelname == "WARNING"
        assert record.__dict__.get("stage") == "run"
        assert record.__dict__.get("conversation_id") == "conv-timeout"
        assert "model" in record.__dict__

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_run_strips_leading_newlines(self, mock_client_factory, orchestrator):
        """Ведущие переносы строк убираются из ответа LLM."""
        mock_client = AsyncMock()
        response = _make_mock_response(content="\n\nОтвет ассистента")
        mock_client.chat.completions.create = AsyncMock(return_value=response)
        mock_client_factory.return_value = mock_client
        orchestrator._save_assistant_message = AsyncMock()

        result = await orchestrator.run(
            message_id="test-msg-id",
            conversation_id="conv-1",
            user_message="Вопрос",
        )

        assert result["response"] == "Ответ ассистента"

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_run_handles_malformed_tool_arguments(
        self, mock_client_factory, orchestrator,
    ):
        """Если LLM вернул битый JSON в tool_call.function.arguments,
        orchestrator подставляет пустой dict и продолжает: tool вызывается,
        round не прерывается. Без этого fallback'а одна кривая модель
        ломала бы весь tool-loop.

        Аналогичный fallback на стрим-путях (orchestrator.py:1010, 1202) —
        идентичен по семантике; проверять каждое место не имеет смысла,
        весь риск в строке ``except json.JSONDecodeError: arguments = {}``.
        """
        captured_args: dict[str, object] = {}

        async def handler(**kwargs):
            captured_args.update(kwargs)
            return "ok"

        test_tool = ChatTool(
            name="probe",
            domain="test",
            description="Проба malformed args",
            handler=handler,
        )
        register_tools([test_tool])

        mock_client = AsyncMock()
        tool_call = _make_tool_call(
            name="probe",
            arguments='{"query": "КМ-01"',  # незакрытая скобка → JSONDecodeError
        )
        response_with_tc = _make_mock_response(
            content=None, tool_calls=[tool_call],
        )
        response_final = _make_mock_response(content="Готово")
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[response_with_tc, response_final],
        )
        mock_client_factory.return_value = mock_client
        orchestrator._save_assistant_message = AsyncMock()

        result = await orchestrator.run(
            message_id="test-msg-id",
            conversation_id="conv-1",
            user_message="Найди что-нибудь",
        )

        # Тool всё-таки выполнен, но с пустыми аргументами.
        assert captured_args == {}
        assert result["response"] == "Готово"


# -------------------------------------------------------------------------
# _execute_tool_call
# -------------------------------------------------------------------------


class TestExecuteToolCall:

    async def test_tool_not_found(self, orchestrator):
        """Вызов несуществующего инструмента возвращает ошибку."""
        result = await orchestrator._execute_tool_call("nonexistent", {})
        assert "не найден" in result

    async def test_tool_without_handler(self, orchestrator):
        """Инструмент без обработчика возвращает ошибку."""
        tool = ChatTool(
            name="no_handler_tool",
            domain="test",
            description="Без обработчика",
            handler=None,
        )
        register_tools([tool])

        result = await orchestrator._execute_tool_call("no_handler_tool", {})
        assert "не имеет обработчика" in result

    async def test_tool_timeout(self, orchestrator):
        """Таймаут выполнения инструмента возвращает ошибку."""

        async def slow_handler(**kwargs):
            await asyncio.sleep(100)
            return "Не должно вернуться"

        tool = ChatTool(
            name="slow_tool",
            domain="test",
            description="Медленный инструмент",
            handler=slow_handler,
        )
        register_tools([tool])

        result = await orchestrator._execute_tool_call("slow_tool", {})
        assert "таймаут" in result.lower()

    async def test_tool_exception(self, orchestrator):
        """Исключение в обработчике возвращает нейтральное сообщение без деталей."""

        async def failing_handler(**kwargs):
            raise ValueError("Внутренняя ошибка инструмента")

        tool = ChatTool(
            name="failing_tool",
            domain="test",
            description="Сбойный инструмент",
            handler=failing_handler,
        )
        register_tools([tool])

        result = await orchestrator._execute_tool_call("failing_tool", {})
        # 4.3: нейтральное сообщение БЕЗ деталей exception
        assert "ошибкой" in result.lower()
        assert "error_id=" in result
        assert "Внутренняя ошибка инструмента" not in result

    async def test_tool_exception_does_not_leak_details(self, orchestrator, caplog):
        """4.3: Детали исключения (SQL, секреты) НЕ попадают в выход LLM;
        полный stack-trace остаётся только в логах с error_id.
        """
        import logging as _logging

        async def leaky_handler(**kwargs):
            raise RuntimeError(
                "secret SQL leaked: SELECT * FROM users WHERE password='hunter2'",
            )

        tool = ChatTool(
            name="leaky_tool",
            domain="test",
            description="Утечка",
            handler=leaky_handler,
        )
        register_tools([tool])

        with caplog.at_level(_logging.ERROR):
            result = await orchestrator._execute_tool_call("leaky_tool", {})

        # Секрет НЕ просочился в результат для LLM
        assert "secret SQL leaked" not in result
        assert "hunter2" not in result
        assert "RuntimeError" not in result
        # Должен быть error_id для трассировки
        assert "error_id=" in result
        # Полный stack-trace и сообщение exception — в логах
        leaked_in_logs = any(
            "secret SQL leaked" in record.getMessage()
            or "secret SQL leaked" in (record.exc_text or "")
            for record in caplog.records
        )
        assert leaked_in_logs, "Детали исключения должны быть в логах"

    async def test_tool_dict_result_serialized(self, orchestrator):
        """Dict-результат инструмента сериализуется в JSON."""
        tool = ChatTool(
            name="json_tool",
            domain="test",
            description="JSON инструмент",
            handler=AsyncMock(return_value={"status": "ok", "data": [1, 2]}),
        )
        register_tools([tool])

        result = await orchestrator._execute_tool_call("json_tool", {})
        parsed = json.loads(result)
        assert parsed["status"] == "ok"

    async def test_missing_required_param_raises_validation_error(self, orchestrator):
        """1.3: Отсутствующий required-параметр → ChatToolValidationError."""
        from app.domains.chat.exceptions import ChatToolValidationError

        tool = ChatTool(
            name="req_tool",
            domain="test",
            description="С обязательным параметром",
            parameters=[
                ChatToolParam(
                    name="must_have",
                    type="string",
                    description="Обязательный",
                    required=True,
                ),
            ],
            handler=AsyncMock(return_value="ok"),
        )
        register_tools([tool])

        with pytest.raises(ChatToolValidationError) as exc_info:
            await orchestrator._execute_tool_call("req_tool", {})

        assert "must_have" in str(exc_info.value)
        assert exc_info.value.status_code == 400

    async def test_optional_param_missing_does_not_raise(self, orchestrator):
        """1.3: Отсутствие optional-параметра не считается ошибкой валидации."""
        tool = ChatTool(
            name="opt_tool",
            domain="test",
            description="С опциональным параметром",
            parameters=[
                ChatToolParam(
                    name="maybe",
                    type="string",
                    description="Опциональный",
                    required=False,
                ),
            ],
            handler=AsyncMock(return_value="ok"),
        )
        register_tools([tool])

        result = await orchestrator._execute_tool_call("opt_tool", {})
        assert result == "ok"

    async def test_tool_param_type_conversion(self, orchestrator):
        """Параметры инструмента конвертируются в правильные типы."""
        received_args = {}

        async def capture_handler(**kwargs):
            received_args.update(kwargs)
            return "OK"

        tool = ChatTool(
            name="typed_tool",
            domain="test",
            description="Типизированный инструмент",
            parameters=[
                ChatToolParam(name="count", type="integer", description="Кол-во"),
                ChatToolParam(name="active", type="boolean", description="Флаг"),
            ],
            handler=capture_handler,
        )
        register_tools([tool])

        await orchestrator._execute_tool_call("typed_tool", {
            "count": "5",
            "active": "true",
        })

        assert received_args["count"] == 5
        assert received_args["active"] is True


# -------------------------------------------------------------------------
# Метрики выполнения tool'ов (4.5.1)
# -------------------------------------------------------------------------


class TestExecuteToolCallMetrics:
    """Проверяем, что _execute_tool_call вызывает _record_tool_metric с
    правильным статусом и неотрицательным latency в каждой ветке."""

    async def test_success_records_success_metric(self, orchestrator):
        """Успешное выполнение → record(status='success', latency_ms>=0)."""
        tool = ChatTool(
            name="ok_tool",
            domain="test",
            description="OK",
            handler=AsyncMock(return_value="result"),
        )
        register_tools([tool])

        # Контекст: должны попасть в record как username/conversation_id
        orchestrator._current_user_id = "user1"
        orchestrator._current_conversation_id = "conv-1"

        with patch.object(
            orchestrator, "_record_tool_metric", new=AsyncMock(),
        ) as mock_record:
            result = await orchestrator._execute_tool_call("ok_tool", {})

        assert result == "result"
        mock_record.assert_awaited_once()
        kwargs = mock_record.call_args.kwargs
        assert kwargs["tool_name"] == "ok_tool"
        assert kwargs["status"] == "success"
        assert kwargs["latency_ms"] >= 0
        assert kwargs["error_message"] is None

    async def test_exception_records_error_metric_with_message(self, orchestrator):
        """Exception в handler → status='error', error_message обрезается до 1000."""
        async def failing_handler(**kwargs):
            raise ValueError("x" * 2000)

        tool = ChatTool(
            name="fail_tool",
            domain="test",
            description="Сбойный",
            handler=failing_handler,
        )
        register_tools([tool])

        with patch.object(
            orchestrator, "_record_tool_metric", new=AsyncMock(),
        ) as mock_record:
            await orchestrator._execute_tool_call("fail_tool", {})

        mock_record.assert_awaited_once()
        kwargs = mock_record.call_args.kwargs
        assert kwargs["status"] == "error"
        # error_message обрезан до 1000 символов
        assert kwargs["error_message"] is not None
        assert len(kwargs["error_message"]) <= 1000

    async def test_validation_error_records_validation_error_metric(self, orchestrator):
        """Отсутствие required-параметра → record(status='validation_error')
        + ChatToolValidationError проброшен наружу."""
        from app.domains.chat.exceptions import ChatToolValidationError

        tool = ChatTool(
            name="req2_tool",
            domain="test",
            description="С required",
            parameters=[
                ChatToolParam(
                    name="must", type="string", description="must",
                    required=True,
                ),
            ],
            handler=AsyncMock(return_value="ok"),
        )
        register_tools([tool])

        with patch.object(
            orchestrator, "_record_tool_metric", new=AsyncMock(),
        ) as mock_record:
            with pytest.raises(ChatToolValidationError):
                await orchestrator._execute_tool_call("req2_tool", {})

        mock_record.assert_awaited_once()
        kwargs = mock_record.call_args.kwargs
        assert kwargs["status"] == "validation_error"
        assert kwargs["latency_ms"] == 0

    async def test_timeout_records_error_metric(self, orchestrator):
        """asyncio.TimeoutError → status='error', error_message содержит timeout."""
        async def slow_handler(**kwargs):
            await asyncio.sleep(100)
            return "x"

        tool = ChatTool(
            name="slow2_tool",
            domain="test",
            description="Медленный",
            handler=slow_handler,
        )
        register_tools([tool])

        with patch.object(
            orchestrator, "_record_tool_metric", new=AsyncMock(),
        ) as mock_record:
            await orchestrator._execute_tool_call("slow2_tool", {})

        mock_record.assert_awaited_once()
        kwargs = mock_record.call_args.kwargs
        assert kwargs["status"] == "error"
        assert "timeout" in kwargs["error_message"].lower()

    async def test_record_metric_failure_does_not_break_tool_loop(self, orchestrator):
        """Сбой записи метрики → tool-loop продолжает работать (результат возвращается)."""
        tool = ChatTool(
            name="ok2_tool",
            domain="test",
            description="OK",
            handler=AsyncMock(return_value="payload"),
        )
        register_tools([tool])

        # Имитируем недоступность DI / репозитория
        with patch(
            "app.domains.chat.deps.get_tool_metrics_repository",
            side_effect=RuntimeError("DB unavailable"),
        ):
            result = await orchestrator._execute_tool_call("ok2_tool", {})

        # Результат tool'а вернулся несмотря на сбой метрики
        assert result == "payload"


# -------------------------------------------------------------------------
# _get_history_messages
# -------------------------------------------------------------------------


class TestGetHistoryMessages:

    async def test_empty_history(self, orchestrator, msg_service):
        """Пустая история возвращает пустой список."""
        msg_service.load_history_for_llm.return_value = []
        result = await orchestrator._get_history_messages("conv-1")
        assert result == []

    async def test_text_blocks_extracted(self, orchestrator, msg_service):
        """Текстовые блоки извлекаются в формат OpenAI."""
        msg_service.load_history_for_llm.return_value = [
            {
                "role": "user",
                "content": [{"type": "text", "content": "Вопрос"}],
            },
            {
                "role": "assistant",
                "content": [{"type": "text", "content": "Ответ"}],
            },
        ]

        result = await orchestrator._get_history_messages("conv-1")
        assert len(result) == 2
        assert result[0] == {"role": "user", "content": "Вопрос"}
        assert result[1] == {"role": "assistant", "content": "Ответ"}

    async def test_code_blocks_formatted(self, orchestrator, msg_service):
        """Code-блоки форматируются как markdown fenced code."""
        msg_service.load_history_for_llm.return_value = [
            {
                "role": "assistant",
                "content": [
                    {"type": "code", "language": "python", "content": "print('hi')"},
                ],
            },
        ]

        result = await orchestrator._get_history_messages("conv-1")
        assert "```python" in result[0]["content"]
        assert "print('hi')" in result[0]["content"]

    async def test_file_blocks_formatted(self, orchestrator, msg_service):
        """File-блоки форматируются как '[Прикреплён файл: ...]'."""
        msg_service.load_history_for_llm.return_value = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "content": "Смотри файл"},
                    {"type": "file", "filename": "report.pdf"},
                ],
            },
        ]

        result = await orchestrator._get_history_messages("conv-1")
        assert "Прикреплён файл: report.pdf" in result[0]["content"]

    async def test_history_truncated_to_max_length(self, orchestrator, msg_service):
        """История обрезается до max_history_length."""
        orchestrator.settings.max_history_length = 3
        msg_service.load_history_for_llm.return_value = [
            {"role": "user", "content": [{"type": "text", "content": f"Msg {i}"}]}
            for i in range(10)
        ]

        result = await orchestrator._get_history_messages("conv-1")
        assert len(result) == 3

    async def test_string_content_handled(self, orchestrator, msg_service):
        """Строковый контент (не список блоков) обрабатывается."""
        msg_service.load_history_for_llm.return_value = [
            {"role": "user", "content": "Просто строка"},
        ]

        result = await orchestrator._get_history_messages("conv-1")
        assert result[0]["content"] == "Просто строка"

    async def test_reasoning_blocks_excluded_from_llm_context(
        self, orchestrator, msg_service,
    ):
        """Reasoning сохранён в истории для UI, но в контекст LLM не идёт.

        Иначе модель в следующем запросе увидит собственный chain-of-thought
        предыдущего ответа и контекст будет засоряться.
        """
        msg_service.load_history_for_llm.return_value = [
            {
                "role": "assistant",
                "content": [
                    {"type": "reasoning", "content": "Думаю про КСО"},
                    {"type": "text", "content": "Ответ по КСО"},
                ],
            },
        ]

        result = await orchestrator._get_history_messages("conv-1")
        assert len(result) == 1
        assert result[0]["content"] == "Ответ по КСО"
        assert "Думаю про КСО" not in result[0]["content"]

    async def test_error_blocks_excluded_from_llm_context(
        self, orchestrator, msg_service,
    ):
        """Сохранённые error-блоки в контекст LLM не передаются."""
        msg_service.load_history_for_llm.return_value = [
            {
                "role": "assistant",
                "content": [
                    {"type": "error", "message": "Сбой моста", "code": "x"},
                    {"type": "text", "content": "Запросите позже."},
                ],
            },
        ]

        result = await orchestrator._get_history_messages("conv-1")
        assert result[0]["content"] == "Запросите позже."
        assert "Сбой моста" not in result[0]["content"]


# -------------------------------------------------------------------------
# _format_block_full / _format_block_shallow
# -------------------------------------------------------------------------


class TestFormatBlock:

    def test_format_block_full_file_size(self):
        """Размер файла берётся из поля file_size (как в FileBlock), не size."""
        block = {"type": "file", "filename": "a.xlsx", "file_size": 2 * 1024 * 1024}
        result = Orchestrator._format_block_full(block)
        assert "2.0 МБ" in result

    def test_format_block_shallow_file_size(self):
        """Shallow-режим тоже берёт размер из file_size."""
        block = {"type": "file", "filename": "a.xlsx", "file_size": 2 * 1024 * 1024}
        result = Orchestrator._format_block_shallow(block)
        assert "2.0 МБ" in result


# -------------------------------------------------------------------------
# _fallback_response
# -------------------------------------------------------------------------


class TestFallbackResponse:

    def test_fallback_with_no_tools(self, orchestrator):
        """Fallback без зарегистрированных инструментов."""
        result = orchestrator._fallback_response("Привет")
        assert "Привет" in result["response"]
        assert "Инструменты не зарегистрированы" in result["response"]
        assert result["status"] == "fallback"

    def test_fallback_with_tools(self, orchestrator):
        """Fallback с зарегистрированными инструментами."""
        tool = ChatTool(
            name="test_tool",
            domain="test",
            description="Тестовый инструмент",
            handler=AsyncMock(),
        )
        register_tools([tool])

        result = orchestrator._fallback_response("Привет")
        assert "Доступно инструментов: 1" in result["response"]
        assert "CHAT__API_BASE" in result["response"]


@pytest.mark.asyncio
async def test_orchestrator_disables_streaming_for_gigachat_profile():
    """Профиль gigachat: оркестратор не вызывает LLM со stream=True (non-streaming)."""
    from unittest.mock import AsyncMock, MagicMock, patch

    from pydantic import SecretStr

    from app.domains.chat.services.orchestrator import Orchestrator
    from app.domains.chat.settings import ChatDomainSettings

    settings = ChatDomainSettings(
        profile="gigachat",
        api_base="http://liveaccess/v1/gc",
        api_key=SecretStr("t"),
        model="GigaChat-3-Ultra",
    )
    msg_service = MagicMock()
    msg_service.load_history_for_llm = AsyncMock(return_value=[])
    conv_service = MagicMock()

    orch = Orchestrator(
        msg_service=msg_service,
        conv_service=conv_service,
        settings=settings,
    )

    # Мокаем underlying API — отдаём простой текстовый ответ
    from openai.types.chat import ChatCompletion
    fake_resp = ChatCompletion.model_validate({
        "id": "x", "object": "chat.completion", "created": 0,
        "model": "GigaChat-3-Ultra",
        "choices": [{"index": 0, "message": {
            "role": "assistant", "content": "Привет",
        }, "finish_reason": "stop"}],
    })

    with patch(
        "app.domains.chat.services.orchestrator.build_llm_client",
    ) as mock_build:
        fake_client = MagicMock()
        fake_client.chat.completions.create = AsyncMock(return_value=fake_resp)
        mock_build.return_value = fake_client

        with patch.object(
            orch, "_save_assistant_message", new=AsyncMock(),
        ):
            await orch.run(
                message_id="test-msg-id",
                conversation_id="c1",
                user_message="привет",
            )

    # Проверяем: ни одного вызова с stream=True
    for call in fake_client.chat.completions.create.await_args_list:
        assert call.kwargs.get("stream", False) is False, (
            "Оркестратор не должен звать LLM со stream=True для gigachat"
        )


# -------------------------------------------------------------------------
# 4.2.3 — Lazy-loading истории (history_full_context_depth)
# -------------------------------------------------------------------------


class TestLazyHistory:
    """Тесты lazy-loading: последние N сообщений — полный контент,
    остальные — placeholder вместо file/image-блоков."""

    async def test_recent_messages_get_full_content(self, orchestrator, msg_service):
        """Последние depth сообщений имеют полный file-контент."""
        orchestrator.settings.history_full_context_depth = 3
        history = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "content": f"Msg {i}"},
                    {"type": "file", "filename": f"file{i}.pdf", "size": 1048576},
                ],
            }
            for i in range(5)
        ]
        msg_service.load_history_for_llm.return_value = history

        result = await orchestrator._get_history_messages("conv-1")
        # Все 5 сообщений присутствуют
        assert len(result) == 5
        # Последние 3 (индексы 2,3,4) имеют «Прикреплён файл»
        for idx in [2, 3, 4]:
            assert "Прикреплён файл" in result[idx]["content"], (
                f"msg {idx} должен иметь полный file-контент"
            )
        # Первые 2 (индексы 0,1) имеют placeholder «не загружен в этом ходу»
        for idx in [0, 1]:
            assert "не загружен в этом ходу" in result[idx]["content"], (
                f"msg {idx} должен иметь placeholder"
            )

    async def test_old_messages_get_placeholder(self, orchestrator, msg_service):
        """Старые сообщения получают placeholder вместо file-контента."""
        orchestrator.settings.history_full_context_depth = 2
        msg_service.load_history_for_llm.return_value = [
            {
                "role": "user",
                "content": [
                    {"type": "file", "filename": "old.pdf", "size": 2097152},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "file", "filename": "new.pdf", "size": 1048576},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "file", "filename": "newest.pdf", "size": 512000},
                ],
            },
        ]

        result = await orchestrator._get_history_messages("conv-1")
        # depth=2: последние 2 (индексы 1,2) — полные
        assert "Прикреплён файл: new.pdf" in result[1]["content"]
        assert "Прикреплён файл: newest.pdf" in result[2]["content"]
        # Первое (индекс 0) — placeholder
        assert "не загружен в этом ходу" in result[0]["content"]
        assert "old.pdf" in result[0]["content"]

    async def test_depth_larger_than_history_all_full(self, orchestrator, msg_service):
        """Если depth > len(history), все сообщения получают полный контент."""
        orchestrator.settings.history_full_context_depth = 10
        msg_service.load_history_for_llm.return_value = [
            {
                "role": "user",
                "content": [
                    {"type": "file", "filename": "f.pdf", "size": 1048576},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "file", "filename": "g.pdf", "size": 2097152},
                ],
            },
        ]

        result = await orchestrator._get_history_messages("conv-1")
        for r in result:
            assert "Прикреплён файл" in r["content"], (
                "Все сообщения должны иметь полный контент при depth > len"
            )

    async def test_text_blocks_always_full(self, orchestrator, msg_service):
        """Text-блоки присутствуют в полном виде независимо от depth."""
        orchestrator.settings.history_full_context_depth = 1
        msg_service.load_history_for_llm.return_value = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "content": "Старый текст"},
                    {"type": "file", "filename": "old.txt"},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "content": "Новый текст"},
                ],
            },
        ]

        result = await orchestrator._get_history_messages("conv-1")
        # Первое сообщение — shallow mode: text присутствует, file — placeholder
        assert "Старый текст" in result[0]["content"]
        assert "не загружен в этом ходу" in result[0]["content"]
        # Второе — full: text полный
        assert "Новый текст" in result[1]["content"]

    async def test_image_blocks_get_placeholder_in_old_messages(
        self, orchestrator, msg_service,
    ):
        """Image-блоки тоже заменяются placeholder'ами в старых сообщениях."""
        orchestrator.settings.history_full_context_depth = 1
        msg_service.load_history_for_llm.return_value = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "filename": "photo.png", "size": 1048576},
                ],
            },
            {
                "role": "user",
                "content": [{"type": "text", "content": "новое"}],
            },
        ]

        result = await orchestrator._get_history_messages("conv-1")
        assert "не загружен в этом ходу" in result[0]["content"]
        assert "photo.png" in result[0]["content"]


# -------------------------------------------------------------------------
# 4.2.1 — GigaChat parallel tool_calls queue (run() — non-streaming)
# -------------------------------------------------------------------------


class TestGigaChatQueue:
    """GigaChat поддерживает только 1 function_call за раунд.
    При >1 tool_calls оркестратор выполняет их по очереди."""

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_run_gigachat_executes_multiple_tool_calls_sequentially(
        self, mock_client_factory,
    ):
        """Если GigaChat вернул 2 tool_calls, оба исполняются по очереди."""
        from pydantic import SecretStr

        settings = ChatDomainSettings(
            profile="gigachat",
            api_base="http://liveaccess/v1/gc",
            api_key=SecretStr("t"),
            model="GigaChat-3-Ultra",
            max_tool_rounds=5,
        )
        call_order: list[str] = []

        async def handler_a(**kwargs):
            call_order.append("A")
            return "result_a"

        async def handler_b(**kwargs):
            call_order.append("B")
            return "result_b"

        tool_a = ChatTool(name="tool_a", domain="test", description="A", handler=handler_a)
        tool_b = ChatTool(name="tool_b", domain="test", description="B", handler=handler_b)
        register_tools([tool_a, tool_b])

        msg_svc = AsyncMock()
        msg_svc.load_history_for_llm = AsyncMock(return_value=[])
        orch = Orchestrator(
            msg_service=msg_svc, conv_service=AsyncMock(), settings=settings,
        )
        orch._save_assistant_message = AsyncMock()

        # LLM вернул 2 tool_calls (как они бы пришли после _translate_response)
        tc_a = _make_tool_call(name="tool_a", arguments="{}", tc_id="tc-a")
        tc_b = _make_tool_call(name="tool_b", arguments="{}", tc_id="tc-b")
        resp_with_two_tcs = _make_mock_response(tool_calls=[tc_a, tc_b])
        resp_final = _make_mock_response(content="Готово")

        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[resp_with_two_tcs, resp_final],
        )
        mock_client_factory.return_value = mock_client

        result = await orch.run(message_id="test-msg-id", conversation_id="conv-1", user_message="два tool_call")

        assert "A" in call_order
        assert "B" in call_order
        assert call_order.index("A") < call_order.index("B"), (
            "tool_a должен исполниться до tool_b"
        )
        assert result["response"] == "Готово"

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_run_non_gigachat_executes_all_parallel(
        self, mock_client_factory, orchestrator,
    ):
        """Для не-GigaChat профилей все tool_calls исполняются в одном раунде."""
        call_order: list[str] = []

        async def handler_x(**kwargs):
            call_order.append("X")
            return "rx"

        async def handler_y(**kwargs):
            call_order.append("Y")
            return "ry"

        tool_x = ChatTool(name="tool_x", domain="test", description="X", handler=handler_x)
        tool_y = ChatTool(name="tool_y", domain="test", description="Y", handler=handler_y)
        register_tools([tool_x, tool_y])
        orchestrator._save_assistant_message = AsyncMock()

        tc_x = _make_tool_call(name="tool_x", arguments="{}", tc_id="tc-x")
        tc_y = _make_tool_call(name="tool_y", arguments="{}", tc_id="tc-y")
        resp_with_two_tcs = _make_mock_response(tool_calls=[tc_x, tc_y])
        resp_final = _make_mock_response(content="Финал")

        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[resp_with_two_tcs, resp_final],
        )
        mock_client_factory.return_value = mock_client

        result = await orchestrator.run(message_id="test-msg-id", conversation_id="conv-1", user_message="параллельно")
        # Оба tool_call исполнены
        assert set(call_order) == {"X", "Y"}
        # LLM вызван дважды: 1 раз с tool_calls, 1 раз финальный
        assert mock_client.chat.completions.create.call_count == 2


# -------------------------------------------------------------------------
# 4.3.3 — Tool-loop exit на 2 одинаковых ошибках валидации
# -------------------------------------------------------------------------


class TestToolLoopExit:
    """При 2 подряд одинаковых ошибках валидации — break loop с error-блоком."""

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_run_exits_on_repeated_validation_error(
        self, mock_client_factory, orchestrator,
    ):
        """run() прерывает цикл при 2 одинаковых ValidationError подряд."""
        tool = ChatTool(
            name="strict",
            domain="test",
            description="Строгий",
            parameters=[
                ChatToolParam(
                    name="must", type="string", description="Обязательный", required=True,
                ),
            ],
            handler=AsyncMock(return_value="ok"),
        )
        register_tools([tool])
        orchestrator._save_assistant_message = AsyncMock()

        # LLM раз за разом не передаёт required-параметр
        tc_bad = _make_tool_call(name="strict", arguments="{}", tc_id="tc-bad")
        resp_bad = _make_mock_response(tool_calls=[tc_bad])

        mock_client = AsyncMock()
        # Отдаём бесконечно bad tool_call, чтобы проверить что loop breaks
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[resp_bad] * 10,
        )
        mock_client_factory.return_value = mock_client

        result = await orchestrator.run(
            message_id="test-msg-id",
            conversation_id="conv-1",
            user_message="вызови strict без параметра",
        )

        # LLM вызван НЕ 10 раз (loop вышел раньше)
        assert mock_client.chat.completions.create.call_count < 10
        # Возврат содержит ошибку
        assert result.get("status") == "error" or "strict" in result.get("response", "")

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_different_errors_do_not_trigger_early_exit(
        self, mock_client_factory, orchestrator,
    ):
        """Разные ошибки валидации не вызывают преждевременный выход из цикла."""
        call_count = 0

        async def handler_a(**kwargs):
            return "ok"

        # tool_a требует param_x, tool_b требует param_y
        tool_a = ChatTool(
            name="tool_diff_a",
            domain="test",
            description="A",
            parameters=[
                ChatToolParam(name="px", type="string", description="px", required=True),
            ],
            handler=handler_a,
        )
        tool_b = ChatTool(
            name="tool_diff_b",
            domain="test",
            description="B",
            parameters=[
                ChatToolParam(name="py", type="string", description="py", required=True),
            ],
            handler=handler_a,
        )
        register_tools([tool_a, tool_b])
        orchestrator._save_assistant_message = AsyncMock()
        orchestrator.settings.max_tool_rounds = 3

        # LLM чередует разные tools без параметров — разные ошибки
        tc_a = _make_tool_call(name="tool_diff_a", arguments="{}", tc_id="tc-da")
        tc_b = _make_tool_call(name="tool_diff_b", arguments="{}", tc_id="tc-db")
        resp_a = _make_mock_response(tool_calls=[tc_a])
        resp_b = _make_mock_response(tool_calls=[tc_b])
        resp_final = _make_mock_response(content="Финал после разных ошибок")

        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[resp_a, resp_b, resp_a, resp_final],
        )
        mock_client_factory.return_value = mock_client

        result = await orchestrator.run(
            message_id="test-msg-id",
            conversation_id="conv-1",
            user_message="чередуй ошибки",
        )
        # Не упал раньше max_tool_rounds из-за разных ошибок
        assert mock_client.chat.completions.create.call_count >= 3


# -------------------------------------------------------------------------
# agent_mode: фильтрация forward-тула и bus-форвард в adaptive-режиме
# -------------------------------------------------------------------------


class TestAgentModeForward:
    """Тесты adaptive-форварда через bus-канал в non-streaming agent_loop."""

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_off_mode_filters_forward_tool(
        self, mock_client_factory, orchestrator,
    ):
        """В режиме off forward-тул не передаётся LLM."""
        from app.core.chat.names import TOOL_FORWARD_TO_KNOWLEDGE_AGENT

        # Регистрируем forward-тул
        forward_tool = ChatTool(
            name=TOOL_FORWARD_TO_KNOWLEDGE_AGENT,
            domain="chat",
            description="Форвард к агенту знаний",
            handler=AsyncMock(return_value="forwarded"),
        )
        register_tools([forward_tool])

        mock_client = AsyncMock()
        response = _make_mock_response(content="Ответ без форварда")
        mock_client.chat.completions.create = AsyncMock(return_value=response)
        mock_client_factory.return_value = mock_client
        orchestrator._save_assistant_message = AsyncMock()

        # Перехватываем вызов LLM, чтобы проверить переданные tools
        captured_tools: list = []

        original_create = mock_client.chat.completions.create

        async def capturing_create(**kwargs):
            captured_tools.extend(kwargs.get("tools", []))
            return await original_create(**kwargs)

        mock_client.chat.completions.create = capturing_create

        await orchestrator.run(
            message_id="msg-1",
            conversation_id="conv-1",
            user_message="Привет",
            agent_mode="off",
        )

        # Forward-тул НЕ должен быть в списке, переданном LLM
        tool_names = [t["function"]["name"] for t in captured_tools]
        assert TOOL_FORWARD_TO_KNOWLEDGE_AGENT not in tool_names

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_adaptive_mode_calls_channel_submit_and_poller(
        self, mock_client_factory, orchestrator,
    ):
        """В adaptive-режиме при tool_call forward → submit + poller.subscribe,
        _save_assistant_message НЕ вызван, результат содержит forwarded=True."""
        from app.core.chat.names import TOOL_FORWARD_TO_KNOWLEDGE_AGENT

        forward_tool = ChatTool(
            name=TOOL_FORWARD_TO_KNOWLEDGE_AGENT,
            domain="chat",
            description="Форвард к агенту знаний",
            handler=AsyncMock(return_value="forwarded"),
        )
        register_tools([forward_tool])

        mock_client = AsyncMock()
        tool_call = _make_tool_call(
            name=TOOL_FORWARD_TO_KNOWLEDGE_AGENT,
            arguments='{"question": "Что такое аудит?"}',
        )
        response_with_forward = _make_mock_response(
            content=None, tool_calls=[tool_call],
        )
        mock_client.chat.completions.create = AsyncMock(
            return_value=response_with_forward,
        )
        mock_client_factory.return_value = mock_client
        orchestrator._save_assistant_message = AsyncMock()

        mock_poller = MagicMock()
        mock_poller.subscribe = MagicMock()

        mock_channel = AsyncMock()
        mock_channel.submit = AsyncMock(return_value="question-uid-123")

        # Мокаем context-manager get_db и AgentChannelService.
        # Импорты в _handle_forward_terminal ленивые (внутри функции),
        # поэтому патчим источники, а не agent_loop.* атрибуты.
        mock_conn = AsyncMock()
        mock_db_ctx = AsyncMock()
        mock_db_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_db_ctx.__aexit__ = AsyncMock(return_value=False)

        with (
            patch(
                "app.db.connection.get_db",
                return_value=mock_db_ctx,
            ),
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService",
                return_value=mock_channel,
            ),
            patch(
                "app.domains.chat.deps.get_agent_channel_poller",
                return_value=mock_poller,
            ),
        ):
            result = await orchestrator.run(
                message_id="msg-forward-1",
                conversation_id="conv-1",
                user_message="Что такое аудит?",
                agent_mode="adaptive",
            )

        # submit вызван с правильными аргументами
        mock_channel.submit.assert_awaited_once()
        submit_kwargs = mock_channel.submit.await_args.kwargs
        assert submit_kwargs["assistant_message_id"] == "msg-forward-1"
        assert submit_kwargs["conversation_id"] == "conv-1"
        assert submit_kwargs["mode"] == "adaptive"
        assert submit_kwargs["text"] == "Что такое аудит?"

        # poller.subscribe вызван
        mock_poller.subscribe.assert_called_once_with(
            assistant_message_id="msg-forward-1",
            question_uid="question-uid-123",
        )

        # _save_assistant_message НЕ должен быть вызван (draft создан submit'ом)
        orchestrator._save_assistant_message.assert_not_awaited()

        # Результат содержит forwarded=True
        assert result.get("forwarded") is True
        assert result["response"] == ""
        assert TOOL_FORWARD_TO_KNOWLEDGE_AGENT in result["sources"]

    @patch("app.domains.chat.services.orchestrator.Orchestrator._get_openai_client")
    async def test_adaptive_mode_poller_none_saves_error_no_forward(
        self, mock_client_factory, orchestrator, caplog,
    ):
        """Если poller не инициализирован — НЕ создаём осиротевший draft: форвард
        не выполняется, сохраняется error-сообщение, логируется ERROR."""
        import logging as _logging
        from app.core.chat.names import TOOL_FORWARD_TO_KNOWLEDGE_AGENT

        forward_tool = ChatTool(
            name=TOOL_FORWARD_TO_KNOWLEDGE_AGENT,
            domain="chat",
            description="Форвард к агенту знаний",
            handler=AsyncMock(return_value="forwarded"),
        )
        register_tools([forward_tool])

        mock_client = AsyncMock()
        tool_call = _make_tool_call(
            name=TOOL_FORWARD_TO_KNOWLEDGE_AGENT,
            arguments="{}",
        )
        response_with_forward = _make_mock_response(
            content=None, tool_calls=[tool_call],
        )
        mock_client.chat.completions.create = AsyncMock(
            return_value=response_with_forward,
        )
        mock_client_factory.return_value = mock_client
        orchestrator._save_assistant_message = AsyncMock()

        mock_channel = AsyncMock()
        mock_channel.submit = AsyncMock(return_value="q-uid-456")

        mock_conn = AsyncMock()
        mock_db_ctx = AsyncMock()
        mock_db_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_db_ctx.__aexit__ = AsyncMock(return_value=False)

        with (
            patch(
                "app.db.connection.get_db",
                return_value=mock_db_ctx,
            ),
            patch(
                "app.domains.chat.services.agent_channel.AgentChannelService",
                return_value=mock_channel,
            ),
            patch(
                "app.domains.chat.deps.get_agent_channel_poller",
                return_value=None,
            ),
            caplog.at_level(_logging.ERROR),
        ):
            result = await orchestrator.run(
                message_id="msg-no-poller",
                conversation_id="conv-1",
                user_message="Вопрос",
                agent_mode="adaptive",
            )

        # Форвард НЕ выполнен (нет осиротевшего draft'а в bus/streaming).
        assert result.get("forwarded") is not True
        assert mock_channel.submit.await_count == 0
        # Вместо форварда сохранено финализированное error-сообщение.
        orchestrator._save_assistant_message.assert_awaited()
        # ERROR залогирован.
        assert any(
            "не инициализирован" in r.getMessage()
            for r in caplog.records
            if r.levelname == "ERROR"
        )
