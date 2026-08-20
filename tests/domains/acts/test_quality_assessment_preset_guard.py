"""Страж синхронизации зеркал пресета таблицы «Результаты оценки качества процесса».

Пресет живёт в двух местах: фронтовый источник правды
``static/js/shared/app-config.js`` (``content.tablePresets.qualityAssessment``)
и питоновское зеркало ``ActCrudService._QUALITY_ASSESSMENT_PRESET``, из которого
таблица создаётся при смене типа проверки на процессный.

Расхождение зеркал даёт разные таблицы в новом акте и в акте после смены типа,
причём молча. Тест парсит JS-исходник и сверяет оба зеркала.
"""
import re
from pathlib import Path

import pytest

from app.domains.acts.services.act_crud_service import ActCrudService

CONFIG = (
    Path(__file__).resolve().parents[3]
    / "static" / "js" / "shared" / "app-config.js"
)


def _extract_balanced(text: str, start: int, opening: str, closing: str) -> str:
    """Возвращает содержимое скобочного блока, начиная с позиции открывающей скобки."""
    assert text[start] == opening, f"ожидалась скобка {opening} на позиции {start}"
    depth = 0
    for i in range(start, len(text)):
        if text[i] == opening:
            depth += 1
        elif text[i] == closing:
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
    raise AssertionError(f"не найдена парная скобка {closing}")


@pytest.fixture(scope="module")
def js_preset() -> dict:
    """Пресет qualityAssessment, вычитанный из app-config.js."""
    text = CONFIG.read_text(encoding="utf-8")

    marker = re.search(r"qualityAssessment:\s*\{", text)
    assert marker, (
        "в app-config.js не найден пресет content.tablePresets.qualityAssessment — "
        "пресет переименовали или удалили, зеркала разъехались"
    )
    block = _extract_balanced(text, marker.end() - 1, "{", "}")

    headers_at = re.search(r"headers:\s*\[", block)
    assert headers_at, "в пресете qualityAssessment не найдено поле headers"
    headers_src = _extract_balanced(block, headers_at.end() - 1, "[", "]")

    col_widths_at = re.search(r"colWidths:\s*\[", block)
    assert col_widths_at, "в пресете qualityAssessment не найдено поле colWidths"
    col_widths_src = _extract_balanced(block, col_widths_at.end() - 1, "[", "]")

    label = re.search(r"label:\s*'([^']*)'", block)
    assert label, (
        "в пресете qualityAssessment не найдено поле label — подпись таблицы "
        "должна быть задана явно, иначе на экране показывается «Таблица N»"
    )

    rows = re.search(r"\brows:\s*(\d+)", block)
    cols = re.search(r"\bcols:\s*(\d+)", block)
    assert rows and cols, "в пресете qualityAssessment не найдены rows/cols"

    return {
        "headers": re.findall(r"'([^']*)'", headers_src),
        "col_widths": [int(v) for v in re.findall(r"\d+", col_widths_src)],
        "label": label.group(1),
        "rows": int(rows.group(1)),
        "cols": int(cols.group(1)),
    }


class TestPresetMirrors:
    """Питоновская константа повторяет фронтовый пресет."""

    def test_headers_match(self, js_preset):
        assert (
            ActCrudService._QUALITY_ASSESSMENT_PRESET["headers"]
            == js_preset["headers"]
        ), "заголовки колонок разошлись с app-config.js"

    def test_rows_and_cols_match(self, js_preset):
        preset = ActCrudService._QUALITY_ASSESSMENT_PRESET
        assert preset["rows"] == js_preset["rows"], "разошлось число строк"
        assert preset["cols"] == js_preset["cols"], "разошлось число колонок"

    def test_col_widths_match(self, js_preset):
        assert (
            ActCrudService._QUALITY_ASSESSMENT_PRESET["col_widths"]
            == js_preset["col_widths"]
        ), "ширины колонок разошлись с app-config.js"

    def test_label_matches(self, js_preset):
        assert (
            ActCrudService._QUALITY_ASSESSMENT_PRESET["label"]
            == js_preset["label"]
        ), "название таблицы разошлось с app-config.js"

    def test_headers_count_equals_cols(self, js_preset):
        assert len(js_preset["headers"]) == js_preset["cols"]


class TestGeneratedTableMatchesPreset:
    """Узел и данные таблицы, создаваемые бэком, соответствуют пресету."""

    def test_node_labels_match_preset(self, js_preset):
        node, _ = ActCrudService._make_quality_assessment_table(parent_id="2")
        # Фронт (_createTableNode) при непустом label пишет его и в label,
        # и в customLabel — подпись на экране берётся из customLabel.
        assert node["label"] == js_preset["label"]
        assert node["customLabel"] == js_preset["label"]

    def test_node_flags_allow_manual_delete(self):
        node, table = ActCrudService._make_quality_assessment_table(parent_id="2")
        assert node["protected"] is True
        assert node["deletable"] is True
        assert table["protected"] is True
        assert table["deletable"] is True

    def test_node_carries_special_marker(self):
        node, _ = ActCrudService._make_quality_assessment_table(parent_id="2")
        assert node["special"] == "quality_assessment"

    def test_node_stays_regular_kind(self):
        """Подвид kind не заводится: любой kind != regular закрепляет таблицу вверху."""
        node, table = ActCrudService._make_quality_assessment_table(parent_id="2")
        assert "kind" not in node
        assert "kind" not in table

    def test_grid_matches_preset(self, js_preset):
        _, table = ActCrudService._make_quality_assessment_table(parent_id="2")
        grid = table["grid"]
        assert len(grid) == js_preset["rows"] + 1
        assert [cell["content"] for cell in grid[0]] == js_preset["headers"]
        for row in grid[1:]:
            assert len(row) == js_preset["cols"]

    def test_table_col_widths_match_preset(self, js_preset):
        _, table = ActCrudService._make_quality_assessment_table(parent_id="2")
        assert table["col_widths"] == js_preset["col_widths"]

    def test_table_label_matches_preset(self, js_preset):
        _, table = ActCrudService._make_quality_assessment_table(parent_id="2")
        assert table["label"] == js_preset["label"]
