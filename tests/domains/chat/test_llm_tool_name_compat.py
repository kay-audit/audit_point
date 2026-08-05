"""Совместимость имён ChatTool с провайдерами, валидирующими имя tool'а.

Anthropic (в т.ч. через OpenRouter) проверяет имя инструмента по шаблону
OpenAI-спеки ``^[a-zA-Z0-9_-]{1,128}$`` и отвечает 400
``tools.0.custom.name: String should match pattern`` на доменные имена с
точкой (``acts.open_act_page``). sglang/GigaChat шаблон не проверяли, поэтому
до подключения Anthropic-моделей проблема не проявлялась.

Контракт: на провод (схема tools[], эхо tool_calls в истории) уходит
«проводное» имя без точки, внутри приложения остаётся каноническое
(реестр, метрики, ``action_id`` кнопок внешнего агента).
"""
from __future__ import annotations

import re
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import SecretStr

from app.core.chat.names import (
    TOOL_FORWARD_TO_KNOWLEDGE_AGENT,
    TOOL_LIST_PAGES,
    TOOL_OPEN_ACT_PAGE,
)
from app.core.chat.tools import (
    ChatTool,
    get_openai_tools,
    register_tools,
    reset as reset_tools,
    resolve_wire_name,
    to_wire_name,
)
from app.core.domain_registry import reset_registry
from app.core.settings_registry import reset as reset_settings
from app.domains.chat.services.forward_tool_factory import (
    build_forward_tool_descriptor,
)
from app.domains.chat.services.orchestrator import Orchestrator
from app.domains.chat.settings import ChatDomainSettings

# Шаблон имени tool'а из OpenAI-спеки; его же валидирует Anthropic.
PROVIDER_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")

# Доменное имя с точкой в прозе промпта/описания: «chat.list_pages» и т.п.
DOTTED_MENTION_RE = re.compile(
    r"\b(?:chat|acts|admin|ck_fin_res|ck_client_exp)\.[a-z_]{3,}",
)


@pytest.fixture(autouse=True)
def _clean_state():
    reset_registry()
    reset_settings()
    reset_tools()
    yield
    reset_registry()
    reset_settings()
    reset_tools()


def _settings(**overrides) -> ChatDomainSettings:
    base = dict(
        profile="openrouter",
        api_base="http://llm/v1",
        api_key=SecretStr("k"),
        model="anthropic/claude-sonnet-4.6",
        max_tool_rounds=5,
        tool_execution_timeout=5,
        temperature=0.0,
    )
    base.update(overrides)
    return ChatDomainSettings(**base)


def _make_tc(name: str, tc_id: str, arguments: str = "{}"):
    func = MagicMock()
    func.name = name
    func.arguments = arguments
    tc = MagicMock()
    tc.id = tc_id
    tc.function = func
    return tc


def _make_response(*, content=None, tool_calls=None):
    msg = MagicMock()
    msg.content = content
    msg.tool_calls = tool_calls
    choice = MagicMock()
    choice.message = msg
    choice.finish_reason = "tool_calls" if tool_calls else "stop"
    resp = MagicMock()
    resp.choices = [choice]
    resp.usage = None
    return resp


def _make_orch(**overrides) -> Orchestrator:
    orch = Orchestrator(
        msg_service=AsyncMock(load_history_for_llm=AsyncMock(return_value=[])),
        conv_service=AsyncMock(),
        settings=_settings(**overrides),
    )
    orch._save_assistant_message = AsyncMock()
    return orch


# ── Схема tools[] ────────────────────────────────────────────────────────────


class TestWireSchema:

    def test_real_tool_names_pass_provider_pattern(self):
        """Имена реальных доменных tool'ов уходят на провод без точки."""
        register_tools([
            build_forward_tool_descriptor(),
            ChatTool(name=TOOL_OPEN_ACT_PAGE, domain="acts", description="d"),
            ChatTool(name=TOOL_LIST_PAGES, domain="chat", description="d"),
        ])
        names = [t["function"]["name"] for t in get_openai_tools()]
        assert names, "реестр пуст — тест бесполезен"
        for name in names:
            assert PROVIDER_NAME_RE.match(name), (
                f"имя '{name}' не пройдёт валидацию провайдера"
            )

    def test_wire_name_is_reversible(self):
        register_tools([
            ChatTool(name=TOOL_OPEN_ACT_PAGE, domain="acts", description="d"),
        ])
        wire = to_wire_name(TOOL_OPEN_ACT_PAGE)
        assert wire != TOOL_OPEN_ACT_PAGE
        assert resolve_wire_name(wire) == TOOL_OPEN_ACT_PAGE

    def test_canonical_name_resolves_to_itself(self):
        """Модель может назвать tool каноническим именем — тоже принимаем."""
        register_tools([
            ChatTool(name=TOOL_OPEN_ACT_PAGE, domain="acts", description="d"),
        ])
        assert resolve_wire_name(TOOL_OPEN_ACT_PAGE) == TOOL_OPEN_ACT_PAGE

    def test_unknown_name_passes_through(self):
        """Незарегистрированное имя не подменяется — executor вернёт «не найден»."""
        assert resolve_wire_name("nonexistent_tool") == "nonexistent_tool"

    def test_wire_name_collision_rejected(self):
        """Два tool'а, схлопывающихся в одно проводное имя, — ошибка старта."""
        register_tools([ChatTool(name="chat.list_pages", domain="chat", description="d")])
        with pytest.raises(RuntimeError, match="проводн"):
            register_tools([
                ChatTool(name="chat_list_pages", domain="other", description="d"),
            ])


