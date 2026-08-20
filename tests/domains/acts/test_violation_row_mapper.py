"""Тесты маппера «строка таблицы нарушений ↔ документ» (блочная модель).

Round-trip: ViolationSchema → insert-аргументы → «строка БД» → документ →
ViolationSchema без потерь. SQL-генерация — по реестру VIOLATION_FIELDS.
"""
import json

from app.domains.acts.repositories import violation_row_mapper as mapper
from app.domains.acts.schemas.act_content import ViolationSchema
from app.domains.acts.violation_fields import (
    VIOLATION_FIELD_COLUMNS,
    VIOLATION_FIELD_KEYS,
    VIOLATION_FIELDS,
)


def _sample_violation(field_order=None) -> ViolationSchema:
    """Нарушение со всеми 10 полями и всеми 3 типами блоков."""
    payload = {
        "id": "viol_1",
        "nodeId": "node_1",
        "fieldOrder": field_order,
        "violated": {
            "enabled": True,
            "blocks": [
                {"id": "text_1_a", "type": "text", "content": "<p>Нарушено</p>"},
            ],
        },
        "codeMining": {
            "enabled": True,
            "blocks": [
                {"id": "table_1_b", "type": "table",
                 "table": {"grid": [[{"content": "A"}, {"content": "B"}]],
                           "colWidths": [50, 50]}},
                {"id": "image_1_c", "type": "image",
                 "image_id": "img-0001", "caption": "Подпись",
                 "filename": "a.png", "width": 40},
            ],
        },
    }
    return ViolationSchema.model_validate(payload)


def _row_from_args(args: tuple) -> dict:
    """Собирает «строку БД» из insert-аргументов (имитация fetch)."""
    columns = (
        "act_id", "audit_act_id", "audit_point_id",
        "violation_id", "node_id", "node_number",
    ) + VIOLATION_FIELD_COLUMNS + ("field_order",)
    return dict(zip(columns, args))


class TestSqlGeneration:
    """SQL генерируется по реестру: все полевые колонки + field_order."""

    def test_select_columns_cover_registry(self):
        sql = mapper.select_columns_sql()
        for col in VIOLATION_FIELD_COLUMNS:
            assert col in sql
        assert "violation_id" in sql and "node_id" in sql and "field_order" in sql

    def test_insert_sql_placeholders_match_columns(self):
        sql = mapper.insert_sql("t")
        n_columns = 6 + len(VIOLATION_FIELD_COLUMNS) + 1  # мета + поля + field_order
        assert f"${n_columns}" in sql
        assert f"${n_columns + 1}" not in sql
        for col in VIOLATION_FIELD_COLUMNS:
            assert col in sql

    def test_copy_sql_covers_registry_and_reuses_column_list(self):
        sql = mapper.copy_sql("t")
        for col in VIOLATION_FIELD_COLUMNS + ("field_order", "violation_id", "node_id", "node_number"):
            assert col in sql
        # audit-привязки не копируются (их проставит сохранение целевого акта).
        assert "audit_act_id" not in sql


class TestRoundTrip:
    """Документ → args → строка → документ: без потерь."""

    def test_full_round_trip(self):
        v = _sample_violation(field_order=list(reversed(VIOLATION_FIELD_KEYS)))
        args = mapper.violation_insert_args(7, "aa-1", "ap-1", v.id, v.nodeId, "5.1.3", v)
        row = _row_from_args(args)
        doc = mapper.row_to_violation_dict(row)

        assert doc["id"] == "viol_1"
        assert doc["nodeId"] == "node_1"
        assert doc["fieldOrder"] == list(reversed(VIOLATION_FIELD_KEYS))
        restored = ViolationSchema.model_validate(doc)
        assert restored.model_dump() == v.model_dump()

    def test_none_field_order_round_trip(self):
        v = _sample_violation(field_order=None)
        args = mapper.violation_insert_args(7, None, None, v.id, v.nodeId, None, v)
        row = _row_from_args(args)
        assert row["field_order"] is None
        doc = mapper.row_to_violation_dict(row)
        assert doc["fieldOrder"] is None

    def test_null_columns_become_default_containers(self):
        """NULL-колонки (повреждённая строка) → дефолтные контейнеры."""
        row = {
            "violation_id": "v1", "node_id": "n1", "field_order": None,
            **{col: None for col in VIOLATION_FIELD_COLUMNS},
        }
        doc = mapper.row_to_violation_dict(row)
        for field in VIOLATION_FIELDS:
            assert doc[field.key] == {"enabled": field.mandatory, "blocks": []}
        # Документ валиден для схемы.
        ViolationSchema.model_validate(doc)

    def test_insert_args_are_json_strings(self):
        v = _sample_violation()
        args = mapper.violation_insert_args(7, None, None, v.id, v.nodeId, None, v)
        row = _row_from_args(args)
        for col in VIOLATION_FIELD_COLUMNS:
            parsed = json.loads(row[col])
            assert set(parsed) == {"enabled", "blocks"}
