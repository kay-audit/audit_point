"""
HTML-роуты shared портальных страниц.

Содержит маршруты для:
- Стартовая страница (landing)

Доменные HTML-роуты (/acts, /constructor, /ck-*) живут в app/domains/*/routes/.
"""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from app.core.navigation import get_knowledge_bases_as_dicts, get_nav_items_for_user, get_nav_items_grouped
from app.core.templating import get_templates, render_template

logger = logging.getLogger("audit_workstation.routes.portal")

templates = get_templates()

router = APIRouter()


@router.get("/", response_class=HTMLResponse)
async def show_landing(request: Request):
    """
    Стартовая страница - портал инструментов.

    Отображает дашборд с навигацией по инструментам компании.
    Авторизация проверяется фронтендом через /api/v1/auth/me.
    Роли загружаются опционально — при ошибке показываем все nav items.
    """
    is_admin = False
    user_domains: set[str] = set()
    try:
        # ИСПОЛЬЗУЕМ СЕССИОННУЮ COOKIE (а не JUPYTERHUB_USER) — иначе все
        # залогиненные пользователи видели бы ВСЕ nav items (включая ЦК и
        # Админ-панель), потому что fallback get_current_user_from_env()
        # читает только env var.
        from app.api.v1.deps.auth_deps import get_current_username
        from app.api.v1.deps.role_deps import get_user_roles

        username = await get_current_username(request)
        if username:
            roles = await get_user_roles(username=username)
            is_admin = any(r["name"] == "Администратор" for r in roles)
            user_domains = {r.get("domain_name") for r in roles if r.get("domain_name")}
            # В landing ВСЕГДА показываем все nav items, чтобы ЦК и прочие
            # были видны (locked) — иначе фильтр их уберёт совсем.
            # Другие страницы продолжают использовать get_nav_items_for_user.
            nav_groups = get_nav_items_grouped()
        else:
            nav_groups = get_nav_items_grouped()
    except Exception:
        logger.debug("Не удалось загрузить роли для landing, показываем все nav items")
        nav_groups = get_nav_items_grouped()

    return await render_template(
        request,
        "portal/landing/landing.html",
        {
            "active_page": "landing",
            "topbar_title": "Единое рабочее место аудитора",
            "nav_groups": nav_groups,
            "is_admin": is_admin,
            "user_domains": sorted(user_domains),
            "chat_domains": None,
            "knowledge_bases": get_knowledge_bases_as_dicts(),
        }
    )
