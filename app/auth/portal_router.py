from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from app.core.templating import get_templates
import logging

logger = logging.getLogger("audit_workstation.auth.portal_router")

router = APIRouter()

# Получаем единственный экземпляр шаблонов из core.templating (singleton)
templates = get_templates()


@router.get("/auth/login", response_class=HTMLResponse)
async def login_page(request: Request):
    """Возвращает страницу входа."""
    return templates.TemplateResponse(request, "auth/login.html")


@router.get("/auth/logout", response_class=HTMLResponse)
async def logout_page(request: Request):
    """Возвращает страницу выхода."""
    return templates.TemplateResponse(request, "auth/logout.html")
