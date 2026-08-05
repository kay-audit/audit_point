"""Тесты статического descriptor'а ChatTool ``chat.forward_to_knowledge_agent``.

Descriptor регистрируется при discover_domains() со ``handler=None`` и
``per_request_handler=True``; реальный перехват forward'а делает agent_loop
по имени тула (bus-канал ``chat_agent_messages_bus``).
"""
from __future__ import annotations

from app.core.chat.names import TOOL_FORWARD_TO_KNOWLEDGE_AGENT
from app.core.chat.tools import ChatTool
from app.domains.chat.services.forward_tool_factory import (
    build_forward_tool_descriptor,
)


def test_build_forward_tool_descriptor_no_handler():
    """Descriptor — handler=None, per_request_handler=True, имя из names.py."""
    tool = build_forward_tool_descriptor()
    assert isinstance(tool, ChatTool)
    assert tool.name == TOOL_FORWARD_TO_KNOWLEDGE_AGENT
    assert tool.handler is None
    assert tool.per_request_handler is True
    assert tool.domain == "chat"
    assert tool.category == "forward"


def test_build_forward_tool_descriptor_parameters():
    """Параметры — question (required) и kb_hint (optional)."""
    tool = build_forward_tool_descriptor()
    param_names = {p.name for p in tool.parameters}
    assert "question" in param_names
    assert "kb_hint" in param_names

    question = next(p for p in tool.parameters if p.name == "question")
    kb_hint = next(p for p in tool.parameters if p.name == "kb_hint")
    assert question.required is True
    assert kb_hint.required is False


def test_build_forward_tool_descriptor_to_openai_schema():
    """to_openai_tool() возвращает валидный function-calling-schema.

    В схему уходит проводное имя (без точки) — доменное имя с точкой не
    проходит валидацию Anthropic; см. ``tools.to_wire_name``.
    """
    from app.core.chat.tools import to_wire_name

    tool = build_forward_tool_descriptor()
    schema = tool.to_openai_tool()
    assert schema["type"] == "function"
    assert schema["function"]["name"] == to_wire_name(
        TOOL_FORWARD_TO_KNOWLEDGE_AGENT,
    )
    props = schema["function"]["parameters"]["properties"]
    assert "question" in props
    assert "kb_hint" in props
    assert "question" in schema["function"]["parameters"]["required"]
