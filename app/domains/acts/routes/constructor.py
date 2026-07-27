"""
HTML-роут конструктора актов.

Содержит маршрут для страницы конструктора с проверкой доступа
пользователя к акту через зависимости авторизации и БД.
"""

import logging

from fastapi import APIRouter, Request, Depends
from fastapi.responses import HTMLResponse, RedirectResponse

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.core.config import get_settings
from app.core.navigation import (
    build_chat_greeting_context,
    get_chat_domains_for_page,
    get_knowledge_bases_as_dicts,
)
from app.core.templating import render_template
from app.db.connection import get_db
from app.domains.acts.repositories import ActAccessRepository

settings = get_settings()
logger = logging.getLogger("audit_workstation.domains.acts.routes.constructor")

router = APIRouter()


@router.get("/constructor", response_class=HTMLResponse)
async def show_constructor(
        request: Request,
        act_id: int,
        username: str = Depends(get_username),
        roles: list[dict] = Depends(get_user_roles),
):
    """
    Страница конструктора конкретного акта.

    Проверяет доступ пользователя к акту ДО рендеринга HTML.
    При отсутствии доступа редиректит на главную страницу (менеджер актов).

    Args:
        request: HTTP запрос
        act_id: ID акта из query параметра
        username: Имя пользователя (из зависимости get_username)
        roles: Роли пользователя (для контекста приветствия AI-ассистента)

    Returns:
        HTML страница конструктора или редирект на /

    Raises:
        RedirectResponse: 302 редирект на / при отсутствии доступа
    """
    async with get_db() as conn:
        access = ActAccessRepository(conn)

        has_access = await access.check_user_access(act_id, username)
        if not has_access:
            logger.info(
                f"Пользователь {username} попытался открыть недоступный акт ID={act_id}, "
                f"редирект на менеджер актов"
            )
            return RedirectResponse(url="/acts", status_code=302)

        return await render_template(
            request,
            "constructor/constructor.html",
            {
                "act_id": act_id,
                "chat_domains": get_chat_domains_for_page("acts"),
                "chat_greeting": await build_chat_greeting_context(roles, username),
                "knowledge_bases": get_knowledge_bases_as_dicts(),
            }
        )
