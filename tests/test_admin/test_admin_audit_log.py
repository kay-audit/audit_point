"""Тесты для AdminAuditLogRepository."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.domains.admin.repositories.admin_audit_log import AdminAuditLogRepository


@pytest.fixture
def repo(mock_conn):
    """Создаёт AdminAuditLogRepository с замоканным адаптером."""
    mock_adapter = MagicMock()
    mock_adapter.get_table_name = lambda name, schema='': name
    mock_adapter.qualify_table_name = lambda name, schema="": name
    with patch(
        "app.db.repositories.base.get_adapter", return_value=mock_adapter
    ):
        return AdminAuditLogRepository(conn=mock_conn)


# -------------------------------------------------------------------------
# log
# -------------------------------------------------------------------------


class TestLog:

    async def test_inserts_record(self, repo, mock_conn):
        """Записывает операцию в аудит-лог."""
        await repo.log(
            action="assign_role",
            target_username="12345",
            admin_username="admin_user",
            role_id=1,
            role_name="Администратор",
        )

        mock_conn.execute.assert_called_once()
        query = mock_conn.execute.call_args[0][0]
        assert "INSERT INTO" in query
        assert mock_conn.execute.call_args[0][1] == "assign_role"
        assert mock_conn.execute.call_args[0][2] == "12345"
        assert mock_conn.execute.call_args[0][3] == "admin_user"

    async def test_does_not_raise_on_error(self, repo, mock_conn):
        """Ошибка записи не пробрасывается наружу."""
        mock_conn.execute.side_effect = Exception("DB error")

        await repo.log(
            action="remove_role",
            target_username="12345",
            admin_username="admin_user",
        )
        # Не должно быть исключения


# -------------------------------------------------------------------------
# get_log
# -------------------------------------------------------------------------


class TestGetLog:

    async def test_no_filters(self, repo, mock_conn):
        """Без фильтров: возвращает все записи."""
        mock_conn.fetchval.return_value = 1
        mock_conn.fetch.return_value = [
            {
                "id": 1,
                "action": "assign_role",
                "target_username": "12345",
                "admin_username": "admin",
                "role_id": 1,
                "role_name": "Администратор",
                "details": "",
                "created_at": "2025-06-15T12:00:00",
            },
        ]
        items, total = await repo.get_log()

        assert total == 1
        assert len(items) == 1
        assert items[0]["action"] == "assign_role"

        count_query = mock_conn.fetchval.call_args[0][0]
        assert "WHERE" not in count_query

    async def test_with_action_filter(self, repo, mock_conn):
        """Фильтр по действию."""
        mock_conn.fetchval.return_value = 0
        mock_conn.fetch.return_value = []
        await repo.get_log(action="remove_role")

        count_query = mock_conn.fetchval.call_args[0][0]
        assert "action = $1" in count_query
        assert mock_conn.fetchval.call_args[0][1] == "remove_role"

    async def test_with_target_filter(self, repo, mock_conn):
        """Фильтр по целевому пользователю."""
        mock_conn.fetchval.return_value = 0
        mock_conn.fetch.return_value = []
        await repo.get_log(target_username="12345")

        count_query = mock_conn.fetchval.call_args[0][0]
        assert "target_username = $1" in count_query

    async def test_with_date_range(self, repo, mock_conn):
        """Фильтр по периоду дат."""
        mock_conn.fetchval.return_value = 0
        mock_conn.fetch.return_value = []
        await repo.get_log(from_date="2025-01-01", to_date="2025-12-31")

        count_query = mock_conn.fetchval.call_args[0][0]
        assert "created_at >= $1" in count_query
        assert "created_at <= $2" in count_query

    async def test_pagination(self, repo, mock_conn):
        """Пагинация: limit и offset передаются в запрос."""
        mock_conn.fetchval.return_value = 100
        mock_conn.fetch.return_value = []
        await repo.get_log(limit=10, offset=20)

        fetch_args = mock_conn.fetch.call_args[0]
        query = fetch_args[0]
        assert "LIMIT" in query
        assert "OFFSET" in query
        # limit=10, offset=20 — последние два параметра
        assert fetch_args[1] == 10
        assert fetch_args[2] == 20
