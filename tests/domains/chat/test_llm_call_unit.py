"""Unit-тесты для pure-функции ``call_llm_with_fallback``.

Модуль ``app.domains.chat.services.llm_call`` извлечён из оркестратора и
принимает ссылку на ``Orchestrator`` (зависимости — методы класса). Здесь
мы тестируем функцию в изоляции — без поднятия полного оркестратора,
без построения messages/history — на минимальной заглушке.

Существующее E2E-покрытие (см. ``test_llm_fallback_integration.py``)
проверяет интеграцию с оркестратором; эти тесты — точечные регрессии
на ветки самой ``call_llm_with_fallback``.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.domains.chat.exceptions import ChatLLMUnavailableError
from app.domains.chat.services.llm_call import call_llm_with_fallback
from app.domains.chat.services.orchestrator import Orchestrator
from app.domains.chat.settings import ChatDomainSettings


def _http_settings(
    *, has_fallback: bool, fallback_profile: str = "gigachat",
) -> ChatDomainSettings:
    """Настройки с HTTP-маршрутами: планировщик не ходит в Redis.

    Доступность маршрута теперь определяется настройками (``plan_routes``),
    а не флагом ``_has_fallback``, поэтому заглушке нужны настоящие
    ``ChatDomainSettings``. HTTP-маршруты выбраны намеренно: их доступность
    = «сконфигурирован», без обращения к heartbeat'у воркера — тесты
    остаются чистыми unit-тестами.
    """
    return ChatDomainSettings(
        profile="openai",
        api_base="http://primary:8000/v1",
        api_key="primary-key",
        fallback_profile=fallback_profile if has_fallback else None,
        fallback_api_base="http://fallback:8000/v1" if has_fallback else None,
        fallback_api_key="fallback-key" if has_fallback else None,
    )


def _make_orch_stub(
    *,
    has_fallback: bool = False,
    breaker_open: bool = False,
    is_provider_failure_result: bool = True,
    fallback_client=None,
    fallback_profile: str = "gigachat",
):
    """Минимальная заглушка оркестратора для ``call_llm_with_fallback``.

    Не используем ``Orchestrator`` чтобы не тянуть build_llm_client,
    settings_registry и прочую тяжёлую обвязку. Дюк-тайпинг работает —
    кроме ``settings``: их читает планировщик маршрутов, поэтому они
    настоящие.
    """
    orch = MagicMock()

    breaker = MagicMock()
    breaker.is_open = AsyncMock(return_value=breaker_open)
    breaker.record_failure = AsyncMock()
    breaker.record_success = AsyncMock()
    orch._get_circuit_breaker = MagicMock(return_value=breaker)

    orch._get_fallback_client = MagicMock(return_value=fallback_client)
    orch._is_provider_failure = MagicMock(return_value=is_provider_failure_result)
    orch._adjust_kwargs_for_fallback = MagicMock(
        side_effect=lambda kw, *, force_non_streaming: {**kw},
    )
    orch._completions_create = AsyncMock()

    orch.settings = _http_settings(
        has_fallback=has_fallback, fallback_profile=fallback_profile,
    )

    return orch, breaker


# ---------------------------------------------------------------------------
# Happy-path: primary успешен → record_success, fallback_used=False
# ---------------------------------------------------------------------------


async def test_primary_success_records_success_and_returns_primary_client():
    """Успешный primary: ``fallback_used=False``, breaker.record_success вызван,
    fallback-клиент НЕ запрашивается."""
    primary = MagicMock(name="primary")
    expected = MagicMock(name="response")
    orch, breaker = _make_orch_stub(has_fallback=True)
    orch._completions_create = AsyncMock(return_value=expected)

    result, fb_used, active = await call_llm_with_fallback(
        orch, primary, model="m", messages=[],
    )

    assert result is expected
    assert fb_used is False
    assert active is primary
    breaker.record_success.assert_awaited_once()
    breaker.record_failure.assert_not_awaited()
    # Fallback fast-path не должен трогать fallback-клиент при closed breaker
    orch._get_fallback_client.assert_not_called()


# ---------------------------------------------------------------------------
# Breaker open + fallback есть → fast-path, primary даже не дёргаем
# ---------------------------------------------------------------------------


async def test_breaker_open_with_fallback_skips_primary_fast_path():
    """При разомкнутом breaker и сконфигурированном fallback — primary
    не вызывается вовсе; вызов сразу идёт в fallback."""
    primary = MagicMock(name="primary")
    fb = MagicMock(name="fb")
    expected = MagicMock(name="response")

    orch, breaker = _make_orch_stub(
        has_fallback=True, breaker_open=True, fallback_client=fb,
    )
    orch._completions_create = AsyncMock(return_value=expected)

    result, fb_used, active = await call_llm_with_fallback(
        orch, primary, force_non_streaming=True, model="m",
    )

    assert result is expected
    assert fb_used is True
    assert active is fb
    # primary не вызывался — _completions_create вызывался один раз и для fb
    orch._completions_create.assert_awaited_once()
    called_client = orch._completions_create.await_args.args[0]
    assert called_client is fb
    # record_failure НЕ должен инкрементиться: тут не было сбоя
    breaker.record_failure.assert_not_awaited()
    # record_success тоже не зовём в fast-path: primary не пробовали
    breaker.record_success.assert_not_awaited()
    # _adjust_kwargs_for_fallback должен быть вызван с force_non_streaming=True
    orch._adjust_kwargs_for_fallback.assert_called_once()
    assert (
        orch._adjust_kwargs_for_fallback.call_args.kwargs["force_non_streaming"]
        is True
    )


async def test_breaker_open_but_fallback_client_none_falls_through_to_primary():
    """Если breaker open и ``_has_fallback`` True, но ``_get_fallback_client``
    вернул None — fast-path не срабатывает, идём в обычную try-ветку primary."""
    primary = MagicMock(name="primary")
    expected = MagicMock(name="response")
    orch, breaker = _make_orch_stub(
        has_fallback=True, breaker_open=True, fallback_client=None,
    )
    orch._completions_create = AsyncMock(return_value=expected)

    result, fb_used, active = await call_llm_with_fallback(
        orch, primary, model="m",
    )

    assert result is expected
    assert fb_used is False
    assert active is primary
    breaker.record_success.assert_awaited_once()


async def test_breaker_open_no_fallback_configured_uses_primary():
    """Breaker open + fallback не сконфигурирован → primary всё равно
    вызывается; fast-path требует наличия fallback."""
    primary = MagicMock(name="primary")
    expected = MagicMock(name="response")
    orch, breaker = _make_orch_stub(has_fallback=False, breaker_open=True)
    orch._completions_create = AsyncMock(return_value=expected)

    result, fb_used, active = await call_llm_with_fallback(orch, primary)

    assert result is expected
    assert fb_used is False
    assert active is primary
    # Fallback-клиент даже не запрашивали
    orch._get_fallback_client.assert_not_called()


# ---------------------------------------------------------------------------
# Provider-failure: инкремент breaker'а и переключение на fallback
# ---------------------------------------------------------------------------


async def test_provider_failure_with_fallback_switches_to_fallback():
    """Primary бросает provider-failure → record_failure, затем fallback;
    итог ``fallback_used=True``, активный клиент — fallback."""
    primary = MagicMock(name="primary")
    fb = MagicMock(name="fb")
    expected_fb = MagicMock(name="fb-response")
    orch, breaker = _make_orch_stub(
        has_fallback=True,
        is_provider_failure_result=True,
        fallback_client=fb,
    )
    # Первый вызов (primary) — exception; второй (fallback) — успех
    orch._completions_create = AsyncMock(
        side_effect=[RuntimeError("primary boom"), expected_fb],
    )

    result, fb_used, active = await call_llm_with_fallback(orch, primary)

    assert result is expected_fb
    assert fb_used is True
    assert active is fb
    breaker.record_failure.assert_awaited_once()
    # record_success НЕ должен вызываться (primary не успешен)
    breaker.record_success.assert_not_awaited()
    assert orch._completions_create.await_count == 2


async def test_provider_failure_no_fallback_reraises_exception():
    """Если fallback не сконфигурирован — provider-failure от primary
    пробрасывается дальше после ``record_failure``."""
    primary = MagicMock(name="primary")
    boom = RuntimeError("primary down")
    orch, breaker = _make_orch_stub(
        has_fallback=False, is_provider_failure_result=True,
    )
    orch._completions_create = AsyncMock(side_effect=boom)

    with pytest.raises(RuntimeError, match="primary down"):
        await call_llm_with_fallback(orch, primary)

    breaker.record_failure.assert_awaited_once()
    breaker.record_success.assert_not_awaited()


async def test_provider_failure_with_fallback_but_client_none_reraises():
    """``_has_fallback`` True, но ``_get_fallback_client`` отдал None
    (например, нет API-ключа в момент построения) — exception пробрасывается."""
    primary = MagicMock(name="primary")
    boom = ConnectionError("net")
    orch, breaker = _make_orch_stub(
        has_fallback=True,
        is_provider_failure_result=True,
        fallback_client=None,
    )
    orch._completions_create = AsyncMock(side_effect=boom)

    with pytest.raises(ConnectionError, match="net"):
        await call_llm_with_fallback(orch, primary)

    breaker.record_failure.assert_awaited_once()


# ---------------------------------------------------------------------------
# Non-provider failure (4xx, ValueError) — НЕ запускает fallback
# ---------------------------------------------------------------------------


async def test_non_provider_failure_reraises_without_breaker_increment():
    """Не-provider-исключение (4xx/ValueError) — НЕ пишет breaker.record_failure,
    fallback не вызывается, exception проброшен наверх."""
    primary = MagicMock(name="primary")
    fb = MagicMock(name="fb")
    orch, breaker = _make_orch_stub(
        has_fallback=True,
        is_provider_failure_result=False,
        fallback_client=fb,
    )
    boom = ValueError("client-side")
    orch._completions_create = AsyncMock(side_effect=boom)

    with pytest.raises(ValueError, match="client-side"):
        await call_llm_with_fallback(orch, primary)

    breaker.record_failure.assert_not_awaited()
    breaker.record_success.assert_not_awaited()
    # Fallback не должен вызываться при клиентских ошибках
    assert orch._completions_create.await_count == 1


# ---------------------------------------------------------------------------
# force_non_streaming прокидывается в _adjust_kwargs_for_fallback
# ---------------------------------------------------------------------------


async def test_force_non_streaming_propagated_to_adjust_kwargs_in_fallback():
    """При fallback на provider-failure флаг ``force_non_streaming`` должен
    дойти до ``_adjust_kwargs_for_fallback`` без потерь."""
    primary = MagicMock(name="primary")
    fb = MagicMock(name="fb")
    expected_fb = MagicMock(name="fb-response")
    orch, _ = _make_orch_stub(
        has_fallback=True,
        is_provider_failure_result=True,
        fallback_client=fb,
    )
    orch._completions_create = AsyncMock(
        side_effect=[RuntimeError("primary"), expected_fb],
    )

    await call_llm_with_fallback(
        orch, primary, force_non_streaming=True, stream=True, model="m",
    )

    orch._adjust_kwargs_for_fallback.assert_called_once()
    call_kwargs = orch._adjust_kwargs_for_fallback.call_args
    assert call_kwargs.kwargs["force_non_streaming"] is True
    # Первый позиционный — переданные kwargs (содержат stream=True, model)
    passed = call_kwargs.args[0]
    assert passed.get("stream") is True
    assert passed.get("model") == "m"


async def test_default_force_non_streaming_is_false():
    """Если ``force_non_streaming`` не задан явно — в ``_adjust_kwargs_for_fallback``
    он передаётся как False (поведение по умолчанию)."""
    primary = MagicMock(name="primary")
    fb = MagicMock(name="fb")
    orch, _ = _make_orch_stub(
        has_fallback=True, breaker_open=True, fallback_client=fb,
    )
    orch._completions_create = AsyncMock(return_value=MagicMock())

    await call_llm_with_fallback(orch, primary)

    orch._adjust_kwargs_for_fallback.assert_called_once()
    assert (
        orch._adjust_kwargs_for_fallback.call_args.kwargs["force_non_streaming"]
        is False
    )


# ---------------------------------------------------------------------------
# _has_fallback / _fallback_is_gigachat: маршруто-зависимая логика
# ---------------------------------------------------------------------------


def make_orchestrator(settings: ChatDomainSettings) -> Orchestrator:
    """Реальный Orchestrator с мок-сервисами — для тестов его собственных
    методов (``_has_fallback``, ``_fallback_is_gigachat``), а не pure-функции."""
    return Orchestrator(
        msg_service=AsyncMock(load_history_for_llm=AsyncMock(return_value=[])),
        conv_service=AsyncMock(),
        settings=settings,
    )


class TestRouteAwareFallback:
    def test_has_fallback_true_for_redis_route_without_api_base(self):
        settings = ChatDomainSettings(
            profile="redis-bridge,gigachat",
            fallback_profile="redis-bridge,openai",
        )
        orch = make_orchestrator(settings)
        assert orch._has_fallback() is True

    def test_has_fallback_false_for_http_route_without_api_base(self):
        settings = ChatDomainSettings(
            profile="openai", fallback_profile="gigachat",
        )
        orch = make_orchestrator(settings)
        assert orch._has_fallback() is False

    def test_fallback_is_gigachat_for_bridge_gigachat(self):
        settings = ChatDomainSettings(
            profile="openai", api_base="http://x", api_key="k",
            fallback_profile="redis-bridge,gigachat",
        )
        orch = make_orchestrator(settings)
        assert orch._fallback_is_gigachat() is True

    def test_fallback_is_gigachat_false_for_bridge_openai(self):
        settings = ChatDomainSettings(
            profile="openai", api_base="http://x", api_key="k",
            fallback_profile="redis-bridge,openai",
        )
        orch = make_orchestrator(settings)
        assert orch._fallback_is_gigachat() is False


# ---------------------------------------------------------------------------
# План маршрутов: работаем только с реально доступными
# ---------------------------------------------------------------------------


class TestRoutePlanDrivesTheCall:
    """Маршрут, которого нет, не пробуется; единственный живой — используется."""

    @staticmethod
    def _orch(settings: ChatDomainSettings, *, fallback_client=None):
        orch, breaker = _make_orch_stub(fallback_client=fallback_client)
        orch.settings = settings
        return orch, breaker

    async def test_no_available_routes_raises_llm_unavailable(self):
        """Primary не сконфигурирован, fallback не задан → запрос не уходит."""
        settings = ChatDomainSettings(profile="openai")  # ни api_base, ни ключа
        orch, breaker = self._orch(settings)

        with pytest.raises(ChatLLMUnavailableError):
            await call_llm_with_fallback(orch, MagicMock(name="primary"))

        orch._completions_create.assert_not_awaited()
        breaker.record_failure.assert_not_awaited()

    async def test_only_fallback_available_is_used_without_primary_failure(self):
        """Primary недоступен (нет ключа), fallback сконфигурирован — идём
        сразу на fallback: это не «сбой primary», а единственный живой маршрут,
        поэтому счётчик breaker'а не трогаем."""
        settings = ChatDomainSettings(
            profile="openai",                       # api_base/api_key пустые
            fallback_profile="gigachat",
            fallback_api_base="http://fallback:8000/v1",
            fallback_api_key="fallback-key",
        )
        fb = MagicMock(name="fb")
        expected = MagicMock(name="response")
        orch, breaker = self._orch(settings, fallback_client=fb)
        orch._completions_create = AsyncMock(return_value=expected)

        result, fb_used, active = await call_llm_with_fallback(
            orch, MagicMock(name="primary"),
        )

        assert result is expected
        assert fb_used is True
        assert active is fb
        orch._completions_create.assert_awaited_once()
        assert orch._completions_create.await_args.args[0] is fb
        breaker.record_failure.assert_not_awaited()
        breaker.record_success.assert_not_awaited()

    async def test_unavailable_fallback_is_not_tried_after_primary_failure(self):
        """Fallback не сконфигурирован как маршрут → после сбоя primary
        исключение пробрасывается, второй попытки нет."""
        settings = ChatDomainSettings(
            profile="openai",
            api_base="http://primary:8000/v1",
            api_key="primary-key",
            fallback_profile="gigachat",   # без FALLBACK_API_BASE/KEY — не маршрут
        )
        orch, breaker = self._orch(settings, fallback_client=MagicMock(name="fb"))
        orch._completions_create = AsyncMock(side_effect=RuntimeError("boom"))

        with pytest.raises(RuntimeError, match="boom"):
            await call_llm_with_fallback(orch, MagicMock(name="primary"))

        assert orch._completions_create.await_count == 1
        breaker.record_failure.assert_awaited_once()
