"""
Shared эндпоинты API v1.

Доменные эндпоинты живут в app/domains/*/api/.
"""

from app.api.v1.endpoints.admin_diagnostics import router as admin_diagnostics
from app.api.v1.endpoints.roles import router as roles
from app.api.v1.endpoints.system import router as system

__all__ = [
    "admin_diagnostics",
    "roles",
    "system",
]
