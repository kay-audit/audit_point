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
        """Поиск по ФИО (ILIKE) или логину (LIKE)."""
        pattern = self._build_pattern(query)
        rows = await self.conn.fetch(
            f"""
            SELECT username, fullname, job FROM (
                SELECT DISTINCT ON (username)
                       username,
                       COALESCE(fullname, '') AS fullname,
                       COALESCE(job, '') AS job
                FROM {self.user_table}
                WHERE fullname ILIKE $1 OR username LIKE $2
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
        """Считает количество DISTINCT username, удовлетворяющих фильтру."""
        pattern = self._build_pattern(query)
        return await self.conn.fetchval(
            f"""
            SELECT COUNT(*) FROM (
                SELECT DISTINCT username
                FROM {self.user_table}
                WHERE fullname ILIKE $1 OR username LIKE $2
            ) sub
            """,
            pattern,
            pattern,
        )

    # -------------------------------------------------------------------------
    # ТОЧЕЧНЫЙ ПОИСК ОДНОГО ПОЛЬЗОВАТЕЛЯ
    #
    # Используется слоем авторизации (app/auth) при входе по ОТП и при сборке
    # контекста пользователя. Живёт здесь, а не в app/auth, чтобы форма
    # справочника описывалась в одном месте: строк на username в справочнике
    # может быть несколько (запись на каждую должность), поэтому обе выборки
    # схлопывают дубли через DISTINCT ON и возвращают ровно одну строку.
    # -------------------------------------------------------------------------

    async def find_by_username(self, username: str) -> dict | None:
        """Возвращает пользователя справочника по логину (точное совпадение)."""
        row = await self.conn.fetchrow(
            f"""
            SELECT DISTINCT ON (username)
                   username,
                   COALESCE(email, '') AS email,
                   COALESCE(fullname, '') AS fullname
            FROM {self.user_table}
            WHERE username = $1
            ORDER BY username
            LIMIT 1
            """,
            username,
        )
        return dict(row) if row else None

    async def find_by_email(self, email: str) -> dict | None:
        """Возвращает пользователя справочника по email.

        Сравнение без учёта регистра и окружающих пробелов — в справочнике
        почта заполняется людьми и приходит в произвольном виде.
        """
        row = await self.conn.fetchrow(
            f"""
            SELECT username, email, fullname
            FROM (
                SELECT DISTINCT ON (username)
                       username,
                       COALESCE(email, '') AS email,
                       COALESCE(fullname, '') AS fullname
                FROM {self.user_table}
                WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
                ORDER BY username
            ) sub
            LIMIT 1
            """,
            email,
        )
        return dict(row) if row else None
