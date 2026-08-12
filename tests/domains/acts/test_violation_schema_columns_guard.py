"""Страж соответствия колонок таблицы нарушений реестру полей.

Блочная модель: состав и порядок полевых JSONB-колонок act_violations в ОБЕИХ
миграциях (postgresql/greenplum) обязан совпадать с VIOLATION_FIELD_COLUMNS
(app/domains/acts/violation_fields.py). Плюс: на каждой полевой колонке —
CHECK check_<col>_is_object_or_null, на field_order — array-or-null.

Парсинг — через DatabaseAdapter._split_sql_statements (учитывает ';' в
комментариях/строках/dollar-quoting), line-комментарии вырезаются до
regex-поиска (конвенция тестирования схем, см. testing-гайд).
"""
import re
from pathlib import Path

import pytest

from app.db.adapters.base import DatabaseAdapter
from app.domains.acts.violation_fields import VIOLATION_FIELD_COLUMNS

_MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "app" / "domains" / "acts" / "migrations"

# Служебные колонки таблицы нарушений (не полевые контейнеры).
_SERVICE_COLUMNS = {
    "id", "act_id", "audit_act_id", "audit_point_id",
    "violation_id", "node_id", "node_number",
    "field_order", "created_at", "updated_at",
}

_COLUMN_RE = re.compile(
    r"^\s*([a-z_]+)\s+(BIGSERIAL|BIGINT|INTEGER|VARCHAR|TEXT|JSONB|TIMESTAMP)",
    re.MULTILINE,
)


def _strip_line_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def _violations_create_stmt(dialect: str) -> str:
    sql = (_MIGRATIONS_DIR / dialect / "schema.sql").read_text(encoding="utf-8")
    for stmt in DatabaseAdapter._split_sql_statements(sql):
        cleaned = _strip_line_comments(stmt)
        if re.search(r"CREATE TABLE.*act_violations\s*\(", cleaned, re.DOTALL):
            return cleaned
    raise AssertionError(f"CREATE TABLE act_violations не найден в {dialect}/schema.sql")


def _ordered_columns(stmt: str) -> list[str]:
    """Все колонки CREATE TABLE в порядке объявления (до секции констрейнтов)."""
    return [m.group(1) for m in _COLUMN_RE.finditer(stmt)]


@pytest.mark.parametrize("dialect", ["postgresql", "greenplum"])
class TestViolationColumnsMatchRegistry:
    """Полевые колонки act_violations == реестр (состав И порядок)."""

    def test_field_columns_match_registry_in_order(self, dialect):
        stmt = _violations_create_stmt(dialect)
        field_columns = [
            col for col in _ordered_columns(stmt) if col not in _SERVICE_COLUMNS
        ]
        assert field_columns == list(VIOLATION_FIELD_COLUMNS), (
            f"{dialect}/schema.sql: полевые колонки act_violations разошлись с "
            "VIOLATION_FIELD_COLUMNS (violation_fields.py) — синхронизируй обе "
            "миграции и реестр"
        )

    def test_field_columns_are_jsonb(self, dialect):
        stmt = _violations_create_stmt(dialect)
        types = {m.group(1): m.group(2) for m in _COLUMN_RE.finditer(stmt)}
        for col in VIOLATION_FIELD_COLUMNS:
            assert types.get(col) == "JSONB", (
                f"{dialect}: колонка {col} должна быть JSONB (контейнер enabled/blocks)"
            )
        assert types.get("field_order") == "JSONB", f"{dialect}: field_order должна быть JSONB"

    def test_each_field_column_has_object_check(self, dialect):
        stmt = _violations_create_stmt(dialect)
        for col in VIOLATION_FIELD_COLUMNS:
            constraint = f"check_{col}_is_object_or_null"
            assert constraint in stmt, (
                f"{dialect}: на колонке {col} нет CHECK {constraint}"
            )
            assert re.search(
                rf"{col}\s+IS\s+NULL\s+OR\s+jsonb_typeof\({col}\)\s*=\s*'object'",
                stmt,
            ), f"{dialect}: CHECK {constraint} должен проверять object-or-null"

    def test_field_order_has_array_check(self, dialect):
        stmt = _violations_create_stmt(dialect)
        assert "check_field_order_is_array_or_null" in stmt
        assert re.search(
            r"field_order\s+IS\s+NULL\s+OR\s+jsonb_typeof\(field_order\)\s*=\s*'array'",
            stmt,
        ), f"{dialect}: CHECK field_order должен проверять array-or-null"


def test_pg_and_gp_column_sets_identical():
    """PG и GP объявляют одинаковый набор колонок act_violations."""
    pg = set(_ordered_columns(_violations_create_stmt("postgresql")))
    gp = set(_ordered_columns(_violations_create_stmt("greenplum")))
    assert pg == gp, f"Рассинхрон колонок PG↔GP: {sorted(pg ^ gp)}"
