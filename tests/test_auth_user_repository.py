"""Тесты AuthUserRepository — адаптера над репозиториями admin-домена.

Справочник пользователей и модель ролей принадлежат домену admin. Слой
авторизации только приводит их строки к своей форме; собственных запросов
он не держит, иначе auth и admin со временем начали бы видеть пользователя
по-разному (см. регрессию в конце файла).
"""

from __future__ import annotations

import pathlib
import re
from unittest.mock import MagicMock, patch

import pytest

from app.auth.user_repository import AuthUserRepository
from app.domains.admin.settings import AdminSettings

_PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]


@pytest.fixture
def repo(mock_conn):
    """Создаёт AuthUserRepository с замоканным адаптером и соединением."""
    mock_adapter = MagicMock()
    mock_adapter.get_table_name = lambda name, schema="": name
    mock_adapter.qualify_table_name = lambda name, schema="": name
    with patch(
        "app.db.repositories.base.get_adapter", return_value=mock_adapter
    ), patch(
        "app.domains.admin.services.user_directory.get_domain_settings",
        return_value=AdminSettings(),
    ), patch(
        "app.auth.user_repository.get_domain_settings",
        return_value=AdminSettings(),
    ):
        return AuthUserRepository(conn=mock_conn)


_DIRECTORY_ROW = {
    "username": "12345",
    "email": "user@example.com",
    "fullname": "Иванов И.И.",
    "job": "Аудитор",
}

_AUTH_USER = {
    "id": "12345",
    "email": "user@example.com",
    "login": "12345",
    "fullname": "Иванов И.И.",
    "job": "Аудитор",
}


# -------------------------------------------------------------------------
# find_by_email / find_by_id
# -------------------------------------------------------------------------


class TestFindByEmail:

    async def test_maps_directory_row(self, repo, mock_conn):
        """Строка справочника приводится к форме слоя авторизации."""
        mock_conn.fetchrow.return_value = dict(_DIRECTORY_ROW)

        assert await repo.find_by_email("user@example.com") == _AUTH_USER

    async def test_not_found(self, repo, mock_conn):
        """Возвращает None, если пользователь не найден."""
        mock_conn.fetchrow.return_value = None

        assert await repo.find_by_email("no@example.com") is None

    async def test_queries_directory_table(self, repo, mock_conn):
        """Запрос уходит в справочник admin-домена с сохранённой семантикой."""
        mock_conn.fetchrow.return_value = None
        await repo.find_by_email("user@example.com")

        sql = mock_conn.fetchrow.call_args.args[0]
        assert "LOWER(TRIM(email)) = LOWER(TRIM($1))" in sql
        assert "DISTINCT ON (username)" in sql


class TestFindById:

    async def test_maps_directory_row(self, repo, mock_conn):
        """id и login заполняются из username справочника."""
        mock_conn.fetchrow.return_value = dict(_DIRECTORY_ROW)
        result = await repo.find_by_id("12345")

        assert result == _AUTH_USER
        assert result["id"] == result["login"]

    async def test_not_found(self, repo, mock_conn):
        """Возвращает None, если пользователя нет в справочнике."""
        mock_conn.fetchrow.return_value = None

        assert await repo.find_by_id("99999") is None


# -------------------------------------------------------------------------
# get_user_context
# -------------------------------------------------------------------------


class TestGetUserContext:

    async def test_composes_user_and_roles(self, repo, mock_conn):
        """Контекст = профиль из справочника + имена ролей из RBAC."""
        mock_conn.fetchrow.return_value = dict(_DIRECTORY_ROW)
        mock_conn.fetch.return_value = [
            {"id": 2, "name": "Чат-ассистент", "domain_name": "chat", "description": ""},
            {"id": 1, "name": "Админ", "domain_name": None, "description": ""},
        ]
        result = await repo.get_user_context("12345")

        assert result == {
            "id": "12345",
            "email": "user@example.com",
            "login": "12345",
            "fullname": "Иванов И.И.",
            "job": "Аудитор",
            "teams": [],
            "roles": ["Админ", "Чат-ассистент"],
        }

    async def test_roles_sorted_by_name(self, repo, mock_conn):
        """Роли отдаются по имени, независимо от порядка строк из БД."""
        mock_conn.fetchrow.return_value = dict(_DIRECTORY_ROW)
        mock_conn.fetch.return_value = [
            {"name": "Цифровой акт"},
            {"name": "Админ"},
            {"name": "SQL-агент"},
        ]
        result = await repo.get_user_context("12345")

        assert result["roles"] == ["SQL-агент", "Админ", "Цифровой акт"]

    async def test_no_roles(self, repo, mock_conn):
        """Пользователь без ролей получает пустой список, а не None."""
        mock_conn.fetchrow.return_value = dict(_DIRECTORY_ROW)
        mock_conn.fetch.return_value = []
        result = await repo.get_user_context("12345")

        assert result["roles"] == []
        assert result["teams"] == []

    async def test_unknown_user_returns_none_without_roles_query(
        self, repo, mock_conn,
    ):
        """Нет пользователя в справочнике — None и без похода за ролями."""
        mock_conn.fetchrow.return_value = None

        assert await repo.get_user_context("99999") is None
        mock_conn.fetch.assert_not_called()


# -------------------------------------------------------------------------
# Регрессия: auth не заводит собственных копий запросов admin
# -------------------------------------------------------------------------


def test_auth_repository_has_no_own_sql():
    """В app/auth/user_repository.py не должно быть своего SQL.

    Справочник и роли читают репозитории admin-домена. Копия запроса здесь
    означала бы, что форма справочника или модель ролей правится в двух
    местах, а расхождение auth и admin — это разные представления об одном
    пользователе (например, снятая роль, оставшаяся в JWT).
    """
    source = (
        _PROJECT_ROOT / "app" / "auth" / "user_repository.py"
    ).read_text(encoding="utf-8")

    found = re.findall(r"\b(SELECT|INSERT|UPDATE|DELETE|JOIN)\b", source)
    assert not found, (
        "app/auth/user_repository.py снова содержит собственный SQL "
        f"({', '.join(sorted(set(found)))}) — запросы к справочнику и ролям "
        "должны выполняться репозиториями admin-домена"
    )
