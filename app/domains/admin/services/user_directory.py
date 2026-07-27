"""
Сервис справочника пользователей.

Реализует IUserDirectory — публичный интерфейс для поиска пользователей
другими доменами (например, acts). Инкапсулирует AdminSettings внутри
admin-домена.
"""

import logging

from app.core.settings_registry import get as get_domain_settings
from app.db.repositories.base import BaseRepository
from app.domains.admin.settings import AdminSettings

logger = logging.getLogger("audit_workstation.domains.admin.user_directory")


class UserDirectoryRepository(BaseRepository):
    """
    Репозиторий поиска пользователей в справочнике.

    Реализует IUserDirectory. Инициализируется с подключением к БД;
    имя таблицы берётся из AdminSettings внутри admin-домена.
    """

    def __init__(self, conn):
        super().__init__(conn)
        settings = get_domain_settings("admin", AdminSettings)
        ud = settings.user_directory
        self.user_table = self.adapter.qualify_table_name(ud.table, ud.schema_name)

    @staticmethod
    def _build_pattern(query: str) -> str:
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return f"%{escaped}%"

    async def search_users(
        self, query: str, limit: int = 20, offset: int = 0,
    ) -> list[dict]:
        """Поиск по ФИО (ILIKE) или логину (LIKE).

        Исключает пользователей с is_deleted=true — soft-deleted записи
        нельзя добавить в НОВЫЕ акты (они нужны только для отображения
        в админ-панели и сохранения ссылок в уже созданных актах).
        """
        pattern = self._build_pattern(query)
        rows = await self.conn.fetch(
            f"""
            SELECT username, fullname, job, tb FROM (
                SELECT DISTINCT ON (username)
                       username,
                       COALESCE(fullname, '') AS fullname,
                       COALESCE(job, '') AS job,
                       COALESCE(tb, '') AS tb
                FROM {self.user_table}
                WHERE (fullname ILIKE $1 OR username LIKE $2)
                  AND COALESCE(is_deleted, FALSE) = FALSE
                ORDER BY username
            ) sub
            ORDER BY fullname
            LIMIT $3 OFFSET $4
            """,
            pattern,
            pattern,
            limit,
            offset,
        )
        return [dict(r) for r in rows]

    async def count_users(self, query: str) -> int:
        """Считает количество DISTINCT username, удовлетворяющих фильтру.

        Исключает soft-deleted записи — те же правила, что и в search_users.
        """
        pattern = self._build_pattern(query)
        return await self.conn.fetchval(
            f"""
            SELECT COUNT(*) FROM (
                SELECT DISTINCT username
                FROM {self.user_table}
                WHERE (fullname ILIKE $1 OR username LIKE $2)
                  AND COALESCE(is_deleted, FALSE) = FALSE
            ) sub
            """,
            pattern,
            pattern,
        )
