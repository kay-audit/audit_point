"""Тест-фиксация семантики нарушений в MD/TXT (M.3-хвост + Wave 2 #9/#12/#14/#16).

descriptionList — ПОЛНЫЙ список пунктов (не сводка «N метрик»), БЕЗ заголовка
«Описание» (#12): только маркированный список (MD «- …», TXT «  • …»).
Пустые пункты списка тоже рендерятся — пустым буллитом (#15/Q1), единообразно
с превью и DOCX. Обязательные Нарушено/Установлено выводят метку даже при пустом теле (#14);
кейсы нумеруются сквозняком включая пустые, сброс на не-кейсе (#9/Q1); в MD
картинка встраивается markdown-разметкой (#16). Если кто-то «оптимизирует»
вывод — эти тесты укажут на дрейф.
"""
from app.domains.acts.formatters.markdown_formatter import MarkdownFormatter
from app.domains.acts.formatters.text_formatter import TextFormatter
from app.domains.acts.settings import ActsSettings


def _md() -> MarkdownFormatter:
    return MarkdownFormatter(settings=None, acts_settings=ActsSettings())


def _txt() -> TextFormatter:
    return TextFormatter(settings=None, acts_settings=ActsSettings())


_VIOLATION = {
    "violated": "Нарушено-X",
    "established": "Установлено-Y",
    "descriptionList": {
        "enabled": True,
        "items": ["Метрика один", "Метрика два", "Метрика три"],
    },
    "additionalContent": {"enabled": False, "items": []},
    "reasons": {"enabled": False, "content": ""},
    "consequences": {"enabled": False, "content": ""},
    "responsible": {"enabled": False, "content": ""},
}


def test_markdown_renders_full_description_list():
    out = _md()._format_violation(_VIOLATION)
    # #12: заголовок «Описание» убран — остаются только буллиты.
    assert "**Описание:**" not in out
    for item in _VIOLATION["descriptionList"]["items"]:
        assert f"- {item}" in out
    # Сводки-счётчика нет.
    assert "метрик" not in out


def test_text_renders_full_description_list():
    out = _txt()._format_violation(_VIOLATION)
    # #12: заголовок «Описание» убран — остаются только буллиты.
    assert "Описание:" not in out
    for item in _VIOLATION["descriptionList"]["items"]:
        assert f"• {item}" in out
    assert "метрик" not in out


def test_disabled_description_list_not_rendered():
    violation = dict(_VIOLATION, descriptionList={"enabled": False, "items": ["скрытая"]})
    assert "скрытая" not in _md()._format_violation(violation)
    assert "скрытая" not in _txt()._format_violation(violation)


def test_measures_rendered_between_reasons_and_consequences():
    """«Принятые меры» стоят под «Причинами» (директива владельца) — до «Последствий»."""
    violation = dict(
        _VIOLATION,
        reasons={"enabled": True, "content": "ПРИЧИНА-X"},
        measures={"enabled": True, "content": "МЕРА-Y"},
        consequences={"enabled": True, "content": "ПОСЛЕДСТВИЕ-Z"},
    )
    for out in (_md()._format_violation(violation), _txt()._format_violation(violation)):
        assert "МЕРА-Y" in out
        assert out.index("ПРИЧИНА-X") < out.index("МЕРА-Y") < out.index("ПОСЛЕДСТВИЕ-Z")


def test_disabled_measures_not_rendered():
    violation = dict(_VIOLATION, measures={"enabled": False, "content": "скрытая-мера"})
    assert "скрытая-мера" not in _md()._format_violation(violation)
    assert "скрытая-мера" not in _txt()._format_violation(violation)


# --- #15/Q1: пустые пункты списка описаний рендерятся (единообразие с превью/DOCX) ---


def test_markdown_renders_empty_description_bullets():
    """Пустой пункт descriptionList → пустой буллит «- » (не отфильтровывается)."""
    violation = dict(_VIOLATION, descriptionList={"enabled": True, "items": ["A", "", "B"]})
    lines = _md()._format_violation(violation).split("\n")
    bullets = [ln for ln in lines if ln.startswith("- ")]
    assert bullets == ["- A", "- ", "- B"]


def test_text_renders_empty_description_bullets():
    """Пустой пункт descriptionList → пустой буллит «  • » (не отфильтровывается)."""
    violation = dict(_VIOLATION, descriptionList={"enabled": True, "items": ["A", "", "B"]})
    lines = _txt()._format_violation(violation).split("\n")
    bullets = [ln for ln in lines if ln.lstrip().startswith("•")]
    assert bullets == ["  • A", "  • ", "  • B"]


# --- #9/Q1: нумерация всех кейсов, сброс на не-кейсе (паритет с DOCX/превью) ---


def _violation_with_items(items):
    return dict(
        _VIOLATION,
        descriptionList={"enabled": False, "items": []},
        additionalContent={"enabled": True, "items": items},
    )


