"""Singleton Jinja2Templates для всех роутов приложения."""

import logging
import subprocess
from functools import lru_cache
from pathlib import Path

from fastapi import Request
from fastapi.templating import Jinja2Templates

from app.core.config import get_settings

logger = logging.getLogger("audit_workstation.templating")


def _resolve_app_version() -> str:
    """Определяет версию приложения для cache-busting статики.

    Приоритет источников:
      1. ``APP_VERSION`` из настроек (env), если значение не дефолтное.
      2. Короткий git-хеш ``HEAD`` (``git rev-parse --short HEAD``).
      3. Строка ``"dev"`` если git недоступен.

    Дефолтное значение настроек (``"1.0.0"``) считается заглушкой и
    игнорируется в пользу git-хеша — так за каждый коммит фронт получит
    новые версионированные URL без ручного bump'а APP_VERSION.
    """
    settings = get_settings()
    env_version = settings.app_version
    if env_version and env_version != "1.0.0":
        return env_version

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=Path(__file__).resolve().parent.parent.parent,
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if result.returncode == 0:
            commit = result.stdout.strip()
            if commit:
                return commit
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        pass

    return "dev"


def _versioned(url: str, version: str) -> str:
    """Дописывает ``?v=<version>`` к URL для cache-busting статики.

    Использует ``&`` если у URL уже есть query-параметр (на случай прокси,
    добавляющего параметры в ``url_for``).
    """
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}v={version}"


async def get_current_user_dict(request: Request) -> dict | None:
    """Возвращает инфу о текущем пользователе (из сессионной cookie).

    None если не залогинен или при ошибке. Используется в render_template
    для прокидывания current_user в контекст шаблона (ФИО/должность/логин
    в topbar — единообразно на всех страницах).
    """
    try:
        from app.api.v1.deps.auth_deps import get_current_username
        from app.db.connection import get_db
        from app.domains.auth.services.auth_service import AuthService

        username = await get_current_username(request)
        if not username:
            return None
        async with get_db() as conn:
            svc = AuthService(conn)
            return await svc.build_me(username)
    except Exception as e:
        logger.debug("get_current_user_dict failed: %s", e)
        return None


async def render_template(request: Request, template_name: str, context: dict | None = None,
                          **response_kwargs):
    """Обёртка над templates.TemplateResponse: автоматически добавляет
    current_user (FIO/должность/логин) в контекст, чтобы topbar был
    единообразным на всех страницах.
    """
    from starlette.responses import HTMLResponse
    templates = get_templates()
    context = dict(context or {})
    if "current_user" not in context:
        context["current_user"] = await get_current_user_dict(request)
    return templates.TemplateResponse(request, template_name, context, **response_kwargs)


@lru_cache(maxsize=1)
def get_templates() -> Jinja2Templates:
    """Возвращает единственный экземпляр Jinja2Templates.

    Регистрирует глобал ``app_version`` и фильтр ``versioned`` для
    cache-busting статических ресурсов в шаблонах.
    """
    templates = Jinja2Templates(directory=str(get_settings().templates_dir))
    version = _resolve_app_version()
    templates.env.globals["app_version"] = version
    templates.env.filters["versioned"] = lambda u: _versioned(str(u), version)
    return templates
