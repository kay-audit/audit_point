from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from app.api.v1.deps.role_deps import get_user_roles
from app.auth.dependencies import get_current_user
from app.auth.middleware import clear_auth_cookies
from app.auth.value_objects import UserContext
from app.core.config import get_settings
from app.core.navigation import get_knowledge_bases_as_dicts, get_nav_items_for_user
from app.core.templating import get_templates
import logging

logger = logging.getLogger("audit_workstation.auth.portal_router")

router = APIRouter()

# Получаем единственный экземпляр шаблонов из core.templating (singleton)
templates = get_templates()


@router.get("/auth/login", response_class=HTMLResponse)
async def login_page(request: Request):
    """Возвращает страницу входа."""
    return templates.TemplateResponse(
        request,
        "auth/login.html",
        {"otp_length": get_settings().auth.otp_length},
    )


@router.get("/auth/logout")
async def logout(request: Request):
    """Выход: очищает JWT-cookie и уводит на страницу входа."""
    response = RedirectResponse(url="/auth/login")
    clear_auth_cookies(response)
    return response


@router.get("/profile", response_class=HTMLResponse)
async def show_profile(
    request: Request,
    user: UserContext = Depends(get_current_user),
    roles: list[dict] = Depends(get_user_roles),
):
    """Страница профиля пользователя: ФИО, должность, логин, email, роли.

    Анонима сюда не пускает уже AuthMiddleware (HTML-путь вне /auth и /static
    редиректит на /auth/login до роута); в тест-режиме get_current_user
    собирает контекст из окружения без похода в БД.
    """
    return templates.TemplateResponse(
        request,
        "portal/profile.html",
        {
            "active_page": "profile",
            "topbar_title": "Профиль",
            "nav_groups": get_nav_items_for_user(roles),
            "is_admin": any(r["name"] == "Админ" for r in roles),
            "chat_domains": None,
            "knowledge_bases": get_knowledge_bases_as_dicts(),
            "profile": user,
        },
    )
