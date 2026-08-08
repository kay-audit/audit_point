"""Адаптер OpenAI ↔ native GigaChat REST.

GigaChat-proxy частично OpenAI-совместим:
- Streaming не поддерживается (422 EventException).
- Tools передаются как плоский `functions=[{name,description,parameters}]`,
  без OpenAI-обёртки `{type:"function", function:{...}}`.
- Ответ содержит `message.function_call: {name, arguments}` (singular),
  где arguments — dict, а не JSON-строка.

Адаптер скрывает эту разницу: внешне ведёт себя как AsyncOpenAI,
внутри переводит формат запроса/ответа на лету.
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletion
from openai.types.chat.chat_completion_message_tool_call import (
    ChatCompletionMessageToolCall,
    Function,
)

logger = logging.getLogger(
    "audit_workstation.domains.chat.services.gigachat_adapter",
)

# Module-level гард: warning о streaming показываем один раз на процесс.
# Оркестратор уже форсирует non-streaming для gigachat (orchestrator.py:899),
# поэтому штатно сюда stream=True не попадает; если попадёт — конфиг-баг,
# и спам по логам на каждый раунд не нужен.
_streaming_warning_emitted = False


def _is_tools_provided(tools: Any) -> bool:
    """Устойчивая проверка наличия tools: ни None, ни NOT_GIVEN, ни пусто.

    bool(NOT_GIVEN) хрупкий: на разных версиях SDK поведение менялось.
    Сравнение по identity (``is``) + явный None даёт стабильный результат.
    """
    from openai import NOT_GIVEN

    if tools is None or tools is NOT_GIVEN:
        return False
    return bool(tools)


class _Completions:
    """Прокси над `AsyncOpenAI.chat.completions`, переводящий формат."""

    def __init__(self, underlying: AsyncOpenAI) -> None:
        self._underlying = underlying

    async def create(self, **kwargs: Any):
        """Переводит OpenAI-style kwargs в native GigaChat и обратно.

        Игнорирует stream=True (GigaChat-proxy не поддерживает SSE).
        Дропает tool_choice (нет полной поддержки в proxy).
        """
        global _streaming_warning_emitted

        if kwargs.pop("stream", False) and not _streaming_warning_emitted:
            logger.warning(
                "GigaChat-proxy не поддерживает streaming; "
                "выполняется non-streaming запрос. "
                "(Сообщение показывается один раз на процесс.)",
            )
            _streaming_warning_emitted = True
        kwargs.pop("tool_choice", None)

        tools = kwargs.pop("tools", None)
        if _is_tools_provided(tools):
            functions = _tools_to_functions(tools)
            extra = dict(kwargs.pop("extra_body", None) or {})
            extra["functions"] = functions
            kwargs["extra_body"] = extra

        messages = kwargs.pop("messages", [])
        kwargs["messages"] = _translate_messages(messages)

        resp = await self._underlying.chat.completions.create(**kwargs)
        return _translate_response(resp)


class _Chat:
    def __init__(self, underlying: AsyncOpenAI) -> None:
        self.completions = _Completions(underlying)


class GigaChatAdapterClient:
    """Duck-typed обёртка над AsyncOpenAI для GigaChat-proxy."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        default_headers: dict[str, str] | None = None,
        timeout: float | int = 60.0,
    ) -> None:
        self._underlying = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
            default_headers=dict(default_headers or {}),
            timeout=timeout,
        )
        self.chat = _Chat(self._underlying)

    @property
    def base_url(self):
        """Проксируем base_url, чтобы тесты могли его проверять."""
        return self._underlying.base_url

    @property
    def models(self):
        """Прокси models для health probe — ping через GET /models на underlying-клиенте."""
        return self._underlying.models


def _args_to_dict(raw: Any) -> dict:
    """Приводит arguments к dict для native GigaChat request-формата.

    OpenAI хранит arguments как JSON-строку, GigaChat — как dict.
    На пути ответа `_translate_response` делает dict→str. На пути запроса
    (echo предыдущего function_call в history) делаем обратное str→dict.
    GigaChat-proxy валидирует request-схему строго: string в поле arguments
    даёт 422 RequestInputValidationException.

    Битый JSON / пустая строка / None → {} (no-args вызов).
    """
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _msg_to_dict(msg: Any) -> dict:
    """Pydantic-объект openai SDK → dict. dict → копия."""
    if isinstance(msg, dict):
        return dict(msg)
    if hasattr(msg, "model_dump"):
        return msg.model_dump(exclude_none=False)
    if hasattr(msg, "__dict__"):
        return dict(msg.__dict__)
    raise TypeError(
        f"GigaChat-адаптер: не умею сериализовать сообщение типа {type(msg)!r}",
    )


