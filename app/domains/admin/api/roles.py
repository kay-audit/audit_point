"""
API эндпоинты для администрирования ролей.

Проверка прав администратора: defence-in-depth — require_admin применяется
и на уровне include_router (domain_registry), и на каждом эндпоинте.
"""

import logging

from fastapi import APIRouter, Depends, Query

logger = logging.getLogger("audit_workstation.api.admin.roles")

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import invalidate_user_roles_cache, require_admin
from app.core.responses import PaginatedResponse
from app.domains.admin.deps import get_admin_service
from app.domains.admin.schemas.admin import (
    AuditLogEntry,
    RoleAssignRequest,
    RoleSchema,
    UserDirectoryItem,
    UserRolesResponse,
    UserSearchResult,
)
from app.domains.admin.services.admin_service import AdminService

_admin = Depends(require_admin())

router = APIRouter()


@router.get("/roles", response_model=PaginatedResponse[RoleSchema], dependencies=[_admin])
async def list_roles(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    service: AdminService = Depends(get_admin_service),
):
    """Возвращает список всех ролей системы."""
    items, total = await service.get_all_roles(limit=limit, offset=offset)
    return PaginatedResponse[RoleSchema](
        items=items, total=total, limit=limit, offset=offset,
    )


@router.get("/users/directory", response_model=PaginatedResponse[UserDirectoryItem], dependencies=[_admin])
async def get_user_directory(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    q: str = Query("", description="Поиск по ФИО, логину, email"),
    service: AdminService = Depends(get_admin_service),
):
    """Возвращает справочник пользователей с назначенными ролями.

    При непустом ``q`` фильтрует справочник по подстроке (ФИО/логин/email)
    на стороне БД — поиск охватывает весь справочник, а не только загруженную
    страницу.
    """
    items, total = await service.get_user_directory(
        limit=limit, offset=offset, query=q or None,
    )
    return PaginatedResponse[UserDirectoryItem](
        items=items, total=total, limit=limit, offset=offset,
    )


@router.get("/users/search", response_model=PaginatedResponse[UserSearchResult], dependencies=[_admin])
async def search_users(
    q: str = "",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    service: AdminService = Depends(get_admin_service),
):
    """Поиск пользователей в справочнике для добавления в систему."""
    items, total = await service.search_users(q, limit=limit, offset=offset)
    return PaginatedResponse[UserSearchResult](
        items=items, total=total, limit=limit, offset=offset,
    )


@router.get("/users/{username}/roles", response_model=UserRolesResponse, dependencies=[_admin])
async def get_user_roles(
    username: str,
    service: AdminService = Depends(get_admin_service),
):
    """Возвращает роли указанного пользователя."""
    return await service.get_user_roles(username)


@router.post("/users/{username}/roles", status_code=200, dependencies=[_admin])
async def assign_role(
    username: str,
    body: RoleAssignRequest,
    admin_username: str = Depends(get_username),
    service: AdminService = Depends(get_admin_service),
):
    """Назначает роль пользователю."""
    assigned = await service.assign_role(username, body.role_id, admin_username)
    if assigned:
        await invalidate_user_roles_cache(username)
        logger.info("Роль id=%s назначена пользователю %s админом %s", body.role_id, username, admin_username)
    return {
        "assigned": assigned,
        "detail": "Роль назначена" if assigned else "Роль уже назначена",
    }


@router.delete("/users/{username}/roles/{role_id}", status_code=200, dependencies=[_admin])
async def remove_role(
    username: str,
    role_id: int,
    admin_username: str = Depends(get_username),
    service: AdminService = Depends(get_admin_service),
):
    """Снимает роль с пользователя."""
    removed = await service.remove_role(username, role_id, admin_username)
    if removed:
        await invalidate_user_roles_cache(username)
        logger.info("Роль id=%s снята с пользователя %s админом %s", role_id, username, admin_username)
    return {
        "removed": removed,
        "detail": "Роль снята" if removed else "Роль не была назначена",
    }


@router.get("/audit-log", response_model=PaginatedResponse[AuditLogEntry], dependencies=[_admin])
async def get_audit_log(
    action: str | None = Query(None, description="Фильтр по типу операции"),
    target_username: str | None = Query(None, description="Фильтр по целевому пользователю"),
    admin_username: str | None = Query(None, description="Фильтр по администратору"),
    from_date: str | None = Query(None, description="Начало периода (YYYY-MM-DD)"),
    to_date: str | None = Query(None, description="Конец периода (YYYY-MM-DD)"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    service: AdminService = Depends(get_admin_service),
):
    """Возвращает аудит-лог операций администрирования."""
    items, total = await service.get_audit_log(
        action=action,
        target_username=target_username,
        admin_username=admin_username,
        from_date=from_date,
        to_date=to_date,
        limit=limit,
        offset=offset,
    )
    return PaginatedResponse[AuditLogEntry](
        items=items, total=total, limit=limit, offset=offset,
    )
