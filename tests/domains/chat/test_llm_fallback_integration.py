"""Тесты интеграции fallback-провайдера и circuit breaker в оркестратор."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from openai import APIConnectionError, APIStatusError
from pydantic import SecretStr

from app.core.chat.tools import reset as reset_tools
from app.core.domain_registry import reset_registry
from app.core.settings_registry import reset as reset_settings
from app.domains.chat.services import circuit_breaker, llm_client
from app.domains.chat.services.circuit_breaker import (
    STATE_OPEN,
    CircuitBreaker,
    set_breaker,
)
from app.domains.chat.services.orchestrator import Orchestrator
from app.domains.chat.settings import ChatDomainSettings, RetryPolicy


@pytest.fixture(autouse=True)
def _clean_state():
    reset_registry()
    reset_settings()
    reset_tools()
    circuit_breaker.reset_breaker()
    llm_client._clients_cache.clear()
    yield
    reset_registry()
    reset_settings()
    reset_tools()
    circuit_breaker.reset_breaker()
    llm_client._clients_cache.clear()


def _no_retry() -> RetryPolicy:
    # Отключаем retry, иначе 5xx крутится 5 раз до fallback'а и тесты тормозят
    return RetryPolicy(
        on_429=False, on_5xx=False, max_attempts=1, backoff_base_sec=0.0,
    )


def _settings_with_fallback(
    *,
    fallback_profile: str = "gigachat",
    failure_threshold: int = 2,
) -> ChatDomainSettings:
    return ChatDomainSettings(
        profile="openai",
        api_base="http://primary:8000/v1",
        api_key=SecretStr("primary-key"),
        model="primary-model",
        fallback_profile=fallback_profile,
        fallback_api_base="http://fallback:8000/v1",
        fallback_api_key=SecretStr("fallback-key"),
        fallback_model="fallback-model",
        circuit_breaker_failure_threshold=failure_threshold,
        circuit_breaker_recovery_timeout_sec=30,
        max_tool_rounds=2,
        tool_execution_timeout=5,
        retry=_no_retry(),
    )


def _settings_no_fallback() -> ChatDomainSettings:
    return ChatDomainSettings(
        profile="openai",
        api_base="http://primary:8000/v1",
        api_key=SecretStr("primary-key"),
        model="primary-model",
        circuit_breaker_failure_threshold=2,
        circuit_breaker_recovery_timeout_sec=30,
        max_tool_rounds=2,
        retry=_no_retry(),
    )


def _make_response(content: str = "Привет"):
    msg = MagicMock()
    msg.content = content
    msg.tool_calls = None
    choice = MagicMock()
    choice.message = msg
    choice.finish_reason = "stop"
    resp = MagicMock()
    resp.choices = [choice]
    resp.usage = None
    return resp


def _make_orchestrator(settings: ChatDomainSettings) -> Orchestrator:
    return Orchestrator(
        msg_service=AsyncMock(load_history_for_llm=AsyncMock(return_value=[])),
        conv_service=AsyncMock(),
        settings=settings,
    )


def _five_hundred_exc() -> APIStatusError:
    req = httpx.Request("POST", "http://x")
    return APIStatusError(
        message="boom", response=httpx.Response(503, request=req), body=None,
    )


def _four_hundred_exc() -> APIStatusError:
    req = httpx.Request("POST", "http://x")
    return APIStatusError(
        message="bad req",
        response=httpx.Response(400, request=req),
        body=None,
    )


# ---------------------------------------------------------------------------
# Базовая логика: primary успешен → fallback не зовётся
# ---------------------------------------------------------------------------


async def test_primary_succeeds_no_fallback():
    """Если primary возвращает ответ — fallback-клиент даже не создаётся."""
    settings = _settings_with_fallback()
    orch = _make_orchestrator(settings)
    orch._save_assistant_message = AsyncMock()

    primary = AsyncMock()
    primary.chat.completions.create = AsyncMock(return_value=_make_response("OK"))

    fallback_called = MagicMock()

    def _no_fallback(_s):
        fallback_called()
        return None

    with patch.object(orch, "_get_openai_client", return_value=primary), \
         patch.object(orch, "_get_fallback_client", side_effect=_no_fallback):
        result = await orch.run(
            message_id="test-msg-id",
            conversation_id="conv-1", user_message="привет",
        )

    assert result["response"] == "OK"
    primary.chat.completions.create.assert_awaited_once()
    fallback_called.assert_not_called()


# ---------------------------------------------------------------------------
# Primary 5xx → инкремент breaker'а, fallback дёргается
# ---------------------------------------------------------------------------


async def test_primary_5xx_triggers_fallback():
    """Primary упал 5xx — fallback клиент вызывается, breaker записал failure."""
    settings = _settings_with_fallback(failure_threshold=10)
    orch = _make_orchestrator(settings)
    orch._save_assistant_message = AsyncMock()

    primary = AsyncMock()
    # Один сбой 5xx
    primary.chat.completions.create = AsyncMock(side_effect=_five_hundred_exc())

    fallback = AsyncMock()
    fallback.chat.completions.create = AsyncMock(
        return_value=_make_response("Fallback answer"),
    )

    with patch.object(orch, "_get_openai_client", return_value=primary), \
         patch.object(orch, "_get_fallback_client", return_value=fallback):
        result = await orch.run(
            message_id="test-msg-id",
            conversation_id="conv-1", user_message="привет",
        )

    assert result["response"] == "Fallback answer"
    primary.chat.completions.create.assert_awaited_once()
    fallback.chat.completions.create.assert_awaited_once()
    breaker = orch._get_circuit_breaker()
    assert breaker.failure_count == 1


async def test_threshold_failures_open_circuit_then_skip_primary():
    """После N подряд сбоев circuit размыкается; следующий вызов идёт сразу
    на fallback, минуя primary."""
    settings = _settings_with_fallback(failure_threshold=2)
    orch = _make_orchestrator(settings)
    orch._save_assistant_message = AsyncMock()

    # Заранее размыкаем circuit, чтобы не возиться с N сбоями
    breaker = orch._get_circuit_breaker()
    # 2 подряд record_failure → state=open
    await breaker.record_failure(_five_hundred_exc())
    await breaker.record_failure(_five_hundred_exc())
    assert breaker.state == STATE_OPEN

    primary = AsyncMock()
    primary.chat.completions.create = AsyncMock(
        return_value=_make_response("primary should not be called"),
    )
    fallback = AsyncMock()
    fallback.chat.completions.create = AsyncMock(
        return_value=_make_response("from fallback"),
    )

    with patch.object(orch, "_get_openai_client", return_value=primary), \
         patch.object(orch, "_get_fallback_client", return_value=fallback):
        result = await orch.run(
            message_id="test-msg-id",
            conversation_id="conv-1", user_message="привет",
        )

    assert result["response"] == "from fallback"
    primary.chat.completions.create.assert_not_called()
    fallback.chat.completions.create.assert_awaited_once()


# ---------------------------------------------------------------------------
# 4xx — НЕ считается сбоем primary; fallback не зовётся
# ---------------------------------------------------------------------------


async def test_4xx_does_not_trigger_fallback():
    """400 от primary прокидывается без попыток fallback'а и не трогает breaker."""
    settings = _settings_with_fallback(failure_threshold=2)
    orch = _make_orchestrator(settings)
    orch._save_assistant_message = AsyncMock()

    primary = AsyncMock()
    primary.chat.completions.create = AsyncMock(side_effect=_four_hundred_exc())

    fallback = AsyncMock()
    fallback.chat.completions.create = AsyncMock(
        return_value=_make_response("should-not-run"),
    )

    with patch.object(orch, "_get_openai_client", return_value=primary), \
         patch.object(orch, "_get_fallback_client", return_value=fallback):
        result = await orch.run(
            message_id="test-msg-id",
            conversation_id="conv-1", user_message="hi",
        )

    # Оркестратор ловит общий Exception и возвращает status=error
    assert result.get("status") == "error"
    primary.chat.completions.create.assert_awaited_once()
    fallback.chat.completions.create.assert_not_called()
    breaker = orch._get_circuit_breaker()
    assert breaker.failure_count == 0


