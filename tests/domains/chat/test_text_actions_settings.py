"""Тесты под-модели TextActionsSettings (Фича «Корректор»)."""

import pytest

from app.core.settings_registry import _load_from_env
from app.core.settings_registry import reset as reset_settings
from app.domains.chat.settings import ChatDomainSettings, TextActionsSettings


@pytest.fixture(autouse=True)
def _reset():
    reset_settings()
    yield
    reset_settings()


def test_text_actions_defaults():
    # Дефолты проверяем прямой инстанциацией (pydantic-settings иначе подсосёт .env).
    s = ChatDomainSettings(api_base="http://x", api_key="x", model="m")
    assert isinstance(s.text_actions, TextActionsSettings)
    assert s.text_actions.corrector_temperature == 0.1
    assert s.text_actions.readability_temperature == 0.1  # температура D17
    assert s.text_actions.formalizer_temperature == 0.01
    assert s.text_actions.corrector_model is None  # → падаем на settings.model
    assert s.text_actions.max_input_chars == 20000
    assert s.text_actions.per_call_timeout_sec == 60.0


def test_text_actions_env_override(monkeypatch):
    monkeypatch.setenv("CHAT__TEXT_ACTIONS__CORRECTOR_MODEL", "qwen3-14b")
    monkeypatch.setenv("CHAT__TEXT_ACTIONS__MAX_INPUT_CHARS", "500")
    s = _load_from_env("chat", ChatDomainSettings)
    assert s.text_actions.corrector_model == "qwen3-14b"
    assert s.text_actions.max_input_chars == 500
