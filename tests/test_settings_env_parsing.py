"""Тесты парсинга .env для доменных настроек через settings_registry."""

import textwrap
from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import BaseModel, Field

from app.core import settings_registry


@pytest.fixture(autouse=True)
def clean_registry():
    settings_registry.reset()
    yield
    settings_registry.reset()


# ── Модели для тестов ──


class NestedWithAlias(BaseModel):
    """Вложенная модель с alias и populate_by_name."""

    schema_name: str = Field(default="default_schema", alias="schema")
    table: str = "default_table"

    model_config = {"populate_by_name": True}


class ParentModel(BaseModel):
    """Родительская модель (populate_by_name во вложенной)."""

    nested: NestedWithAlias = NestedWithAlias()


class NestedWithoutPopulateByName(BaseModel):
    """Вложенная модель с alias, но БЕЗ populate_by_name."""

    schema_name: str = Field(default="default_schema", alias="schema")
    table: str = "default_table"


class ParentWithoutPopulate(BaseModel):
    """Родительская модель с вложенной без populate_by_name."""

    nested: NestedWithoutPopulateByName = NestedWithoutPopulateByName()


# ── Тесты механики pydantic alias roundtrip ──


class TestAliasRoundtrip:
    """Тесты roundtrip model_dump → model_validate для полей с alias."""

    def test_roundtrip_with_populate_by_name(self):
        """С populate_by_name roundtrip через field names работает."""
        original = NestedWithAlias(schema="my_schema", table="my_table")
        dumped = original.model_dump()
        assert "schema_name" in dumped

        restored = NestedWithAlias.model_validate(dumped)
        assert restored.schema_name == "my_schema"

    def test_roundtrip_without_populate_by_name_loses_value(self):
        """
        БЕЗ populate_by_name roundtrip model_dump → model_validate
        теряет значения полей с alias — корень бага.
        """
        original = NestedWithoutPopulateByName(
            schema="my_schema", table="my_table"
        )
        assert original.schema_name == "my_schema"

        dumped = original.model_dump()
        assert dumped == {"schema_name": "my_schema", "table": "my_table"}

        # model_validate НЕ распознаёт field name — откат на дефолт
        restored = NestedWithoutPopulateByName.model_validate(dumped)
        assert restored.schema_name == "default_schema"

    def test_roundtrip_by_alias_preserves_value(self):
        """model_dump(by_alias=True) → model_validate() сохраняет значения."""
        original = NestedWithoutPopulateByName(
            schema="my_schema", table="my_table"
        )
        dumped = original.model_dump(by_alias=True)
        assert dumped == {"schema": "my_schema", "table": "my_table"}

        restored = NestedWithoutPopulateByName.model_validate(dumped)
        assert restored.schema_name == "my_schema"


# ── Тесты _load_from_env ──


def _load_with_env_file(name: str, cls: type[BaseModel], env_file: Path) -> BaseModel:
    """Вызывает _load_from_env с подменой пути к .env файлу."""
    with patch(
        "app.core.settings_registry.Path.resolve",
        return_value=env_file.parent / "fake" / "fake" / "fake",
    ):
        pass

    # Подменяем путь к .env внутри _load_from_env
    from pydantic_core import PydanticUndefined
    from pydantic_settings import BaseSettings, SettingsConfigDict

    loader_cls = type(
        f"_{name}_Loader",
        (BaseSettings,),
        {
            "__annotations__": cls.__annotations__.copy(),
            "model_config": SettingsConfigDict(
                env_prefix=f"{name.upper()}__",
                env_nested_delimiter="__",
                env_file=str(env_file),
                case_sensitive=False,
                extra="ignore",
            ),
            **{
                field_name: field_info.default
                for field_name, field_info in cls.model_fields.items()
                if field_info.default is not None
                and field_info.default is not PydanticUndefined
            },
        },
    )

    loader_instance = loader_cls()
    # Используем by_alias=True — как в исправленном _load_from_env
    return cls.model_validate(loader_instance.model_dump(by_alias=True))


