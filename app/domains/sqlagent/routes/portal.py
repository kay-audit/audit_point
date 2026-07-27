"""HTML-роут страницы SQL-агента: iframe на отдельный процесс SQLAgent
или заглушка для placeholder-инструмента (?tool=xxx).

Когда ``?tool=`` не задан — это родная страница SQL-агента:
- если sidecar-процесс SQLAgent запущен → iframe на него;
- иначе → заглушка «SQL-агент в разработке».

Когда ``?tool=xxx`` задан — это один из placeholder-инструментов
блока Аналитика (ИОР, CRM, Документы, Источники данных,
JIRA|BB|Confluence, Follow UP). Показываем заглушку с описанием этого
инструмента. Sidecar SQLAgent не проверяем — он тут не нужен.
"""

import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.api.v1.endpoints.auth import get_current_user_from_env
from app.core.config import get_settings
from app.core.navigation import (
    build_chat_greeting_context,
    get_knowledge_bases_as_dicts,
    get_nav_items_for_user,
)
from app.core.settings_registry import get as get_domain_settings
from app.core.templating import get_templates
from app.domains.sqlagent.placeholders import get_placeholder_paragraphs
from app.domains.sqlagent.settings import SQLAgentSettings

templates = get_templates()

router = APIRouter()


def _build_sqlagent_src(sidecar_port: int) -> str | None:
    """URL встраиваемого UI SQLAgent — абсолютный путь от origin-корня.

    Под Greenplum/JupyterHub-proxy SQLAgent доступен соседним проксированным
    портом того же origin (`/user/{user}/proxy/{port}/`) — зеркало логики
    root_path в app/main.py; это **same-origin**, поэтому проходит под
    enforce-CSP `default-src 'self'`. На локальном dev (PostgreSQL) — отдельный
    localhost-порт: это **cross-origin** (другой порт), и под включённой CSP
    (нет `frame-src`/`child-src` → фолбэк на `default-src 'self'`) iframe будет
    заблокирован. Для PG-dev тогда нужен `SECURITY__CSP_*`-релакс (frame-src на
    порт sidecar) или report-only.

    Возвращает None, если на Greenplum-пути не удалось определить пользователя —
    собрать валидный proxy-URL нечем; роут трактует это как «недоступен».
    """
    app_settings = get_settings()
    if app_settings.database.type == "greenplum":
        user = get_current_user_from_env(truncate=False)
        if not user:
            return None
        return f"/user/{user}/proxy/{sidecar_port}/"
    return f"http://localhost:{sidecar_port}/"


async def _is_sidecar_up(port: int, timeout: float = 0.5) -> bool:
    """Слушает ли процесс SQLAgent свой порт (быстрый TCP-connect к localhost).

    По результату страница отдаёт либо iframe, либо баннер «недоступен» вместо
    браузерной заглушки о разорванном соединении. Порт проверяется на localhost
    (процесс живёт в том же контейнере) независимо от того, как до него идёт
    браузер — напрямую или через JupyterHub-proxy.
    """
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", port), timeout=timeout
        )
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass
    return True


def _find_nav_item(roles: list[dict], tool: str) -> dict | None:
    """Найти NavItem по active_page (``sqlagent-xxx``) для placeholder-инструмента.

    Используется, чтобы показать пользователю корректный title/subtitle/icon
    (из самого доменного дескриптора), а не дублировать их в placeholders.py.
    """
    from app.core.domain_registry import get_all_domains

    target = f"sqlagent-{tool}"
    for d in get_all_domains():
        for nav in d.nav_items:
            if nav.active_page == target:
                return {
                    "label": nav.label,
                    "description": nav.description,
                    "icon_svg": nav.icon_svg,
                    "active_page": nav.active_page,
                }
    return None


