"""Тесты конфигурации профилей и retry/agent_channel."""
import pytest

from app.core.settings_registry import _load_from_env, reset
from app.domains.chat.settings import ChatDomainSettings, parse_route, wire_is_gigachat


def _env(monkeypatch, **vars):
    """Хелпер: проставить env-переменные для одного теста."""
    for k, v in vars.items():
        monkeypatch.setenv(k, v)


@pytest.fixture(autouse=True)
def _reset_registry():
    reset()
    yield
    reset()


def _load(monkeypatch, **env_vars) -> ChatDomainSettings:
    _env(monkeypatch, **env_vars)
    return _load_from_env("chat", ChatDomainSettings)


def test_default_profile_is_openai():
    # Прямое инстанцирование, чтобы тест документировал ДЕФОЛТЫ КЛАССА,
    # а не текущее содержимое пользовательского .env (где у разработчика
    # может стоять другой маршрут).
    s = ChatDomainSettings(
        api_base="http://localhost:30000/v1", api_key="dummy", model="m",
    )
    assert s.profile == "openai"
    assert s.retry.on_429 is True
    assert s.retry.on_5xx is True
    assert s.smalltalk_mode == "local"
    assert s.agent_channel.poll_min_interval_sec == 2.0
    assert s.agent_channel.poll_max_interval_sec == 10.0
    assert s.agent_channel.poll_backoff_multiplier == 1.5


def test_openai_profile_with_extra_headers():
    # Прямое инстанцирование, чтобы headers из пользовательского .env
    # (X-Title и т.п.) не вмешивались в проверку парсинга dict.
    s = ChatDomainSettings(
        profile="openai",
        api_base="https://openrouter.ai/api/v1",
        api_key="sk-or-x",
        model="minimax/minimax-m2:free",
        extra_headers={"HTTP-Referer": "https://aw.local"},
    )
    assert s.profile == "openai"
    assert s.extra_headers == {"HTTP-Referer": "https://aw.local"}


def test_nested_retry_overrides(monkeypatch):
    s = _load(monkeypatch,
              CHAT__API_BASE="http://x", CHAT__API_KEY="x", CHAT__MODEL="m",
              CHAT__RETRY__ON_429="false",
              CHAT__RETRY__ON_5XX="true",
              CHAT__RETRY__MAX_ATTEMPTS="3",
              CHAT__RETRY__BACKOFF_BASE_SEC="0.5")
    assert s.retry.on_429 is False
    assert s.retry.on_5xx is True
    assert s.retry.max_attempts == 3
    assert s.retry.backoff_base_sec == 0.5


def test_nested_agent_channel_overrides(monkeypatch):
    s = _load(monkeypatch,
              CHAT__API_BASE="http://x", CHAT__API_KEY="x", CHAT__MODEL="m",
              CHAT__AGENT_CHANNEL__POLL_MIN_INTERVAL_SEC="0.25",
              CHAT__AGENT_CHANNEL__POLL_MAX_INTERVAL_SEC="5.0",
              CHAT__AGENT_CHANNEL__POLL_BACKOFF_MULTIPLIER="2.0",
              CHAT__AGENT_CHANNEL__ANSWER_TIMEOUT_SEC="900",
              CHAT__AGENT_CHANNEL__CLAIM_TIMEOUT_SEC="300",
              CHAT__AGENT_CHANNEL__MAX_BLOCK_TEXT_SIZE="1024")
    assert s.agent_channel.poll_min_interval_sec == 0.25
    assert s.agent_channel.poll_max_interval_sec == 5.0
    assert s.agent_channel.poll_backoff_multiplier == 2.0
    assert s.agent_channel.answer_timeout_sec == 900
    assert s.agent_channel.claim_timeout_sec == 300
    assert s.agent_channel.max_block_text_size == 1024


def test_smalltalk_mode_forward(monkeypatch):
    s = _load(monkeypatch,
              CHAT__API_BASE="http://x", CHAT__API_KEY="x", CHAT__MODEL="m",
              CHAT__SMALLTALK_MODE="forward")
    assert s.smalltalk_mode == "forward"


def test_gigachat_profile_accepted():
    """Профиль gigachat должен валидно создаваться."""
    s = ChatDomainSettings(
        profile="gigachat",
        api_base="http://liveaccess/v1/gc",
        api_key="dummy-token",
        model="GigaChat-3-Ultra",
    )
    assert s.profile == "gigachat"


