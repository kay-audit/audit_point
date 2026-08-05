"""
Домен актов.

Содержит всю бизнес-логику, связанную с актами:
CRUD, блокировки, содержимое, экспорт, фактуры.

Импорты API/routes/lifecycle — lazy, чтобы избежать
циклических импортов при загрузке settings из config.py.
"""


DOMAIN_NAME = "acts"


async def _health_check() -> dict:
    """Health-проверка домена актов: пинг БД и наличие таблицы acts.

    Возвращает структуру:
        {"status": "ok"|"error", "db": "reachable"|<msg>, "tables": "present"|"missing"}
    """
    from app.db.connection import get_db, get_adapter

    result: dict = {"status": "ok", "db": "reachable", "tables": "present"}

    try:
        adapter = get_adapter()
        async with get_db() as conn:
            await conn.fetchval("SELECT 1")
            expected = adapter.get_table_name("acts").split(".")[-1]
            existing = await adapter._get_existing_tables(conn, [expected])
            if expected not in existing:
                result["status"] = "error"
                result["tables"] = "missing"
    except Exception as exc:
        return {"status": "error", "db": str(exc), "tables": "unknown"}

    return result


def _build_domain():
    """Ленивое построение DomainDescriptor (вызывается из domain_registry)."""
    from app.core.chat.names import TOOL_OPEN_ACT_PAGE
    from app.core.chat.tools import to_wire_name
    from app.core.domain import DomainDescriptor, KnowledgeBase, NavItem
    from app.domains.acts.api import get_api_routers
    from app.domains.acts.routes import get_html_routers
    from app.domains.acts._lifecycle import (
        on_shutdown,
        on_startup,
        register_lifespan_hooks,
    )
    from app.core import settings_registry
    from app.domains.acts.settings import ActsSettings
    from app.domains.acts.integrations.chat_tools import get_chat_tools

    # Регистрация инфраструктурных lifespan-hooks (батчер аудит-лога,
    # очистка просроченных блокировок) в общем реестре.
    register_lifespan_hooks()

    return DomainDescriptor(
        name=DOMAIN_NAME,
        api_routers=get_api_routers(),
        html_routers=get_html_routers(),
        settings_class=ActsSettings,
        dependencies={
            "admin": "роли/доступ к домену, справочник пользователей (IUserDirectory) для атрибуции авторов актов",
            "ua_data": "имена таблиц фактур (UaInvoiceTableNames) и справочники подразделений/контрагентов",
        },
        on_startup=on_startup,
        on_shutdown=on_shutdown,
        chat_tools=get_chat_tools(),
        migration_substitutions={
            "{REF_HADOOP_TABLES}": lambda: settings_registry.get(DOMAIN_NAME, ActsSettings).invoice.hive_registry_table,
        },
        health_check=_health_check,
        nav_items=[
            NavItem(
                label="Управление актами",
                url="/acts",
                icon_svg=(
                    '<path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 '
                    '012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 '
                    '01.293.707V19a2 2 0 01-2 2z" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round"/>'
                ),
                order=10,
                active_page="acts",
                chat_domains=[DOMAIN_NAME],
                group="Аудит",
                description=(
                    "Список и редактирование актов аудита; конкретный акт "
                    "открывается через инструмент "
                    f"{to_wire_name(TOOL_OPEN_ACT_PAGE)}"
                ),
            ),
        ],
        knowledge_bases=[
            KnowledgeBase(
                key="knowledge_base_oarb",
                label="База Знаний ОАРБ",
                description="Поиск по базе знаний отдела аудита розничного бизнеса",
            ),
            KnowledgeBase(
                key="knowledge_base_sources",
                label="База знаний источников информации",
                description="Поиск по каталогу источников данных",
            ),
            KnowledgeBase(
                key="knowledge_base_tools",
                label="База знаний по инструментам",
                description="Поиск по документации инструментов",
            ),
        ],
        chat_system_prompt=(
            "Ты — AI-ассистент для работы с актами аудита. "
            "Акты имеют древовидную структуру с 5 разделами: "
            "1) Общая информация, 2) Оценка качества, 3) Источники данных, "
            "4) Выводы, 5) Отчётные таблицы. "
            "КМ-номера имеют формат КМ-XX-XXXXX. "
            "Служебные записки — формат Текст/ГГГГ. "
            "Используй доступные инструменты для получения данных из актов."
        ),
    )
