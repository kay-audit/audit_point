"""Тесты для UserDirectoryRepository."""

from unittest.mock import MagicMock, patch

import pytest

from app.domains.admin.services.user_directory import UserDirectoryRepository
from app.domains.admin.settings import AdminSettings


@pytest.fixture
def repo(mock_conn):
    """Создаёт UserDirectoryRepository с замоканным адаптером и соединением."""
    mock_adapter = MagicMock()
    mock_adapter.get_table_name = lambda name, schema="": name
    mock_adapter.qualify_table_name = lambda name, schema="": name
    with patch(
        "app.db.repositories.base.get_adapter", return_value=mock_adapter
    ), patch(
        "app.domains.admin.services.user_directory.get_domain_settings",
        return_value=AdminSettings(),
    ):
        return UserDirectoryRepository(conn=mock_conn)


def _sql_of(mock_conn):
    """Возвращает текст последнего запроса, ушедшего в fetchrow."""
    return mock_conn.fetchrow.call_args.args[0]


# -------------------------------------------------------------------------
# find_by_username
# -------------------------------------------------------------------------


class TestFindByUsername:

    async def test_returns_user(self, repo, mock_conn):
        """Возвращает строку справочника по логину."""
        mock_conn.fetchrow.return_value = {
            "username": "12345",
            "email": "user@example.com",
            "fullname": "Иванов И.И.",
        }
        result = await repo.find_by_username("12345")

        assert result == {
            "username": "12345",
            "email": "user@example.com",
            "fullname": "Иванов И.И.",
        }
        assert mock_conn.fetchrow.call_args.args[1] == "12345"

    async def test_not_found(self, repo, mock_conn):
        """Возвращает None, если пользователя нет в справочнике."""
        mock_conn.fetchrow.return_value = None

        assert await repo.find_by_username("99999") is None

    async def test_collapses_duplicate_rows(self, repo, mock_conn):
        """Схлопывает дубли по username: DISTINCT ON + LIMIT 1.

        В справочнике на один логин может быть несколько строк (запись на
        каждую должность) — выборка обязана вернуть ровно одну.
        """
        mock_conn.fetchrow.return_value = {
            "username": "12345", "email": "", "fullname": "",
        }
        await repo.find_by_username("12345")

        sql = _sql_of(mock_conn)
        assert "DISTINCT ON (username)" in sql
        assert "LIMIT 1" in sql


# -------------------------------------------------------------------------
# find_by_email
# -------------------------------------------------------------------------


class TestFindByEmail:

    async def test_returns_user(self, repo, mock_conn):
        """Возвращает строку справочника по email."""
        mock_conn.fetchrow.return_value = {
            "username": "12345",
            "email": "user@example.com",
            "fullname": "Иванов И.И.",
        }
        result = await repo.find_by_email("user@example.com")

        assert result["username"] == "12345"
        assert mock_conn.fetchrow.call_args.args[1] == "user@example.com"

    async def test_not_found(self, repo, mock_conn):
        """Возвращает None, если email не найден."""
        mock_conn.fetchrow.return_value = None

        assert await repo.find_by_email("no@example.com") is None

    async def test_case_and_space_insensitive(self, repo, mock_conn):
        """Сравнение идёт через LOWER(TRIM(...)) с обеих сторон.

        Почта в справочнике заполняется людьми: регистр и лишние пробелы
        не должны мешать входу.
        """
        mock_conn.fetchrow.return_value = None
        await repo.find_by_email("  User@Example.COM ")

        sql = _sql_of(mock_conn)
        assert "LOWER(TRIM(email)) = LOWER(TRIM($1))" in sql
        # Нормализация — на стороне SQL, аргумент уходит как есть.
        assert mock_conn.fetchrow.call_args.args[1] == "  User@Example.COM "

    async def test_collapses_duplicate_rows(self, repo, mock_conn):
        """Схлопывает дубли по username: DISTINCT ON + LIMIT 1."""
        mock_conn.fetchrow.return_value = None
        await repo.find_by_email("user@example.com")

        sql = _sql_of(mock_conn)
        assert "DISTINCT ON (username)" in sql
        assert "LIMIT 1" in sql