def test_invalid_profile_rejected():
    """Литерал отвергает значения вне whitelist'а."""
    import pydantic
    with pytest.raises(pydantic.ValidationError):
        ChatDomainSettings(
            profile="anthropic",  # нет в Literal
            api_base="http://x",
            api_key="x",
            model="m",
        )


def test_agent_channel_settings_defaults():
    from app.domains.chat.settings import AgentChannelSettings
    s = AgentChannelSettings()
    assert s.table_name == "chat_agent_messages_bus"
    assert s.answer_timeout_sec == 1800
    assert s.claim_timeout_sec == 1800
    assert s.poll_min_interval_sec == 2.0
    assert s.poll_max_interval_sec == 10.0
    assert s.poll_backoff_multiplier == 1.5
    assert s.max_block_text_size == 262144


def test_answer_timeout_default():
    """Дефолт answer_timeout_sec — 30 минут: NanoBot ретраит вопрос до 3 раз.

    Инстанцируем модель напрямую: _load_from_env подсосал бы реальный .env.
    """
    s = ChatDomainSettings(api_base="x", api_key="k", model="m")
    assert s.agent_channel.answer_timeout_sec == 1800


def test_agent_channel_claim_timeout_must_be_positive():
    import pydantic
    from app.domains.chat.settings import AgentChannelSettings
    with pytest.raises(pydantic.ValidationError):
        AgentChannelSettings(claim_timeout_sec=0)


class TestParseRoute:
    @pytest.mark.parametrize("route,expected", [
        ("gigachat", ("http", "gigachat")),
        ("openai", ("http", "openai")),
        ("redis-bridge,gigachat", ("redis", "gigachat")),
        ("redis-bridge,openai", ("redis", "openai")),
        ("redis-bridge, openai", ("redis", "openai")),  # пробел после запятой
    ])
    def test_valid_routes(self, route, expected):
        assert parse_route(route) == expected

    @pytest.mark.parametrize("route", [
        "sglang",            # упразднён
        "openrouter",        # упразднён
        "redis-bridge",      # без цели
        "redis-bridge,sglang",  # неизвестная цель
        "",                  # пусто
        "gigachat,openai",   # цель у HTTP-маршрута
    ])
    def test_invalid_routes_raise(self, route):
        with pytest.raises(ValueError):
            parse_route(route)


class TestWireIsGigachat:
    def test_direct_gigachat(self):
        assert wire_is_gigachat("gigachat") is True

    def test_bridge_gigachat(self):
        assert wire_is_gigachat("redis-bridge,gigachat") is True

    def test_openai_routes(self):
        assert wire_is_gigachat("openai") is False
        assert wire_is_gigachat("redis-bridge,openai") is False

    def test_none_and_empty(self):
        assert wire_is_gigachat(None) is False
        assert wire_is_gigachat("") is False


class TestProfileValidation:
    def test_default_profile_is_openai(self):
        s = ChatDomainSettings()
        assert s.profile == "openai"

    def test_bridge_profile_accepted(self):
        s = ChatDomainSettings(profile="redis-bridge,gigachat")
        assert s.profile == "redis-bridge,gigachat"

    def test_legacy_profile_rejected(self):
        with pytest.raises(ValueError):
            ChatDomainSettings(profile="sglang")

    def test_fallback_route_validated(self):
        with pytest.raises(ValueError):
            ChatDomainSettings(fallback_profile="redis-bridge")

    def test_fallback_none_ok(self):
        s = ChatDomainSettings()
        assert s.fallback_profile is None

    def test_fallback_empty_string_normalized_to_none(self):
        """CHAT__FALLBACK_PROFILE= (пусто) — документированное «отключено»:
        pydantic-settings передаёт "", а не None; старт не должен падать."""
        s = ChatDomainSettings(fallback_profile="")
        assert s.fallback_profile is None

    def test_fallback_whitespace_normalized_to_none(self):
        s = ChatDomainSettings(fallback_profile="   ")
        assert s.fallback_profile is None

    def test_redis_bridge_settings_default_prefix(self):
        s = ChatDomainSettings()
        assert s.redis_bridge.key_prefix == "llm:bridge:"