@router.get("/sqlagent", response_class=HTMLResponse)
async def show_sqlagent(
    request: Request,
    roles: list[dict] = Depends(get_user_roles),
    username: str = Depends(get_username),
):
    """Страница SQL-агента: iframe на родной UI SQLAgent либо заглушка
    placeholder-инструмента (?tool=xxx), либо баннер «недоступен».
    """
    sa_settings = get_domain_settings("sqlagent", SQLAgentSettings)
    chat_greeting = await build_chat_greeting_context(roles, username)

    # 1) Placeholder-инструмент блока Аналитика (?tool=xxx).
    #    Всегда показываем заглушку — sidecar SQLAgent тут не при чём.
    tool = request.query_params.get("tool")
    if tool:
        nav = _find_nav_item(roles, tool)
        # Если NavItem не найден — фолбэк на общую заглушку SQL-агента.
        if nav is None:
            return await _show_sqlagent_unavailable(
                request, roles, sa_settings, tool=None, chat_greeting=chat_greeting,
            )
        return templates.TemplateResponse(
            request,
            "portal/sqlagent/embed.html",
            {
                "active_page": nav["active_page"],
                "topbar_title": nav["label"],
                "nav_groups": get_nav_items_for_user(roles),
                "is_admin": any(r["name"] == "Администратор" for r in roles),
                "chat_domains": None,
                "chat_greeting": chat_greeting,
                "knowledge_bases": get_knowledge_bases_as_dicts(),
                "sqlagent_available": False,
                "sqlagent_port": sa_settings.sidecar_port,
                "sqlagent_src": None,
                "placeholder": {
                    "title": nav["label"],
                    "subtitle": nav["description"],
                    "icon_svg": nav["icon_svg"],
                    "paragraphs": get_placeholder_paragraphs(tool),
                },
            },
        )

    # 2) Родная страница SQL-агента: iframe или заглушка по состоянию sidecar.
    src = _build_sqlagent_src(sa_settings.sidecar_port)
    available = (
        sa_settings.enabled
        and src is not None
        and await _is_sidecar_up(sa_settings.sidecar_port)
    )

    if available:
        return templates.TemplateResponse(
            request,
            "portal/sqlagent/embed.html",
            {
                "active_page": "sqlagent",
                "topbar_title": "SQL-агент",
                "nav_groups": get_nav_items_for_user(roles),
                "is_admin": any(r["name"] == "Администратор" for r in roles),
                "chat_domains": None,
                "chat_greeting": chat_greeting,
                "knowledge_bases": get_knowledge_bases_as_dicts(),
                "sqlagent_available": True,
                "sqlagent_port": sa_settings.sidecar_port,
                "sqlagent_src": src,
            },
        )

    # SQL-агент недоступен (sidecar не запущен) — показываем его же заглушку.
    return await _show_sqlagent_unavailable(
        request, roles, sa_settings, tool=None, chat_greeting=chat_greeting,
    )


async def _show_sqlagent_unavailable(
    request: Request,
    roles: list[dict],
    sa_settings: SQLAgentSettings,
    tool: str | None,
    chat_greeting: dict | None = None,
) -> HTMLResponse:
    """Заглушка «SQL-агент недоступен / в разработке» с полным текстом.

    Используется в двух случаях:
    1) ``?tool=`` не задан, но sidecar-процесс не отвечает.
    2) ``?tool=xxx`` задан, но NavItem с таким active_page не найден.
    """
    from app.core.domain_registry import get_all_domains

    nav = None
    for d in get_all_domains():
        for n in d.nav_items:
            if n.active_page == "sqlagent" and d.name == "sqlagent":
                nav = {
                    "label": n.label,
                    "description": n.description,
                    "icon_svg": n.icon_svg,
                }
                break
        if nav:
            break

    if nav is None:
        nav = {"label": "SQL-агент", "description": "", "icon_svg": ""}

    return templates.TemplateResponse(
        request,
        "portal/sqlagent/embed.html",
        {
            "active_page": "sqlagent",
            "topbar_title": "SQL-агент",
            "nav_groups": get_nav_items_for_user(roles),
            "is_admin": any(r["name"] == "Администратор" for r in roles),
            "chat_domains": None,
            "chat_greeting": chat_greeting or {},
            "knowledge_bases": get_knowledge_bases_as_dicts(),
            "sqlagent_available": False,
            "sqlagent_port": sa_settings.sidecar_port,
            "sqlagent_src": None,
            "placeholder": {
                "title": nav["label"],
                "subtitle": nav["description"],
                "icon_svg": nav["icon_svg"],
                "paragraphs": get_placeholder_paragraphs("sqlagent"),
            },
        },
    )
