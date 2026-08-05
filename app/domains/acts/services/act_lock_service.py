"""
Сервис блокировок актов.

Управляет блокировками для эксклюзивного редактирования.
"""

import logging

from app.core.config import Settings
from app.db.types import DbConn
from app.domains.acts.exceptions import ActLockError
from app.domains.acts.repositories.act_access import ActAccessRepository
from app.domains.acts.repositories.act_audit_log import ActAuditLogRepository
from app.domains.acts.repositories.act_lock import ActLockRepository
from app.domains.acts.services.access_guard import AccessGuard
from app.domains.acts.settings import ActsSettings

logger = logging.getLogger("audit_workstation.service.acts.lock")


class ActLockService:
    """Блокировки актов: захват, снятие, продление."""

    def __init__(
        self,
        conn: DbConn,
        settings: Settings,
        *,
        acts_settings: ActsSettings,
        access: ActAccessRepository | None = None,
        lock: ActLockRepository | None = None,
    ):
        self.conn = conn
        self.settings = settings
        self.acts_settings = acts_settings
        self._access = access or ActAccessRepository(conn)
        self._lock = lock or ActLockRepository()
        self.guard = AccessGuard(self._access, self._lock)
        self._audit = ActAuditLogRepository(conn)

    async def lock_act(self, act_id: int, username: str) -> dict:
        """Блокирует акт для редактирования."""
        await self.guard.require_edit_permission(act_id, username)

        duration = self.acts_settings.lock.duration_minutes

        row = await self._lock.atomic_lock_act(act_id, username, duration)
        if row:
            await self._audit.log("lock", username, act_id)
            return {
                "success": True,
                "locked_until": row["lock_expires_at"].isoformat(),
                "message": "Акт заблокирован для редактирования",
            }

        lock_info = await self._lock.get_lock_info(act_id)
        if lock_info and lock_info["locked_by"]:
            raise ActLockError(
                f"Акт редактируется пользователем {lock_info['locked_by']}. "
                f"Попробуйте открыть его позже.",
                locked_by=lock_info["locked_by"],
                locked_until=str(lock_info["lock_expires_at"]),
            )
        raise ActLockError("Не удалось заблокировать акт. Попробуйте позже.")

    async def unlock_act(self, act_id: int, username: str) -> dict:
        """Снимает блокировку с акта."""
        await self.guard.require_access(act_id, username)
        was_unlocked = await self._lock.unlock_act(act_id, username)
        if not was_unlocked:
            raise ActLockError("Вы не владеете блокировкой этого акта")
        await self._audit.log("unlock", username, act_id)
        return {"success": True, "message": "Блокировка снята"}

    async def extend_lock(self, act_id: int, username: str) -> dict:
        """Продлевает блокировку акта."""
        await self.guard.require_edit_permission(act_id, username)

        duration = self.acts_settings.lock.duration_minutes

        result = await self._lock.atomic_extend_lock(act_id, username, duration)

        if result["extended"]:
            return {
                "success": True,
                "locked_until": result["lock_expires_at"].isoformat(),
                "message": "Блокировка продлена",
            }

        # Диагностика на основе атомарно полученного состояния
        if not result["locked_by"]:
            raise ActLockError("Акт не заблокирован")
        if result["locked_by"] != username:
            raise ActLockError("Вы не владеете блокировкой этого акта")
        # locked_by == username, но extend не сработал → блокировка истекла
        raise ActLockError("Блокировка истекла. Откройте акт заново для продолжения работы.")
