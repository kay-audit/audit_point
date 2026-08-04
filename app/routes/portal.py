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
from app.core.templating import get_templates

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
    try:
        from app.auth.dependencies import get_optional_user_id
        from app.api.v1.deps.role_deps import get_user_roles

        # Username кладёт AuthMiddleware (ОТП-режим) либо тест-режим из окружения.
        username = get_optional_user_id(request)
        if username:
            roles = await get_user_roles(username=username)
            nav_groups = get_nav_items_for_user(roles)
            is_admin = any(r["name"] == "Админ" for r in roles)
        else:
            nav_groups = get_nav_items_grouped()
    except Exception as e:
        logger.debug("Не удалось загрузить роли для landing, показываем все nav items: %s", e)
        nav_groups = get_nav_items_grouped()

    return templates.TemplateResponse(
        request,
        "portal/landing/landing.html",
        {
            "active_page": "landing",
            "topbar_title": "Рабочее пространство",
            "nav_groups": nav_groups,
            "is_admin": is_admin,
            "chat_domains": None,
            "knowledge_bases": get_knowledge_bases_as_dicts(),
        }
    )