# ── Agent loop ───────────────────────────────────────────────────────────────


class TestAgentLoopWireNames:

    async def test_tool_call_by_wire_name_executes_canonical_tool(self):
        """Провайдер вернул проводное имя — исполняется канонический tool."""
        calls: list[dict] = []

        async def handler(**kwargs):
            calls.append(dict(kwargs))
            return "ok"

        register_tools([
            ChatTool(
                name=TOOL_LIST_PAGES, domain="chat", description="d",
                handler=handler,
            ),
        ])

        orch = _make_orch()
        first = _make_response(
            tool_calls=[_make_tc(to_wire_name(TOOL_LIST_PAGES), "id-1")],
        )
        final = _make_response(content="готово")
        client = AsyncMock()
        client.chat.completions.create = AsyncMock(side_effect=[first, final])
        orch._get_openai_client = MagicMock(return_value=client)

        result = await orch.run(
            conversation_id="c1", user_message="что умеешь?", message_id="m1",
        )

        assert calls == [{}], "handler канонического tool'а не был вызван"
        assert result["sources"] == [TOOL_LIST_PAGES]

    async def test_echoed_tool_call_name_stays_provider_safe(self):
        """Эхо tool_call в истории тоже без точки (Anthropic валидирует и его)."""
        async def handler(**kwargs):
            return "ok"

        register_tools([
            ChatTool(
                name=TOOL_LIST_PAGES, domain="chat", description="d",
                handler=handler,
            ),
        ])

        orch = _make_orch()
        # Модель «списала» имя с точкой из промпта — эхо должно быть очищено.
        first = _make_response(tool_calls=[_make_tc(TOOL_LIST_PAGES, "id-1")])
        final = _make_response(content="готово")
        client = AsyncMock()
        client.chat.completions.create = AsyncMock(side_effect=[first, final])
        orch._get_openai_client = MagicMock(return_value=client)

        await orch.run(
            conversation_id="c1", user_message="что умеешь?", message_id="m1",
        )

        second_call = client.chat.completions.create.await_args_list[1]
        echoed = [
            tc["function"]["name"]
            for msg in second_call.kwargs["messages"]
            if msg.get("role") == "assistant" and msg.get("tool_calls")
            for tc in msg["tool_calls"]
        ]
        assert echoed, "эхо assistant-сообщения с tool_calls не найдено"
        for name in echoed:
            assert PROVIDER_NAME_RE.match(name), f"эхо '{name}' сломает запрос"

    async def test_forward_tool_hidden_when_mode_not_adaptive(self):
        """Фильтр forward-тула работает и с проводными именами схемы."""
        register_tools([
            build_forward_tool_descriptor(),
            ChatTool(name=TOOL_LIST_PAGES, domain="chat", description="d"),
        ])

        orch = _make_orch()
        client = AsyncMock()
        client.chat.completions.create = AsyncMock(
            return_value=_make_response(content="ответ"),
        )
        orch._get_openai_client = MagicMock(return_value=client)

        await orch.run(
            conversation_id="c1", user_message="привет", message_id="m1",
            agent_mode="off",
        )

        sent = client.chat.completions.create.await_args.kwargs["tools"]
        sent_names = [t["function"]["name"] for t in sent]
        assert to_wire_name(TOOL_FORWARD_TO_KNOWLEDGE_AGENT) not in sent_names
        assert TOOL_FORWARD_TO_KNOWLEDGE_AGENT not in sent_names
        assert to_wire_name(TOOL_LIST_PAGES) in sent_names

    async def test_forward_tool_intercepted_by_wire_name(self):
        """Форвард перехватывается, когда провайдер зовёт проводное имя."""
        register_tools([build_forward_tool_descriptor()])

        orch = _make_orch()
        first = _make_response(tool_calls=[
            _make_tc(
                to_wire_name(TOOL_FORWARD_TO_KNOWLEDGE_AGENT), "id-1",
                arguments='{"question": "как считается метрика?"}',
            ),
        ])
        client = AsyncMock()
        client.chat.completions.create = AsyncMock(return_value=first)
        orch._get_openai_client = MagicMock(return_value=client)

        # Поллер не инициализирован → терминальная ветка отдаёт error-блок,
        # но факт перехвата подтверждает: до _execute_tool_call не дошло.
        result = await orch.run(
            conversation_id="c1", user_message="как считается метрика?",
            message_id="m1", agent_mode="adaptive",
        )

        assert result.get("status") != "error"
        blocks = orch._save_assistant_message.await_args.kwargs["content_blocks"]
        assert blocks[0]["code"] == "agent_unavailable"


# ── Промпты ──────────────────────────────────────────────────────────────────


class TestPromptsUseWireNames:

    def test_system_prompt_has_no_dotted_tool_names(self):
        """Промпт называет tool'ы так же, как схема, — иначе модель путается."""
        orch = _make_orch()
        prompt = orch._build_system_messages(domains=None)[0]["content"]
        assert not DOTTED_MENTION_RE.findall(prompt)
        assert to_wire_name(TOOL_FORWARD_TO_KNOWLEDGE_AGENT) in prompt

    def test_tool_descriptions_have_no_dotted_tool_names(self):
        """Описания tool'ов — тоже часть промпта."""
        from app.domains.acts.integrations.chat_tools import get_chat_tools

        for tool in [*get_chat_tools(), build_forward_tool_descriptor()]:
            assert not DOTTED_MENTION_RE.findall(tool.description), (
                f"описание '{tool.name}' ссылается на tool с точкой"
            )
