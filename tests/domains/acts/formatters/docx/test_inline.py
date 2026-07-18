"""Тесты inline HTML → docx runs."""
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt

from app.domains.acts.formatters.docx.builders.inline import apply_inline_html
from app.domains.acts.formatters.docx.styles import Fonts


def _add_p(doc):
    return doc.add_paragraph()


def _count_breaks(p) -> int:
    """Число реальных OOXML-переносов строки (<w:br/>) в параграфе."""
    return len(p._p.findall(".//" + qn("w:br")))


def test_plain_text(doc):
    p = _add_p(doc)
    apply_inline_html(p, "Просто текст.", base_size_pt=12)
    assert len(p.runs) == 1
    assert p.runs[0].text == "Просто текст."
    assert p.runs[0].font.name == Fonts.main
    assert p.runs[0].font.size == Pt(12)
    assert not p.runs[0].bold
    assert not p.runs[0].italic


def test_bold_tag(doc):
    p = _add_p(doc)
    apply_inline_html(p, "Слово <b>жирное</b> в строке", base_size_pt=12)
    texts = [(r.text, r.bold) for r in p.runs]
    assert texts == [("Слово ", False), ("жирное", True), (" в строке", False)]


def test_italic_and_underline(doc):
    p = _add_p(doc)
    apply_inline_html(p, "<i>курсив</i> и <u>подчёркнуто</u>", base_size_pt=12)
    assert p.runs[0].italic is True
    assert p.runs[2].underline is True


def test_font_size_px_converted_to_pt(doc):
    """16px в HTML должно стать 12pt (16 * 0.75)."""
    p = _add_p(doc)
    apply_inline_html(p, '<span style="font-size: 16px">шестнадцать</span>', base_size_pt=12)
    assert p.runs[0].font.size == Pt(12)


def test_font_size_pt_passed_through(doc):
    p = _add_p(doc)
    apply_inline_html(p, '<span style="font-size: 11pt">одиннадцать</span>', base_size_pt=12)
    assert p.runs[0].font.size == Pt(11)


def test_nested_bold_italic(doc):
    p = _add_p(doc)
    apply_inline_html(p, "<b><i>жирно-курсив</i></b>", base_size_pt=12)
    assert p.runs[0].bold is True
    assert p.runs[0].italic is True


def test_br_creates_line_break(doc):
    """<br/> вставляет реальный OOXML-перенос (<w:br/>), а не символ '\\n'
    внутри <w:t>: литеральный '\\n' Word схлопывает в пробел (текст в одну
    строку при экспорте). _count_breaks считает именно элементы w:br —
    прежний баг (_add_run('\\n')) дал бы 0 переносов (python-docx показывает
    w:br как '\\n' в .text, поэтому различаем по XML, а не по тексту)."""
    p = _add_p(doc)
    apply_inline_html(p, "первая<br/>вторая", base_size_pt=12)
    full_text = "".join(r.text for r in p.runs)
    assert "первая" in full_text and "вторая" in full_text
    assert _count_breaks(p) == 1


def test_br_void_no_slash(doc):
    """<br> без слэша тоже вставляет OOXML-перенос (handle_starttag path)."""
    p = _add_p(doc)
    apply_inline_html(p, "первая<br>вторая", base_size_pt=12)
    full_text = "".join(r.text for r in p.runs)
    assert "первая" in full_text and "вторая" in full_text
    assert _count_breaks(p) == 1


def test_br_with_closing_tag_preserves_formatting(doc):
    """<b>text<br></br>more</b> — </br> не должен сорвать bold-фрейм."""
    p = _add_p(doc)
    apply_inline_html(p, "<b>один<br></br>два</b>", base_size_pt=12)
    # Все непустые runs внутри <b> должны быть bold
    bold_runs = [r for r in p.runs if r.text.strip()]
    assert len(bold_runs) >= 2
    assert all(r.bold for r in bold_runs)


def test_br_void_does_not_break_bold_balance(doc):
    """H7: void-<br> внутри <b> не ломает баланс стека.

    Раньше <br> пушил лишний кадр, </b> снимал его вместо bold-фрейма —
    и текст ПОСЛЕ </b> оставался жирным.
    """
    p = _add_p(doc)
    apply_inline_html(p, "<b>x<br>y</b> z", base_size_pt=12)
    runs = [(r.text, bool(r.bold)) for r in p.runs]
    # Текст внутри <b> жирный, перевод строки тоже внутри <b>
    assert ("x", True) in runs
    assert ("y", True) in runs
    # Текст после </b> НЕ жирный — баланс стека восстановлен
    assert (" z", False) in runs


def test_double_br_void_does_not_break_bold_balance(doc):
    """H7: два подряд void-<br> тоже не сдвигают баланс."""
    p = _add_p(doc)
    apply_inline_html(p, "<b>a<br><br>b</b> tail", base_size_pt=12)
    runs = [(r.text, bool(r.bold)) for r in p.runs]
    assert ("a", True) in runs
    assert ("b", True) in runs
    assert (" tail", False) in runs
    assert _count_breaks(p) == 2


