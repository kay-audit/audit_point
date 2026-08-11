"""Тест-страж декларативного контракта полей нарушения (violation_fields.py).

Блочная модель: закрывает риск рассинхронизации реестра полей
(состав/метки/порядок/mandatory/small/labeled/колонки) со схемой ViolationSchema и
с фронтовым зеркалом static/js/constructor/violation/violation-fields.js
(значения меток — тут пиннятся литералом, там — своим стражем
tests/js/violation-fields.test.mjs). Плюс страж значений типов блоков
python-union ↔ фронтовые константы violation-block-types.js.
"""
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.domains.acts.schemas.act_content import ViolationSchema
from app.domains.acts.violation_fields import (
    FIELD_BY_KEY,
    LABELS,
    MANDATORY_FIELD_KEYS,
    VIOLATION_FIELD_COLUMNS,
    VIOLATION_FIELD_KEYS,
    VIOLATION_FIELDS,
    field_label_for_render,
    is_valid_field_order,
    ordered_fields,
    should_render_field,
)

# id/nodeId/fieldOrder — метаданные нарушения, не поля контента; в контракт не входят.
_META_FIELDS = ("id", "nodeId", "fieldOrder")

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_BLOCK_TYPES_JS = (
    _PROJECT_ROOT / "static" / "js" / "constructor" / "violation"
    / "violation-block-types.js"
)


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
    """default_order — позиция в кортеже, ключи и колонки не дублируются."""

    def test_no_duplicate_keys(self):
        keys = [field.key for field in VIOLATION_FIELDS]
        assert len(keys) == len(set(keys)), "В VIOLATION_FIELDS есть дублирующиеся key"

    def test_no_duplicate_columns(self):
        cols = [field.column for field in VIOLATION_FIELDS]
        assert len(cols) == len(set(cols)), "В VIOLATION_FIELDS есть дублирующиеся column"

    def test_default_order_is_positional_index(self):
        for index, field in enumerate(VIOLATION_FIELDS):
            assert field.default_order == index, (
                f"default_order поля {field.key!r} ({field.default_order}) должен "
                f"совпадать с позицией в кортеже ({index})"
            )

    def test_derived_collections_consistent(self):
        assert VIOLATION_FIELD_KEYS == tuple(f.key for f in VIOLATION_FIELDS)
        assert VIOLATION_FIELD_COLUMNS == tuple(f.column for f in VIOLATION_FIELDS)
        assert set(FIELD_BY_KEY) == set(VIOLATION_FIELD_KEYS)


class TestCanonicalLabels:
    """Точные канонические значения меток (якорь ручной синхронизации с фронтом)."""

    def test_labels_literal_values(self):
        assert LABELS == {
            "violated": "Нарушено",
            "established": "Установлено",
            "description": "Описание",
            "codeMining": "CodeMining",
            "processMining": "ProcessMining",
            "additionalContent": "Дополнительный контент",
            "reasons": "Причины",
            "measures": "Принятые меры",
            "consequences": "Последствия",
            "responsible": "Ответственные",
        }


class TestMandatoryAndSmallFlags:
    """mandatory/small/labeled — точные значения контракта (решения владельца)."""

    def test_mandatory_flag_values(self):
        assert MANDATORY_FIELD_KEYS == ("violated", "established")

    def test_small_flag_values(self):
        """9pt-курсив — только Нарушено/Установлено (additionalContent выведен
        из группы решением владельца: обычный размер, без курсива)."""
        expected = {
            "violated": True,
            "established": True,
            "description": False,
            "codeMining": False,
            "processMining": False,
            "additionalContent": False,
            "reasons": False,
            "measures": False,
            "consequences": False,
            "responsible": False,
        }
        actual = {f.key: f.small for f in VIOLATION_FIELDS}
        assert actual == expected

    def test_labeled_flag_values(self):
        """Без метки в экспортах/превью — CodeMining/ProcessMining/доп. контент."""
        expected = {
            "violated": True,
            "established": True,
            "description": True,
            "codeMining": False,
            "processMining": False,
            "additionalContent": False,
            "reasons": True,
            "measures": True,
            "consequences": True,
            "responsible": True,
        }
        actual = {f.key: f.labeled for f in VIOLATION_FIELDS}
        assert actual == expected


