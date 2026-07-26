"""HTML-роуты auth-домена: страница /login."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from app.core.templating import get_templates

logger = logging.getLogger("audit_workstation.domains.auth.routes")

templates = get_templates()
router = APIRouter()


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    """Страница входа. Если уже залогинен — редирект на главную."""
    from app.domains.auth.api import get_current_username

    username = await get_current_username(request)
    if username:
        return RedirectResponse(url="/", status_code=302)

    return templates.TemplateResponse(
        request,
        "auth/login.html",
        {
            "active_page": "login",
            "topbar_title": "Вход в систему",
        },
    )


def get_html_routers() -> list[APIRouter]:
    return [router]
