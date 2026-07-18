"""Тест-страж реестра типов блоков конструктора (решение Б-2.6).

Закрывает риск «добавил тип — забыл формат» (§7 recheck-отчёта): правки
при добавлении типа рассыпаны по схеме, трём форматтерам и санитайзеру,
и пропуск любой точки молчалив (блок просто исчезает из одного экспорта).

Для КАЖДОГО leaf-типа из реестра app/domains/acts/block_types.py страж
проверяет:
- (а) тип присутствует в Literal ActItemSchema.type (и наоборот — Literal
  не содержит типов вне реестра);
- (б, в, г) семантически: фикстура-акт с одним блоком данного типа
  прогоняется через DOCX-, markdown- и text-форматтеры, маркер контента
  блока обязан попасть в вывод;
- (д) textblock.content и violation.violated/established (rich-поля —
  VIOLATION_FIELDS.rich) проходят sanitize_act_data: грязный HTML
  вычищается, текст остаётся.

Новый тип, добавленный в LEAF_BLOCK_TYPES, провалит параметризацию
(нет фикстуры → явный fail с подсказкой), пока не появятся payload
фикстуры и ветки обработки во всех трёх форматтерах.
"""

from datetime import date
from typing import get_args

import pytest

from app.domains.acts.block_types import (
    LEAF_BLOCK_REFS,
    LEAF_BLOCK_TYPES,
    NODE_TYPE_TABLE,
    NODE_TYPE_TEXTBLOCK,
    NODE_TYPE_VIOLATION,
    NODE_TYPES,
)
from app.domains.acts.formatters import (
    DocxFormatter,
    MarkdownFormatter,
    TextFormatter,
)
from app.domains.acts.formatters.docx import ExportContext
from app.domains.acts.schemas.act_content import ActDataSchema, ActItemSchema
from app.domains.acts.settings import ActsSettings
from app.domains.acts.utils.html_sanitizer import sanitize_act_data

# Уникальный маркер содержимого блока: обязан дойти до вывода форматтера.
MARKER = "МАРКЕР_КОНТЕНТА_БЛОКА_7F2C"

# Детерминированный порядок для параметризации.
LEAF_TYPES = sorted(LEAF_BLOCK_TYPES)


class _Meta:
    """Минимальные метаданные акта для DOCX-фасада (как в test_formatter_facade)."""
    km_number = "КМ-99-99999"
    part_number = 1
    total_parts = 1
    inspection_name = "Демо"
    is_process_based = False
    inspection_start_date = date(2026, 3, 1)
    inspection_end_date = date(2026, 4, 30)
    order_number = "Text/2026/15-Б"
    order_date = date(2026, 1, 15)
    city = "Москва"
    audit_team = []
    directives = []


# Payload записи словаря для каждого leaf-типа. Новый тип в реестре без
# записи здесь провалит _make_act_data с явной подсказкой.
_BLOCK_PAYLOADS = {
    NODE_TYPE_TABLE: lambda block_id: {
        "id": block_id,
        "nodeId": "1.1",
        "grid": [
            [{"content": "Заголовок", "isHeader": True}],
            [{"content": MARKER}],
        ],
        "colWidths": [100],
    },
    NODE_TYPE_TEXTBLOCK: lambda block_id: {
        "id": block_id,
        "nodeId": "1.1",
        "content": f"<p>{MARKER}</p>",
    },
    NODE_TYPE_VIOLATION: lambda block_id: {
        "id": block_id,
        "nodeId": "1.1",
        "violated": MARKER,
    },
}


def _make_act_data(block_type: str) -> dict:
    """Собирает данные акта с единственным блоком указанного типа."""
    if block_type not in _BLOCK_PAYLOADS:
        pytest.fail(
            f"Для типа {block_type!r} нет фикстуры в тест-страже: добавь payload "
            f"в _BLOCK_PAYLOADS и убедись, что тип обработан в схеме, трёх "
            f"форматтерах и санитайзере (чек-лист — developer-guide §10.10)"
        )

    ref_field, dict_name = LEAF_BLOCK_REFS[block_type]
    block_id = f"{block_type}_1"
    data = {
        "tree": {
            "id": "root",
            "label": "Акт",
            "children": [
                {
                    "id": "1",
                    "label": "Раздел 1",
                    "children": [
                        {
                            "id": "1.1",
                            "type": block_type,
                            "label": "Блок",
                            ref_field: block_id,
                        },
                    ],
                },
            ],
        },
        "tables": {},
        "textBlocks": {},
        "violations": {},
    }
    data[dict_name] = {block_id: _BLOCK_PAYLOADS[block_type](block_id)}
    return data


