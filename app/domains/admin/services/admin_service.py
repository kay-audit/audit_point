"""Сервис администрирования — бизнес-логика управления ролями."""

import json
import logging

import asyncpg

from app.api.v1.deps.role_deps import DEFAULT_ROLE_NAMES
from app.domains.admin.exceptions import (
    LastAdminError,
    RoleNotFoundError,
    UserNotFoundError,
)
from app.domains.admin.repositories.admin_audit_log import AdminAuditLogRepository
from app.domains.admin.repositories.admin_repository import AdminRepository
from app.domains.admin.settings import AdminSettings

logger = logging.getLogger("audit_workstation.domains.admin.service")

MIN_SEARCH_LENGTH = 2


class AdminService:
    """Управление ролями и справочником пользователей."""

    def __init__(self, conn: asyncpg.Connection, settings: AdminSettings):
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
        is_admin = any(r["name"] == "Администратор" for r in roles)
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

        if role["name"] == "Администратор":
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

        admin_role = await self.repo.get_role_by_name("Администратор")
        if not admin_role:
            logger.warning("Роль 'Администратор' не найдена, заполнение пропущено")
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

    async def create_user_with_roles(
        self,
        *,
        username: str,
        fullname: str,
        job: str = "",
        tn: str = "",
        email: str = "",
        branch: str = "",
        tb: str = "",
        role_ids: list[int] | None = None,
        current_admin: str,
    ) -> dict:
        """Создаёт/обновляет пользователя в справочнике и опционально назначает роли.

        Используется администратором для онбординга пользователей, которых нет
        в справочнике EDW/Hive. Если пользователь уже существует — его поля
        (fullname, job, tn, email, branch, tb) обновляются, а указанные в
        ``role_ids`` роли добавляются к уже имеющимся (idempotent).

        НИКОГДА не назначает роль «Администратор» — эта роль присваивается
        только через отдельный admin-flow (чтобы случайно создаваемый
        пользователь не получил бы полный доступ).

        Raises:
            RoleNotFoundError: если хотя бы одного role_id не существует.
        """
        role_ids = role_ids or []

        # 1. Превентивная валидация role_ids — все роли должны существовать.
        for rid in role_ids:
            if not await self.repo.get_role_by_id(rid):
                raise RoleNotFoundError(f"Роль с id={rid} не найдена")

        # 2. Upsert в справочник.
        await self.repo.upsert_user_in_directory(
            username=username,
            fullname=fullname,
            job=job,
            tn=tn,
            email=email,
            branch=branch,
            tb=tb,
        )

        # 3. Назначаем роли (idempotent — повторный вызов с тем же role_id — noop).
        #    «Администратор» НЕ включается автоматически — это особая роль,
        #    выдаваемая только осознанно через отдельный admin-flow.
        assigned_count = 0
        for rid in role_ids:
            if await self.repo.assign_role(username, rid, current_admin):
                assigned_count += 1

        # 4. Пишем в аудит-лог одной записью, чтобы было видно всё действие.
        details = json.dumps(
            {
                "fullname": fullname,
                "job": job,
                "tn": tn,
                "email": email,
                "branch": branch,
                "tb": tb,
                "role_ids": role_ids,
                "roles_newly_assigned": assigned_count,
            },
            ensure_ascii=False,
        )
        await self.audit_log.log(
            action="create_user",
            target_username=username,
            admin_username=current_admin,
            details=details,
        )

        # 5. Возвращаем пользователя с актуальными ролями.
        return await self.get_user_roles(username)

    async def update_user_metadata(
        self,
        *,
        username: str,
        fullname: str,
        job: str = "",
        tn: str = "",
        email: str = "",
        branch: str = "",
        tb: str = "",
        current_admin: str,
    ) -> dict:
        """Обновляет метаданные пользователя (ФИО/Должность/ТБ и т.п.).

        Используется админ-панелью для кнопки «Редактировать». Не трогает
        is_deleted/deleted_* (для этого — отдельные методы soft_delete /
        restore). Роли в user_roles тоже не меняются — это делается через
        свои эндпоинты /roles.

        Raises:
            UserNotFoundError: если пользователь не найден в справочнике.
        """
        existing = await self.repo.get_user_from_directory(username)
        if not existing:
            raise UserNotFoundError(f"Пользователь {username} не найден в справочнике")

        await self.repo.upsert_user_in_directory(
            username=username,
            fullname=fullname,
            job=job,
            tn=tn,
            email=email,
            branch=branch,
            tb=tb,
        )

        details = json.dumps(
            {
                "fullname": fullname,
                "job": job,
                "tn": tn,
                "email": email,
                "branch": branch,
                "tb": tb,
            },
            ensure_ascii=False,
        )
        await self.audit_log.log(
            action="update_user",
            target_username=username,
            admin_username=current_admin,
            details=details,
        )
        return await self.get_user_roles(username)

    async def soft_delete_user(self, username: str, current_admin: str) -> bool:
        """Помечает пользователя как удалённого (soft-delete).

        Удалённый пользователь:
        - остаётся в БД (с пометкой «УДАЛЕН» в UI);
        - недоступен в /api/v1/acts/users/search (нельзя добавить в НОВЫЕ акты);
        - существующие упоминания в уже созданных актах продолжают работать.

        Если пользователь уже помечен удалённым — операция идемпотентна,
        повторный вызов возвращает False без побочных эффектов.

        Raises:
            UserNotFoundError: если пользователь не найден в справочнике.
        """
        existing = await self.repo.get_user_from_directory(username)
        if not existing:
            raise UserNotFoundError(f"Пользователь {username} не найден в справочнике")

        deleted = await self.repo.soft_delete_user(username, current_admin)
        if deleted:
            await self.audit_log.log(
                action="delete_user",
                target_username=username,
                admin_username=current_admin,
            )
        return deleted

    async def restore_user(self, username: str, current_admin: str) -> bool:
        """Восстанавливает пользователя из soft-delete.

        Используется при отмене ошибочного удаления. Не восстанавливает
        роли — их можно переназначить через admin-панель.

        Raises:
            UserNotFoundError: если пользователь не найден.
        """
        existing = await self.repo.get_user_from_directory(username)
        if not existing:
            raise UserNotFoundError(f"Пользователь {username} не найден в справочнике")

        restored = await self.repo.restore_user(username)
        if restored:
            await self.audit_log.log(
                action="restore_user",
                target_username=username,
                admin_username=current_admin,
            )
        return restored
