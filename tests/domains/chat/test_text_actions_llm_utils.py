"""Тесты нативных LLM-хелперов text-actions."""

from unittest.mock import AsyncMock

import pytest

from app.domains.chat.exceptions import TextActionUnavailableError
from app.domains.chat.services.text_actions import llm_utils as U


def test_strip_think_removes_reasoning():
    raw = "<think>рассуждаю тут\nи тут</think>\nИсправленный текст."
    assert U.strip_think(raw).strip() == "Исправленный текст."


def test_strip_think_noop_on_plain_text():
    assert U.strip_think("обычный текст") == "обычный текст"


def test_clean_text_response_strips_leading_preamble_label():
    # Anthropic вопреки запрету добавил ярлык отдельной строкой — срезаем.
    raw = "Исправленный текст:\n\nВ ходе проверки выявлено нарушение."
    assert U.clean_text_response(raw) == "В ходе проверки выявлено нарушение."


def test_clean_text_response_strips_readability_preamble():
    raw = "Вот улучшенный вариант:\nТекст стал яснее."
    assert U.clean_text_response(raw) == "Текст стал яснее."


def test_clean_text_response_unwraps_code_fence():
    raw = "```\nисправленный абзац\n```"
    assert U.clean_text_response(raw) == "исправленный абзац"


def test_clean_text_response_strips_think_and_preamble_together():
    raw = "<think>подумаю</think>\nИсправленный текст:\nГотово."
    assert U.clean_text_response(raw) == "Готово."


def test_clean_text_response_keeps_inline_label_as_real_content():
    # Ярлык БЕЗ перевода строки — это реальный текст (не преамбула), не трогаем.
    raw = "Исправленный текст: смотри приложение №3."
    assert U.clean_text_response(raw) == "Исправленный текст: смотри приложение №3."


def test_clean_text_response_noop_on_clean_text():
    assert U.clean_text_response("В акте установлено нарушение.") == "В акте установлено нарушение."


def test_extract_json_plain_object():
    assert U.extract_json('{"a": 1, "b": "x"}') == {"a": 1, "b": "x"}


def test_extract_json_ignores_prose_and_stray_braces_around():
    # Лишние скобки в прозе до и после JSON не ломают разбор.
    raw = 'Анализ {данных}: {"a": 1} см. {3}'
    assert U.extract_json(raw) == {"a": 1}


def test_extract_json_with_nested_braces():
    raw = 'Результат: {"outer": {"inner": [1, 2]}, "k": "v"} — конец.'
    assert U.extract_json(raw) == {"outer": {"inner": [1, 2]}, "k": "v"}


def test_extract_json_inside_code_fence():
    raw = 'Вот ответ:\n```json\n{"norm_doc": "п. 5", "essence": "суть"}\n```'
    assert U.extract_json(raw) == {"norm_doc": "п. 5", "essence": "суть"}


def test_extract_json_strips_think_before_parsing():
    raw = '<think>прикину структуру {x}</think>{"causes": ["c1"]}'
    assert U.extract_json(raw) == {"causes": ["c1"]}


def test_extract_json_raises_when_no_object():
    with pytest.raises(ValueError):
        U.extract_json("никакого json тут нет")


def test_extract_json_raises_on_broken_object():
    with pytest.raises(ValueError):
        U.extract_json('начало {"a": } конец')


async def test_run_text_call_returns_content_and_passes_params():
    client = AsyncMock()
    msg = AsyncMock()
    msg.content = "<think>ага</think>исправлено"
    resp = AsyncMock()
    resp.choices = [AsyncMock(message=msg)]
    client.chat.completions.create = AsyncMock(return_value=resp)

    out = await U.run_text_call(
        client, model="m", temperature=0.1, system="s", user="u",
        retry_call=lambda f: f, timeout=5.0, max_tokens=1024,
    )
    assert out == "исправлено"
    kwargs = client.chat.completions.create.call_args.kwargs
    assert kwargs["temperature"] == 0.1
    assert kwargs["stream"] is False
    assert kwargs["timeout"] == 5.0
    assert kwargs["max_tokens"] == 1024
    assert kwargs["messages"][0] == {"role": "system", "content": "s"}
    assert kwargs["messages"][1] == {"role": "user", "content": "u"}


def _resp(content: str, finish_reason=None):
    """Ответ LLM-клиента с заданным content и finish_reason."""
    msg = AsyncMock()
    msg.content = content
    choice = AsyncMock(message=msg)
    if finish_reason is not None:
        choice.finish_reason = finish_reason
    resp = AsyncMock()
    resp.choices = [choice]
    return resp


async def test_run_text_call_raises_on_length_finish_reason():
    """finish_reason='length' — ответ оборван, отдавать его пользователю нельзя."""
    client = AsyncMock()
    client.chat.completions.create = AsyncMock(
        return_value=_resp("начало текста, а дальше обрыв", finish_reason="length"),
    )

    with pytest.raises(TextActionUnavailableError):
        await U.run_text_call(
            client, model="m", temperature=0.1, system="s", user="u",
            retry_call=lambda f: f, timeout=5.0, max_tokens=16,
        )


async def test_run_json_call_raises_on_length_finish_reason():
    """Тот же обрыв в JSON-вызове: битый JSON не должен маскироваться под «пусто»."""
    client = AsyncMock()
    client.chat.completions.create = AsyncMock(
        return_value=_resp('{"essence": "нача', finish_reason="length"),
    )

    with pytest.raises(TextActionUnavailableError):
        await U.run_json_call(
            client, model="m", temperature=0.1, system="s", user="u",
            retry_call=lambda f: f, timeout=5.0, max_tokens=16,
        )


async def test_run_text_call_passes_through_normal_finish_reason():
    """finish_reason='stop' — обычный ответ, никаких ошибок."""
    client = AsyncMock()
    client.chat.completions.create = AsyncMock(
        return_value=_resp("готовый текст", finish_reason="stop"),
    )

    out = await U.run_text_call(
        client, model="m", temperature=0.1, system="s", user="u",
        retry_call=lambda f: f, timeout=5.0, max_tokens=512,
    )
    assert out == "готовый текст"
