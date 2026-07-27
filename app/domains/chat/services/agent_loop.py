"""Non-streaming agent loop оркестратора.

Логика жила в ``Orchestrator.run`` (~320 строк). Вынесена сюда отдельной
pure-функцией, принимающей ссылку на ``Orchestrator``: все зависимости
(LLM-вызов, tool executor, save_assistant_message, parse_*, build_*) —
методы класса, которые тесты могут патчить через ``patch.object`` / instance
assign. Pure-функция зовёт их через ``orch.``, поэтому существующие mock'и
продолжают работать.

В ``Orchestrator.run`` остаётся тонкий wrapper, который устанавливает
context-атрибуты (``_current_conversation_id`` / ``_current_user_id``) и
делегирует сюда.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any

from app.core.chat.block_id_generator import BlockIdGenerator
from app.core.chat.names import TOOL_FORWARD_TO_KNOWLEDGE_AGENT
from app.domains.chat.exceptions import ChatLimitError, ChatToolValidationError
from app.domains.chat.services.orchestrator_helpers import (
    TOOL_VALIDATION_NEUTRAL_MESSAGE,
    ToolValidationTracker,
    build_tool_loop_exit_answer,
    safe_args as _safe_args,
    unpack_pending_tool_call,
)

if TYPE_CHECKING:
    from app.domains.chat.services.orchestrator import Orchestrator

logger = logging.getLogger("audit_workstation.domains.chat.agent_loop")


async def _handle_forward_terminal(
    *,
    orch: "Orchestrator",
    conversation_id: str,
    user_message: str,
    message_id: str,
    user_id: str | None,
    file_blocks: list[dict] | None,
    arguments: dict,
    sources: list[str],
    token_usage: dict[str, Any],
) -> dict[str, Any]:
    """Терминальная обработка tool_call forward_to_knowledge_agent в bus-режиме.

    submit() создаёт draft-сообщение (create_streaming с message_id) и кладёт
    вопрос в bus-таблицу. Поллер подхватывает дальнейшее заполнение.
    _save_assistant_message НЕ вызывается — draft уже создан в submit().
    """
    question = arguments.get("question") or user_message

    from app.db.connection import get_db
    from app.domains.chat.deps import get_agent_channel_poller
    from app.domains.chat.services.agent_channel import AgentChannelService

    # Проверяем поллер ДО submit: без него draft завис бы в 'streaming' навсегда
    # (беседу нельзя было бы удалить). Не создаём осиротевший draft — отдаём
    # обычное error-сообщение через _save_assistant_message.
    poller = get_agent_channel_poller()
    if poller is None:
        logger.error(
            "agent_channel_poller не инициализирован — форвард недоступен "
            "(message_id=%s)",
            message_id,
        )
        await orch._save_assistant_message(
            conversation_id=conversation_id,
            content_blocks=[{
                "type": "error",
                "message": "Канал внешнего агента недоступен. Обратитесь к администратору.",
                "code": "agent_unavailable",
            }],
            token_usage=None,
            message_id=message_id,
        )
        return {
            "response": "",
            "sources": list(dict.fromkeys(sources)),
            "model": orch.settings.model,
            "token_usage": token_usage,
        }

    try:
        async with get_db() as conn:
            channel = AgentChannelService(conn, orch.settings)
            question_uid = await channel.submit(
                conversation_id=conversation_id,
                user_id=user_id or "",
                assistant_message_id=message_id,
                text=question,
                mode="adaptive",
                media=file_blocks or None,
            )
    except ChatLimitError as exc:
        logger.warning(
            "agent_channel: лимит параллельных запросов для user=%s, message_id=%s: %s",
            user_id,
            message_id,
            exc.message,
        )
        await orch._save_assistant_message(
            conversation_id=conversation_id,
            content_blocks=[{
                "type": "error",
                "message": exc.message,
                "code": "agent_limit",
            }],
            token_usage=None,
            message_id=message_id,
        )
        return {
            "response": exc.message,
            "sources": list(dict.fromkeys(sources)),
            "model": orch.settings.model,
            "token_usage": token_usage,
        }

    poller.subscribe(assistant_message_id=message_id, question_uid=question_uid)

    return {
        "response": "",
        "sources": list(dict.fromkeys(sources + [TOOL_FORWARD_TO_KNOWLEDGE_AGENT])),
        "model": orch.settings.model,
        "token_usage": token_usage,
        "forwarded": True,
    }


async def _collect_tool_blocks(
    orch: "Orchestrator",
    result: str,
    *,
    tool_name: str,
    block_id_gen: BlockIdGenerator,
    emitted_blocks: list[dict],
) -> str:
    """Извлекает презентационные блоки из результата tool'а.

    Если ``result`` — JSON client_action / buttons / список блоков, добавляет
    соответствующие блоки в ``emitted_blocks`` (они попадут в финальное
    сообщение ассистента) и возвращает краткий summary ``<выполнено: {tool}>``
    для скармливания LLM — иначе модель пересказывает содержимое блока обычным
    текстом (кнопки превращаются в «теги», client_action не исполняется).

    Если ``result`` — обычный текст, возвращает его без изменений.

    ``buttons``-блоки прогоняются через ``_translate_buttons``: серверные
    ``action_id`` (имена ChatTool, как в кнопках внешнего агента) переписываются
    в клиентские; уже-клиентские (``open_url`` из ``list_pages``) проходят
    как есть.
    """
    client_action = orch._parse_client_action_result(
        result, block_id_gen=block_id_gen,
    )
    blocks_list = (
        None if client_action is not None
        else orch._parse_blocks_list_result(result, block_id_gen=block_id_gen)
    )
    buttons_block = (
        None if (client_action is not None or blocks_list is not None)
        else orch._parse_buttons_result(result)
    )

    if client_action is not None:
        emitted_blocks.append(client_action)
    elif blocks_list is not None:
        for raw_block in blocks_list:
            if raw_block.get("type") == "buttons":
                translated = await orch._translate_buttons(
                    raw_block.get("buttons", []),
                )
                emitted_blocks.append(
                    {"type": "buttons", "buttons": translated},
                )
            else:
                emitted_blocks.append(raw_block)
    elif buttons_block is not None:
        translated = await orch._translate_buttons(
            buttons_block.get("buttons", []),
        )
        emitted_blocks.append({"type": "buttons", "buttons": translated})
    else:
        return result
    return f"<выполнено: {tool_name}>"


async def run_agent_loop(
    orch: "Orchestrator",
    *,
    conversation_id: str,
    user_message: str,
    message_id: str,
    domains: list[str] | None = None,
    file_blocks: list[dict] | None = None,
    user_id: str | None = None,
    agent_mode: str = "off",
) -> dict[str, Any]:
    """Полный (не стриминговый) agent loop.

    Возвращает dict с полями: response, sources, model, token_usage.
    На ошибку — dict с ``status="error"``.

    ``message_id`` обязателен и должен быть тем же id, что попадёт в БД
    через ``_save_assistant_message``: на нём строится детерминированный
    ``block_id`` ClientActionBlock (``f"{message_id}:client_action:{i}"``).

    ``agent_mode`` управляет доступностью forward-тула:
    - "adaptive" — forward-тул включён (LLM может его вызвать);
    - "off" и любое другое — forward-тул скрыт от LLM.
    """
    # Fallback при отсутствии настроек API
    if (
        not orch.settings.api_base
        or not orch.settings.api_key.get_secret_value()
    ):
        return orch._fallback_response(user_message)

    try:
        from openai import NOT_GIVEN
    except ImportError:
        logger.warning("Пакет openai не установлен, используется заглушка")
        return orch._fallback_response(user_message)

    client = orch._get_openai_client()
    tools = orch._get_tools(domains)

    # В режимах, отличных от "adaptive", forward-тул скрыт от LLM.
    if agent_mode != "adaptive":
        tools = [
            t for t in tools
            if t.get("function", {}).get("name") != TOOL_FORWARD_TO_KNOWLEDGE_AGENT
        ]

    # Собираем messages: system + history + текущее сообщение
    messages = await orch._build_system_messages(domains)
    history = await orch._get_history_messages(conversation_id)
    # Убираем последнее сообщение из истории — оно уже сохранено как user message,
    # но мы добавим его явно ниже
    if history and history[-1].get("role") == "user":
        history = history[:-1]
    messages.extend(history)

    user_content = await orch._build_user_content(
        user_message, file_blocks, conversation_id,
    )
    messages.append({"role": "user", "content": user_content})

    sources: list[str] = []
    token_usage: dict[str, Any] = {}
    # GigaChat поддерживает только 1 function_call за раунд. Если LLM
    # вернул >1 tool_call, первый исполняем сейчас, остальные — в очередь.
    pending_tool_calls: list[Any] = []
    is_gigachat = orch.settings.profile == "gigachat"
    validation_tracker = ToolValidationTracker()
    # Презентационные блоки (client_action / buttons / список), эмитнутые
    # tool'ами по ходу цикла — попадут в финальное сообщение ассистента.
    emitted_blocks: list[dict] = []
    block_id_gen = BlockIdGenerator(message_id)

    try:
        response, _fb_used, client = await orch._llm_call_with_fallback(
            client,
            model=orch.settings.model,
            messages=messages,
            tools=tools if tools else NOT_GIVEN,
            temperature=orch.settings.temperature,
        )
        if _fb_used and orch._fallback_is_gigachat():
            # После переключения на GigaChat — соблюдаем его ограничения
            is_gigachat = True

        # Agent loop
        rounds = 0
        while rounds < orch.settings.max_tool_rounds:
            # Если очередь GigaChat не пуста — берём следующий tool без LLM
            if pending_tool_calls:
                tc = pending_tool_calls.pop(0)
                tool_name, tc_id, raw_args = unpack_pending_tool_call(tc)
                try:
                    arguments = json.loads(_safe_args(raw_args))
                except json.JSONDecodeError:
                    arguments = {}
                logger.info(
                    "GigaChat queue tool call #%d: %s(%s)", rounds, tool_name,
                    ", ".join(f"{k}={v!r}" for k, v in arguments.items()),
                )
                if tool_name == TOOL_FORWARD_TO_KNOWLEDGE_AGENT:
                    return await _handle_forward_terminal(
                        orch=orch,
                        conversation_id=conversation_id,
                        user_message=user_message,
                        message_id=message_id,
                        user_id=user_id,
                        file_blocks=file_blocks,
                        arguments=arguments,
                        sources=sources,
                        token_usage=token_usage,
                    )
                try:
                    result = await orch._execute_tool_call(
                        tool_name, arguments,
                    )
                except ChatToolValidationError as exc:
                    logger.warning("Tool validation error: %s", exc.message)
                    result = TOOL_VALIDATION_NEUTRAL_MESSAGE
                sources.append(tool_name)
                llm_content = await _collect_tool_blocks(
                    orch, result, tool_name=tool_name,
                    block_id_gen=block_id_gen, emitted_blocks=emitted_blocks,
                )
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "content": llm_content,
                })
                rounds += 1
                if pending_tool_calls:
                    continue
                # Очередь опустела — вызываем LLM с обновлённой историей
                response, _fb_used, client = await orch._llm_call_with_fallback(
                    client,
                    model=orch.settings.model,
                    messages=messages,
                    tools=tools if tools else NOT_GIVEN,
                    temperature=orch.settings.temperature,
                )
                if _fb_used and orch._fallback_is_gigachat():
                    is_gigachat = True
                # Переходим к началу цикла: проверяем новый ответ LLM
                continue

            if not response.choices[0].message.tool_calls:
                break

            raw_msg = response.choices[0].message
            # Не передаём Pydantic-объект как есть: Qwen/SGLang и
            # GigaChat-proxy не принимают
            # null content при наличии tool_calls. По той же причине
            # arguments санитизируется через _safe_args (пустая строка
            # → "{}", иначе провайдеры ломают чат-template).
            assistant_msg = {
                "role": "assistant",
                "content": raw_msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": _safe_args(tc.function.arguments),
                        },
                    }
                    for tc in raw_msg.tool_calls
                ],
            }
            messages.append(assistant_msg)

            # GigaChat: ≤1 tool за раунд; лишние — в очередь
            if is_gigachat and len(raw_msg.tool_calls) > 1:
                logger.info(
                    "GigaChat: %d tool_calls → исполняем 1, %d в очередь",
                    len(raw_msg.tool_calls), len(raw_msg.tool_calls) - 1,
                )
                pending_tool_calls = list(raw_msg.tool_calls[1:])
            tcs_this_round = (
                raw_msg.tool_calls[:1] if is_gigachat else raw_msg.tool_calls
            )

            for tc in tcs_this_round:
                tool_name = tc.function.name
                try:
                    arguments = json.loads(_safe_args(tc.function.arguments))
                except json.JSONDecodeError:
                    arguments = {}

                logger.info(
                    "Tool call #%d: %s(%s)", rounds, tool_name,
                    ", ".join(f"{k}={v!r}" for k, v in arguments.items()),
                )
                if tool_name == TOOL_FORWARD_TO_KNOWLEDGE_AGENT:
                    return await _handle_forward_terminal(
                        orch=orch,
                        conversation_id=conversation_id,
                        user_message=user_message,
                        message_id=message_id,
                        user_id=user_id,
                        file_blocks=file_blocks,
                        arguments=arguments,
                        sources=sources,
                        token_usage=token_usage,
                    )
                try:
                    result = await orch._execute_tool_call(
                        tool_name, arguments,
                    )
                    validation_tracker.reset()
                except ChatToolValidationError as exc:
                    consecutive = validation_tracker.track(exc.message, tool_name)
                    logger.warning(
                        "Tool validation error: %s (consecutive=%d)",
                        exc.message, consecutive,
                    )
                    if validation_tracker.should_exit:
                        logger.warning(
                            "Tool-loop exit: 2 одинаковых ошибки валидации "
                            "подряд для tool=%s, прерываем цикл",
                            tool_name,
                        )
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": TOOL_VALIDATION_NEUTRAL_MESSAGE,
                        })
                        sources.append(tool_name)
                        error_answer = build_tool_loop_exit_answer(tool_name)
                        await orch._save_assistant_message(
                            conversation_id=conversation_id,
                            content_blocks=[
                                *emitted_blocks,
                                {
                                    "type": "error",
                                    "message": error_answer,
                                    "code": "tool_validation_loop",
                                },
                            ],
                            token_usage=None,
                            message_id=message_id,
                        )
                        return {
                            "response": error_answer,
                            "sources": list(dict.fromkeys(sources)),
                            "model": orch.settings.model,
                            "token_usage": token_usage,
                        }
                    result = TOOL_VALIDATION_NEUTRAL_MESSAGE
                sources.append(tool_name)

                llm_content = await _collect_tool_blocks(
                    orch, result, tool_name=tool_name,
                    block_id_gen=block_id_gen, emitted_blocks=emitted_blocks,
                )
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": llm_content,
                })

            rounds += 1
            # Если в очереди GigaChat ещё есть tool_call'ы — не зовём LLM,
            # переходим к следующей итерации, где очередь будет обработана.
            if pending_tool_calls:
                continue
            response, _fb_used, client = await orch._llm_call_with_fallback(
                client,
                model=orch.settings.model,
                messages=messages,
                tools=tools if tools else NOT_GIVEN,
                temperature=orch.settings.temperature,
            )
            if _fb_used and orch._fallback_is_gigachat():
                is_gigachat = True

        answer = (response.choices[0].message.content or "").lstrip("\n")

        if response.usage:
            token_usage = {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens,
            }

        # Сохраняем сообщение ассистента через свежее соединение из пула
        # (DI-соединение может быть закрыто при StreamingResponse).
        # Финал = презентационные блоки от tool'ов + финальный текст модели.
        # Текст добавляем, если он непустой ИЛИ блоков нет вовсе (не сохраняем
        # пустое сообщение).
        content_blocks = list(emitted_blocks)
        if answer or not content_blocks:
            content_blocks.append({"type": "text", "content": answer})
        await orch._save_assistant_message(
            conversation_id=conversation_id,
            content_blocks=content_blocks,
            token_usage=token_usage if token_usage else None,
            message_id=message_id,
        )

        return {
            "response": answer,
            "sources": list(dict.fromkeys(sources)),
            "model": orch.settings.model,
            "token_usage": token_usage,
        }

    except asyncio.TimeoutError:
        logger.warning(
            "LLM timeout",
            extra={
                "stage": "run",
                "model": orch.settings.model,
                "conversation_id": conversation_id,
            },
        )
        error_message = "Временная ошибка AI-сервиса. Попробуйте позже."
        try:
            await orch._save_assistant_message(
                conversation_id=conversation_id,
                content_blocks=[{
                    "type": "error",
                    "message": error_message,
                    "code": "llm_unavailable",
                }],
                token_usage=None,
                message_id=message_id,
            )
        except Exception:
            logger.exception(
                "Не удалось сохранить error-block ассистент-сообщения",
            )
        return {"response": error_message, "status": "error"}
    except Exception:
        logger.exception("Ошибка вызова LLM API")
        # Сохраняем ErrorBlock в историю: без этого при перезагрузке
        # страницы пользователь не увидит, что произошло — будет только
        # его user-message без ответа. Сырые детали (stack/код провайдера)
        # наружу не пробрасываем — только нейтральное сообщение.
        error_message = "Временная ошибка AI-сервиса. Попробуйте позже."
        try:
            await orch._save_assistant_message(
                conversation_id=conversation_id,
                content_blocks=[{
                    "type": "error",
                    "message": error_message,
                    "code": "llm_unavailable",
                }],
                token_usage=None,
                message_id=message_id,
            )
        except Exception:
            # save может упасть, если БД тоже недоступна — это не фатально,
            # ответ всё равно вернём.
            logger.exception(
                "Не удалось сохранить error-block ассистент-сообщения",
            )
        return {
            "response": error_message,
            "status": "error",
        }
