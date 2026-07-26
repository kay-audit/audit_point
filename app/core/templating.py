"""Singleton Jinja2Templates для всех роутов приложения."""

import logging
import subprocess
from functools import lru_cache
from pathlib import Path

from fastapi import Request
from fastapi.templating import Jinja2Templates

from app.core.config import get_settings

logger = logging.getLogger("audit_workstation.templating")


def _static_max_mtime(static_dir: Path) -> float:
    """Рекурсивно ищет максимальный mtime всех файлов в static/.

    Используется как cache-busting fingerprint: меняется при любой правке
    CSS/JS, без необходимости коммитить и перезапускать сервер.
    """
    if not static_dir.exists():
        return 0.0
    latest = 0.0
    try:
        for p in static_dir.rglob("*"):
            if p.is_file():
                m = p.stat().st_mtime
                if m > latest:
                    latest = m
    except OSError as e:
        logger.debug("static_max_mtime failed: %s", e)
    return latest


def _resolve_app_version() -> str:
    """Определяет cache-busting-токен для статики (CSS/JS).

    Композитный fingerprint, чтобы фронт ВСЕГДА подхватывал свежие правки:

      1. ``APP_VERSION`` из настроек, если задан явно (env).
      2. Иначе: ``<git_short_hash>-<static_mtime_int>`` — и коммит,
         и время последней правки любого файла в static/.
         При правке CSS без коммита mtime меняется → новая версия → браузер
         скачает обновлённый файл. При коммите меняется hash → то же.
      3. Fallback: ``"dev"`` если git недоступен.

    Дефолт ``"1.0.0"`` из .env считается заглушкой и игнорируется.
    """
    settings = get_settings()
    env_version = settings.app_version
    if env_version and env_version != "1.0.0":
        return env_version

    parts: list[str] = []
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
                parts.append(commit)
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        pass

    static_dir = Path(__file__).resolve().parent.parent.parent / "static"
    mtime = _static_max_mtime(static_dir)
    if mtime > 0:
        parts.append(str(int(mtime)))

    return "-".join(parts) if parts else "dev"


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


# Без lru_cache — каждый вызов создаёт свежий Jinja2Templates с актуальной
# версией. Создание Environment дешёвое, а зато любые правки static/ дают
# новую версию мгновенно (lru_cache пришлось бы сбрасывать рестартом).
def get_templates() -> Jinja2Templates:
    """Возвращает экземпляр Jinja2Templates с актуальной версией.

    Глобал ``app_version`` и фильтр ``versioned`` оба динамические —
    каждый вызов TemplateResponse резолвит версию заново через
    ``_resolve_app_version()`` (git hash + mtime static/). Это гарантирует,
    что после правки CSS/JS фронт получает новые URL без перезапуска.
    """
    templates = Jinja2Templates(directory=str(get_settings().templates_dir))
    version = _resolve_app_version()
    # Сохраняем актуальную версию в момент создания templates. Jinja
    # кеширует env, но при следующем вызове get_templates() мы создаём
    # новый templates-объект с новой версией.
    templates.env.globals["app_version"] = version
    templates.env.filters["versioned"] = lambda u: _versioned(str(u), version)
    return templates