def _translate_messages(messages: list[Any]) -> list[dict]:
    """Переводит OpenAI-сообщения в native GigaChat-формат.

    - assistant с `tool_calls=[...]` → `function_call={name,arguments}` (первый).
    - tool-сообщение `{role:"tool", tool_call_id}` →
      `{role:"function", name:<из mapping предыдущих assistant>}`.
    - System/user/function — без изменений (копируются).
    """
    # Строим mapping tool_call_id → function_name из всей истории за один проход.
    id_to_name: dict[str, str] = {}
    for m in messages:
        md = _msg_to_dict(m)
        if md.get("role") != "assistant":
            continue
        tcs = md.get("tool_calls") or []
        for tc in tcs:
            tc_d = tc if isinstance(tc, dict) else _msg_to_dict(tc)
            tc_id = tc_d.get("id")
            fn = tc_d.get("function") or {}
            fn_d = fn if isinstance(fn, dict) else _msg_to_dict(fn)
            if tc_id and fn_d.get("name"):
                id_to_name[tc_id] = fn_d["name"]

    out: list[dict] = []
    for m in messages:
        md = _msg_to_dict(m)
        role = md.get("role")

        if role == "tool":
            tc_id = md.get("tool_call_id")
            name = id_to_name.get(tc_id) if tc_id else None
            if not name:
                logger.warning(
                    "GigaChat-адаптер: не нашли mapping для "
                    "tool_call_id=%r, использую 'unknown_function'",
                    tc_id,
                )
                name = "unknown_function"
            out.append({
                "role": "function",
                "name": name,
                "content": md.get("content") or "",
            })
            continue

        if role == "assistant" and md.get("tool_calls"):
            tcs = md["tool_calls"]
            if len(tcs) > 1:
                logger.warning(
                    "GigaChat поддерживает 1 function_call за раунд; "
                    "из %d параллельных tool_calls берётся первый",
                    len(tcs),
                )
            tc = tcs[0] if isinstance(tcs[0], dict) else _msg_to_dict(tcs[0])
            fn = tc.get("function") or {}
            fn_d = fn if isinstance(fn, dict) else _msg_to_dict(fn)
            # content="" (не None) — GigaChat-proxy отдаёт 422
            # RequestInputValidationException на null content
            # при наличии function_call. arguments в request-формате должен
            # быть DICT (нативная схема GigaChat), не JSON-string как в
            # OpenAI: proxy валидирует Pydantic-схему строго → 422 на string.
            new_msg = {
                "role": "assistant",
                "content": md.get("content") or "",
                "function_call": {
                    "name": fn_d.get("name", ""),
                    "arguments": _args_to_dict(fn_d.get("arguments")),
                },
            }
            out.append(new_msg)
            continue

        # Всё прочее — копия без поля tool_calls
        copy = {k: v for k, v in md.items() if k != "tool_calls"}
        out.append(copy)

    return out


def _tools_to_functions(tools: list[dict]) -> list[dict]:
    """Распаковывает OpenAI tools[] в native GigaChat functions[].

    Вход:  [{"type":"function","function":{"name","description","parameters"}}]
    Выход: [{"name","description","parameters"}]
    """
    out: list[dict] = []
    for tool in tools:
        if tool.get("type") != "function":
            raise ValueError(
                f"GigaChat-адаптер: ожидался type=function, получен "
                f"{tool.get('type')!r}",
            )
        fn = tool.get("function")
        if not fn:
            raise ValueError(
                "GigaChat-адаптер: отсутствует поле function в tool",
            )
        flat: dict = {"name": fn["name"]}
        if "description" in fn:
            flat["description"] = fn["description"]
        if "parameters" in fn:
            flat["parameters"] = fn["parameters"]
        out.append(flat)
    return out


def _translate_response(resp: ChatCompletion) -> ChatCompletion:
    """Синтезирует OpenAI-style tool_calls[] из native function_call.

    Если в ответе нет function_call — возвращает объект без изменений.
    Иначе мутирует resp.choices[0].message: добавляет tool_calls[], зануляет
    function_call, переводит finish_reason в "tool_calls".

    Аргументы конвертируются в JSON-строку (GigaChat отдаёт dict — OpenAI
    SDK ожидает строку).
    """
    if not resp.choices:
        return resp
    choice = resp.choices[0]
    fc = getattr(choice.message, "function_call", None)
    if fc is None:
        return resp

    args = fc.arguments
    if not isinstance(args, str):
        # default=str — защита от datetime/Decimal в args, согласовано с
        # orchestrator.py:1015 (там тоже default=str для tool_call args).
        args = json.dumps(args, ensure_ascii=False, default=str)

    synthetic_id = f"gc_{uuid.uuid4().hex[:12]}"
    tool_call = ChatCompletionMessageToolCall(
        id=synthetic_id,
        type="function",
        function=Function(name=fc.name, arguments=args),
    )

    # pydantic v2 модели в openai SDK 1.x mutable — патчим in-place.
    # Если когда-нибудь станут frozen — упадём с TypeError, тогда fallback на
    # ChatCompletion.model_construct.
    choice.message.tool_calls = [tool_call]
    choice.message.function_call = None
    choice.finish_reason = "tool_calls"
    return resp
