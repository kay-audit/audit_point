"""HTML-роут страницы ЦК Клиентский опыт."""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.core.navigation import (
    build_chat_greeting_context,
    get_chat_domains_for_page,
    get_knowledge_bases_as_dicts,
    get_nav_items_for_user,
)
from app.core.templating import render_template

router = APIRouter()

DOMAIN_NAME = "ck_client_exp"
DOMAIN_LABEL = "ЦК Клиентский опыт"


def _user_has_access(roles: list[dict]) -> bool:
    if any(r["name"] == "Администратор" for r in roles):
        return True
    return any((r.get("domain_name") or "") == DOMAIN_NAME for r in roles)


@router.get("/ck-client-experience", response_class=HTMLResponse)
async def show_ck_client_experience(
    request: Request,
    roles: list[dict] = Depends(get_user_roles),
    username: str = Depends(get_username),
):
    """Страница ЦК Клиентский опыт — без роли показывает «нет доступа»."""
    nav_groups = get_nav_items_for_user(roles)
    is_admin = any(r["name"] == "Администратор" for r in roles)
    user_domains = sorted({r.get("domain_name") for r in roles if r.get("domain_name")})
    chat_greeting = await build_chat_greeting_context(roles, username)

    if not _user_has_access(roles):
        return await render_template(
            request,
            "portal/no_access.html",
            {
                "active_page": "ck_client_experience",
                "topbar_title": DOMAIN_LABEL,
                "nav_groups": nav_groups,
                "is_admin": is_admin,
                "user_domains": user_domains,
                "username": username,
                "chat_domains": None,
                "chat_greeting": chat_greeting,
                "knowledge_bases": get_knowledge_bases_as_dicts(),
            },
        )

    return await render_template(
        request,
        "portal/ck/ck_client_experience.html",
        {
            "active_page": "ck_client_experience",
            "topbar_title": DOMAIN_LABEL,
            "nav_groups": nav_groups,
            "is_admin": is_admin,
            "user_domains": user_domains,
            "chat_domains": get_chat_domains_for_page("ck_client_experience"),
            "chat_greeting": chat_greeting,
            "knowledge_bases": get_knowledge_bases_as_dicts(),
        },
    )
