"""Тесты LLMHealthProbe.

Тестируется логика _tick (восстановление/провал пробы), отсутствие пинга в
closed-состоянии и идемпотентный/опциональный start().

Реальный _run/sleep не запускается — sleep инжектируется как AsyncMock,
client_factory отдаёт мок-клиент с client.models.list (AsyncMock либо
side_effect=Exception). Синглтон circuit breaker'а подменяется реальным
CircuitBreaker с FakeClock через set_breaker()/reset_breaker().
"""

import pytest
from unittest.mock import AsyncMock, MagicMock

from app.domains.chat.services.circuit_breaker import (
    STATE_CLOSED,
    STATE_OPEN,
    CircuitBreaker,
    reset_breaker,
    set_breaker,
)
from app.domains.chat.services.llm_health_probe import LLMHealthProbe
from app.domains.chat.settings import ChatDomainSettings


# ── Фикстуры / хелперы ─────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_breaker():
    """Сбрасывает синглтон breaker'а до и после каждого теста."""
    reset_breaker()
    yield
    reset_breaker()


class FakeClock:
    """Управляемые монотонные часы для breaker'а (без реального времени)."""

    def __init__(self, start: float = 0.0):
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


@pytest.fixture
def settings():
    return ChatDomainSettings()


def _install_breaker(*, clock=None):
    """Ставит реальный CircuitBreaker (external_recovery) синглтоном."""
    breaker = CircuitBreaker(
        failure_threshold=2,
        external_recovery=True,
        clock=clock or FakeClock(),
    )
    set_breaker(breaker)
    return breaker


async def _open_breaker(breaker: CircuitBreaker) -> None:
    """Доводит breaker до состояния open (2 подряд провала на пороге)."""
    await breaker.record_failure(RuntimeError("boom"))
    await breaker.record_failure(RuntimeError("boom"))


def _make_probe(settings, *, ping_ok=True):
    """Создаёт probe с инжектированными sleep (AsyncMock) и мок-клиентом."""
    client = MagicMock()
    if ping_ok:
        client.models.list = AsyncMock(return_value=MagicMock())
    else:
        client.models.list = AsyncMock(side_effect=Exception("primary down"))

    probe = LLMHealthProbe(
        settings,
        sleep=AsyncMock(),
        client_factory=lambda: client,
    )
    return probe, client


# ── _tick: восстановление ───────────────────────────────────────────────────────


class TestTickRecovers:

    async def test_open_plus_successful_ping_closes_breaker(self, settings):
        """OPEN + успешный ping → breaker закрыт, интервал сброшен в min."""
        breaker = _install_breaker()
        await _open_breaker(breaker)
        assert breaker.state == STATE_OPEN

        probe, client = _make_probe(settings, ping_ok=True)
        # Заведомо «раздуем» интервал, чтобы проверить сброс.
        probe._current_interval = 99.0

        await probe._tick()

        assert breaker.state == STATE_CLOSED
        assert probe._current_interval == settings.health_probe.poll_min_interval_sec
        assert probe._last_ping_ok is True
        client.models.list.assert_awaited_once()


# ── _tick: провал ───────────────────────────────────────────────────────────────


class TestTickFails:

    async def test_open_plus_failed_ping_stays_open_and_backs_off(self, settings):
        """OPEN + провальный ping → остаётся open, интервал вырос, last_ping_ok False."""
        breaker = _install_breaker()
        await _open_breaker(breaker)
        assert breaker.state == STATE_OPEN

        probe, client = _make_probe(settings, ping_ok=False)
        before = probe._current_interval

        await probe._tick()

        assert breaker.state == STATE_OPEN
        assert probe._last_ping_ok is False
        expected = min(
            before * settings.health_probe.poll_backoff_multiplier,
            settings.health_probe.poll_max_interval_sec,
        )
        assert probe._current_interval == expected
        assert probe._current_interval > before
        client.models.list.assert_awaited_once()


# ── _tick: closed — нечего пинговать ────────────────────────────────────────────


class TestTickClosed:

    async def test_closed_does_not_ping(self, settings):
        """CLOSED → _tick не зовёт ping (client.models.list не вызывался)."""
        breaker = _install_breaker()
        assert breaker.state == STATE_CLOSED

        probe, client = _make_probe(settings, ping_ok=True)
        await probe._tick()

        client.models.list.assert_not_awaited()
        assert probe._current_interval == settings.health_probe.poll_min_interval_sec


# ── start(): опциональность ─────────────────────────────────────────────────────


class TestStart:

    def test_start_disabled_does_not_create_task(self, settings):
        """start() при health_probe.enabled=False → задача не создаётся."""
        settings.health_probe.enabled = False
        probe, _ = _make_probe(settings, ping_ok=True)

        probe.start()

        assert probe._task is None
        assert probe.get_status()["running"] is False


# ── get_status ──────────────────────────────────────────────────────────────────


class TestGetStatus:

    def test_get_status_structure(self, settings):
        _install_breaker()
        probe, _ = _make_probe(settings, ping_ok=True)
        status = probe.get_status()
        assert status["name"] == "chat.llm_health_probe"
        assert status["running"] is False
        assert status["breaker_state"] == STATE_CLOSED
        assert (
            status["current_interval_sec"]
            == settings.health_probe.poll_min_interval_sec
        )
        assert status["last_ping_ok"] is None


# ── Фабрика клиентов ───────────────────────────────────────────────────────


class TestProbeClientViaFactory:
    """Probe строит клиента через фабрику build_llm_client, получая правильный
    тип по маршруту профиля (RedisBridgeClient для redis-bridge маршрута)."""

    def test_probe_builds_bridge_client_for_bridge_route(self, fake_redis):
        """Probe без client_factory использует build_llm_client → RedisBridgeClient."""
        from app.domains.chat.services.llm_client import _clients_cache
        from app.domains.chat.services.redis_bridge_adapter import (
            RedisBridgeClient,
        )

        # Чистим кэш для свежего теста
        _clients_cache.clear()

        # Создаём settings с redis-bridge маршрутом
        settings = ChatDomainSettings(profile="redis-bridge,gigachat")

        # Создаём probe БЕЗ client_factory — должен использовать build_llm_client
        probe = LLMHealthProbe(settings)

        # Вызываем _get_client() — должен вернуть RedisBridgeClient
        client = probe._get_client()

        assert isinstance(client, RedisBridgeClient)

    def test_probe_builds_gigachat_client_with_models_proxy(self):
        """Probe для маршрута gigachat получает GigaChatAdapterClient с
        рабочим client.models (иначе _ping падает AttributeError и breaker
        никогда не закрывается)."""
        from app.domains.chat.services.llm_client import _clients_cache
        from app.domains.chat.services.gigachat_adapter import (
            GigaChatAdapterClient,
        )

        _clients_cache.clear()

        settings = ChatDomainSettings(
            profile="gigachat",
            api_base="https://gigachat.local",
            api_key="test-key",
        )

        probe = LLMHealthProbe(settings)
        client = probe._get_client()

        assert isinstance(client, GigaChatAdapterClient)
        assert hasattr(client, "models")
        assert hasattr(client.models, "list")
