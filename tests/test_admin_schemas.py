"""Тесты для Pydantic-схем администрирования."""

import pytest
from pydantic import ValidationError

from app.domains.admin.schemas.admin import (
    RoleSchema,
    TB_CODES,
    UserCreateRequest,
    UserDirectoryItem,
    UserSearchResult,
    UserUpdateRequest,
    RoleAssignRequest,
)


class TestUserDirectoryItem:

    def test_department_user_with_roles(self):
        item = UserDirectoryItem(
            username="22494524",
            fullname="Маштаков Денис Романович",
            job="Менеджер направления",
            is_department=True,
            roles=[RoleSchema(id=1, name="Администратор")],
        )
        assert item.is_department is True
        assert len(item.roles) == 1

    def test_external_user_without_roles(self):
        item = UserDirectoryItem(
            username="22501010",
            fullname="Захарова Мария Дмитриевна",
            is_department=False,
        )
        assert item.is_department is False
        assert item.roles == []

    def test_defaults(self):
        item = UserDirectoryItem(username="12345678")
        assert item.fullname == ""
        assert item.job == ""
        assert item.tn == ""
        assert item.email == ""
        assert item.is_department is True
        assert item.roles == []


class TestUserSearchResult:

    def test_minimal(self):
        result = UserSearchResult(username="22501010")
        assert result.fullname == ""
        assert result.job == ""
        assert result.email == ""

    def test_full(self):
        result = UserSearchResult(
            username="22501010",
            fullname="Захарова Мария Дмитриевна",
            job="Старший аудитор",
            email="MDZakharova@omega.sbrf.ru",
        )
        assert result.username == "22501010"


class TestRoleAssignRequest:

    def test_valid(self):
        req = RoleAssignRequest(role_id=1)
        assert req.role_id == 1

    def test_missing_role_id(self):
        with pytest.raises(ValidationError):
            RoleAssignRequest()


# -------------------------------------------------------------------------
# UserDirectoryItem — новые поля tb/is_deleted
# -------------------------------------------------------------------------


class TestUserDirectoryItemTb:

    def test_tb_default_empty(self):
        """По умолчанию ТБ — пустая строка (поле может быть не заполнено)."""
        item = UserDirectoryItem(username="12345")
        assert item.tb == ""
        assert item.is_deleted is False

    def test_tb_value(self):
        item = UserDirectoryItem(username="12345", tb="МБ", is_deleted=False)
        assert item.tb == "МБ"
        assert item.is_deleted is False

    def test_deleted_user(self):
        item = UserDirectoryItem(
            username="12345",
            fullname="Удалённый",
            is_deleted=True,
            deleted_by="admin",
        )
        assert item.is_deleted is True
        assert item.deleted_by == "admin"


# -------------------------------------------------------------------------
# UserCreateRequest — tb
# -------------------------------------------------------------------------


class TestUserCreateRequest:

    def test_minimal(self):
        req = UserCreateRequest(username="12345", fullname="Иванов")
        assert req.username == "12345"
        assert req.tb == ""
        assert req.role_ids == []

    def test_with_tb_and_roles(self):
        req = UserCreateRequest(
            username="12345",
            fullname="Иванов",
            job="Аудитор",
            tb="ЦА",
            role_ids=[1, 2],
        )
        assert req.tb == "ЦА"
        assert req.role_ids == [1, 2]


# -------------------------------------------------------------------------
# UserUpdateRequest
# -------------------------------------------------------------------------


class TestUserUpdateRequest:

    def test_minimal(self):
        req = UserUpdateRequest(fullname="Иванов")
        assert req.fullname == "Иванов"
        assert req.job == ""
        assert req.tb == ""

    def test_full(self):
        req = UserUpdateRequest(
            fullname="Иванов И.И.",
            job="Аудитор",
            email="i@omega.sbrf.ru",
            tb="СИБ",
        )
        assert req.tb == "СИБ"


# -------------------------------------------------------------------------
# TB_CODES — фиксированный список допустимых ТБ
# -------------------------------------------------------------------------


class TestTbCodes:

    def test_contains_all_expected_codes(self):
        """Список ТБ содержит все 12 банков."""
        assert "СРБ" in TB_CODES
        assert "СИБ" in TB_CODES
        assert "ББ" in TB_CODES
        assert "ВВБ" in TB_CODES
        assert "МБ" in TB_CODES
        assert "ЦЧБ" in TB_CODES
        assert "СЗБ" in TB_CODES
        assert "ЮЗБ" in TB_CODES
        assert "ДВБ" in TB_CODES
        assert "УБ" in TB_CODES
        assert "ПБ" in TB_CODES
        assert "ЦА" in TB_CODES

    def test_no_duplicates(self):
        """В списке нет дубликатов."""
        assert len(TB_CODES) == len(set(TB_CODES))
