"""Тесты для навигации — сбор NavItem и KnowledgeBase из доменов."""

import pytest
from unittest.mock import patch

from app.core.domain import DomainDescriptor, KnowledgeBase, NavItem
from app.core.domain_registry import reset_registry
from app.core.navigation import (
    get_chat_domains_for_page,
    get_knowledge_bases,
    get_knowledge_bases_as_dicts,
    get_nav_items,
    get_nav_items_for_user,
    get_nav_items_grouped,
)


@pytest.fixture(autouse=True)
def clean_registry():
    reset_registry()
    yield
    reset_registry()


def _nav(label, url, order=100, active_page="", chat_domains=None, group=""):
    return NavItem(
        label=label,
        url=url,
        icon_svg="<path/>",
        order=order,
        active_page=active_page,
        chat_domains=chat_domains or [],
        group=group,
    )


def _domain(name, nav_items=None, knowledge_bases=None):
    return DomainDescriptor(
        name=name,
        nav_items=nav_items or [],
        knowledge_bases=knowledge_bases or [],
    )


MOCK_PATH = "app.core.domain_registry.get_all_domains"


# ── get_nav_items ──


class TestGetNavItems:

    @patch(MOCK_PATH)
    def test_sorted_by_order(self, mock_domains):
        mock_domains.return_value = [
            _domain("b", [_nav("Второй", "/b", order=20)]),
            _domain("a", [_nav("Первый", "/a", order=10)]),
        ]
        result = get_nav_items()
        assert [i.label for i in result] == ["Первый", "Второй"]

    @patch(MOCK_PATH)
    def test_collects_from_multiple_domains(self, mock_domains):
        mock_domains.return_value = [
            _domain("x", [_nav("X1", "/x1"), _nav("X2", "/x2")]),
            _domain("y", [_nav("Y1", "/y1")]),
        ]
        result = get_nav_items()
        assert len(result) == 3

    @patch(MOCK_PATH)
    def test_empty_domains(self, mock_domains):
        mock_domains.return_value = []
        assert get_nav_items() == []


# ── get_chat_domains_for_page ──


class TestGetChatDomains:

    @patch(MOCK_PATH)
    def test_landing_returns_none(self, mock_domains):
        mock_domains.return_value = []
        assert get_chat_domains_for_page("landing") is None

    @patch(MOCK_PATH)
    def test_matching_active_page(self, mock_domains):
        mock_domains.return_value = [
            _domain("acts", [_nav("Акты", "/acts", active_page="acts_manager", chat_domains=["acts"])]),
        ]
        result = get_chat_domains_for_page("acts_manager")
        assert result == ["acts"]

    @patch(MOCK_PATH)
    def test_no_match_returns_none(self, mock_domains):
        mock_domains.return_value = [
            _domain("acts", [_nav("Акты", "/acts", active_page="acts_manager")]),
        ]
        assert get_chat_domains_for_page("unknown_page") is None

    @patch(MOCK_PATH)
    def test_match_without_chat_domains_returns_none(self, mock_domains):
        mock_domains.return_value = [
            _domain("acts", [_nav("Акты", "/acts", active_page="acts_manager", chat_domains=[])]),
        ]
        assert get_chat_domains_for_page("acts_manager") is None


# ── get_nav_items_grouped ──


