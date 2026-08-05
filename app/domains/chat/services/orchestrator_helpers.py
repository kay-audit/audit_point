"""Хелперы оркестратора чата.

Module-level функции и константы, общие для веток ``Orchestrator``
(run / non-streaming GigaChat). Жили в
``orchestrator.py`` — вынесены сюда, чтобы:

* уменьшить размер оркестратора (~2.4 тыс. строк → ~2.1 тыс.);
* собрать в одном месте «защитные» преобразования, которые читаются
  одинаково в трёх зеркальных ветках (``_safe_args``, ``_convert_param``);
* системные промпты и нейтральные текстовые шаблоны не путались с
  бизнес-логикой потоков.

Любой импорт из ``orchestrator.py`` должен делать ``from .orchestrator_helpers
import ...`` — это единственный публичный путь.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.core.chat.names import TOOL_FORWARD_TO_KNOWLEDGE_AGENT
from app.core.chat.tools import to_wire_name


# Нейтральное сообщение для tool-результата при ChatToolValidationError —
# попадает в messages[], НЕ показывается пользователю напрямую.
TOOL_VALIDATION_NEUTRAL_MESSAGE = (
    "Не удалось выполнить инструмент. Попробуйте переформулировать запрос."
)


# Порог выхода из tool-loop'а: столько одинаковых ChatToolValidationError'ов
# подряд для одного tool'а → прерываем цикл и финализируем сообщение
# ошибкой. Жил локально в agent_loop как «магическая» 2.
TOOL_VALIDATION_LOOP_THRESHOLD = 2


@dataclass
class ToolValidationTracker:
    """Считает повторяющиеся ChatToolValidationError'ы tool-loop'а.

    Ключ повторения — пара ``(error_message, tool_name)``: охватывает класс
    ошибки + имя параметра + имя инструмента. При двух подряд одинаковых
    ошибках ``should_exit`` становится True — оркестратор финализирует
    сообщение ошибкой и завершает цикл (см. зеркальные ветки в
    ``agent_loop.run_agent_loop``).

    Инстанс на одну итерацию ``run``: создаётся локально,
    не шарится между запросами.
    """

    _last_key: tuple[str, str] | None = field(default=None)
    _consecutive: int = field(default=0)

    def track(self, error_message: str, tool_name: str) -> int:
        """Регистрирует очередную validation-ошибку, возвращает счётчик."""
        key = (error_message, tool_name)
        if self._last_key == key:
            self._consecutive += 1
        else:
            self._last_key = key
            self._consecutive = 1
        return self._consecutive

    def reset(self) -> None:
        """Успешный tool-вызов — сбрасываем счётчик."""
        self._last_key = None
        self._consecutive = 0

    @property
    def consecutive(self) -> int:
        return self._consecutive

    @property
    def should_exit(self) -> bool:
        return self._consecutive >= TOOL_VALIDATION_LOOP_THRESHOLD


def build_tool_loop_exit_answer(tool_name: str) -> str:
    """Текст ErrorBlock'а при выходе из tool-loop'а по validation-петле."""
    return (
        f"Модель не смогла корректно вызвать инструмент "
        f"`{tool_name}`. Перефразируйте запрос."
    )


def unpack_pending_tool_call(tc: Any) -> tuple[str, str, Any]:
    """Распаковывает элемент очереди ``pending_tool_calls``.

    Очередь GigaChat-ветки может содержать три формы tool_call:

    * dict ``{"name", "id", "arguments"}`` — собранный из стрима tool_call;
    * Pydantic ``ChatCompletionMessageToolCall`` — кладёт ``agent_loop``
      (имя/args через ``.function``);
    * плоский ``FinalizedToolCall`` из ``ToolCallAccumulator`` (на случай
      повторной перекладки) — поля ``.name`` / ``.id`` / ``.arguments``.

    Возвращает ``(tool_name, tool_call_id, raw_arguments)`` — последнее
    значение пригодно для ``safe_args(...)`` и ``json.loads(...)``.
    """
    if isinstance(tc, dict):
        return tc["name"], tc["id"], tc.get("arguments") or ""
    func = getattr(tc, "function", None)
    if func is not None:
        return func.name, tc.id, func.arguments
    return tc.name, tc.id, tc.arguments


# Базовый system-prompt оркестратора. Дописывается per-domain-промптами в
# ``Orchestrator._build_system_messages``.
#
# Инструменты в прозе называются проводными именами (``to_wire_name``) — теми
# же, что в схеме tools[]. Иначе модель зовёт tool именем из промпта, и оно
# не совпадает со схемой.
BASE_SYSTEM_PROMPT = (
    "Ты — ассистент в AuditWorkstation.\n\n"
    "ВАЖНОЕ ПРАВИЛО ПРИОРИТЕТА:\n"
    "По умолчанию любые вопросы пользователя про данные, контент, акты, "
    "нормативы, регламенты, фактуры, нарушения, метрики, реестры — "
    f"передавай через {to_wire_name(TOOL_FORWARD_TO_KNOWLEDGE_AGENT)}. "
    "Внешний агент сам найдёт информацию.\n\n"
    "Локальные action-tools (open_*, navigate_*, notify, ...) — вызывай "
    "ТОЛЬКО когда пользователь явно просит что-то сделать в интерфейсе "
    "(\"открой\", \"создай\", \"перейди\", \"покажи на странице\").\n\n"
    "Не сочиняй данные из БЗ — всегда передавай вопрос внешнему агенту."
)


def safe_args(raw: Any) -> str:
    """Возвращает arguments tool_call'а как непустую JSON-строку.

    SDK и streaming-аккумулятор отдают ``arguments=""`` для вызовов без
    параметров (LLM не эмитит delta аргументов). При эхо такой пустой
    строки в следующий LLM-вызов:

    * Qwen/SGLang chat-template: ``json.loads("")`` → 400 «zero-length
      empty doc».
    * GigaChat-proxy: 422 ``RequestInputValidationException``.

    Возвращаем ``"{}"`` — корректный пустой JSON-объект.
    """
    if isinstance(raw, str) and raw:
        return raw
    return "{}"


def convert_param(value: Any, param_type: str) -> Any:
    """Конвертация значения параметра из JSON в Python-тип."""
    if value is None:
        return None
    if param_type == "boolean":
        if isinstance(value, bool):
            return value
        return str(value).lower() in ("true", "1")
    if param_type == "integer":
        return int(value)
    if param_type == "date":
        if isinstance(value, str):
            return date.fromisoformat(value)
        return value
    if param_type == "string":
        return str(value)
    return value
