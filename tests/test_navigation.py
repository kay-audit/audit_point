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


def _nav(label, url, order=100, active_page="", chat_domains=None, group="", description="", icon_svg="<path/>"):
    return NavItem(
        label=label,
        url=url,
        icon_svg=icon_svg,
        order=order,
        active_page=active_page,
        chat_domains=chat_domains or [],
        group=group,
        description=description,
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


# ── build_chat_greeting_context ──


class TestBuildChatGreetingContext:
    """Контекст приветствия AI-ассистента: agent_buttons + tools + inspections."""

    @patch("app.core.navigation._load_user_inspections")
    @patch(MOCK_PATH)
    def test_admin_gets_all_quick_buttons(
            self, mock_domains, mock_inspections,
    ):
        """Админ видит 3 кнопки быстрого перехода: Администрирование, Управление актами, План проверок."""
        from app.core.navigation import build_chat_greeting_context

        mock_inspections.return_value = []
        mock_domains.return_value = [
            _domain("acts", [
                _nav(
                    "Управление актами", "/acts", order=10,
                    active_page="acts", group="ЦИФРОВОЙ АКТ",
                    chat_domains=["acts"], description="Создание и редактирование актов",
                ),
                _nav(
                    "План проверок", "/acts/plan", order=11,
                    active_page="acts-plan", group="ЦИФРОВОЙ АКТ",
                    chat_domains=["acts"], description="Планирование",
                ),
            ]),
        ]

        roles = [{"name": "Администратор", "domain_name": None}]
        result = await_sync(build_chat_greeting_context(roles, "user1"))

        assert result["is_admin"] is True
        labels = [b["label"] for b in result["quick_buttons"]]
        assert labels == ["Администрирование", "Управление актами", "План проверок"]

    @patch("app.core.navigation._load_user_inspections")
    @patch(MOCK_PATH)
    def test_regular_user_filters_quick_buttons(
            self, mock_domains, mock_inspections,
    ):
        """Обычный пользователь без роли в acts — только видимые ему кнопки.

        «Администрирование» НЕ показывается не-админу. «Управление актами»
        / «План проверок» — только если есть роль в домене ``acts``.
        """
        from app.core.navigation import build_chat_greeting_context

        mock_inspections.return_value = []
        mock_domains.return_value = [
            _domain("acts", [
                _nav(
                    "Управление актами", "/acts", active_page="acts",
                    group="ЦИФРОВОЙ АКТ", chat_domains=["acts"],
                    description="Акты",
                ),
                _nav(
                    "План проверок", "/acts/plan", active_page="acts-plan",
                    group="ЦИФРОВОЙ АКТ", chat_domains=["acts"],
                    description="План",
                ),
            ]),
        ]

        # Не-админ без роли в acts — нет кнопок
        result = await_sync(
            build_chat_greeting_context([{"name": "Участник", "domain_name": "ck_client_exp"}], "u"),
        )
        assert [b["label"] for b in result["quick_buttons"]] == []

        # Не-админ с ролью в acts — две кнопки (без Администрирования)
        result = await_sync(
            build_chat_greeting_context([{"name": "Участник", "domain_name": "acts"}], "u"),
        )
        assert [b["label"] for b in result["quick_buttons"]] == ["Управление актами", "План проверок"]

    @patch("app.core.navigation._load_user_inspections")
    @patch(MOCK_PATH)
    def test_available_ck_filtered_by_domain(
            self, mock_domains, mock_inspections,
    ):
        """ЦК показываются только если у пользователя есть роль в ck-домене.

        НЕ через ``chat_domains`` (там могут быть «acts», иначе любой
        пользователь с ролью в acts видел бы все ЦК — а заказчик просил
        «убрать доступные всем»).
        """
        from app.core.navigation import build_chat_greeting_context

        mock_inspections.return_value = []
        mock_domains.return_value = [
            _domain("ck_client_exp", [_nav(
                "ЦК Клиентский опыт", "/ck-client-experience",
                group="ЦЕНТРЫ КОМПЕТЕНЦИЙ",
                chat_domains=["ck_client_exp", "acts"],
                description="метрики",
            )]),
            _domain("ck_fin_res", [_nav(
                "ЦК Фин. результат", "/ck-fin-res",
                group="ЦЕНТРЫ КОМПЕТЕНЦИЙ",
                chat_domains=["ck_fin_res", "acts"],
                description="финрез",
            )]),
        ]

        # Только с ролью в ck_client_exp — видит один ЦК
        result = await_sync(
            build_chat_greeting_context(
                [{"name": "Участник", "domain_name": "ck_client_exp"}], "u",
            ),
        )
        labels = [c["label"] for c in result["available_ck"]]
        assert labels == ["ЦК Клиентский опыт"]

        # С ролью только в acts — НЕ видит ЦК (даже несмотря на chat_domains)
        result = await_sync(
            build_chat_greeting_context(
                [{"name": "Участник", "domain_name": "acts"}], "u",
            ),
        )
        assert result["available_ck"] == []

        # Админ видит все
        result = await_sync(
            build_chat_greeting_context(
                [{"name": "Администратор", "domain_name": None}], "admin",
            ),
        )
        assert {c["label"] for c in result["available_ck"]} == {
            "ЦК Клиентский опыт", "ЦК Фин. результат",
        }

    @patch("app.core.navigation._load_user_inspections")
    @patch(MOCK_PATH)
    def test_ck_uses_display_label(
            self, mock_domains, mock_inspections,
    ):
        """ЦК Code Mining отображается с явным display_label, icon_svg пробрасывается."""
        from app.core.navigation import build_chat_greeting_context

        mock_inspections.return_value = []
        mock_domains.return_value = [
            _domain("ck_code_mining", [_nav(
                "ЦК Code Mining", "/ck-code-mining",
                group="ЦЕНТРЫ КОМПЕТЕНЦИЙ",
                chat_domains=["ck_code_mining", "acts"],
                icon_svg="<path d='M1 2h22M3 6h18M5 10h14M7 14h10M9 18h6'/>",
                description="Центр компетенций по анализу кода проверяемых систем",
            )]),
        ]

        result = await_sync(
            build_chat_greeting_context(
                [{"name": "Администратор", "domain_name": None}], "admin",
            ),
        )
        assert result["available_ck"][0]["label"] == "ЦК Code Mining"
        # icon_svg пробрасывается в контекст для рендера кнопки
        assert result["available_ck"][0]["icon_svg"]
        assert "Центр компетенций по анализу кода" in result["available_ck"][0]["description"]

    @patch("app.core.navigation._load_user_inspections")
    @patch(MOCK_PATH)
    def test_available_agents_group(
            self, mock_domains, mock_inspections,
    ):
        """Агенты берутся из группы «АГЕНТЫ» с правилами доступа."""
        from app.core.navigation import build_chat_greeting_context

        mock_inspections.return_value = []
        mock_domains.return_value = [
            _domain("sqlagent", [
                _nav(
                    "SQL-агент", "/sqlagent", order=30, group="АГЕНТЫ",
                    active_page="sqlagent", description="Авто-запросы",
                ),
                _nav(
                    "ИОР", "/sqlagent?tool=ior", order=31, group="АГЕНТЫ",
                    active_page="sqlagent-ior",
                    chat_domains=["sqlagent_ior"], description="Инциденты",
                ),
                _nav(
                    "CRM", "/sqlagent?tool=crm", order=32, group="АГЕНТЫ",
                    active_page="sqlagent-crm",
                    chat_domains=["sqlagent_crm"], description="Обращения",
                ),
            ]),
        ]

        # Пользователь только в sqlagent_ior — видит SQL-агент (т.к. есть
        # роль в sqlagent*) + ИОР (chat_domains).
        result = await_sync(
            build_chat_greeting_context(
                [{"name": "Участник", "domain_name": "sqlagent_ior"}], "u",
            ),
        )
        labels = [a["label"] for a in result["available_agents"]]
        assert labels == ["SQL-агент", "ИОР"]
        # Каждый агент имеет url, icon_svg, description
        for a in result["available_agents"]:
            assert a["url"]
            assert a["icon_svg"]
            assert a["description"]

        # Пользователь без ролей в sqlagent* — НЕ видит ни одного агента
        result = await_sync(
            build_chat_greeting_context(
                [{"name": "Участник", "domain_name": "acts"}], "u",
            ),
        )
        assert result["available_agents"] == []

        # Админ видит все агенты
        result = await_sync(
            build_chat_greeting_context(
                [{"name": "Администратор", "domain_name": None}], "admin",
            ),
        )
        labels = [a["label"] for a in result["available_agents"]]
        assert labels == ["SQL-агент", "ИОР", "CRM"]

    @patch("app.core.navigation._load_user_inspections")
    @patch(MOCK_PATH)
    def test_inspections_passed_through(
            self, mock_domains, mock_inspections,
    ):
        """Список проверок пользователя прокидывается из _load_user_inspections."""
        from app.core.navigation import build_chat_greeting_context

        mock_inspections.return_value = [
            {
                "km_number": "КМ-99-00001",
                "inspection_name": "Тестовая проверка",
                "period": "12.05 – 25.05.2025",
                "role": "Руководитель",
            },
        ]
        mock_domains.return_value = []

        roles = [{"name": "Участник", "domain_name": "acts"}]
        result = await_sync(build_chat_greeting_context(roles, "u"))

        assert len(result["inspections"]) == 1
        assert result["inspections"][0]["km_number"] == "КМ-99-00001"
        assert result["inspections"][0]["role"] == "Руководитель"

    @patch("app.core.navigation._load_user_inspections")
    @patch(MOCK_PATH)
    def test_no_username_yields_empty_inspections(
            self, mock_domains, mock_inspections,
    ):
        """Без username inspections = []."""
        from app.core.navigation import build_chat_greeting_context

        mock_inspections.return_value = []
        mock_domains.return_value = []

        result = await_sync(build_chat_greeting_context([], None))
        assert result["inspections"] == []
        assert result["quick_buttons"] == []
        assert result["available_ck"] == []
        assert result["available_agents"] == []


def await_sync(coro):
    """Прогоняет async-функцию в текущем loop (тесты синхронные)."""
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError("closed")
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


# ── _format_period ──


class TestFormatPeriod:
    """Форматирование периода проверки для приветствия AI-ассистента."""

    def test_same_year_start_end_different(self):
        from app.core.navigation import _format_period
        from datetime import date

        assert _format_period(
            date(2025, 5, 12), date(2025, 5, 25),
        ) == "12.05 – 25.05.2025"

    def test_same_year_same_day(self):
        from app.core.navigation import _format_period
        from datetime import date

        assert _format_period(
            date(2025, 5, 12), date(2025, 5, 12),
        ) == "12.05.2025"

    def test_different_years(self):
        from app.core.navigation import _format_period
        from datetime import date

        assert _format_period(
            date(2024, 12, 15), date(2025, 1, 10),
        ) == "15.12.2024 – 10.01.2025"

    def test_only_start(self):
        from app.core.navigation import _format_period
        from datetime import date

        assert _format_period(date(2025, 5, 12), None) == "12.05.2025"

    def test_only_end(self):
        from app.core.navigation import _format_period
        from datetime import date

        assert _format_period(None, date(2025, 5, 25)) == "25.05.2025"

    def test_both_none(self):
        from app.core.navigation import _format_period
        assert _format_period(None, None) == ""
