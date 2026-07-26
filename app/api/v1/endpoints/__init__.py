"""
Shared эндпоинты API v1.

Auth-эндпоинты теперь живут в app/domains/auth/api/ (регистрируются
через domain_registry). Старый ``app.api.v1.endpoints.auth`` оставлен
как re-export-обёртка для обратной совместимости (app/routes/portal.py
импортирует оттуда extract_username_digits/get_current_user_from_env).
"""

from app.api.v1.endpoints.admin_diagnostics import router as admin_diagnostics
from app.api.v1.endpoints.roles import router as roles
from app.api.v1.endpoints.system import router as system

__all__ = [
    "admin_diagnostics",
    "roles",
    "system",
]
