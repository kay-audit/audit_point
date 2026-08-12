"""Маппер «строка таблицы нарушений ↔ документ нарушения» (блочная модель).

ЕДИНСТВЕННОЕ место знания о соответствии колонок БД полям нарушения:
SELECT-список, INSERT-запрос и разбор строки генерируются циклом по реестру
VIOLATION_FIELDS (violation_fields.py). Потребители: загрузка/сохранение
(act_content.py), копирование акта (act_crud.py). Ручное перечисление
колонок нарушения вне этого модуля — регрессия (страж состава колонок —
tests/domains/acts/test_violation_schema_columns_guard.py, маппера —
tests/domains/acts/test_violation_row_mapper.py).
"""
import json
from typing import Any, Mapping

from app.domains.acts.violation_fields import VIOLATION_FIELDS

# Колонки контента в порядке реестра + field_order (пользовательский порядок).
_CONTENT_COLUMNS: tuple[str, ...] = tuple(
    f.column for f in VIOLATION_FIELDS
) + ("field_order",)

# Колонки, идентифицирующие нарушение при копировании между актами
# (audit_act_id/audit_point_id сознательно не копируются — их проставляет
# следующее сохранение целевого акта, как и раньше).
_COPY_COLUMNS: tuple[str, ...] = (
    "violation_id", "node_id", "node_number",
) + _CONTENT_COLUMNS

# Полный список колонок INSERT при сохранении акта.
_INSERT_COLUMNS: tuple[str, ...] = (
    "act_id", "audit_act_id", "audit_point_id",
    "violation_id", "node_id", "node_number",
) + _CONTENT_COLUMNS


def select_columns_sql() -> str:
    """Список колонок для SELECT загрузки нарушений акта."""
    return ", ".join(("violation_id", "node_id") + _CONTENT_COLUMNS)


def insert_sql(table: str) -> str:
    """INSERT сохранения нарушения с позиционными плейсхолдерами."""
    placeholders = ", ".join(f"${i}" for i in range(1, len(_INSERT_COLUMNS) + 1))
    return (
        f"INSERT INTO {table} ({', '.join(_INSERT_COLUMNS)})\n"
        f"VALUES ({placeholders})"
    )


def copy_sql(table: str) -> str:
    """INSERT…SELECT копирования нарушений из акта $1 в акт $2."""
    cols = ", ".join(_COPY_COLUMNS)
    return (
        f"INSERT INTO {table} (act_id, {cols})\n"
        f"SELECT $2, {cols}\n"
        f"FROM {table}\n"
        f"WHERE act_id = $1"
    )


def row_to_violation_dict(row: Mapping[str, Any]) -> dict:
    """Строка БД → документ нарушения (форма фронта/ViolationSchema).

    NULL-колонка поля → дефолтный контейнер (mandatory-поля — включённые),
    NULL field_order → None (стандартный порядок).
    """
    doc: dict[str, Any] = {
        "id": row["violation_id"],
        "nodeId": row["node_id"],
        "fieldOrder": json.loads(row["field_order"]) if row["field_order"] else None,
    }
    for field in VIOLATION_FIELDS:
        raw = row[field.column]
        doc[field.key] = (
            json.loads(raw) if raw
            else {"enabled": field.mandatory, "blocks": []}
        )
    return doc


def violation_insert_args(
    act_id: int,
    audit_act_id: str | None,
    audit_point_id: str | None,
    violation_id: str,
    node_id: str,
    node_number: str | None,
    v_data: Any,
) -> tuple:
    """Значения INSERT в порядке _INSERT_COLUMNS.

    v_data — ViolationSchema: полевые контейнеры сериализуются в JSON
    (model_dump), fieldOrder — JSON-массив или NULL.
    """
    content_values = tuple(
        json.dumps(getattr(v_data, field.key).model_dump())
        for field in VIOLATION_FIELDS
    ) + (
        json.dumps(v_data.fieldOrder) if v_data.fieldOrder is not None else None,
    )
    return (
        act_id, audit_act_id, audit_point_id,
        violation_id, node_id, node_number,
    ) + content_values
