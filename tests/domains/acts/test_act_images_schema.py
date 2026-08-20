"""Схема таблицы act_images: паритет PG ↔ GP и GP-правила размещения.

Общие GP-инварианты (DISTRIBUTED BY ⊆ PK и ⊆ каждого UNIQUE, отсутствие
PG 9.5+ синтаксиса) закрывает tests/test_gp_compatibility.py — здесь только
то, что специфично для act_images: состав колонок, дедуп-констрейнт,
ключ распределения и наличие CHECK на положительный размер.
"""

import re
from pathlib import Path

import pytest

from app.db.adapters.base import DatabaseAdapter

MIGRATIONS = (
    Path(__file__).parent.parent.parent.parent
    / "app" / "domains" / "acts" / "migrations"
)


def _create_stmt(db_type: str, table: str) -> str:
    """CREATE TABLE нужной таблицы из схемы, без line-комментариев."""
    content = (MIGRATIONS / db_type / "schema.sql").read_text(encoding="utf-8")
    for raw in DatabaseAdapter._split_sql_statements(content):
        cleaned = re.sub(r"--[^\n]*", "", raw)
        if (
            re.search(r"\bCREATE\s+TABLE\b", cleaned, re.IGNORECASE)
            and "{PREFIX}" + table in cleaned
        ):
            return cleaned
    raise AssertionError(f"{db_type}/schema.sql: CREATE TABLE {table} не найдено")


@pytest.mark.parametrize("db_type", ["postgresql", "greenplum"])
def test_act_images_columns_present(db_type):
    """Обе схемы объявляют один и тот же состав колонок картинки."""
    stmt = _create_stmt(db_type, "act_images")
    for column in (
        "id", "act_id", "content_hash", "mime_type",
        "byte_size", "data", "created_by", "created_at",
    ):
        assert re.search(rf"\b{column}\b", stmt), (
            f"{db_type}: act_images не объявляет колонку {column}"
        )
    assert "BYTEA" in stmt, f"{db_type}: байты картинки должны храниться в BYTEA"


@pytest.mark.parametrize("db_type", ["postgresql", "greenplum"])
def test_act_images_dedup_unique_is_per_act(db_type):
    """Дедупликация — в пределах акта: UNIQUE (act_id, content_hash).

    Глобальный дедуп (UNIQUE по одному content_hash) дал бы одну строку на
    два акта — пользователь без доступа ко второму получил бы её содержимое
    через первый. Это констрейнт безопасности, а не только оптимизация.
    """
    stmt = _create_stmt(db_type, "act_images")
    uniques = [
        {c.strip().lower() for c in m.group(1).split(",") if c.strip()}
        for m in re.finditer(r"\bUNIQUE\s*\(([^)]+)\)", stmt, re.IGNORECASE)
    ]
    assert {"act_id", "content_hash"} in uniques, (
        f"{db_type}: нет UNIQUE (act_id, content_hash); найдено {uniques}"
    )
    assert {"content_hash"} not in uniques, (
        f"{db_type}: глобальный дедуп по content_hash недопустим"
    )


@pytest.mark.parametrize("db_type", ["postgresql", "greenplum"])
def test_act_images_byte_size_check(db_type):
    """CHECK byte_size > 0 в обеих схемах (пустой файл не сохраняется)."""
    stmt = _create_stmt(db_type, "act_images")
    assert "check_act_images_byte_size_positive" in stmt
    assert re.search(r"byte_size\s*>\s*0", stmt)


def test_act_images_byte_size_check_has_user_message():
    """CHECK замаплен в CHECK_CONSTRAINT_MESSAGES — юзер не увидит stacktrace."""
    from app.core.exceptions import CHECK_CONSTRAINT_MESSAGES

    assert "check_act_images_byte_size_positive" in CHECK_CONSTRAINT_MESSAGES


def test_act_images_gp_distribution_and_pk():
    """GP: DISTRIBUTED BY (act_id), PK (id, act_id) — id ведущий.

    Ключ распределения обязан входить и в PK, и в UNIQUE (иначе GP отдаёт
    InvalidTableDefinitionError на CREATE TABLE); id ведёт, чтобы lookups
    `WHERE id = $1 AND act_id = $2` шли по PK-индексу.
    """
    stmt = _create_stmt("greenplum", "act_images")
    dist = re.search(r"DISTRIBUTED\s+BY\s*\(([^)]+)\)", stmt, re.IGNORECASE)
    assert dist and dist.group(1).strip().lower() == "act_id"
    pk = re.search(r"PRIMARY\s+KEY\s*\(([^)]+)\)", stmt, re.IGNORECASE)
    assert pk, "GP: act_images не объявляет составной PRIMARY KEY"
    pk_cols = [c.strip().lower() for c in pk.group(1).split(",")]
    assert pk_cols == ["id", "act_id"]


def test_act_images_gp_is_heap_table():
    """GP: WITH (appendonly=false) — таблица обновляемая, как chat_files."""
    stmt = _create_stmt("greenplum", "act_images")
    assert re.search(r"appendonly\s*=\s*false", stmt, re.IGNORECASE)


def test_act_images_index_named_by_convention():
    """Индекс по act_id в обеих схемах, имя — idx_{PREFIX}act_images_act_id."""
    for db_type in ("postgresql", "greenplum"):
        sql = (MIGRATIONS / db_type / "schema.sql").read_text(encoding="utf-8")
        assert "idx_{PREFIX}act_images_act_id" in sql, (
            f"{db_type}: нет индекса idx_{{PREFIX}}act_images_act_id"
        )


def test_act_images_deleted_with_act():
    """Удаление акта уносит картинки: act_images в списке дочерних таблиц.

    На PG работает ON DELETE CASCADE, на GP referential actions не
    enforce-ятся — там таблицу чистит явный DELETE из _CHILD_TABLES.
    """
    from app.domains.acts.repositories.act_crud import ActCrudRepository

    assert "act_images" in ActCrudRepository._CHILD_TABLES
