"""Тесты фабрики LLM-клиента."""
import pytest
from pydantic import SecretStr

from app.domains.chat.services import llm_client
from app.domains.chat.services.llm_client import build_llm_client
from app.domains.chat.settings import ChatDomainSettings


@pytest.fixture(autouse=True)
def _reset_clients_cache():
    """Изоляция: кэш LLM-клиентов между тестами не должен протекать."""
    llm_client._clients_cache.clear()
    yield
    llm_client._clients_cache.clear()


def _settings(**overrides) -> ChatDomainSettings:
    base = dict(
        profile="openai",
        api_base="http://localhost:30000/v1",
        api_key=SecretStr("dummy"),
        model="m",
        extra_headers={},
    )
    base.update(overrides)
    return ChatDomainSettings(**base)


def test_client_uses_api_base_from_settings():
    s = _settings(
        api_base="https://openrouter.ai/api/v1",
        profile="openai",
        api_key=SecretStr("sk-or-x"),
    )
    client = build_llm_client(s)
    assert str(client.base_url).startswith("https://openrouter.ai/api/v1")


def test_extra_headers_propagated():
    s = _settings(
        profile="openai",
        extra_headers={"HTTP-Referer": "https://aw.local", "X-Title": "AW"},
    )
    client = build_llm_client(s)
    headers = dict(client.default_headers)
    assert headers.get("HTTP-Referer") == "https://aw.local"
    assert headers.get("X-Title") == "AW"


def test_request_timeout_propagated():
    s = _settings(request_timeout=42)
    client = build_llm_client(s)
    # AsyncOpenAI хранит timeout в нескольких внутренних полях; на верхнем
    # уровне он доступен через атрибут .timeout
    assert client.timeout == 42


def test_gigachat_profile_returns_adapter():
    """Для profile=gigachat фабрика отдаёт GigaChatAdapterClient."""
    from app.domains.chat.services.gigachat_adapter import GigaChatAdapterClient

    s = _settings(
        profile="gigachat",
        api_base="http://liveaccess/v1/gc",
        api_key=SecretStr("internal-token"),
        model="GigaChat-3-Ultra",
    )
    client = build_llm_client(s)
    assert isinstance(client, GigaChatAdapterClient)
    assert str(client.base_url).startswith("http://liveaccess/v1/gc")


def test_non_gigachat_profile_returns_asyncopenai():
    """Для маршрута openai — обычный AsyncOpenAI."""
    from openai import AsyncOpenAI

    s = _settings(profile="openai")
    client = build_llm_client(s)
    assert isinstance(client, AsyncOpenAI)


def test_clients_cached_by_settings_key():
    """Повторный вызов с теми же настройками возвращает тот же объект
    (один httpx.AsyncClient на (profile, base, key, headers, timeout)).
    """
    s = _settings(profile="openai")
    c1 = build_llm_client(s)
    c2 = build_llm_client(s)
    assert c1 is c2

    # Разные api_base → разные клиенты
    s2 = _settings(profile="openai", api_base="https://other/v1")
    c3 = build_llm_client(s2)
    assert c3 is not c1


@pytest.mark.asyncio
async def test_close_cached_clients_clears_cache_and_closes_underlying():
    """close_cached_clients() закрывает httpx-клиенты и очищает кэш."""
    s = _settings(profile="openai")
    client = build_llm_client(s)
    assert len(llm_client._clients_cache) == 1

    count = await llm_client.close_cached_clients()
    assert count == 1
    assert llm_client._clients_cache == {}

    # Повторный вызов — нечего закрывать
    assert await llm_client.close_cached_clients() == 0
