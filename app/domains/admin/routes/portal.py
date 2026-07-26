"""HTML-роут страницы администрирования."""

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.core.navigation import get_chat_domains_for_page, get_knowledge_bases_as_dicts, get_nav_items_for_user
from app.core.templating import render_template

router = APIRouter()


@router.get("/admin", response_class=HTMLResponse)
async def show_admin_page(
    request: Request,
    roles: list[dict] = Depends(get_user_roles),
    username: str = Depends(get_username),
):
    """
    Страница администрирования.

    Доступ только для пользователей с ролью «Админ». Прочие
    перенаправляются на /portal/acts (303), чтобы не показывать
    пустой шаблон с сообщением «Не удалось загрузить данные
    администрирования» (API возвращает 403 для всех вложенных вызовов).
    """
    is_admin = any(r.get("name") == "Админ" for r in roles)
    if not is_admin:
        return RedirectResponse(url="/portal/acts", status_code=303)

    return await render_template(
        request,
        "portal/admin/admin.html",
        {
            "active_page": "admin",
            "topbar_title": "Администрирование",
            "nav_groups": get_nav_items_for_user(roles),
            "is_admin": True,
            "user_domains": ["admin"],
            "username": username,
            "chat_domains": get_chat_domains_for_page("admin"),
            "knowledge_bases": get_knowledge_bases_as_dicts(),
        }
    )
