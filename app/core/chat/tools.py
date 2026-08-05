"""
Реестр ChatTool для AI-ассистента.

Каждый домен регистрирует свои инструменты (ChatTool) при обнаружении.
Endpoint чата собирает все инструменты и передаёт их LLM
в формате OpenAI function-calling.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

logger = logging.getLogger("audit_workstation.core.chat_tools")


# ── Проводные имена инструментов ──
#
# Имена ChatTool доменные, с точкой ("acts.open_act_page"). Спека OpenAI
# ограничивает имя function шаблоном ^[a-zA-Z0-9_-]{1,128}$; sglang и
# GigaChat его не проверяют, а Anthropic (в т.ч. через OpenRouter) проверяет
# строго и отвечает 400 "tools.0.custom.name: String should match pattern".
#
# Поэтому на провод (схема tools[] и эхо tool_calls в истории) уходит
# «проводное» имя — точка заменена подчёркиванием. Внутри приложения имя
# остаётся каноническим: ключ реестра, tool_name в метриках и action_id
# кнопок внешнего агента не меняются. Преобразование безусловное для всех
# провайдеров: подчёркивание принимают все, развилка по профилю не нужна.

_WIRE_UNSAFE_RE = re.compile(r"[^a-zA-Z0-9_-]")


def to_wire_name(name: str) -> str:
    """Каноническое имя ChatTool → имя для передачи провайдеру."""
    return _WIRE_UNSAFE_RE.sub("_", name)


def resolve_wire_name(wire: str) -> str:
    """Имя из ответа провайдера → каноническое имя ChatTool.

    Каноническое имя (модель могла назвать tool с точкой, увидев его в
    прозе промпта) возвращается как есть. Незарегистрированное имя тоже
    возвращается без изменений — «инструмент не найден» отработает выше.
    """
    if wire in _tools:
        return wire
    for name in _tools:
        if to_wire_name(name) == wire:
            return name
    return wire


@dataclass(frozen=True)
class ChatToolParam:
    """Параметр инструмента чата (маппится на JSON Schema property)."""

    name: str
    type: str  # "string", "integer", "boolean", "array", "object", "date"
    description: str
    required: bool = True
    default: Any = None
    enum: list[str] | None = None
    items_type: str = "string"  # тип элементов для type="array"


@dataclass(frozen=True)
class ChatTool:
    """
    Инструмент домена для AI-чата.

    Маппится на OpenAI function-calling формат:
    {
        "type": "function",
        "function": {
            "name": self.name,
            "description": self.description,
            "parameters": { ... из self.parameters ... }
        }
    }
    """

    name: str
    domain: str
    description: str
    parameters: list[ChatToolParam] = field(default_factory=list)
    handler: Callable[..., Awaitable[str]] | None = field(default=None)
    # True — handler намеренно None, оркестратор строит его per-request
    # (например, forward к внешнему агенту нуждается в conn/conversation_id).
    # Подавляет startup-warning и сигнализирует «handler не утечка, а контракт».
    per_request_handler: bool = False
    category: str = ""
    # Транслятор кнопки: принимает params серверной кнопки (action_id=имя tool'а),
    # возвращает {"action": <client-action-id>, "params": {...}} или None
    # (если транслировать нечего — кнопка передаётся как есть).
    button_translator: (
        Callable[[dict], Awaitable[dict | None]] | None
    ) = field(default=None)

    def to_openai_tool(self) -> dict:
        """Конвертация в OpenAI function-calling формат."""
        properties = {}
        required = []
        for p in self.parameters:
            # "date" → JSON Schema "string" с format "date"
            schema_type = "string" if p.type == "date" else p.type
            prop: dict[str, Any] = {"type": schema_type, "description": p.description}
            if p.type == "date":
                prop["format"] = "date"
            if p.enum:
                prop["enum"] = p.enum
            if p.default is not None:
                prop["default"] = p.default
            if schema_type == "array":
                prop["items"] = {"type": p.items_type}
            properties[p.name] = prop
            if p.required:
                required.append(p.name)

        return {
            "type": "function",
            "function": {
                # Провайдеру уходит проводное имя (см. to_wire_name):
                # доменная точка не проходит валидацию Anthropic.
                "name": to_wire_name(self.name),
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                    "additionalProperties": False,
                },
            },
        }


# ── Реестр ──

_tools: dict[str, ChatTool] = {}


def register_tools(tools: list[ChatTool]) -> None:
    """Регистрация инструментов домена (вызывается из domain_registry)."""
    for tool in tools:
        if tool.name in _tools:
            raise RuntimeError(
                f"ChatTool '{tool.name}' уже зарегистрирован "
                f"доменом '{_tools[tool.name].domain}'"
            )
        wire = to_wire_name(tool.name)
        clash = next(
            (n for n in _tools if to_wire_name(n) == wire), None,
        )
        if clash is not None:
            raise RuntimeError(
                f"ChatTool '{tool.name}' даёт то же проводное имя '{wire}', "
                f"что и '{clash}' — LLM не различит их"
            )
        if tool.handler is None and not tool.per_request_handler:
            logger.warning(
                "ChatTool '%s' (домен '%s') зарегистрирован без handler — "
                "вызов инструмента LLM вернёт ошибку",
                tool.name, tool.domain,
            )
        _tools[tool.name] = tool
        logger.debug("Зарегистрирован ChatTool: %s", tool.name)


def get_all_tools() -> list[ChatTool]:
    """Все зарегистрированные инструменты."""
    return list(_tools.values())


def get_tool(name: str) -> ChatTool | None:
    """Инструмент по имени."""
    return _tools.get(name)


def get_tools_by_domain(domain: str) -> list[ChatTool]:
    """Все инструменты конкретного домена."""
    return [t for t in _tools.values() if t.domain == domain]


def get_openai_tools() -> list[dict]:
    """Все инструменты в OpenAI function-calling формате."""
    return [t.to_openai_tool() for t in _tools.values()]


def reset() -> None:
    """Для тестов."""
    _tools.clear()
