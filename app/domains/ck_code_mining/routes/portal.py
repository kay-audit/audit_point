"""HTML-роут страницы ЦК Code Mining.

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
    get_chat_domains_for_page,
    get_knowledge_bases_as_dicts,
    get_nav_items_for_user,
)
from app.core.templating import render_template

router = APIRouter()

DOMAIN_NAME = "ck_code_mining"
DOMAIN_LABEL = "ЦК Code Mining"


def _user_has_access(roles: list[dict]) -> bool:
    if any(r["name"] == "Администратор" for r in roles):
        return True
    return any((r.get("domain_name") or "") == DOMAIN_NAME for r in roles)


@router.get("/ck-code-mining", response_class=HTMLResponse)
async def show_ck_code_mining(
    request: Request,
    roles: list[dict] = Depends(get_user_roles),
    username: str = Depends(get_username),
):
    """Страница ЦК Code Mining — без роли показывает «нет доступа».

    Для пользователей с ролью в домене показывается карточка-плейсхолдер
    с описанием ЦК Code Mining. Контент страницы — статический (стадия
    «в разработке»), полноценная логика будет добавлена позднее.
    """
    nav_groups = get_nav_items_for_user(roles)
    is_admin = any(r["name"] == "Администратор" for r in roles)
    user_domains = sorted({r.get("domain_name") for r in roles if r.get("domain_name")})

    if not _user_has_access(roles):
        return await render_template(
            request,
            "portal/no_access.html",
            {
                "active_page": "ck_code_mining",
                "topbar_title": DOMAIN_LABEL,
                "nav_groups": nav_groups,
                "is_admin": is_admin,
                "user_domains": user_domains,
                "username": username,
                "chat_domains": None,
                "knowledge_bases": get_knowledge_bases_as_dicts(),
            },
        )

    return await render_template(
        request,
        "portal/ck/_ck_placeholder.html",
        {
            "active_page": "ck_code_mining",
            "topbar_title": DOMAIN_LABEL,
            "nav_groups": nav_groups,
            "is_admin": is_admin,
            "user_domains": user_domains,
            "username": username,
            "chat_domains": get_chat_domains_for_page("ck_code_mining"),
            "knowledge_bases": get_knowledge_bases_as_dicts(),
            "placeholder": {
                "title": DOMAIN_LABEL,
                "subtitle": (
                    "Центр компетенций по анализу исходного кода "
                    "проверяемых систем (code mining)"
                ),
                "lead": (
                    "Информация о работе ЦК Code Mining, ссылки на инструменты, "
                    "инструкции, дэшборды и результаты анализа кейсов группой экспертов."
                ),
                "icon_svg": (
                    # иконка «</>» — символ исходного кода
                    '<path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 '
                    '00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" '
                    'stroke="currentColor" stroke-width="2" '
                    'stroke-linecap="round" stroke-linejoin="round"/>'
                ),
            },
        },
    )