def test_markdown_empty_first_case_shifts_next_to_case_2():
    """Пустой первый кейс занимает «Кейс 1», следующий непустой → «Кейс 2»."""
    v = _violation_with_items([
        {"type": "case", "content": ""},
        {"type": "case", "content": "Второй"},
    ])
    out = _md()._format_violation(v)
    assert "**Кейс 1:**" in out
    assert "**Кейс 2:** Второй" in out


def test_markdown_case_numbering_resets_after_non_case():
    """Не-кейс (freeText) сбрасывает нумерацию кейсов."""
    v = _violation_with_items([
        {"type": "case", "content": "A"},
        {"type": "freeText", "content": "текст"},
        {"type": "case", "content": "B"},
    ])
    out = _md()._format_violation(v)
    assert "**Кейс 1:** A" in out
    assert "**Кейс 1:** B" in out
    assert "**Кейс 2:**" not in out


# --- #14: обязательные Нарушено/Установлено выводят метку даже при пустом ---


def test_markdown_required_labels_shown_when_empty():
    v = dict(_VIOLATION, violated="", established="")
    out = _md()._format_violation(v)
    assert "**Нарушено:**" in out
    assert "**Установлено:**" in out


# --- #16: картинка встраивается markdown-разметкой, имя файла — в title ---


def test_markdown_image_embedded_with_filename_in_title():
    v = _violation_with_items([{
        "type": "image",
        "url": "data:image/png;base64,AAAA",
        "caption": "Подпись",
        "filename": "pic.png",
    }])
    out = _md()._format_violation(v)
    assert '![Подпись](data:image/png;base64,AAAA "pic.png")' in out


def test_markdown_image_empty_url_falls_back_to_filename():
    v = _violation_with_items([{
        "type": "image", "url": "", "caption": "", "filename": "draft.png",
    }])
    out = _md()._format_violation(v)
    assert "*draft.png*" in out
    assert "![" not in out


def test_markdown_image_filename_with_quote_escaped_in_title():
    """Дословный (без bleach, T4) filename с `"` не должен разрывать title."""
    v = _violation_with_items([{
        "type": "image",
        "url": "data:image/png;base64,AAAA",
        "caption": "Подпись",
        "filename": 'pic "one".png',
    }])
    out = _md()._format_violation(v)
    assert '![Подпись](data:image/png;base64,AAAA "pic \\"one\\".png")' in out


def test_markdown_image_caption_with_bracket_escaped_in_alt():
    """Дословная caption с `]` не должна преждевременно закрывать alt-текст."""
    v = _violation_with_items([{
        "type": "image",
        "url": "data:image/png;base64,AAAA",
        "caption": "рост] на 10%",
        "filename": "pic.png",
    }])
    out = _md()._format_violation(v)
    assert '![рост\\] на 10%](data:image/png;base64,AAAA "pic.png")' in out


# --- TXT: те же правила #9/#14 (картинка #16 в TXT не трогается) ---


def test_text_empty_first_case_shifts_next_to_case_2():
    v = _violation_with_items([
        {"type": "case", "content": ""},
        {"type": "case", "content": "Второй"},
    ])
    out = _txt()._format_violation(v)
    assert "Кейс 1:" in out
    assert "Кейс 2: Второй" in out


def test_text_case_numbering_resets_after_non_case():
    v = _violation_with_items([
        {"type": "case", "content": "A"},
        {"type": "freeText", "content": "текст"},
        {"type": "case", "content": "B"},
    ])
    out = _txt()._format_violation(v)
    assert "Кейс 1: A" in out
    assert "Кейс 1: B" in out
    assert "Кейс 2:" not in out


def test_text_required_labels_shown_when_empty():
    v = dict(_VIOLATION, violated="", established="")
    out = _txt()._format_violation(v)
    assert "Нарушено:" in out
    assert "Установлено:" in out


# --- Task 1.1.3: rich-поля нарушения — HTML→Markdown / HTML→plain через text_conv ---


def test_markdown_rich_field_converts_html():
    v = dict(_VIOLATION, violated="это <b>жирное</b> и Ромашка &amp; Ко")
    out = _md()._format_violation(v)
    assert "**жирное**" in out and "Ромашка & Ко" in out and "&amp;" not in out


def test_text_rich_field_strips_html():
    v = dict(_VIOLATION, violated="это <b>жирное</b> и Ромашка &amp; Ко")
    out = _txt()._format_violation(v)
    assert "жирное" in out and "<b>" not in out and "Ромашка & Ко" in out


def test_measures_and_case_are_rich():
    v = dict(_VIOLATION, measures={"enabled": True, "content": "<i>мера</i>"},
             additionalContent={"enabled": True, "items": [{"type": "case", "content": "<b>кейс</b>"}]})
    md = _md()._format_violation(v)
    assert "*мера*" in md and "**кейс**" in md


def test_description_list_stays_plain():
    v = dict(_VIOLATION, descriptionList={"enabled": True, "items": ["<b>пункт</b>"]})
    assert "<b>пункт</b>" in _md()._format_violation(v)
