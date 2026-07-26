"""
API-эндпоинты для авторизации (LEGACY-модуль).

Все актуальные эндпоинты auth (/login, /logout, /me, /me/password,
/me/change-password, /me/avatar, /admin/users/{u}/reset-password и пр.)
теперь живут в app/domains/auth/api/ и регистрируются через domain_registry
под префиксом /api/v1/auth/.

Этот файл оставлен ради обратной совместимости: re-экспортирует хелперы,
которые импортирует app/routes/portal.py (extract_username_digits,
get_current_user_from_env). Сами эндпоинты удалены, чтобы не было
дубликатов путей в OpenAPI.
"""
from __future__ import annotations

# Re-exports для обратной совместимости
from app.api.v1.deps.auth_deps import (  # noqa: F401
    extract_username_digits,
    get_current_user_from_env,
    get_current_username,
    get_username,
)

# Старый AuthResponse модель — оставлен для импорта в legacy-коде.
from pydantic import BaseModel


class AuthResponse(BaseModel):  # noqa: D401
    """Legacy-совместимая модель ответа /me."""
    authenticated: bool
    username: str | None = None
    display_name: str | None = None
