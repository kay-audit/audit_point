from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from app.auth.middleware import clear_auth_cookies
from app.core.config import get_settings
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
