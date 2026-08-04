"""
Общий модуль проверки доступа для сервисов актов.

AccessGuard инкапсулирует проверки доступа, прав редактирования
и владения блокировкой. Используется всеми сервисами домена актов.
"""

from app.domains.acts.exceptions import AccessDeniedError, ActLockError, InsufficientRightsError, ManagementRoleRequiredError
from app.domains.acts.repositories.act_access import ActAccessRepository
from app.domains.acts.repositories.act_lock import ActLockRepository


class AccessGuard:
    """Проверки доступа и прав пользователя к актам."""

    def __init__(
        self,
        access_repo: ActAccessRepository,
        lock_repo: ActLockRepository,
    ):
        self._access = access_repo
        self._lock = lock_repo

    async def require_access(self, act_id: int, username: str) -> None:
        """Бросает AccessDeniedError если пользователь не имеет доступа."""
        has_access = await self._access.check_user_access(act_id, username)
        if not has_access:
            raise AccessDeniedError("Нет доступа к акту")

    async def require_edit_permission(self, act_id: int, username: str) -> dict:
        """
        Бросает AccessDeniedError/InsufficientRightsError если нет прав.

        Returns:
            dict с полями has_access, can_edit, role
        """
        permission = await self._access.get_user_edit_permission(act_id, username)
        if not permission["has_access"]:
            raise AccessDeniedError("Нет доступа к акту")
        if not permission["can_edit"]:
            raise InsufficientRightsError(
                "Недостаточно прав для редактирования. "
                "Роль 'Участник' имеет доступ только для просмотра."
            )
        return permission

    async def require_management_role(self, act_id: int, username: str) -> dict:
        """
        Требует роль Куратор или Руководитель.

        Returns:
            dict с полями has_access, can_edit, role
        """
        permission = await self._access.get_user_edit_permission(act_id, username)
        if not permission["has_access"]:
            raise AccessDeniedError("Нет доступа к акту")
        if permission["role"] not in ("Куратор", "Руководитель"):
            raise ManagementRoleRequiredError(
                "Доступно только для Куратора и Руководителя"
            )
        return permission

    async def require_lock_owner(self, act_id: int, username: str) -> None:
        """Бросает ActLockError если пользователь не владеет активной блокировкой.

        Проверяется и срок: истёкший лок не даёт права на запись (H9, TOCTOU) —
        иначе после истечения срока и перехвата лока другим пользователем
        обе стороны могли бы писать одновременно (lost-write).
        """
        lock_info = await self._lock.get_lock_info(act_id)
        if not lock_info or not lock_info["locked_by"]:
            raise ActLockError("Акт не заблокирован. Откройте акт для редактирования.")
        if lock_info["locked_by"] != username:
            raise ActLockError(
                f"Акт редактируется пользователем {lock_info['locked_by']}",
                locked_by=lock_info["locked_by"],
                locked_until=str(lock_info["lock_expires_at"]),
            )
