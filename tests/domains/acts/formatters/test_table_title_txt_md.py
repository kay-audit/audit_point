"""Оформление подписи таблицы в TXT и MD — единое правило проекта.

TXT рисует подчёркивание ASCII-строкой дефисов под подписью, и она обязана
появляться ровно по тому же правилу, что `run.underline` в DOCX: только у
пресетной таблицы разделов 1–4.

MD правки НЕ требует и в правило укладывается без изменений: подпись там
выводится плоской строкой без разметки. Подчёркивания в Markdown нет как
понятия, а строка дефисов под текстом — это setext-заголовок H2, то есть
подпись превратилась бы в заголовок раздела. Тесты ниже фиксируют это как
осознанное поведение, а не как «забыли доделать».
"""
import pytest

from app.domains.acts.formatters.markdown_formatter import MarkdownFormatter
from app.domains.acts.formatters.text_formatter import TextFormatter
from app.domains.acts.settings import ActsSettings

TITLE = "Результаты оценки качества"


def _data(section_id: str, **node_kw) -> dict:
    """Акт из одного раздела с одной таблицей внутри."""
    node = {
        "id": "t1", "type": "table", "tableId": "tbl1",
        "label": TITLE, "customLabel": TITLE, **node_kw,
    }
    return {
        "tree": {
            "id": "root", "label": "Акт",
            "children": [
                {"id": section_id, "label": f"Раздел {section_id}",
                 "number": section_id, "children": [node]}
            ],
        },
        "tables": {
            "tbl1": {
                "id": "tbl1", "nodeId": "t1",
                "grid": [[{"content": "Ячейка", "isHeader": False}]],
            }
        },
    }


def _txt(data: dict) -> list[str]:
    return TextFormatter(settings=None, acts_settings=ActsSettings()).format(
        data
    ).split("\n")


def _line_after_title(lines: list[str]) -> str:
    """Строка, идущая сразу за подписью таблицы."""
    for i, line in enumerate(lines):
        if line.strip() == TITLE:
            return lines[i + 1].strip()
    raise AssertionError(f"в выводе нет подписи «{TITLE}»")


@pytest.mark.parametrize("section_id", ["1", "2", "3", "4"])
def test_txt_preset_table_title_underlined(section_id):
    """Пресетная таблица разделов 1–4: под подписью строка дефисов."""
    lines = _txt(_data(section_id, protected=True))
    assert _line_after_title(lines) == "-" * len(TITLE)


def test_txt_section_5_table_title_without_dashes():
    """Раздел 5: подпись без ASCII-подчёркивания."""
    lines = _txt(_data("5", protected=True))
    assert _line_after_title(lines) != "-" * len(TITLE)


def test_txt_user_table_title_without_dashes():
    """Пользовательская таблица: подпись без ASCII-подчёркивания."""
    lines = _txt(_data("2", protected=False))
    assert _line_after_title(lines) != "-" * len(TITLE)


@pytest.mark.parametrize("section_id,protected", [("2", True), ("5", True), ("2", False)])
def test_md_table_title_is_always_plain(section_id, protected):
    """MD: подпись — плоская строка без разметки для ЛЮБОГО класса таблицы."""
    md = MarkdownFormatter(settings=None, acts_settings=ActsSettings()).format(
        _data(section_id, protected=protected)
    )
    lines = md.split("\n")
    idx = next(i for i, line in enumerate(lines) if line.strip() == TITLE)
    assert not lines[idx].startswith(("#", "*", "_")), "подпись обзавелась разметкой"
    # Следующая строка не должна стать setext-подчёркиванием (иначе H2).
    assert set(lines[idx + 1].strip()) != {"-"}
