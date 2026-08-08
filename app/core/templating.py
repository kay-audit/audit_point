"""Singleton Jinja2Templates для всех роутов приложения."""

from functools import lru_cache

from fastapi.templating import Jinja2Templates

from app.core.config import get_settings


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
    version = get_settings().app_version
    templates.env.globals["app_version"] = version
    # Для условных элементов шаблонов (кнопка «Выйти» видна только в ОТП-режиме).
    templates.env.globals["auth_enabled"] = get_settings().auth.enabled
    templates.env.filters["versioned"] = lambda u: _versioned(str(u), version)
    return templates