def _docx_all_text(doc) -> str:
    """Собирает весь текст DOCX: абзацы документа и ячейки всех таблиц."""
    parts = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                parts.append(cell.text)
    return "\n".join(parts)


class TestRegistrySchemaSync:
    """(а) Реестр ↔ Literal схемы: наборы типов совпадают в обе стороны."""

    def test_literal_matches_registry_node_types(self):
        """Literal ActItemSchema.type — ровно NODE_TYPES реестра."""
        literal_types = set(get_args(ActItemSchema.model_fields["type"].annotation))
        assert literal_types == set(NODE_TYPES), (
            "Набор типов в Literal ActItemSchema.type разошёлся с реестром "
            "block_types.py — синхронизируй оба места (и фронтовый "
            "static/js/constructor/block-types.js)"
        )

    def test_leaf_refs_cover_all_leaf_types(self):
        """LEAF_BLOCK_REFS описывает каждый leaf-тип (и только их)."""
        assert set(LEAF_BLOCK_REFS) == set(LEAF_BLOCK_TYPES)

    def test_leaf_ref_fields_exist_in_schemas(self):
        """Поле-ссылка есть в ActItemSchema, словарь — в ActDataSchema."""
        for ref_field, dict_name in LEAF_BLOCK_REFS.values():
            assert ref_field in ActItemSchema.model_fields, (
                f"В ActItemSchema нет поля-ссылки {ref_field!r}"
            )
            assert dict_name in ActDataSchema.model_fields, (
                f"В ActDataSchema нет словаря {dict_name!r}"
            )


@pytest.mark.parametrize("block_type", LEAF_TYPES)
class TestFormattersCoverEveryLeafType:
    """(б, в, г) Каждый leaf-тип доходит до вывода всех трёх форматтеров."""

    def test_text_formatter_renders_block(self, block_type):
        formatter = TextFormatter(settings=None, acts_settings=ActsSettings())
        output = formatter.format(_make_act_data(block_type))
        assert MARKER in output, (
            f"text_formatter потерял блок типа {block_type!r} — нет ветки обработки"
        )

    def test_markdown_formatter_renders_block(self, block_type):
        formatter = MarkdownFormatter(settings=None, acts_settings=ActsSettings())
        output = formatter.format(_make_act_data(block_type))
        assert MARKER in output, (
            f"markdown_formatter потерял блок типа {block_type!r} — нет ветки обработки"
        )

    def test_docx_formatter_renders_block(self, block_type):
        content = ActDataSchema.model_validate(_make_act_data(block_type))
        doc = DocxFormatter().format(ExportContext(metadata=_Meta(), content=content))
        assert MARKER in _docx_all_text(doc), (
            f"DOCX-форматтер потерял блок типа {block_type!r} — нет ветки обработки"
        )


class TestSanitizerCoversHtmlFields:
    """(д) textblock.content и violation.violated/established чистятся sanitize_act_data."""

    DIRTY = f"<script>alert(1)</script><b>{MARKER}</b>"

    def test_textblock_content_sanitized(self):
        data = _make_act_data(NODE_TYPE_TEXTBLOCK)
        data["textBlocks"][f"{NODE_TYPE_TEXTBLOCK}_1"]["content"] = self.DIRTY
        model = ActDataSchema.model_validate(data)

        sanitize_act_data(model)

        content = model.textBlocks[f"{NODE_TYPE_TEXTBLOCK}_1"].content
        assert "<script>" not in content, "textblock.content не прошёл санитизацию"
        assert MARKER in content, "санитайзер не должен терять легитимный текст"

    def test_violation_rich_fields_sanitized(self):
        """violation.violated/established — rich-поля, sanitize_act_data их чистит."""
        data = _make_act_data(NODE_TYPE_VIOLATION)
        violation = data["violations"][f"{NODE_TYPE_VIOLATION}_1"]
        violation["violated"] = self.DIRTY
        violation["established"] = self.DIRTY
        model = ActDataSchema.model_validate(data)

        sanitize_act_data(model)

        result = model.violations[f"{NODE_TYPE_VIOLATION}_1"]
        for field_name in ("violated", "established"):
            value = getattr(result, field_name)
            assert "<script>" not in value, (
                f"violation.{field_name} не прошёл санитизацию"
            )
            assert MARKER in value, "санитайзер не должен терять легитимный текст"
