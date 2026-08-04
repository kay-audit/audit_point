"""Тесты для UserAvatarRepository."""

import datetime as dt
from unittest.mock import MagicMock, patch

import asyncpg
import pytest

from app.domains.admin.repositories.user_avatars import UserAvatarRepository


@pytest.fixture
def repo(mock_conn):
    """Создаёт UserAvatarRepository с замоканным адаптером."""
    mock_adapter = MagicMock()
    mock_adapter.get_table_name = lambda name, schema='': name
    mock_adapter.qualify_table_name = lambda name, schema="": name
    with patch(
        "app.db.repositories.base.get_adapter", return_value=mock_adapter
    ):
        return UserAvatarRepository(conn=mock_conn)


class TestGet:

    async def test_returns_row_as_dict(self, repo, mock_conn):
        updated_at = dt.datetime(2026, 7, 31, 12, 0, 0)
        mock_conn.fetchrow.return_value = {
            "image": b"jpeg", "mime": "image/jpeg", "updated_at": updated_at,
        }

        result = await repo.get("12345")

        assert result == {"image": b"jpeg", "mime": "image/jpeg", "updated_at": updated_at}
        assert mock_conn.fetchrow.call_args[0][1] == "12345"

    async def test_returns_none_when_absent(self, repo, mock_conn):
        mock_conn.fetchrow.return_value = None

        assert await repo.get("12345") is None


class TestGetUpdatedAt:

    async def test_selects_only_timestamp(self, repo, mock_conn):
        """Версия фото в /me читается без выборки самих байтов."""
        mock_conn.fetchval.return_value = dt.datetime(2026, 7, 31, 12, 0, 0)

        result = await repo.get_updated_at("12345")

        assert result == dt.datetime(2026, 7, 31, 12, 0, 0)
        query = mock_conn.fetchval.call_args[0][0]
        assert "SELECT updated_at" in query
        assert "image" not in query


class TestUpsert:

    async def test_updates_existing_row_without_insert(self, repo, mock_conn):
        mock_conn.execute.return_value = "UPDATE 1"

        await repo.upsert("12345", b"jpeg", "image/jpeg")

        assert mock_conn.execute.call_count == 1
        query = mock_conn.execute.call_args[0][0]
        assert query.strip().startswith("UPDATE")
        # Триггеров в проекте нет — updated_at обязан выставляться явно.
        assert "updated_at = CURRENT_TIMESTAMP" in query

    async def test_inserts_when_no_row_updated(self, repo, mock_conn):
        """ON CONFLICT недоступен на GP, поэтому вставка — второй шаг."""
        mock_conn.execute.side_effect = ["UPDATE 0", "INSERT 0 1"]

        await repo.upsert("12345", b"jpeg", "image/jpeg")

        assert mock_conn.execute.call_count == 2
        insert_query = mock_conn.execute.call_args_list[1][0][0]
        assert "INSERT INTO" in insert_query
        assert mock_conn.execute.call_args_list[1][0][1:] == ("12345", b"jpeg", "image/jpeg")

    async def test_no_on_conflict_in_queries(self, repo, mock_conn):
        """Регрессия совместимости с Greenplum 6 (PG 9.4)."""
        mock_conn.execute.side_effect = ["UPDATE 0", "INSERT 0 1"]

        await repo.upsert("12345", b"jpeg", "image/jpeg")

        for call in mock_conn.execute.call_args_list:
            assert "ON CONFLICT" not in call[0][0].upper()

    async def test_retries_update_after_concurrent_first_insert(self, repo, mock_conn):
        """Гонка двух первых загрузок одного пользователя: проигравший ловит
        UniqueViolationError на своём INSERT и повторяет UPDATE — строка,
        которую вставил победитель, уже есть."""
        mock_conn.execute.side_effect = [
            "UPDATE 0",
            asyncpg.UniqueViolationError("duplicate key"),
            "UPDATE 1",
        ]

        await repo.upsert("12345", b"jpeg", "image/jpeg")

        assert mock_conn.execute.call_count == 3


class TestDelete:

    async def test_returns_true_when_row_removed(self, repo, mock_conn):
        mock_conn.execute.return_value = "DELETE 1"

        assert await repo.delete("12345") is True

    async def test_returns_false_when_nothing_to_delete(self, repo, mock_conn):
        """Идемпотентность: повторное удаление — не ошибка."""
        mock_conn.execute.return_value = "DELETE 0"

        assert await repo.delete("12345") is False
