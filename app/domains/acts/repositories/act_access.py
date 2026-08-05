"""
Репозиторий проверки доступа к актам.
"""

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn


class ActAccessRepository(BaseRepository):
    """Проверка доступа и прав пользователя к актам."""

    def __init__(self, conn: DbConn):
        super().__init__(conn)
        self.audit_team = self.adapter.get_table_name("audit_team_members")

    async def check_user_access(self, act_id: int, username: str) -> bool:
        """Проверяет имеет ли пользователь доступ к акту."""
        result = await self.conn.fetchval(
            f"""
            SELECT EXISTS(
                SELECT 1
                FROM {self.audit_team}
                WHERE act_id = $1 AND username = $2
            )
            """,
            act_id,
            username,
        )

        return bool(result)

    async def get_user_edit_permission(self, act_id: int, username: str) -> dict:
        """
        Проверяет права пользователя на редактирование акта.

        Роли с правом редактирования: Куратор, Руководитель, Редактор
        Роль только для просмотра: Участник

        Returns:
            dict с полями:
                - has_access: есть ли доступ к акту
                - can_edit: может ли редактировать
                - role: роль пользователя в команде
        """
        row = await self.conn.fetchrow(
            f"""
            SELECT role FROM {self.audit_team}
            WHERE act_id = $1 AND username = $2
            """,
            act_id,
            username,
        )

        if not row:
            return {"has_access": False, "can_edit": False, "role": None}

        role = row["role"]
        can_edit = role in ("Куратор", "Руководитель", "Редактор")
        return {"has_access": True, "can_edit": can_edit, "role": role}
