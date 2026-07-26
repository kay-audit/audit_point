"""HTML-роут страницы управления актами."""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.core.navigation import get_chat_domains_for_page, get_knowledge_bases_as_dicts, get_nav_items_for_user
from app.core.templating import render_template

router = APIRouter()


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
            "is_admin": any(r["name"] == "Админ" for r in roles),
            "user_domains": sorted({r.get("domain_name") for r in roles if r.get("domain_name")}),
            "username": username,
            "chat_domains": get_chat_domains_for_page("acts"),
            "knowledge_bases": get_knowledge_bases_as_dicts(),
        }
    )