def test_block_div_breaks_between_blocks(doc):
    """Enter в contenteditable → <div>: перенос МЕЖДУ блоками, не перед первым."""
    p = _add_p(doc)
    apply_inline_html(p, "<div>строка1</div><div>строка2</div>", base_size_pt=12)
    full_text = "".join(r.text for r in p.runs)
    assert "строка1" in full_text and "строка2" in full_text
    assert _count_breaks(p) == 1  # только между блоками


def test_block_div_no_leading_break(doc):
    """Одиночный <div>-wrapper вокруг содержимого не даёт ведущего переноса."""
    p = _add_p(doc)
    apply_inline_html(p, "<div>единственная</div>", base_size_pt=12)
    assert _count_breaks(p) == 0


def test_block_paragraph_tag_breaks(doc):
    """<p> трактуется как блок: перенос между абзацами."""
    p = _add_p(doc)
    apply_inline_html(p, "<p>раз</p><p>два</p>", base_size_pt=12)
    assert _count_breaks(p) == 1


def test_empty_block_div_single_break(doc):
    """#6: <div><br></div> между блоками = ОДНА пустая строка, а не две.

    Граница блока и placeholder-<br> внутри пустого <div> — один визуальный
    разрыв: раньше считались оба (перенос границы + перенос <br>) → лишняя
    пустая строка в DOCX. Ждём 2 переноса на «a / (пусто) / b»."""
    p = _add_p(doc)
    apply_inline_html(p, "<div>a</div><div><br></div><div>b</div>", base_size_pt=12)
    full = "".join(r.text for r in p.runs)
    assert "a" in full and "b" in full
    assert _count_breaks(p) == 2


def test_multiple_empty_block_divs_preserved(doc):
    """#6: несколько пустых блоков-строк сохраняются (НЕ схлопываются в одну).

    Пользователь может намеренно вставить 2+ пустых строки — у каждого пустого
    блока своя граница-перенос, поэтому «a / пусто / пусто / b» = 3 переноса."""
    p = _add_p(doc)
    apply_inline_html(
        p, "<div>a</div><div><br></div><div><br></div><div>b</div>", base_size_pt=12
    )
    assert _count_breaks(p) == 3


def test_soft_break_inside_block_still_breaks(doc):
    """#6-регресс: настоящий <br> ВНУТРИ непустого блока остаётся переносом.

    <div>b<br>c</div> после предыдущего блока: граница блока + реальный мягкий
    перенос между b и c = 2 переноса (не должен быть съеден как placeholder)."""
    p = _add_p(doc)
    apply_inline_html(p, "<div>a</div><div>b<br>c</div>", base_size_pt=12)
    full = "".join(r.text for r in p.runs)
    assert "b" in full and "c" in full
    assert _count_breaks(p) == 2


def test_zero_width_size_anchor_stripped(doc):
    """#8: U+200B (якорь размера из applyFontSize) не утекает в <w:t>."""
    zwsp = chr(0x200B)
    p = _add_p(doc)
    apply_inline_html(p, "до" + zwsp + "после", base_size_pt=12)
    full = "".join(r.text for r in p.runs)
    assert zwsp not in full
    assert full == "допосле"


def _direct_text_runs(p):
    """Прямые w:r параграфа с непустым текстом (без runs внутри w:hyperlink)."""
    out = []
    for r in p._p.findall(qn("w:r")):
        t = r.find(qn("w:t"))
        if t is not None and t.text:
            out.append(t.text)
    return out


def test_nbsp_applied_before_footnote_after_word_under_justify(doc):
    """BUG-3: под justify пробел перед словом-якорем сноски становится NBSP —
    номер сноски «прилипает» к слову. Базовый (рабочий) сценарий не сломан."""
    p = _add_p(doc)
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    apply_inline_html(
        p,
        'Слово <span class="text-footnote" data-footnote-text="прим">якорь</span>',
        base_size_pt=12,
    )
    joined = "".join(_direct_text_runs(p))
    assert chr(0xA0) in joined  # неразрывный пробел поставлен


def test_nbsp_not_applied_when_footnote_follows_link(doc):
    """#7-регресс: сноска сразу за ссылкой — прямой run ПЕРЕД ссылкой НЕ должен
    получить NBSP (он к сноске не примыкает, runs ссылки лежат в w:hyperlink)."""
    p = _add_p(doc)
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    apply_inline_html(
        p,
        'Смотри <span class="text-link" data-link-url="https://e.com">тут</span>'
        '<span class="text-footnote" data-footnote-text="прим">якорь</span>',
        base_size_pt=12,
    )
    # Прямой текст "Смотри " не тронут: обычный пробел, не NBSP.
    smotri = next(t for t in _direct_text_runs(p) if "Смотри" in t)
    assert chr(0xA0) not in smotri


def test_break_preserves_inline_formatting(doc):
    """Перенос не сбрасывает per-run начертание соседних runs."""
    p = _add_p(doc)
    apply_inline_html(p, "<b>жирн</b><br><i>курс</i>", base_size_pt=12)
    assert _count_breaks(p) == 1
    bold = next(r for r in p.runs if r.text == "жирн")
    italic = next(r for r in p.runs if r.text == "курс")
    assert bold.bold is True
    assert italic.italic is True


