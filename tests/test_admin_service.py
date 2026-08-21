"""Тесты для AdminService."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.domains.admin.exceptions import RoleNotFoundError, UserNotFoundError
from app.domains.admin.services.admin_service import AdminService
from app.domains.admin.settings import AdminSettings


@pytest.fixture
def settings():
    return AdminSettings()


@pytest.fixture
def mock_repo():
    return AsyncMock()


@pytest.fixture
def service(mock_conn, settings, mock_repo):
    mock_adapter = MagicMock()
    mock_adapter.get_table_name = lambda name, schema='': name
    mock_adapter.qualify_table_name = lambda name, schema="": name
    with patch("app.db.repositories.base.get_adapter", return_value=mock_adapter):
        svc = AdminService(conn=mock_conn, settings=settings)
    svc.repo = mock_repo
    return svc


class TestGetUserDirectory:

    async def test_passes_branch_filter(self, service, mock_repo):
        mock_repo.get_users_with_roles.return_value = []
        mock_repo.count_users_with_roles.return_value = 0
        items, total = await service.get_user_directory()
        mock_repo.get_users_with_roles.assert_called_once_with(
            "Отдел аудита розничного бизнеса", limit=50, offset=0, query=None,
        )
        mock_repo.count_users_with_roles.assert_called_once_with(
            "Отдел аудита розничного бизнеса", query=None,
        )
        assert items == []
        assert total == 0

    async def test_passes_search_query(self, service, mock_repo):
        mock_repo.get_users_with_roles.return_value = []
        mock_repo.count_users_with_roles.return_value = 0
        await service.get_user_directory(query="Иванов")
        mock_repo.get_users_with_roles.assert_called_once_with(
            "Отдел аудита розничного бизнеса", limit=50, offset=0, query="Иванов",
        )
        mock_repo.count_users_with_roles.assert_called_once_with(
            "Отдел аудита розничного бизнеса", query="Иванов",
        )

    async def test_returns_users(self, service, mock_repo):
        mock_repo.get_users_with_roles.return_value = [
            {"username": "22494524", "fullname": "Маштаков Д.Р.", "roles": [], "is_department": True},
        ]
        mock_repo.count_users_with_roles.return_value = 1
        items, total = await service.get_user_directory()
        assert len(items) == 1
        assert items[0]["username"] == "22494524"
        assert total == 1


class TestSearchUsers:

    async def test_returns_results(self, service, mock_repo):
        mock_repo.search_users.return_value = [
            {"username": "22501010", "fullname": "Захарова М.Д.", "job": "", "email": ""},
        ]
        mock_repo.count_search_users.return_value = 1
        items, total = await service.search_users("Захарова")
        mock_repo.search_users.assert_called_once_with(
            "Захарова", "Отдел аудита розничного бизнеса", limit=50, offset=0,
        )
        mock_repo.count_search_users.assert_called_once_with(
            "Захарова", "Отдел аудита розничного бизнеса",
        )
        assert len(items) == 1
        assert total == 1

    async def test_empty_query_returns_empty(self, service, mock_repo):
        items, total = await service.search_users("")
        mock_repo.search_users.assert_not_called()
        assert items == []
        assert total == 0

    async def test_short_query_returns_empty(self, service, mock_repo):
        items, total = await service.search_users("З")
        mock_repo.search_users.assert_not_called()
        assert items == []
        assert total == 0


class TestAssignRoleValidation:

    async def test_user_not_in_directory_raises(self, service, mock_repo):
        mock_repo.get_role_by_id.return_value = {"id": 1, "name": "Админ"}
        mock_repo.get_user_from_directory.return_value = None
        with pytest.raises(UserNotFoundError):
            await service.assign_role("99999999", 1, "admin")

    async def test_user_in_directory_succeeds(self, service, mock_repo):
        mock_repo.get_role_by_id.return_value = {"id": 1, "name": "Админ"}
        mock_repo.get_user_from_directory.return_value = {"username": "22501010"}
        mock_repo.assign_role.return_value = True
        result = await service.assign_role("22501010", 1, "admin")
        assert result is True

    async def test_role_not_found_raises(self, service, mock_repo):
        mock_repo.get_role_by_id.return_value = None
        with pytest.raises(RoleNotFoundError):
            await service.assign_role("22501010", 999, "admin")


class TestSeedInitialRoles:

    async def test_assigns_all_default_roles(self, service, mock_repo):
        # Все дефолтные роли ("Цифровой акт", "Чат-ассистент", "SQL-агент")
        # должны назначаться каждому пользователю — иначе разделы недоступны
        # не-админам.
        roles = {
            "Админ": {"id": 1, "name": "Админ"},
            "Цифровой акт": {"id": 2, "name": "Цифровой акт"},
            "Чат-ассистент": {"id": 3, "name": "Чат-ассистент"},
            "SQL-агент": {"id": 4, "name": "SQL-агент"},
        }
        mock_repo.count_user_roles.return_value = 0
        mock_repo.get_role_by_name.side_effect = lambda name: roles.get(name)
        mock_repo.get_users_from_directory.return_value = ["22494524", "22501010"]
        mock_repo.bulk_assign_roles.return_value = 6

        await service.seed_initial_roles("branch1", default_admins=["00000000"])

        assignments = mock_repo.bulk_assign_roles.call_args.args[0]
        role_ids = {role_id for _, role_id, _ in assignments}
        assert role_ids == {2, 3, 4}
        assert len(assignments) == 6  # по три дефолтные роли на двух пользователей

    async def test_skips_when_user_roles_not_empty(self, service, mock_repo):
        mock_repo.count_user_roles.return_value = 5
        await service.seed_initial_roles("branch1", default_admins=["00000000"])
        mock_repo.bulk_assign_roles.assert_not_called()

    async def test_assigns_admin_role_to_each_default_admin_present(self, service, mock_repo):
        roles = {
            "Админ": {"id": 1, "name": "Админ"},
            "Цифровой акт": {"id": 2, "name": "Цифровой акт"},
            "Чат-ассистент": {"id": 3, "name": "Чат-ассистент"},
            "SQL-агент": {"id": 4, "name": "SQL-агент"},
        }
        mock_repo.count_user_roles.return_value = 0
        mock_repo.get_role_by_name.side_effect = lambda name: roles.get(name)
        mock_repo.get_users_from_directory.return_value = ["22494524", "18284771", "22501010"]
        mock_repo.bulk_assign_roles.return_value = 11

        await service.seed_initial_roles(
            "branch1", default_admins=["22494524", "18284771", "99999999"],
        )

        assignments = mock_repo.bulk_assign_roles.call_args.args[0]
        admin_assignees = {u for u, role_id, _ in assignments if role_id == 1}
        # 99999999 нет в каталоге — роль не назначается; лишний логин молча пропускается
        assert admin_assignees == {"22494524", "18284771"}
