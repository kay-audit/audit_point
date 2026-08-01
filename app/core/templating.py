"""Singleton Jinja2Templates для всех роутов приложения."""

import subprocess
from functools import lru_cache
from pathlib import Path

from fastapi.templating import Jinja2Templates

from app.core.config import get_settings


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


@lru_cache(maxsize=1)
def get_templates() -> Jinja2Templates:
    """Возвращает единственный экземпляр Jinja2Templates.

    Регистрирует глобал ``app_version`` и фильтр ``versioned`` для
    cache-busting статических ресурсов в шаблонах.
    """
    templates = Jinja2Templates(directory=str(get_settings().templates_dir))
    version = _resolve_app_version()
    templates.env.globals["app_version"] = version
    # Для условных элементов шаблонов (кнопка «Выйти» видна только в ОТП-режиме).
    templates.env.globals["auth_enabled"] = get_settings().auth.enabled
    templates.env.filters["versioned"] = lambda u: _versioned(str(u), version)
    return templates