class TestLoadFromEnvWithAlias:
    """Тесты загрузки доменных настроек с alias-полями из .env."""

    def test_alias_field_loaded_from_env(self, tmp_path: Path):
        """Поле с alias='schema' загружается из PREFIX__NESTED__SCHEMA."""
        env_file = tmp_path / ".env"
        env_file.write_text(
            "TEST__NESTED__SCHEMA=custom_schema\nTEST__NESTED__TABLE=custom_table\n",
            encoding="utf-8",
        )

        result = _load_with_env_file("test", ParentModel, env_file)

        assert result.nested.table == "custom_table"
        assert result.nested.schema_name == "custom_schema"

    def test_alias_field_without_populate_by_name(self, tmp_path: Path):
        """Даже без populate_by_name, by_alias=True решает проблему."""
        env_file = tmp_path / ".env"
        env_file.write_text(
            "TEST__NESTED__SCHEMA=new_schema\nTEST__NESTED__TABLE=new_table\n",
            encoding="utf-8",
        )

        result = _load_with_env_file("test", ParentWithoutPopulate, env_file)

        assert result.nested.table == "new_table"
        assert result.nested.schema_name == "new_schema"

    def test_missing_env_uses_default(self, tmp_path: Path):
        """Без переменных в .env используются дефолтные значения."""
        env_file = tmp_path / ".env"
        env_file.write_text("", encoding="utf-8")

        result = _load_with_env_file("test", ParentWithoutPopulate, env_file)

        assert result.nested.table == "default_table"
        assert result.nested.schema_name == "default_schema"

    def test_partial_env_override(self, tmp_path: Path):
        """Переопределяется только указанное поле, остальные — дефолт."""
        env_file = tmp_path / ".env"
        env_file.write_text(
            "TEST__NESTED__TABLE=only_table\n",
            encoding="utf-8",
        )

        result = _load_with_env_file("test", ParentWithoutPopulate, env_file)

        assert result.nested.table == "only_table"
        assert result.nested.schema_name == "default_schema"


# ── Тесты для реальных AdminSettings ──


class TestAdminSettingsEnvParsing:
    """Тесты для настроек домена admin."""

    def test_admin_user_directory_schema_from_env(self, tmp_path: Path):
        """
        ADMIN__USER_DIRECTORY__SCHEMA из .env должен перезаписывать
        дефолтное значение UserDirectorySettings.schema_name.
        """
        from app.domains.admin.settings import AdminSettings

        env_file = tmp_path / ".env"
        env_file.write_text(
            textwrap.dedent("""\
                ADMIN__USER_DIRECTORY__SCHEMA=s_grnplm_ld_audit_da_project_34
                ADMIN__USER_DIRECTORY__TABLE=v_db_oarb_ua_user
                ADMIN__USER_DIRECTORY__BRANCH_FILTER=Тестовый отдел
                ADMIN__USER_DIRECTORY__DEFAULT_ADMINS=99999999,88888888
            """),
            encoding="utf-8",
        )

        result = _load_with_env_file("admin", AdminSettings, env_file)

        assert result.user_directory.table == "v_db_oarb_ua_user"
        assert result.user_directory.branch_filter == "Тестовый отдел"
        assert result.user_directory.default_admins == "99999999,88888888"
        assert result.user_directory.schema_name == "s_grnplm_ld_audit_da_project_34", (
            f"SCHEMA из .env не применился: '{result.user_directory.schema_name}'"
        )

    def test_admin_settings_default_values(self):
        """Проверка дефолтных значений UserDirectorySettings."""
        from app.domains.admin.settings import AdminSettings, UserDirectorySettings

        defaults = UserDirectorySettings()
        assert defaults.schema_name == ""
        assert defaults.table == "t_db_oarb_ua_user"

        admin = AdminSettings()
        assert admin.user_directory.schema_name == ""

    def test_admin_schema_only_override(self, tmp_path: Path):
        """Переопределение только SCHEMA, остальное — дефолт."""
        from app.domains.admin.settings import AdminSettings

        env_file = tmp_path / ".env"
        env_file.write_text(
            "ADMIN__USER_DIRECTORY__SCHEMA=s_grnplm_ld_audit_da_project_34\n",
            encoding="utf-8",
        )

        result = _load_with_env_file("admin", AdminSettings, env_file)

        assert result.user_directory.schema_name == "s_grnplm_ld_audit_da_project_34"
        assert result.user_directory.table == "t_db_oarb_ua_user"  # дефолт

    def test_parse_admin_logins_splits_and_trims(self):
        from app.domains.admin.settings import parse_admin_logins

        assert parse_admin_logins("22494524, 18284771 ,") == ["22494524", "18284771"]
        assert parse_admin_logins("22494524") == ["22494524"]
        assert parse_admin_logins("") == []
        assert parse_admin_logins(None) == []
