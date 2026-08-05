"""Сервис администрирования — бизнес-логика управления ролями."""

import logging

from app.api.v1.deps.role_deps import DEFAULT_ROLE_NAMES
from app.db.types import DbConn
from app.domains.admin.exceptions import LastAdminError, RoleNotFoundError, UserNotFoundError
from app.domains.admin.repositories.admin_audit_log import AdminAuditLogRepository
from app.domains.admin.repositories.admin_repository import AdminRepository
from app.domains.admin.settings import AdminSettings

logger = logging.getLogger("audit_workstation.domains.admin.service")

MIN_SEARCH_LENGTH = 2


class AdminService:
    """Управление ролями и справочником пользователей."""

    def __init__(self, conn: DbConn, settings: AdminSettings):
        self.conn = conn
        self.settings = settings
        self.repo = AdminRepository(conn, settings)
        self.audit_log = AdminAuditLogRepository(conn)

    async def get_all_roles(
        self, *, limit: int = 50, offset: int = 0,
    ) -> tuple[list[dict], int]:
        """Возвращает страницу ролей и общее количество."""
        items = await self.repo.get_all_roles(limit=limit, offset=offset)
        total = await self.repo.count_all_roles()
        return items, total

    async def get_user_roles(self, username: str) -> dict:
        """Возвращает роли пользователя."""
        roles = await self.repo.get_user_roles(username)
        is_admin = any(r["name"] == "Админ" for r in roles)
        return {
            "username": username,
            "roles": roles,
            "is_admin": is_admin,
        }

    async def assign_role(self, username: str, role_id: int, assigned_by: str) -> bool:
        """
        Назначает роль пользователю.

        Raises:
            RoleNotFoundError: если роль не существует.
            UserNotFoundError: если пользователь не найден в справочнике.
        """
        role = await self.repo.get_role_by_id(role_id)
        if not role:
            logger.warning("Попытка назначить несуществующую роль id=%s", role_id)
            raise RoleNotFoundError(f"Роль с id={role_id} не найдена")

        user = await self.repo.get_user_from_directory(username)
        if not user:
            logger.warning("Пользователь %s не найден в справочнике при назначении роли", username)
            raise UserNotFoundError(f"Пользователь {username} не найден в справочнике")

        assigned = await self.repo.assign_role(username, role_id, assigned_by)
        if assigned:
            await self.audit_log.log(
                action="assign_role",
                target_username=username,
                admin_username=assigned_by,
                role_id=role_id,
                role_name=role["name"],
            )
        return assigned

    async def remove_role(self, username: str, role_id: int, removed_by: str) -> bool:
        """
        Снимает роль с пользователя.

        Raises:
            RoleNotFoundError: если роль не существует.
            LastAdminError: если это последний администратор системы.
        """
        role = await self.repo.get_role_by_id(role_id)
        if not role:
            logger.warning("Попытка снять несуществующую роль id=%s", role_id)
            raise RoleNotFoundError(f"Роль с id={role_id} не найдена")

        if role["name"] == "Админ":
            admin_count = await self.repo.count_admins()
            if admin_count <= 1:
                logger.warning(
                    "Попытка снять роль Админ с %s — последний администратор (снимает %s)",
                    username, removed_by,
                )
                raise LastAdminError(
                    "Нельзя снять роль — это последний администратор системы"
                )

        removed = await self.repo.remove_role(username, role_id)
        if removed:
            await self.audit_log.log(
                action="remove_role",
                target_username=username,
                admin_username=removed_by,
                role_id=role_id,
                role_name=role["name"],
            )
        return removed

    async def get_audit_log(self, **filters) -> tuple[list[dict], int]:
        """Возвращает записи аудит-лога с фильтрацией."""
        return await self.audit_log.get_log(**filters)

    async def get_user_directory(
        self, *, limit: int = 50, offset: int = 0, query: str | None = None,
    ) -> tuple[list[dict], int]:
        """Возвращает страницу пользователей отдела + пользователей с ролями.

        При непустом ``query`` справочник фильтруется по подстроке
        (ФИО/логин/email) на стороне БД.
        """
        branch = self.settings.user_directory.branch_filter
        items = await self.repo.get_users_with_roles(
            branch, limit=limit, offset=offset, query=query,
        )
        total = await self.repo.count_users_with_roles(branch, query=query)
        return items, total

    async def search_users(
        self, query: str, *, limit: int = 50, offset: int = 0,
    ) -> tuple[list[dict], int]:
        """Поиск пользователей в справочнике (исключая уже видимых)."""
        if len(query) < MIN_SEARCH_LENGTH:
            return [], 0
        branch = self.settings.user_directory.branch_filter
        items = await self.repo.search_users(
            query, branch, limit=limit, offset=offset,
        )
        total = await self.repo.count_search_users(query, branch)
        return items, total

    async def seed_initial_roles(self, branch_filter: str, default_admin: str) -> None:
        """Начальное заполнение ролей при первом запуске."""
        count = await self.repo.count_user_roles()
        if count > 0:
            logger.info(
                "Таблица user_roles не пуста (%s записей), начальное заполнение пропущено",
                count,
            )
            return

        admin_role = await self.repo.get_role_by_name("Админ")
        if not admin_role:
            logger.warning("Роль 'Админ' не найдена, заполнение пропущено")
            return

        # Дефолтные роли — тот же набор, что auto-assign при первом обращении
        # пользователя (DEFAULT_ROLE_NAMES), чтобы поведение не расходилось.
        default_roles = []
        for role_name in DEFAULT_ROLE_NAMES:
            role = await self.repo.get_role_by_name(role_name)
            if role:
                default_roles.append(role)
            else:
                logger.warning("Роль '%s' не найдена при начальном заполнении", role_name)
        if not default_roles:
            logger.warning("Дефолтные роли не найдены, заполнение пропущено")
            return

        usernames = await self.repo.get_users_from_directory(branch_filter)
        if not usernames:
            logger.warning(
                "Пользователи с branch='%s' не найдены, заполнение пропущено",
                branch_filter,
            )
            return

        assignments: list[tuple[str, int, str]] = [
            (u, role["id"], "system")
            for u in usernames
            for role in default_roles
        ]

        if default_admin in usernames:
            assignments.append((default_admin, admin_role["id"], "system"))

        assigned_count = await self.repo.bulk_assign_roles(assignments)
        logger.info(
            "Начальное заполнение ролей: назначено %s ролей для %s пользователей из '%s'",
            assigned_count, len(usernames), branch_filter,
        )
