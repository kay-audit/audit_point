"""HTML-роут страницы ЦК Process Mining.

Минимальная страница-заглушка (аналогично ck_client_exp/ck_fin_res):
показывает карточку-плейсхолдер с описанием ЦК. Если у пользователя нет
роли в домене — отрисовывается дружелюбная страница «нет доступа»
(см. portal/no_access.html).
"""
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

DOMAIN_NAME = "ck_process_mining"
DOMAIN_LABEL = "ЦК Process Mining"


def _user_has_access(roles: list[dict]) -> bool:
    if any(r["name"] == "Администратор" for r in roles):
        return True
    return any((r.get("domain_name") or "") == DOMAIN_NAME for r in roles)


@router.get("/ck-process-mining", response_class=HTMLResponse)
async def show_ck_process_mining(
    request: Request,
    roles: list[dict] = Depends(get_user_roles),
    username: str = Depends(get_username),
):
    """Страница ЦК Process Mining — без роли показывает «нет доступа».

    Для пользователей с ролью в домене показывается карточка-плейсхолдер
    с описанием ЦК Process Mining. Контент страницы — статический (стадия
    «в разработке»), полноценная логика будет добавлена позднее.
    """
    nav_groups = get_nav_items_for_user(roles)
    is_admin = any(r["name"] == "Администратор" for r in roles)
    user_domains = sorted({r.get("domain_name") for r in roles if r.get("domain_name")})
    chat_greeting = await build_chat_greeting_context(roles, username)

    if not _user_has_access(roles):
        return await render_template(
            request,
            "portal/no_access.html",
            {
                "active_page": "ck_process_mining",
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
        "portal/ck/_ck_placeholder.html",
        {
            "active_page": "ck_process_mining",
            "topbar_title": DOMAIN_LABEL,
            "nav_groups": nav_groups,
            "is_admin": is_admin,
            "user_domains": user_domains,
            "username": username,
            "chat_domains": get_chat_domains_for_page("ck_process_mining"),
            "chat_greeting": chat_greeting,
            "knowledge_bases": get_knowledge_bases_as_dicts(),
            "placeholder": {
                "title": DOMAIN_LABEL,
                "subtitle": (
                    "Центр компетенций по процессной аналитике "
                    "(process mining) проверяемых процессов"
                ),
                "lead": (
                    "Информация о работе ЦК Process Mining, ссылки на инструменты, "
                    "инструкции, дэшборды и результаты анализа кейсов группой экспертов."
                ),
                "icon_svg": (
                    # иконка «граф/схема процесса» — узлы + соединительные линии
                    '<circle cx="5" cy="6" r="2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<circle cx="5" cy="18" r="2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<circle cx="19" cy="6" r="2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<circle cx="19" cy="18" r="2" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<circle cx="12" cy="12" r="2.5" '
                    'stroke="currentColor" stroke-width="2" fill="none"/>'
                    '<line x1="6.5" y1="7.5" x2="10" y2="10.5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="6.5" y1="16.5" x2="10" y2="13.5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="17.5" y1="7.5" x2="14" y2="10.5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                    '<line x1="17.5" y1="16.5" x2="14" y2="13.5" '
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
                ),
            },
        },
    )
