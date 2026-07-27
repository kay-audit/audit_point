"""Тесты для AdminService."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.domains.admin.exceptions import LastAdminError, RoleNotFoundError, UserNotFoundError
from app.domains.admin.services.admin_service import AdminService
from app.domains.admin.settings import AdminSettings


@pytest.fixture
def mock_repo():
    """Mock AdminRepository."""
    repo = AsyncMock()
    repo.get_role_by_id = AsyncMock()
    repo.get_user_from_directory = AsyncMock()
    repo.count_admins = AsyncMock()
    repo.assign_role = AsyncMock()
    repo.remove_role = AsyncMock()
    repo.upsert_user_in_directory = AsyncMock()
    repo.soft_delete_user = AsyncMock()
    repo.restore_user = AsyncMock()
    return repo


@pytest.fixture
def mock_audit_log():
    """Mock AdminAuditLogRepository."""
    return AsyncMock()


@pytest.fixture
def service(mock_conn, mock_repo, mock_audit_log):
    """Создаёт AdminService с замоканными репозиториями."""
    mock_adapter = MagicMock()
    mock_adapter.get_table_name = lambda name, schema='': name
    mock_adapter.qualify_table_name = lambda name, schema="": name
    mock_adapter.supports_on_conflict = MagicMock(return_value=True)
    with patch(
        "app.db.repositories.base.get_adapter", return_value=mock_adapter
    ):
        svc = AdminService(conn=mock_conn, settings=AdminSettings())
    svc.repo = mock_repo
    svc.audit_log = mock_audit_log
    return svc


# -------------------------------------------------------------------------
# assign_role — аудит-лог
# -------------------------------------------------------------------------


class TestAssignRoleAudit:

    async def test_logs_on_assign(self, service, mock_repo, mock_audit_log):
        """При назначении роли пишется запись в аудит-лог."""
        mock_repo.get_role_by_id.return_value = {
            "id": 2, "name": "ЦК Фин.Рез.", "domain_name": "ck_fin_res", "description": "",
        }
        mock_repo.get_user_from_directory.return_value = {"username": "12345"}
        mock_repo.assign_role.return_value = True

        await service.assign_role("12345", 2, "admin_user")

        mock_audit_log.log.assert_called_once_with(
            action="assign_role",
            target_username="12345",
            admin_username="admin_user",
            role_id=2,
            role_name="ЦК Фин.Рез.",
        )

    async def test_no_log_when_already_assigned(self, service, mock_repo, mock_audit_log):
        """Если роль уже назначена — аудит-лог не пишется."""
        mock_repo.get_role_by_id.return_value = {
            "id": 2, "name": "ЦК Фин.Рез.", "domain_name": "ck_fin_res", "description": "",
        }
        mock_repo.get_user_from_directory.return_value = {"username": "12345"}
        mock_repo.assign_role.return_value = False

        await service.assign_role("12345", 2, "admin_user")

        mock_audit_log.log.assert_not_called()


# -------------------------------------------------------------------------
# remove_role — защита последнего админа
# -------------------------------------------------------------------------


class TestRemoveRoleLastAdmin:

    async def test_blocks_last_admin_removal(self, service, mock_repo, mock_audit_log):
        """Нельзя снять роль Админ, если это последний администратор."""
        mock_repo.get_role_by_id.return_value = {
            "id": 1, "name": "Администратор", "domain_name": None, "description": "",
        }
        mock_repo.count_admins.return_value = 1

        with pytest.raises(LastAdminError):
            await service.remove_role("12345", 1, "admin_user")

        mock_repo.remove_role.assert_not_called()
        mock_audit_log.log.assert_not_called()

    async def test_allows_removal_with_multiple_admins(self, service, mock_repo):
        """Можно снять роль Админ, если администраторов больше одного."""
        mock_repo.get_role_by_id.return_value = {
            "id": 1, "name": "Администратор", "domain_name": None, "description": "",
        }
        mock_repo.count_admins.return_value = 2
        mock_repo.remove_role.return_value = True

        result = await service.remove_role("12345", 1, "admin_user")

        assert result is True
        mock_repo.remove_role.assert_called_once_with("12345", 1)

    async def test_non_admin_role_no_count_check(self, service, mock_repo):
        """Для не-админских ролей проверка количества не выполняется."""
        mock_repo.get_role_by_id.return_value = {
            "id": 2, "name": "Цифровой акт", "domain_name": "acts", "description": "",
        }
        mock_repo.remove_role.return_value = True

        result = await service.remove_role("12345", 2, "admin_user")

        assert result is True
        mock_repo.count_admins.assert_not_called()

    async def test_role_not_found(self, service, mock_repo):
        """Ошибка, если роль не существует."""
        mock_repo.get_role_by_id.return_value = None

        with pytest.raises(RoleNotFoundError):
            await service.remove_role("12345", 999, "admin_user")


# -------------------------------------------------------------------------
# remove_role — аудит-лог
# -------------------------------------------------------------------------


class TestRemoveRoleAudit:

    async def test_logs_on_remove(self, service, mock_repo, mock_audit_log):
        """При снятии роли пишется запись в аудит-лог."""
        mock_repo.get_role_by_id.return_value = {
            "id": 2, "name": "ЦК Фин.Рез.", "domain_name": "ck_fin_res", "description": "",
        }
        mock_repo.remove_role.return_value = True

        await service.remove_role("12345", 2, "admin_user")

        mock_audit_log.log.assert_called_once_with(
            action="remove_role",
            target_username="12345",
            admin_username="admin_user",
            role_id=2,
            role_name="ЦК Фин.Рез.",
        )

    async def test_no_log_when_not_removed(self, service, mock_repo, mock_audit_log):
        """Если роль не была назначена — аудит-лог не пишется."""
        mock_repo.get_role_by_id.return_value = {
            "id": 2, "name": "ЦК Фин.Рез.", "domain_name": "ck_fin_res", "description": "",
        }
        mock_repo.remove_role.return_value = False

        result = await service.remove_role("12345", 2, "admin_user")

        assert result is False
        mock_audit_log.log.assert_not_called()


# -------------------------------------------------------------------------
# create_user_with_roles — новая логика с поддержкой tb
# -------------------------------------------------------------------------


class TestCreateUserWithTb:
    """Проверяем, что новое поле ТБ проходит через create_user."""

    async def test_passes_tb_to_repo(self, service, mock_repo, mock_audit_log):
        """При создании пользователя ТБ записывается через upsert."""
        mock_repo.get_role_by_id.return_value = {
            "id": 2, "name": "ЦК Фин.Рез.", "domain_name": "ck_fin_res", "description": "",
        }
        mock_repo.get_user_from_directory.return_value = {"username": "12345"}
        mock_repo.assign_role.return_value = True
        mock_repo.upsert_user_in_directory.return_value = {
            "username": "12345",
            "fullname": "Иванов",
            "job": "",
            "tb": "МБ",
        }

        await service.create_user_with_roles(
            username="12345",
            fullname="Иванов",
            tb="МБ",
            role_ids=[2],
            current_admin="admin_user",
        )

        # ТБ передан в upsert_user_in_directory
        upsert_kwargs = mock_repo.upsert_user_in_directory.call_args.kwargs
        assert upsert_kwargs["tb"] == "МБ"

    async def test_no_admin_role_by_default(self, service, mock_repo, mock_audit_log):
        """Роль «Администратор» не передаётся автоматически (выдаётся вручную).

        Пользователь может передать её явно через role_ids — это нормально,
        но сервис не подмешивает её неявно (защита от случайной выдачи).
        """
        mock_repo.get_role_by_id.return_value = {
            "id": 99, "name": "Администратор", "domain_name": None, "description": "",
        }
        mock_repo.get_user_from_directory.return_value = {"username": "12345"}
        mock_repo.assign_role.return_value = True

        # Передаём пустой список — сервис должен пропустить все роли.
        await service.create_user_with_roles(
            username="12345",
            fullname="Иванов",
            tb="",
            role_ids=[],
            current_admin="admin_user",
        )
        # Никаких assign_role не было — пустой список.
        mock_repo.assign_role.assert_not_called()


# -------------------------------------------------------------------------
# update_user_metadata — редактирование ФИО/Должности/ТБ
# -------------------------------------------------------------------------


class TestUpdateUserMetadata:
    """Проверяем логику редактирования пользователя."""

    async def test_updates_metadata(self, service, mock_repo, mock_audit_log):
        """Сервис передаёт новые метаданные в upsert и пишет аудит-лог."""
        mock_repo.get_user_from_directory.return_value = {"username": "12345"}
        mock_repo.upsert_user_in_directory.return_value = {
            "username": "12345",
            "fullname": "Новый",
            "job": "Аудитор",
            "tb": "ЦА",
        }

        result = await service.update_user_metadata(
            username="12345",
            fullname="Новый",
            job="Аудитор",
            tb="ЦА",
            current_admin="admin_user",
        )

        upsert_kwargs = mock_repo.upsert_user_in_directory.call_args.kwargs
        assert upsert_kwargs["fullname"] == "Новый"
        assert upsert_kwargs["tb"] == "ЦА"
        # Аудит-лог записан
        mock_audit_log.log.assert_called_once()
        call = mock_audit_log.log.call_args
        assert call.kwargs["action"] == "update_user"
        assert call.kwargs["target_username"] == "12345"

    async def test_user_not_found_raises(self, service, mock_repo):
        """Ошибка UserNotFoundError, если пользователя нет в справочнике."""
        mock_repo.get_user_from_directory.return_value = None

        with pytest.raises(UserNotFoundError):
            await service.update_user_metadata(
                username="unknown",
                fullname="X",
                current_admin="admin_user",
            )


# -------------------------------------------------------------------------
# soft_delete_user / restore_user
# -------------------------------------------------------------------------


class TestSoftDeleteUser:

    async def test_marks_deleted_and_logs(self, service, mock_repo, mock_audit_log):
        """Удаление помечает is_deleted=true и пишет аудит-лог."""
        mock_repo.get_user_from_directory.return_value = {"username": "12345"}
        mock_repo.soft_delete_user.return_value = True

        result = await service.soft_delete_user("12345", "admin_user")

        assert result is True
        mock_repo.soft_delete_user.assert_awaited_once_with("12345", "admin_user")
        mock_audit_log.log.assert_called_once()
        assert mock_audit_log.log.call_args.kwargs["action"] == "delete_user"

    async def test_already_deleted_no_log(self, service, mock_repo, mock_audit_log):
        """Идемпотентность: повторный soft-delete — без побочных эффектов."""
        mock_repo.get_user_from_directory.return_value = {"username": "12345"}
        mock_repo.soft_delete_user.return_value = False

        result = await service.soft_delete_user("12345", "admin_user")

        assert result is False
        mock_audit_log.log.assert_not_called()

    async def test_user_not_found_raises(self, service, mock_repo):
        """Ошибка UserNotFoundError, если пользователя нет."""
        mock_repo.get_user_from_directory.return_value = None

        with pytest.raises(UserNotFoundError):
            await service.soft_delete_user("unknown", "admin_user")


class TestRestoreUser:

    async def test_restores_and_logs(self, service, mock_repo, mock_audit_log):
        """Восстановление снимает is_deleted и пишет аудит-лог."""
        mock_repo.get_user_from_directory.return_value = {"username": "12345"}
        mock_repo.restore_user.return_value = True

        result = await service.restore_user("12345", "admin_user")

        assert result is True
        mock_repo.restore_user.assert_awaited_once_with("12345")
        mock_audit_log.log.assert_called_once()
        assert mock_audit_log.log.call_args.kwargs["action"] == "restore_user"

    async def test_not_deleted_no_log(self, service, mock_repo, mock_audit_log):
        """Идемпотентность: восстановление не-удалённого пользователя — noop."""
        mock_repo.get_user_from_directory.return_value = {"username": "12345"}
        mock_repo.restore_user.return_value = False

        result = await service.restore_user("12345", "admin_user")

        assert result is False
        mock_audit_log.log.assert_not_called()
