"""
Shared эндпоинт для получения ролей текущего пользователя.

Доступен всем авторизованным пользователям (не требует роли Админ).
"""

from fastapi import APIRouter, Depends

from app.api.v1.deps.auth_deps import get_username
from app.api.v1.deps.role_deps import get_user_roles
from app.schemas.errors import ErrorDetail

router = APIRouter()


@router.get("/my-roles", responses={401: {"description": "Требуется авторизация", "model": ErrorDetail}})
async def get_my_roles(
    username: str = Depends(get_username),
    roles: list[dict] = Depends(get_user_roles),
):
    """Возвращает роли текущего пользователя."""
    return {
        "username": username,
        "roles": roles,
        "is_admin": any(r["name"] == "Администратор" for r in roles),
    }