class TestRenderPolicy:
    """Централизованная политика рендеров (№18): предикаты реестра.

    Оба Python-рендера (DOCX и MD/TXT) обязаны звать эти функции вместо
    собственных условий — тест фиксирует их семантику как контракт.
    """

    def test_label_none_for_unlabeled_fields(self):
        for key in ("codeMining", "processMining", "additionalContent"):
            assert field_label_for_render(FIELD_BY_KEY[key]) is None

    def test_label_is_field_label_for_labeled_fields(self):
        for key, label in LABELS.items():
            if FIELD_BY_KEY[key].labeled:
                assert field_label_for_render(FIELD_BY_KEY[key]) == label

    def test_mandatory_field_always_rendered(self):
        """#14: метка обязательного поля выводится и при пустом контейнере."""
        field = FIELD_BY_KEY["violated"]
        assert should_render_field(field, enabled=True, has_blocks=False) is True
        assert should_render_field(field, enabled=False, has_blocks=False) is True

    def test_optional_field_requires_enabled_and_blocks(self):
        field = FIELD_BY_KEY["reasons"]
        assert should_render_field(field, enabled=True, has_blocks=True) is True
        assert should_render_field(field, enabled=True, has_blocks=False) is False
        assert should_render_field(field, enabled=False, has_blocks=True) is False


class TestColumnNames:
    """Имена колонок БД — snake_case ключей (якорь для schema.sql-стража)."""

    def test_column_literal_values(self):
        expected = {
            "violated": "violated",
            "established": "established",
            "description": "description",
            "codeMining": "code_mining",
            "processMining": "process_mining",
            "additionalContent": "additional_content",
            "reasons": "reasons",
            "measures": "measures",
            "consequences": "consequences",
            "responsible": "responsible",
        }
        actual = {f.key: f.column for f in VIOLATION_FIELDS}
        assert actual == expected


# Невалидные порядки полей: описание → значение fieldOrder.
_INVALID_ORDERS = {
    "не список": "violated",
    "None": None,
    "неполный": list(VIOLATION_FIELD_KEYS[1:]),
    "лишний элемент": [*VIOLATION_FIELD_KEYS, "violated"],
    "дубль вместо ключа": [*VIOLATION_FIELD_KEYS[:9], "violated"],
    "чужой ключ": [*VIOLATION_FIELD_KEYS[:9], "unknownField"],
}


class TestFieldOrderPredicate:
    """`is_valid_field_order` — единый критерий валидности fieldOrder.

    Реакция потребителей разная (рендеры молча падают на стандартный порядок,
    схема отклоняет запись), критерий — один.
    """

    def test_permutation_of_all_keys_is_valid(self):
        assert is_valid_field_order(list(VIOLATION_FIELD_KEYS)) is True
        assert is_valid_field_order(list(reversed(VIOLATION_FIELD_KEYS))) is True

    @pytest.mark.parametrize("case", list(_INVALID_ORDERS), ids=list(_INVALID_ORDERS))
    def test_invalid_orders_rejected(self, case):
        assert is_valid_field_order(_INVALID_ORDERS[case]) is False

    @pytest.mark.parametrize("case", list(_INVALID_ORDERS), ids=list(_INVALID_ORDERS))
    def test_ordered_fields_falls_back_silently(self, case):
        """Рендеры: невалидный порядок молча заменяется стандартным."""
        assert ordered_fields({"fieldOrder": _INVALID_ORDERS[case]}) == VIOLATION_FIELDS

    def test_ordered_fields_applies_valid_permutation(self):
        order = list(reversed(VIOLATION_FIELD_KEYS))
        assert [f.key for f in ordered_fields({"fieldOrder": order})] == order

    @pytest.mark.parametrize("case", list(_INVALID_ORDERS), ids=list(_INVALID_ORDERS))
    def test_schema_rejects_invalid_order(self, case):
        """Схема: тот же критерий, но невалидный порядок — отказ, не дефолт.

        None — легитимное значение поля (стандартный порядок), проверяется
        отдельно ниже.
        """
        order = _INVALID_ORDERS[case]
        if order is None:
            return
        with pytest.raises(ValidationError):
            ViolationSchema(id="v1", nodeId="n1", fieldOrder=order)

    def test_schema_accepts_none_and_valid_permutation(self):
        assert ViolationSchema(id="v1", nodeId="n1", fieldOrder=None).fieldOrder is None
        order = list(reversed(VIOLATION_FIELD_KEYS))
        assert ViolationSchema(id="v1", nodeId="n1", fieldOrder=order).fieldOrder == order


class TestBlockTypesSync:
    """Значения типов блоков: python-union ↔ фронтовые константы BLOCK_TYPES.

    По образцу пары block_types.py ↔ block-types.js: фронт не импортирует
    Python, синхронизация ручная, пин — этот тест (парсит js-файл).
    """

    def test_frontend_block_types_match_python_literals(self):
        js_source = _BLOCK_TYPES_JS.read_text(encoding="utf-8")
        js_values = set(
            re.findall(r"^\s*[A-Z_]+:\s*'([a-z]+)'", js_source, re.MULTILINE)
        )
        assert js_values == {"text", "image", "table"}, (
            "BLOCK_TYPES в violation-block-types.js разошёлся со значениями "
            "Literal-типов блоков в act_content.py (text/image/table)"
        )
