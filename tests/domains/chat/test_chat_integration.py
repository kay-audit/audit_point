"""Интеграционные тесты домена чата."""

from pathlib import Path

import pytest

from app.core.domain_registry import discover_domains, reset_registry
from app.core.settings_registry import reset as reset_settings
from app.core.chat.tools import reset as reset_tools


@pytest.fixture(autouse=True)
def clean_registries():
    """Сброс глобального состояния реестров между тестами."""
    reset_registry()
    reset_settings()
    reset_tools()
    yield
    reset_registry()
    reset_settings()
    reset_tools()


# -------------------------------------------------------------------------
# Обнаружение домена
# -------------------------------------------------------------------------


def test_chat_domain_discovered():
    """Chat-домен обнаруживается при discover_domains."""
    domains_dir = Path(__file__).parent.parent.parent.parent / "app" / "domains"
    domains = discover_domains(domains_dir)
    domain_names = [d.name for d in domains]
    assert "chat" in domain_names


# -------------------------------------------------------------------------
# Настройки
# -------------------------------------------------------------------------


def test_chat_settings_load():
    """Настройки чата загружаются с дефолтами."""
    from app.domains.chat.settings import ChatDomainSettings

    s = ChatDomainSettings()
    assert s.model == "gpt-4o"
    assert s.max_file_size == 512 * 1024 * 1024


# -------------------------------------------------------------------------
# Core SDK экспорт
# -------------------------------------------------------------------------


def test_core_sdk_imports():
    """Core SDK экспортирует все необходимые объекты."""
    from app.core.chat import (
        ChatTool,
        ChatToolParam,
        TextBlock,
        CodeBlock,
        ReasoningBlock,
        PlanBlock,
        FileBlock,
        ImageBlock,
        Button,
        ButtonGroup,
        register_tools,
        parse_message_blocks,
        serialize_message_blocks,
    )

    # Проверяем, что все объекты не None
    assert ChatTool is not None
    assert ChatToolParam is not None
    assert TextBlock is not None
    assert CodeBlock is not None
    assert ReasoningBlock is not None
    assert PlanBlock is not None
    assert FileBlock is not None
    assert ImageBlock is not None
    assert Button is not None
    assert ButtonGroup is not None
    assert callable(register_tools)
    assert callable(parse_message_blocks)
    assert callable(serialize_message_blocks)
