"""Исполнение одного ChatTool: валидация параметров, таймаут, метрики.

Логика жила в ``Orchestrator._execute_tool_call`` (~90 строк). Вынесена
сюда отдельной свободной async-функцией, принимающей ссылку на оркестратор:
из ``orch`` берутся ``settings.tool_execution_timeout`` и ``_record_tool_metric``
(тесты могут патчить метрики через DI-фабрику).

В классе ``Orchestrator`` остаётся 1-строковый wrapper ``_execute_tool_call`` —
тесты массово зовут ``orchestrator._execute_tool_call(...)`` напрямую.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import time
import uuid
from typing import TYPE_CHECKING

from app.core.chat.tools import get_tool
from app.domains.chat.exceptions import ChatToolValidationError
from app.domains.chat.services.orchestrator_helpers import (
    convert_param as _convert_param,
)

if TYPE_CHECKING:
    from app.domains.chat.services.orchestrator import Orchestrator

logger = logging.getLogger("audit_workstation.domains.chat.tool_executor")


# Контекстная переменная с username текущего запроса.
# Оркестратор выставляет её перед каждым вызовом tool-handler'а
# (см. execute_tool_call ниже) — handler'ы, которым нужен контекст
# пользователя (например, acts.create_act — нужно знать, кто создаёт акт),
# читают её через get_current_chat_user(). Это позволяет не менять
# сигнатуру handler'ов и оставаться совместимым с уже зарегистрированными
# ChatTool-инструментами.
_current_chat_user_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_chat_user", default=None,
)


def get_current_chat_user() -> str | None:
    """Username текущего запроса, выставленный оркестратором.

    Возвращает None вне контекста chat-сессии (например, при вызове handler-а
    из фоновой задачи или из тестов).
    """
    return _current_chat_user_var.get()


async def execute_tool_call(
    orch: "Orchestrator", tool_name: str, arguments: dict,
) -> str:
    """Выполняет один вызов ChatTool и возвращает результат как строку.

    Бросает ``ChatToolValidationError`` при отсутствии required-параметра —
    оркестратор перехватывает и формирует нейтральный tool_error-блок без
    сырого текста для пользователя. На любую другую ошибку handler'а возвращает
    «error_id»-сообщение (детали проглатываются, идут в лог).
    """
    chat_tool = get_tool(tool_name)
    if chat_tool is None:
        return f"Ошибка: инструмент '{tool_name}' не найден"
    if chat_tool.handler is None:
        return f"Ошибка: инструмент '{tool_name}' не имеет обработчика"

    # Валидация обязательных параметров. Если LLM не передал required-параметр,
    # дальше нельзя — handler упадёт с TypeError или вернёт мусор.
    # Кидаем доменное исключение, его ловит agent_loop и возвращает
    # нейтральный tool_error (без сырого текста для пользователя).
    for param in chat_tool.parameters:
        if param.required and param.name not in arguments:
            err_msg = (
                f"Tool {tool_name}: отсутствует обязательный "
                f"параметр {param.name}"
            )
            # Метрика валидации фиксируется до raise (latency=0 — handler
            # ещё не запускался). Это нужно для observability таких
            # случаев в отдельном статусе.
            await orch._record_tool_metric(
                tool_name=tool_name,
                status="validation_error",
                latency_ms=0,
                error_message=err_msg[:1000],
            )
            raise ChatToolValidationError(err_msg)

    # Конвертация типов параметров
    param_types = {p.name: p.type for p in chat_tool.parameters}
    converted_args = {}
    for key, value in arguments.items():
        if key in param_types:
            converted_args[key] = _convert_param(value, param_types[key])

    timeout = orch.settings.tool_execution_timeout
    started = time.perf_counter()
    status = "success"
    error_message: str | None = None
    # Пробрасываем username в handler через ContextVar, чтобы tool мог
    # идентифицировать автора действия (например, acts.create_act пишет
    # created_by = <этот username>). Сбрасываем обратно в finally.
    user_token = _current_chat_user_var.set(getattr(orch, "_current_user_id", None))
    try:
        result = await asyncio.wait_for(
            chat_tool.handler(**converted_args),
            timeout=timeout,
        )
        if isinstance(result, dict):
            out = json.dumps(result, ensure_ascii=False, default=str)
        else:
            out = str(result)
        preview = out[:200] + "..." if len(out) > 200 else out
        logger.info(
            "Tool result: %s, длина=%d, preview=%s",
            tool_name, len(out), preview,
        )
        return out
    except asyncio.TimeoutError:
        status = "error"
        error_message = f"timeout {timeout}s"
        logger.warning(
            "Таймаут выполнения ChatTool %s (%dс)", tool_name, timeout,
        )
        return f"Ошибка: таймаут выполнения инструмента '{tool_name}'"
    except Exception as exc:
        status = "error"
        error_message = str(exc)[:1000]
        # Никаких деталей exception в выходе LLM: stack trace, имена БД,
        # SQL-фрагменты и пр. могут содержать чувствительные данные.
        # Полный stack логируем под error_id; LLM получает нейтральный
        # текст с этим id для трассировки администратором.
        error_id = str(uuid.uuid4())[:8]
        logger.exception(
            "Ошибка выполнения tool=%s error_id=%s",
            tool_name, error_id,
        )
        return (
            f"Инструмент завершился с ошибкой. error_id={error_id}. "
            "Сообщите администратору."
        )
    finally:
        _current_chat_user_var.reset(user_token)
        latency_ms = int((time.perf_counter() - started) * 1000)
        await orch._record_tool_metric(
            tool_name=tool_name,
            status=status,
            latency_ms=latency_ms,
            error_message=error_message,
        )
