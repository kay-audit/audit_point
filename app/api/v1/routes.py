"""
Главный роутер для API версии 1.

Содержит только shared эндпоинты (auth, system).
Доменные эндпоинты регистрируются через domain_registry.
"""

from fastapi import APIRouter

from app.api.v1.endpoints import admin_diagnostics, roles, system
from app.auth.router import router as auth_router

# Создание главного роутера для API v1
api_router = APIRouter()

# Shared роутеры (доменные регистрируются через auto-discovery)
ROUTERS = [
    (auth_router, "/auth", ["Авторизация"]),
    (system, "/system", ["Системные операции"]),
    (roles, "/roles", ["Роли пользователей"]),
    (admin_diagnostics, "/admin/diagnostics", ["Администрирование"]),
]

# Подключение shared роутеров
for router, prefix, tags in ROUTERS:
    api_router.include_router(router, prefix=prefix, tags=tags)