class TestGetNavItemsGrouped:

    @patch(MOCK_PATH)
    def test_groups_by_group_field(self, mock_domains):
        mock_domains.return_value = [
            _domain("a", [
                _nav("А1", "/a1", order=1, group="Группа А"),
                _nav("А2", "/a2", order=2, group="Группа А"),
            ]),
            _domain("b", [_nav("Б1", "/b1", order=3, group="Группа Б")]),
        ]
        result = get_nav_items_grouped()
        assert len(result) == 2
        assert result[0]["group"] == "Группа А"
        assert len(result[0]["nav_items"]) == 2
        assert result[1]["group"] == "Группа Б"

    @patch(MOCK_PATH)
    def test_empty_group_key(self, mock_domains):
        mock_domains.return_value = [
            _domain("a", [_nav("Без группы", "/x", order=1)]),
        ]
        result = get_nav_items_grouped()
        assert result[0]["group"] == ""

    @patch(MOCK_PATH)
    def test_mixed_groups(self, mock_domains):
        mock_domains.return_value = [
            _domain("a", [
                _nav("Без", "/x", order=1, group=""),
                _nav("С группой", "/y", order=2, group="ЦК"),
            ]),
        ]
        result = get_nav_items_grouped()
        groups = [r["group"] for r in result]
        assert "" in groups
        assert "ЦК" in groups


# ── get_nav_items_for_user ──


class TestGetNavItemsForUser:

    @patch(MOCK_PATH)
    def test_admin_sees_all(self, mock_domains):
        mock_domains.return_value = [
            _domain("acts", [_nav("Акты", "/acts", group="Основные")]),
            _domain("ck", [_nav("ЦК", "/ck", group="ЦК")]),
        ]
        roles = [{"name": "Администратор"}]
        result = get_nav_items_for_user(roles)
        labels = [item.label for g in result for item in g["nav_items"]]
        assert "Акты" in labels
        assert "ЦК" in labels

    @patch(MOCK_PATH)
    def test_regular_user_sees_own_domains(self, mock_domains):
        mock_domains.return_value = [
            _domain("acts", [_nav("Акты", "/acts", group="Основные")]),
            _domain("ck", [_nav("ЦК", "/ck", group="ЦК")]),
        ]
        roles = [{"name": "Участник", "domain_name": "acts"}]
        result = get_nav_items_for_user(roles)
        labels = [item.label for g in result for item in g["nav_items"]]
        assert "Акты" in labels
        assert "ЦК" not in labels

    @patch(MOCK_PATH)
    def test_inaccessible_domain_group_excluded(self, mock_domains):
        mock_domains.return_value = [
            _domain("acts", [_nav("Акты", "/acts", group="Основные")]),
            _domain("ck", [_nav("ЦК", "/ck", group="ЦК")]),
        ]
        roles = [{"name": "Участник", "domain_name": "acts"}]
        result = get_nav_items_for_user(roles)
        groups = [r["group"] for r in result]
        assert "ЦК" not in groups

    @patch(MOCK_PATH)
    def test_empty_roles_sees_nothing(self, mock_domains):
        mock_domains.return_value = [
            _domain("acts", [_nav("Акты", "/acts", group="Основные")]),
        ]
        result = get_nav_items_for_user([])
        assert result == []


# ── get_knowledge_bases ──


class TestGetKnowledgeBases:

    @patch(MOCK_PATH)
    def test_collects_from_domains(self, mock_domains):
        kb1 = KnowledgeBase(key="kb1", label="БЗ 1", description="Описание 1")
        kb2 = KnowledgeBase(key="kb2", label="БЗ 2", description="Описание 2")
        mock_domains.return_value = [
            _domain("a", knowledge_bases=[kb1]),
            _domain("b", knowledge_bases=[kb2]),
        ]
        result = get_knowledge_bases()
        assert len(result) == 2
        assert result[0].key == "kb1"
        assert result[1].key == "kb2"

    @patch(MOCK_PATH)
    def test_empty_domains(self, mock_domains):
        mock_domains.return_value = []
        assert get_knowledge_bases() == []

    @patch(MOCK_PATH)
    def test_as_dicts(self, mock_domains):
        kb = KnowledgeBase(key="kb1", label="БЗ", description="Описание")
        mock_domains.return_value = [_domain("a", knowledge_bases=[kb])]
        result = get_knowledge_bases_as_dicts()
        assert isinstance(result, list)
        assert result[0] == {"key": "kb1", "label": "БЗ", "description": "Описание"}
