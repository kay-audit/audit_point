"""
Главный роутер для API версии 1.

Содержит shared эндпоинты (system, roles, admin_diagnostics).
Auth-эндпоинты (/api/v1/auth/*) теперь приходят из auth-домена
через domain_registry (см. app/domains/auth/__init__.py).
"""

from fastapi import APIRouter

from app.api.v1.endpoints import admin_diagnostics, roles, system

# Создание главного роутера для API v1
api_router = APIRouter()

# Shared роутеры (auth, chat, acts, ck_* и пр. регистрируются
# автоматически через domain_registry).
ROUTERS = [
    (system, "/system", ["Системные операции"]),
    (roles, "/roles", ["Роли пользователей"]),
    (admin_diagnostics, "/admin/diagnostics", ["Администрирование"]),
]

# Подключение shared роутеров
for router, prefix, tags in ROUTERS:
    api_router.include_router(router, prefix=prefix, tags=tags)
