"""
Домен администрирования.

Управление ролями пользователей, справочник пользователей,
начальное заполнение ролей при первом запуске.
"""


async def _health_check() -> dict:
    """Health-проверка админ-домена: БД и наличие таблицы roles."""
    from app.db.connection import get_db, get_adapter

    result: dict = {"status": "ok", "db": "reachable", "tables": "present"}

    try:
        adapter = get_adapter()
        async with get_db() as conn:
            await conn.fetchval("SELECT 1")
            expected = adapter.get_table_name("roles").split(".")[-1]
            existing = await adapter._get_existing_tables(conn, [expected])
            if expected not in existing:
                result["status"] = "error"
                result["tables"] = "missing"
    except Exception as exc:
        return {"status": "error", "db": str(exc), "tables": "unknown"}

    return result


def _build_domain():
    """Ленивое построение DomainDescriptor (вызывается из domain_registry)."""
    from app.core.domain import DomainDescriptor
    from app.domains.admin.api import get_api_routers
    from app.domains.admin.routes import get_html_routers
    from app.domains.admin._lifecycle import (
        on_startup,
        register_factories,
        register_lifespan_hooks,
    )
    from app.core import settings_registry
    from app.domains.admin.integrations.chat_tools import get_chat_tools
    from app.domains.admin.settings import AdminSettings

    # Экспортируем фабрики и hooks до возврата DomainDescriptor — потребители
    # (например, acts.deps.get_users_repository) разрешают фабрику через ключ.
    register_factories()
    register_lifespan_hooks()

    return DomainDescriptor(
        name="admin",
        api_routers=get_api_routers(),
        html_routers=get_html_routers(),
        settings_class=AdminSettings,
        on_startup=on_startup,
        chat_tools=get_chat_tools(),
        migration_substitutions={
            "{REF_USER_TABLE}": lambda: settings_registry.get("admin", AdminSettings).user_directory.table,
            "{REF_USER_TABLE_PLAIN}": lambda: settings_registry.get("admin", AdminSettings).user_directory.table,
        },
        health_check=_health_check,
        nav_items=[],
        chat_system_prompt=(
            "В админ-панели администратор управляет пользователями, ролями "
            "и доступом к доменам. Ты можешь подсказать, как туда попасть "
            "и что там делать."
        ),
    )
