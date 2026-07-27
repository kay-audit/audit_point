"""HTML-роуты страниц домена «Акты»:
- /acts         — управление актами аудита (список и конструктор);
- /acts/plan    — заглушка «План проверок в разработке».
"""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.core.domain_registry import get_all_domains
from app.core.navigation import get_chat_domains_for_page, get_knowledge_bases_as_dicts, get_nav_items_for_user
from app.core.templating import render_template
from app.domains.sqlagent.placeholders import get_placeholder_paragraphs

router = APIRouter()


def _find_acts_nav_item(active_page: str) -> dict | None:
    """Найти NavItem домена acts по active_page (например, ``acts-plan``)."""
    for d in get_all_domains():
        for nav in d.nav_items:
            if nav.active_page == active_page and d.name == "acts":
                return {
                    "label": nav.label,
                    "description": nav.description,
                    "icon_svg": nav.icon_svg,
                    "active_page": nav.active_page,
                }
    return None


@router.get("/acts", response_class=HTMLResponse)
async def show_acts_manager(
    request: Request,
    roles: list[dict] = Depends(get_user_roles),
    username: str = Depends(get_username),
):
    """Страница управления актами."""
    return await render_template(
        request,
        "portal/acts-manager/acts_manager.html",
        {
            "active_page": "acts",
            "topbar_title": "Управление актами",
            "nav_groups": get_nav_items_for_user(roles),
            "is_admin": any(r["name"] == "Администратор" for r in roles),
            "user_domains": sorted({r.get("domain_name") for r in roles if r.get("domain_name")}),
            "username": username,
            "chat_domains": get_chat_domains_for_page("acts"),
            "knowledge_bases": get_knowledge_bases_as_dicts(),
        }
    )


@router.get("/acts/plan", response_class=HTMLResponse)
async def show_acts_plan(
    request: Request,
    roles: list[dict] = Depends(get_user_roles),
):
    """Заглушка «План проверок в разработке» (блок Аудит).

    Использует ту же карточку-плейсхолдер, что и placeholder-инструменты
    блока Аналитика (/sqlagent?tool=xxx), чтобы дать пользователю единый
    визуальный язык. Текст берётся из ``placeholders.TOOL_PARAGRAPHS['plan']``
    + общая завершающая фраза про «внешнюю сеть / ЕРМ в КАП».
    """
    nav = _find_acts_nav_item("acts-plan")
    if nav is None:
        nav = {
            "label": "План проверок",
            "description": "Планирование: действующие проверки, их статусы, сроки и участники",
            "icon_svg": "",
            "active_page": "acts-plan",
        }

    return await render_template(
        request,
        "portal/acts-manager/plan_placeholder.html",
        {
            "active_page": nav["active_page"],
            "topbar_title": nav["label"],
            "nav_groups": get_nav_items_for_user(roles),
            "is_admin": any(r["name"] == "Администратор" for r in roles),
            "user_domains": sorted({r.get("domain_name") for r in roles if r.get("domain_name")}),
            "chat_domains": get_chat_domains_for_page("acts"),
            "knowledge_bases": get_knowledge_bases_as_dicts(),
            "placeholder": {
                "title": nav["label"],
                "subtitle": nav["description"],
                "icon_svg": nav["icon_svg"],
                "paragraphs": get_placeholder_paragraphs("plan"),
            },
        },
    )
