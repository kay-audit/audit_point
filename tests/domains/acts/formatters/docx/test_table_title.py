"""Оформление подписи таблицы в DOCX — единое правило проекта.

Пресетная таблица разделов 1–4 — обычным начертанием с подчёркиванием;
раздел 5 и любая пользовательская таблица — без эффектов вовсе. Источник
правила — ``app/domains/acts/formatters/table_title.py`` (зеркало фронта,
страж — ``tests/domains/acts/formatters/test_table_title_rule.py``).
"""
from datetime import date

import pytest

from app.domains.acts.formatters.docx import DocxFormatter, ExportContext
from app.domains.acts.schemas.act_content import ActDataSchema


class _Meta:
    km_number = "КМ-99-99999"
    part_number = 1
    total_parts = 1
    inspection_name = "Демо"
    is_process_based = True
    inspection_start_date = date(2026, 3, 1)
    inspection_end_date = date(2026, 4, 30)
    order_number = "Text/2026/15-Б"
    order_date = date(2026, 1, 15)
    city = "Москва"
    audit_team = []
    directives = []


def _table_node(node_id: str, table_id: str, title: str, **kw) -> dict:
    return {
        "id": node_id, "type": "table", "tableId": table_id,
        "label": title, "customLabel": title, **kw,
    }


def _table_schema(table_id: str, node_id: str) -> dict:
    return {
        "id": table_id, "nodeId": node_id,
        "grid": [[{"content": "Ячейка", "isHeader": False}]],
    }


def _render(section_id: str, node: dict) -> object:
    """Рендерит акт с одним разделом и одной таблицей в нём."""
    content = ActDataSchema(
        tree={
            "id": "root", "label": "Акт",
            "children": [
                {"id": section_id, "label": f"Раздел {section_id}", "children": [node]}
            ],
        },
        tables={node["tableId"]: _table_schema(node["tableId"], node["id"])},
    )
    return DocxFormatter().format(ExportContext(metadata=_Meta(), content=content))


def _title_runs(doc, title: str) -> list:
    """Runs абзаца-подписи с заданным текстом."""
    paragraphs = [p for p in doc.paragraphs if p.text == title]
    assert paragraphs, f"в документе нет абзаца-подписи «{title}»"
    return list(paragraphs[0].runs)


@pytest.mark.parametrize("section_id", ["1", "2", "3", "4"])
def test_preset_table_title_underlined_not_bold(section_id):
    """Пресетная таблица разделов 1–4: подчёркнута и НЕ жирная."""
    title = "Результаты оценки качества"
    doc = _render(
        section_id,
        _table_node(f"{section_id}_qa", "tbl_qa", title, protected=True),
    )
    for run in _title_runs(doc, title):
        assert not run.bold, "подпись пресетной таблицы больше не жирная"
        assert run.underline is True, "подпись пресетной таблицы 1–4 подчёркивается"


def test_preset_table_in_section_5_has_no_effects():
    """Раздел 5: любая таблица — без жирного и без подчёркивания."""
    title = "Таблица раздела 5"
    doc = _render("5", _table_node("5_t", "tbl5", title, protected=True))
    for run in _title_runs(doc, title):
        assert not run.bold
        assert not run.underline


def test_user_table_has_no_effects():
    """Пользовательская таблица (protected=False) — без эффектов даже в 1–4."""
    title = "Моя таблица"
    doc = _render("2", _table_node("2_u", "tblu", title, protected=False))
    for run in _title_runs(doc, title):
        assert not run.bold
        assert not run.underline


def test_pinned_table_in_sections_1_4_has_no_effects():
    """Спецтаблица (kind≠regular) пресетной не считается — эффектов нет."""
    title = "Сводные метрики"
    doc = _render(
        "2", _table_node("2_m", "tblm", title, protected=True, kind="metrics"),
    )
    for run in _title_runs(doc, title):
        assert not run.bold
        assert not run.underline