# ---------------------------------------------------------------------------
# Когда fallback не настроен — провайдер-failure пробрасывается дальше
# ---------------------------------------------------------------------------


async def test_no_fallback_propagates_provider_failure():
    settings = _settings_no_fallback()
    orch = _make_orchestrator(settings)
    orch._save_assistant_message = AsyncMock()

    primary = AsyncMock()
    primary.chat.completions.create = AsyncMock(side_effect=_five_hundred_exc())

    with patch.object(orch, "_get_openai_client", return_value=primary):
        result = await orch.run(
            message_id="test-msg-id",
            conversation_id="conv-1", user_message="hi",
        )

    assert result.get("status") == "error"
    breaker = orch._get_circuit_breaker()
    # Без fallback breaker всё равно учитывает сбои (для будущих probe)
    assert breaker.failure_count == 1


# ---------------------------------------------------------------------------
# Fallback=gigachat форсирует non-streaming
# ---------------------------------------------------------------------------


def test_adjust_kwargs_for_fallback_strips_stream_for_gigachat():
    settings = _settings_with_fallback(fallback_profile="gigachat")
    orch = _make_orchestrator(settings)
    kwargs = {
        "model": "primary-model",
        "messages": [{"role": "user", "content": "x"}],
        "stream": True,
    }
    out = orch._adjust_kwargs_for_fallback(kwargs, force_non_streaming=True)
    assert "stream" not in out
    # И model подменена на fallback_model
    assert out["model"] == "fallback-model"


def test_adjust_kwargs_for_fallback_keeps_stream_for_non_gigachat():
    settings = _settings_with_fallback(fallback_profile="openai")
    orch = _make_orchestrator(settings)
    kwargs = {
        "model": "primary-model",
        "messages": [{"role": "user", "content": "x"}],
        "stream": True,
    }
    out = orch._adjust_kwargs_for_fallback(kwargs, force_non_streaming=False)
    # Не-gigachat fallback — стрим остаётся
    assert out.get("stream") is True


async def test_fallback_gigachat_called_non_streaming():
    """При сбое primary fallback=gigachat вызывается БЕЗ stream=True."""
    settings = _settings_with_fallback(
        fallback_profile="gigachat", failure_threshold=10,
    )
    orch = _make_orchestrator(settings)
    orch._save_assistant_message = AsyncMock()

    primary = AsyncMock()
    primary.chat.completions.create = AsyncMock(
        side_effect=APIConnectionError(request=httpx.Request("POST", "http://x")),
    )
    fallback = AsyncMock()
    fallback.chat.completions.create = AsyncMock(
        return_value=_make_response("gc answer"),
    )

    with patch.object(orch, "_get_openai_client", return_value=primary), \
         patch.object(orch, "_get_fallback_client", return_value=fallback):
        result = await orch.run(
            message_id="test-msg-id",
            conversation_id="conv-1", user_message="hi",
        )

    # Fallback вызван без stream=True
    assert fallback.chat.completions.create.await_count >= 1
    for call in fallback.chat.completions.create.await_args_list:
        kwargs = call.kwargs
        assert kwargs.get("stream") in (False, None), (
            f"GigaChat fallback не должен вызываться со stream=True: {kwargs}"
        )
    # Что-то отдалось клиенту
    assert "gc answer" in result.get("response", "")
