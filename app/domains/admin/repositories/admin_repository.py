"""
Репозиторий операций администрирования.
"""

import json
import logging

from app.db.repositories.base import BaseRepository
from app.db.types import DbConn
from app.domains.admin.settings import AdminSettings

logger = logging.getLogger("audit_workstation.db.repository.admin")


class AdminRepository(BaseRepository):
    """Операции с ролями и справочником пользователей."""

    def __init__(self, conn: DbConn, settings: AdminSettings):
        super().__init__(conn)
        self.settings = settings
        self.roles = self.adapter.get_table_name("roles")
        self.user_roles = self.adapter.get_table_name("user_roles")
        self.user_table = self._resolve_user_table()

    def _resolve_user_table(self) -> str:
        """
        Возвращает квалифицированное имя таблицы справочника пользователей.

        Использует qualify_table_name — единый механизм для всех адаптеров.
        """
        ud = self.settings.user_directory
        return self.adapter.qualify_table_name(ud.table, ud.schema_name)

    # -------------------------------------------------------------------------
    # РОЛИ
    # -------------------------------------------------------------------------

    async def get_all_roles(
        self, *, limit: int = 50, offset: int = 0,
    ) -> list[dict]:
        """Возвращает роли с пагинацией."""
        rows = await self.conn.fetch(
            f"""
            SELECT id, name, domain_name, description
            FROM {self.roles}
            ORDER BY id
            LIMIT $1 OFFSET $2
            """,
            limit,
            offset,
        )
        return [dict(r) for r in rows]

    async def count_all_roles(self) -> int:
        """Возвращает общее количество ролей."""
        return await self.conn.fetchval(
            f"SELECT COUNT(*) FROM {self.roles}"
        )

    async def get_role_by_name(self, name: str) -> dict | None:
        """Возвращает роль по имени."""
        row = await self.conn.fetchrow(
            f"SELECT id, name, domain_name, description FROM {self.roles} WHERE name = $1",
            name,
        )
        return dict(row) if row else None

    async def get_role_by_id(self, role_id: int) -> dict | None:
        """Возвращает роль по id."""
        row = await self.conn.fetchrow(
            f"SELECT id, name, domain_name, description FROM {self.roles} WHERE id = $1",
            role_id,
        )
        return dict(row) if row else None

    # -------------------------------------------------------------------------
    # РОЛИ ПОЛЬЗОВАТЕЛЕЙ
    # -------------------------------------------------------------------------

    async def get_user_roles(self, username: str) -> list[dict]:
        """Возвращает список ролей пользователя (JOIN user_roles + roles)."""
        rows = await self.conn.fetch(
            f"""
            SELECT r.id, r.name, r.domain_name, r.description
            FROM {self.user_roles} ur
            JOIN {self.roles} r ON r.id = ur.role_id
            WHERE ur.username = $1
            ORDER BY r.id
            """,
            username,
        )
        return [dict(r) for r in rows]

    async def assign_role(self, username: str, role_id: int, assigned_by: str) -> bool:
        """
        Назначает роль пользователю.

        Возвращает True если роль была назначена, False если уже существует.
        Для PostgreSQL использует ON CONFLICT, для GreenPlum — try/except.
        """
        if self.adapter.supports_on_conflict():
            result = await self.conn.execute(
                f"""
                INSERT INTO {self.user_roles} (username, role_id, assigned_by)
                VALUES ($1, $2, $3)
                ON CONFLICT (username, role_id) DO NOTHING
                """,
                username, role_id, assigned_by,
            )
            return result == "INSERT 0 1"
        else:
            # GreenPlum: UNIQUE(username, role_id) отсутствует (distribution key —
            # id), поэтому except UniqueViolationError тут никогда не сработал бы.
            # INSERT ... WHERE NOT EXISTS одним statement'ом сужает окно гонки на
            # дубль по сравнению с раздельными SELECT+INSERT (без UNIQUE полностью
            # его не закрыть) — тот же идиом, что у seed-ролей в greenplum/schema.sql.
            # Касты $1::varchar/$2::bigint ОБЯЗАТЕЛЬНЫ: $1/$2 встречаются и в
            # SELECT-листе, и в WHERE; GP (PG 9.4) выводит для них разные типы
            # (text vs varchar) → AmbiguousParameterError. Каст фиксирует тип.
            result = await self.conn.execute(
                f"""
                INSERT INTO {self.user_roles} (username, role_id, assigned_by)
                SELECT $1::varchar, $2::bigint, $3::varchar
                WHERE NOT EXISTS (
                    SELECT 1 FROM {self.user_roles}
                    WHERE username = $1 AND role_id = $2
                )
                """,
                username, role_id, assigned_by,
            )
            return result == "INSERT 0 1"

    async def remove_role(self, username: str, role_id: int) -> bool:
        """Снимает роль с пользователя. Возвращает True если запись была удалена."""
        result = await self.conn.execute(
            f"DELETE FROM {self.user_roles} WHERE username = $1 AND role_id = $2",
            username, role_id,
        )
        return result == "DELETE 1"

    async def count_admins(self) -> int:
        """Возвращает количество пользователей с ролью 'Админ'."""
        return await self.conn.fetchval(
            f"""
            SELECT COUNT(*) FROM {self.user_roles} ur
            JOIN {self.roles} r ON r.id = ur.role_id
            WHERE r.name = $1
            """,
            "Админ",
        )

    async def count_user_roles(self) -> int:
        """Возвращает общее количество записей в user_roles."""
        return await self.conn.fetchval(
            f"SELECT COUNT(*) FROM {self.user_roles}"
        )

    async def bulk_assign_roles(
        self, assignments: list[tuple[str, int, str]]
    ) -> int:
        """
        Массовое назначение ролей.

        Args:
            assignments: список кортежей (username, role_id, assigned_by)

        Returns:
            Количество назначенных ролей.
        """
        count = 0
        async with self.conn.transaction():
            for username, role_id, assigned_by in assignments:
                if await self.assign_role(username, role_id, assigned_by):
                    count += 1
        logger.info("Массовое назначение ролей: %s из %s успешно", count, len(assignments))
        return count

    @staticmethod
    def _like_pattern(query: str) -> str:
        """Экранирует спецсимволы LIKE и оборачивает в %…% для подстроки."""
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return f"%{escaped}%"

    async def get_users_with_roles(
        self, branch: str, *, limit: int = 50, offset: int = 0,
        query: str | None = None,
    ) -> list[dict]:
        """
        Возвращает пользователей отдела + пользователей с ролями.

        Один SQL-запрос с UNION + LEFT JOIN + json_agg. При непустом ``query``
        результат фильтруется по подстроке (ФИО/логин/email) на стороне БД.
        """
        params: list = [branch]
        where_sql = ""
        if query:
            pattern = self._like_pattern(query)
            # Три отдельных плейсхолдера под один паттерн — GP (PG 9.4) выводит
            # типы по контексту; одинаковый параметр в разных местах ILIKE может
            # дать AmbiguousParameterError (см. assign_role/search_users).
            params.extend([pattern, pattern, pattern])
            where_sql = (
                "WHERE (COALESCE(d.fullname, '') ILIKE $2 "
                "OR base.username ILIKE $3 "
                "OR COALESCE(d.email, '') ILIKE $4)"
            )
        limit_idx = len(params) + 1
        offset_idx = len(params) + 2
        params.extend([limit, offset])

        rows = await self.conn.fetch(
            f"""
            SELECT
                base.username,
                COALESCE(d.fullname, '') AS fullname,
                COALESCE(d.job, '') AS job,
                COALESCE(d.tn, '') AS tn,
                COALESCE(d.email, '') AS email,
                (d.branch IS NOT NULL AND d.branch = $1) AS is_department,
                COALESCE(
                    json_agg(json_build_object(
                        'id', r.id, 'name', r.name,
                        'domain_name', r.domain_name,
                        'description', r.description
                    )) FILTER (WHERE r.id IS NOT NULL),
                    '[]'::json
                ) AS roles
            FROM (
                SELECT username FROM {self.user_table} WHERE branch = $1
                UNION
                SELECT DISTINCT username FROM {self.user_roles}
            ) base
            LEFT JOIN (
                SELECT DISTINCT ON (username) username, fullname, job, tn, email, branch
                FROM {self.user_table}
                ORDER BY username
            ) d ON d.username = base.username
            LEFT JOIN {self.user_roles} ur ON ur.username = base.username
            LEFT JOIN {self.roles} r ON r.id = ur.role_id
            {where_sql}
            GROUP BY base.username, d.fullname, d.job, d.tn, d.email, d.branch
            ORDER BY COALESCE(d.fullname, base.username)
            LIMIT ${limit_idx} OFFSET ${offset_idx}
            """,
            *params,
        )
        result = []
        for row in rows:
            d = dict(row)
            roles = d["roles"]
            if isinstance(roles, str):
                roles = json.loads(roles)
            d["roles"] = roles
            result.append(d)
        return result

    async def count_users_with_roles(
        self, branch: str, query: str | None = None,
    ) -> int:
        """Считает общее количество пользователей в справочнике
        (DISTINCT username отдела + с ролями). При непустом ``query`` —
        количество совпадений по подстроке (ФИО/логин/email)."""
        if not query:
            return await self.conn.fetchval(
                f"""
                SELECT COUNT(*) FROM (
                    SELECT username FROM {self.user_table} WHERE branch = $1
                    UNION
                    SELECT DISTINCT username FROM {self.user_roles}
                ) base
                """,
                branch,
            )

        pattern = self._like_pattern(query)
        return await self.conn.fetchval(
            f"""
            SELECT COUNT(*) FROM (
                SELECT base.username
                FROM (
                    SELECT username FROM {self.user_table} WHERE branch = $1
                    UNION
                    SELECT DISTINCT username FROM {self.user_roles}
                ) base
                LEFT JOIN (
                    SELECT DISTINCT ON (username) username, fullname, email
                    FROM {self.user_table}
                    ORDER BY username
                ) d ON d.username = base.username
                WHERE (COALESCE(d.fullname, '') ILIKE $2
                    OR base.username ILIKE $3
                    OR COALESCE(d.email, '') ILIKE $4)
            ) sub
            """,
            branch,
            pattern,
            pattern,
            pattern,
        )

    async def search_users(
        self,
        query: str,
        branch: str,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        """
        Поиск пользователей в справочнике по ФИО или username.

        Исключает пользователей, уже видимых в основном списке
        (из отдела + с ролями).
        """
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        rows = await self.conn.fetch(
            f"""
            SELECT username, fullname, job, email FROM (
                SELECT DISTINCT ON (username)
                       username,
                       COALESCE(fullname, '') AS fullname,
                       COALESCE(job, '') AS job,
                       COALESCE(email, '') AS email
                FROM {self.user_table}
                WHERE (fullname ILIKE $1 OR username LIKE $2)
                  AND username NOT IN (
                      SELECT username FROM {self.user_table} WHERE branch = $3
                      UNION
                      SELECT DISTINCT username FROM {self.user_roles}
                  )
                ORDER BY username
            ) sub
            ORDER BY fullname
            LIMIT $4 OFFSET $5
            """,
            pattern,
            pattern,
            branch,
            limit,
            offset,
        )
        return [dict(r) for r in rows]

    async def count_search_users(self, query: str, branch: str) -> int:
        """Считает общее число пользователей, удовлетворяющих фильтру поиска."""
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        return await self.conn.fetchval(
            f"""
            SELECT COUNT(*) FROM (
                SELECT DISTINCT username
                FROM {self.user_table}
                WHERE (fullname ILIKE $1 OR username LIKE $2)
                  AND username NOT IN (
                      SELECT username FROM {self.user_table} WHERE branch = $3
                      UNION
                      SELECT DISTINCT username FROM {self.user_roles}
                  )
            ) sub
            """,
            pattern,
            pattern,
            branch,
        )

    # -------------------------------------------------------------------------
    # СПРАВОЧНИК ПОЛЬЗОВАТЕЛЕЙ
    # -------------------------------------------------------------------------

    async def get_users_from_directory(self, branch_filter: str) -> list[str]:
        """Возвращает список username пользователей из указанного подразделения."""
        rows = await self.conn.fetch(
            f"""
            SELECT DISTINCT username
            FROM {self.user_table}
            WHERE branch = $1
            ORDER BY username
            """,
            branch_filter,
        )
        return [r["username"] for r in rows]

    async def get_user_from_directory(self, username: str) -> dict | None:
        """Возвращает пользователя из справочника по username."""
        row = await self.conn.fetchrow(
            f"""
            SELECT username,
                   COALESCE(fullname, '') AS fullname,
                   COALESCE(job, '') AS job,
                   COALESCE(tn, '') AS tn,
                   COALESCE(email, '') AS email
            FROM {self.user_table}
            WHERE username = $1
            """,
            username,
        )
        return dict(row) if row else None