def test_break_preserves_font_size(doc):
    """Размер шрифта соседних с переносом runs сохраняется (20px → 15pt)."""
    p = _add_p(doc)
    apply_inline_html(p, '<span style="font-size:20px">A</span><br>B', base_size_pt=12)
    assert _count_breaks(p) == 1
    run_a = next(r for r in p.runs if r.text == "A")
    assert run_a.font.size == Pt(15)


def test_empty_html(doc):
    p = _add_p(doc)
    apply_inline_html(p, "", base_size_pt=12)
    assert len(p.runs) == 0


def test_strike_tags_render_strikethrough(doc):
    """M.19: <s>/<strike>/<del> → run.font.strike (тег-форма Chromium)."""
    for tag in ("s", "strike", "del"):
        p = _add_p(doc)
        apply_inline_html(p, f"до <{tag}>зачёркнуто</{tag}> после", base_size_pt=12)
        runs = [(r.text, bool(r.font.strike)) for r in p.runs]
        assert ("зачёркнуто", True) in runs, f"<{tag}> не дал зачёркивание"
        assert ("до ", False) in runs
        assert (" после", False) in runs


def test_strike_via_span_style_line_through(doc):
    """M.19: span style="text-decoration: line-through" → зачёркивание (CSS-форма)."""
    p = _add_p(doc)
    apply_inline_html(
        p,
        '<span style="text-decoration: line-through;">зач</span> обычный',
        base_size_pt=12,
    )
    runs = [(r.text, bool(r.font.strike)) for r in p.runs]
    assert ("зач", True) in runs
    assert (" обычный", False) in runs


def test_strike_via_span_style_text_decoration_line(doc):
    """M.19: вариант свойства text-decoration-line тоже распознаётся."""
    p = _add_p(doc)
    apply_inline_html(
        p,
        '<span style="text-decoration-line: line-through;">зач</span>',
        base_size_pt=12,
    )
    assert p.runs[0].font.strike is True


def test_strike_nested_with_bold(doc):
    """Зачёркивание комбинируется с другими начертаниями."""
    p = _add_p(doc)
    apply_inline_html(p, "<b><s>жирно-зачёркнуто</s></b>", base_size_pt=12)
    assert p.runs[0].bold is True
    assert p.runs[0].font.strike is True


def test_base_italic_makes_default_runs_italic(doc):
    p = doc.add_paragraph()
    apply_inline_html(p, "обычный <b>жирный</b>", base_size_pt=9, base_italic=True)
    assert all(r.italic for r in p.runs if r.text)
    bold = [r for r in p.runs if r.text == "жирный"][0]
    assert bold.bold and bold.italic


def test_base_italic_default_false_unchanged(doc):
    p = doc.add_paragraph()
    apply_inline_html(p, "текст", base_size_pt=12)
    assert not p.runs[0].italic


def test_trailing_br_in_content_div_not_doubled(doc):
    """Репро БАГ-3: хвостовой br в строке + пустая строка — в редакторе a/пусто/b."""
    p = doc.add_paragraph()
    apply_inline_html(p, "<div>a<br></div><div><br></div><div>b</div>", base_size_pt=12)
    assert _count_breaks(p) == 2  # был 3 → в Word две пустые строки


def test_trailing_br_before_block_close_invisible(doc):
    p = doc.add_paragraph()
    apply_inline_html(p, "<div>a<br></div><div>b</div>", base_size_pt=12)
    assert _count_breaks(p) == 1


def test_leading_empty_div_single_break(doc):
    """Пустая строка В НАЧАЛЕ поля: пусто/b = один перенос."""
    p = doc.add_paragraph()
    apply_inline_html(p, "<div><br></div><div>b</div>", base_size_pt=12)
    assert _count_breaks(p) == 1  # было 2


def test_trailing_br_at_fragment_end_dropped(doc):
    p = doc.add_paragraph()
    apply_inline_html(p, "<div>a<br></div>", base_size_pt=12)
    assert _count_breaks(p) == 0


def test_double_br_then_content_two_breaks(doc):
    p = doc.add_paragraph()
    apply_inline_html(p, "a<br><br>b", base_size_pt=12)
    assert _count_breaks(p) == 2


def test_deferred_break_flushes_before_empty_anchor_footnote(doc):
    """БАГ-3: <br> перед footnote-якорем БЕЗ текста материализуется до вставки
    номера сноски — иначе перенос "уехал" бы после него (footnoteReference
    вставляется в paragraph.add_run() напрямую, минуя _add_run/_flush_soft_break,
    если не флешить явно перед add_footnote)."""
    p = doc.add_paragraph()
    apply_inline_html(
        p,
        'x<br><span class="text-footnote" data-footnote-text="прим"></span>tail',
        base_size_pt=12,
    )
    assert _count_breaks(p) == 1
    tags = [
        el.tag.rsplit("}", 1)[-1]
        for el in p._p.iter()
        if el.tag.rsplit("}", 1)[-1] in ("br", "footnoteReference")
    ]
    assert tags == ["br", "footnoteReference"]
