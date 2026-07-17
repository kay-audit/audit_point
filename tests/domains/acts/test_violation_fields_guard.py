"""Тест-страж декларативного контракта полей нарушения (violation_fields.py).

По образцу test_block_types_guard.py: закрывает риск рассинхронизации
контракта полей нарушения (метки/порядок/kind/флаги) со схемой
ViolationSchema (порядок полей) и с фронтовым зеркалом
static/js/constructor/violation/violation-fields.js (значения меток — тут
пиннятся литералом, там — своим стражем tests/js/violation-fields.test.mjs).

Покрытие форматтеров MARKER'ом — в Task 11 (форматтеры ещё не выровнены на
этот контракт), здесь его сознательно нет.
"""
from app.domains.acts.schemas.act_content import ViolationSchema
from app.domains.acts.violation_fields import (
    CASE_LABEL_TEMPLATE,
    FREE_TEXT_LABEL,
    LABELS,
    VIOLATION_FIELDS,
)

# id/nodeId — метаданные нарушения, не поля контента; в контракт не входят.
_META_FIELDS = ("id", "nodeId")


class TestOrderMatchesSchema:
    """Порядок/состав контракта обязан совпадать с ViolationSchema."""

    def test_keys_match_violation_schema_field_order(self):
        schema_keys = [
            key for key in ViolationSchema.model_fields if key not in _META_FIELDS
        ]
        contract_keys = [field.key for field in VIOLATION_FIELDS]
        assert contract_keys == schema_keys, (
            "Порядок/состав VIOLATION_FIELDS разошёлся с полями ViolationSchema — "
            "синхронизируй violation_fields.py (и фронтовый violation-fields.js)"
        )


class TestNoDuplicatesAndOrderIndex:
    """order — позиция в кортеже, ключи не дублируются."""

    def test_no_duplicate_keys(self):
        keys = [field.key for field in VIOLATION_FIELDS]
        assert len(keys) == len(set(keys)), "В VIOLATION_FIELDS есть дублирующиеся key"

    def test_order_is_positional_index(self):
        for index, field in enumerate(VIOLATION_FIELDS):
            assert field.order == index, (
                f"order поля {field.key!r} ({field.order}) должен совпадать с "
                f"позицией в кортеже ({index})"
            )


class TestCanonicalLabels:
    """Точные канонические значения меток (якорь ручной синхронизации с фронтом)."""

    def test_labels_literal_values(self):
        assert LABELS == {
            "violated": "Нарушено",
            "established": "Установлено",
            "descriptionList": "",
            "additionalContent": "",
            "reasons": "Причины",
            "measures": "Принятые меры",
            "consequences": "Последствия",
            "responsible": "Ответственные",
        }

    def test_case_and_free_text_labels(self):
        assert CASE_LABEL_TEMPLATE == "Кейс {n}"
        assert FREE_TEXT_LABEL == ""


class TestKindSmallAndPreviewFlags:
    """kind/small/show_label_in_preview — точные значения контракта (бриф #31A)."""

    def test_kind_small_show_label_in_preview(self):
        expected = {
            "violated": ("pair", True, True),
            "established": ("pair", True, True),
            "descriptionList": ("list", True, False),
            "additionalContent": ("additional", True, False),
            "reasons": ("optional_text", False, True),
            "measures": ("optional_text", False, True),
            "consequences": ("optional_text", False, True),
            "responsible": ("optional_text", False, True),
        }
        actual = {
            field.key: (field.kind, field.small, field.show_label_in_preview)
            for field in VIOLATION_FIELDS
        }
        assert actual == expected


class TestRichFlag:
    """Флаг rich указывает, какие поля требуют rich-редактора и HTML-санитайзера."""

    def test_rich_flag_values(self):
        expected = {
            "violated": True,
            "established": True,
            "descriptionList": False,
            "additionalContent": False,
            "reasons": True,
            "measures": True,
            "consequences": True,
            "responsible": True,
        }
        actual = {f.key: f.rich for f in VIOLATION_FIELDS}
        assert actual == expected
