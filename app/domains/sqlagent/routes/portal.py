"""HTML-роут страницы SQL-агента: iframe на отдельный процесс SQLAgent."""

import asyncio

from fastapi import APIRouter, Depends, Request, HTTPException
from fastapi.responses import HTMLResponse

from app.api.v1.deps.role_deps import get_user_roles
from app.auth.dependencies import get_current_user
from app.core.config import get_settings
from app.core.navigation import get_knowledge_bases_as_dicts, get_nav_items_for_user
from app.core.settings_registry import get as get_domain_settings
from app.core.templating import get_templates
from app.domains.sqlagent.settings import SQLAgentSettings
from fastapi import HTTPException

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
        try:
            user = get_current_user(Depends())
        except HTTPException:
            return None

        # Если возвращен RedirectResponse, пропускаем дальнейшую обработку
        if hasattr(user, "status_code") and user.status_code == 307:
            return None

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


@router.get("/sqlagent", response_class=HTMLResponse)
async def show_sqlagent(request: Request, roles: list[dict] = Depends(get_user_roles)):
    """Страница SQL-агента: iframe на родной UI SQLAgent либо баннер «недоступен»."""
    sa_settings = get_domain_settings("sqlagent", SQLAgentSettings)
    src = _build_sqlagent_src(sa_settings.sidecar_port)
    available = (
        sa_settings.enabled
        and src is not None
        and await _is_sidecar_up(sa_settings.sidecar_port)
    )
    return templates.TemplateResponse(
        request,
        "portal/sqlagent/embed.html",
        {
            "active_page": "sqlagent",
            "topbar_title": "SQL-агент",
            "nav_groups": get_nav_items_for_user(roles),
            "is_admin": any(r["name"] == "Админ" for r in roles),
            "chat_domains": None,
            "knowledge_bases": get_knowledge_bases_as_dicts(),
            "sqlagent_available": available,
            "sqlagent_port": sa_settings.sidecar_port,
            "sqlagent_src": src,
        },
    )
