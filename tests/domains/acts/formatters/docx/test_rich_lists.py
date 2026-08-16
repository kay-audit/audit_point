"""Списки rich-HTML (<ul>/<ol>/<li>) в DOCX: изоляция и многоуровневость.

Списки живут в rich-редакторе ВООБЩЕ (решение владельца, спека §2.3), поэтому
учится им ОБЩИЙ конвертер render_block_segments — единственный путь rich-HTML →
абзацы для всех потребителей: текстблоки акта, rich-поля нарушения, подписи
картинок.

Правило (спека многоуровневых списков, §3.1): один HTML-элемент <ul>/<ol> =
один w:num. Built-in стилей "List Bullet"/"List Number" больше нет — они были
завязаны на единственный style-linked numId, из-за чего для Word ВСЕ списки
акта были одним списком (сквозной счёт, общая подсветка маркеров). Теперь
каждый <li> — абзац с собственным w:numPr: numId своего списка, ilvl —
глубина вложенности.
"""
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt

from app.domains.acts.formatters.docx import DocxFormatter
from app.domains.acts.formatters.docx.builders.inline import (
    BlockSegment,
    ListRef,
    render_block_segments,
    split_block_segments,
)
from app.domains.acts.formatters.docx.builders.violation import _labeled_paragraph
from app.domains.acts.formatters.docx.styles import Sizes
from app.domains.acts.schemas.act_content import TextBlockSchema


def _render(doc, html, **kwargs):
    """Рендерит html общим конвертером, возвращает ДОБАВЛЕННЫЕ абзацы."""
    kwargs.setdefault("base_size_pt", 12.0)
    return render_block_segments(doc, html, **kwargs)


def _texts(paragraphs) -> list[str]:
    return [p.text for p in paragraphs]


def _num_pr(paragraph):
    p_pr = paragraph._p.find(qn("w:pPr"))
    return None if p_pr is None else p_pr.find(qn("w:numPr"))


def _num_ids(paragraphs) -> list[int | None]:
    """numId каждого абзаца; None — абзац вне списка."""
    out = []
    for para in paragraphs:
        num_pr = _num_pr(para)
        out.append(
            None if num_pr is None
            else int(num_pr.find(qn("w:numId")).get(qn("w:val")))
        )
    return out


def _ilvls(paragraphs) -> list[int | None]:
    out = []
    for para in paragraphs:
        num_pr = _num_pr(para)
        out.append(
            None if num_pr is None
            else int(num_pr.find(qn("w:ilvl")).get(qn("w:val")))
        )
    return out


def _abstract_of(doc, num_id: int) -> str:
    """abstractNumId, на который ссылается нумерация num_id."""
    for num in doc.part.numbering_part.element.findall(qn("w:num")):
        if num.get(qn("w:numId")) == str(num_id):
            return num.find(qn("w:abstractNumId")).get(qn("w:val"))
    raise AssertionError(f"num {num_id} не найден в numbering.xml")


# --- сегментация: <li> → сегмент со ссылкой на свой список -------------------

def test_ul_items_become_bullet_segments():
    assert split_block_segments("<ul><li>раз</li><li>два</li></ul>") == [
        BlockSegment(None, "раз", ListRef(1, "ul", 0)),
        BlockSegment(None, "два", ListRef(1, "ul", 0)),
    ]


def test_ol_items_become_number_segments():
    assert split_block_segments("<ol><li>раз</li><li>два</li></ol>") == [
        BlockSegment(None, "раз", ListRef(1, "ol", 0)),
        BlockSegment(None, "два", ListRef(1, "ol", 0)),
    ]


def test_list_tag_itself_gives_no_segment():
    """<ul>/<ol> — только носитель ссылки для своих <li>, абзаца не даёт."""
    assert split_block_segments("<ul></ul>") == []


def test_whitespace_between_list_tags_ignored():
    """Переносы строк разметки между <ul> и <li> не превращаются в абзацы."""
    assert split_block_segments("<ul>\n  <li>раз</li>\n  <li>два</li>\n</ul>") == [
        BlockSegment(None, "раз", ListRef(1, "ul", 0)),
        BlockSegment(None, "два", ListRef(1, "ul", 0)),
    ]


def test_unclosed_list_items_closed_by_list_end():
    """Разметка без </li> (<ul><li>a<li>b</ul>) даёт те же два пункта."""
    assert split_block_segments("<ul><li>раз<li>два</ul>") == [
        BlockSegment(None, "раз", ListRef(1, "ul", 0)),
        BlockSegment(None, "два", ListRef(1, "ul", 0)),
    ]


def test_orphan_li_without_list_stays_raw():
    """<li> вне <ul>/<ol> — не пункт: остаётся сырьём сегмента (мягкий перенос,
    прежнее поведение), ссылки на список не получает."""
    assert split_block_segments("<li>сирота</li>") == [
        BlockSegment(None, "<li>сирота</li>", None),
    ]


def test_li_own_text_align_kept():
    assert split_block_segments('<ol><li style="text-align: right">пункт</li></ol>') == [
        BlockSegment("right", "пункт", ListRef(1, "ol", 0)),
    ]


# --- изоляция и уровни на сегментации ----------------------------------------

def test_each_list_element_gets_own_instance():
    """Правило §3.1: каждый элемент <ul>/<ol> — свой instance (→ свой w:num)."""
    segments = split_block_segments(
        "<ol><li>перв</li></ol><ol><li>втор</li></ol>"
    )
    assert segments == [
        BlockSegment(None, "перв", ListRef(1, "ol", 0)),
        BlockSegment(None, "втор", ListRef(2, "ol", 0)),
    ]


def test_nested_list_is_separate_instance_on_deeper_level():
    """Вложенный список — тоже отдельный instance, но на уровне глубже."""
    segments = split_block_segments(
        "<ul><li>верх<ul><li>вложен</li></ul></li><li>ещё</li></ul>"
    )
    assert segments == [
        BlockSegment(None, "верх", ListRef(1, "ul", 0)),
        BlockSegment(None, "вложен", ListRef(2, "ul", 1)),
        BlockSegment(None, "ещё", ListRef(1, "ul", 0)),
    ]


def test_level_clamped_at_eight():
    """Глубже 9 уровней w:abstractNum не умеет — уровень зажимается на 8."""
    html = "<ul>" * 12 + "<li>дно</li>" + "</ul>" * 12
    segments = split_block_segments(html)
    assert [s.list_ref.level for s in segments] == [8]


def test_invalid_nesting_tolerated():
    """Легаси/чужой HTML вида <ul><ul><li> (список прямо в списке, минуя <li>)
    не ломает парсер: он работает на стеке глубины, а не на строгой структуре."""
    assert split_block_segments("<ul><ul><li>кривой</li></ul></ul>") == [
        BlockSegment(None, "кривой", ListRef(2, "ul", 1)),
    ]


# --- ревью №9: <li> наследует text-align объемлющего div/p ------------------

def test_li_inherits_align_from_enclosing_div():
    """Список без своего align внутри выровненного div — пункт получает
    align объемлющего контейнера, а не дефолт (было: терялось в None)."""
    html = '<div style="text-align:center"><ul><li>перв</li></ul></div>'
    assert split_block_segments(html) == [
        BlockSegment("center", "перв", ListRef(1, "ul", 0)),
    ]


def test_li_own_align_overrides_inherited():
    """Собственный text-align <li> приоритетнее унаследованного от div."""
    html = (
        '<div style="text-align:center">'
        '<ol><li style="text-align: right">пункт</li></ol></div>'
    )
    assert split_block_segments(html) == [
        BlockSegment("right", "пункт", ListRef(1, "ol", 0)),
    ]


def test_li_without_enclosing_div_stays_unaligned():
    """Без объемлющего align-контейнера поведение не меняется (align=None)."""
    assert split_block_segments("<ul><li>перв</li></ul>") == [
        BlockSegment(None, "перв", ListRef(1, "ul", 0)),
    ]


def test_nested_li_inherits_align_through_outer_li():
    """Вложенный пункт тоже наследует align — через уже унаследованный align
    родительского пункта (каскад, как в браузере)."""
    html = (
        '<div style="text-align:center">'
        '<ul><li>верх<ul><li>вложен</li></ul></li></ul></div>'
    )
    assert split_block_segments(html) == [
        BlockSegment("center", "верх", ListRef(1, "ul", 0)),
        BlockSegment("center", "вложен", ListRef(2, "ul", 1)),
    ]


def test_render_list_item_inherits_align_from_enclosing_div(doc):
    """Точка входа рендера: наследованный align применяется к абзацу Word."""
    html = '<div style="text-align:center"><ul><li>перв</li></ul></div>'
    paragraphs = _render(doc, html)
    assert paragraphs[0].alignment == WD_ALIGN_PARAGRAPH.CENTER


# --- рендер: пункт = абзац со своим w:numPr ----------------------------------

def test_bullet_list_one_paragraph_per_item(doc):
    paragraphs = _render(doc, "<ul><li>раз</li><li>два</li><li>три</li></ul>")
    assert _texts(paragraphs) == ["раз", "два", "три"]
    num_ids = _num_ids(paragraphs)
    assert None not in num_ids
    assert len(set(num_ids)) == 1  # один список — одна связка нумерации
    assert _ilvls(paragraphs) == [0, 0, 0]


def test_numbered_list_gets_own_numbering(doc):
    paragraphs = _render(doc, "<ol><li>раз</li><li>два</li></ol>")
    assert _texts(paragraphs) == ["раз", "два"]
    num_ids = _num_ids(paragraphs)
    assert None not in num_ids
    assert len(set(num_ids)) == 1


def test_list_paragraphs_keep_normal_style(doc):
    """Built-in стилей списка больше нет — оформление несёт нумерация."""
    paragraphs = _render(doc, "<ul><li>пункт</li></ul>")
    assert [p.style.name for p in paragraphs] == ["Normal"]


def test_list_item_default_alignment_applies(doc):
    paragraphs = _render(doc, "<ul><li>пункт</li></ul>")
    assert paragraphs[0].alignment == WD_ALIGN_PARAGRAPH.JUSTIFY


def test_list_item_own_alignment_overrides_default(doc):
    paragraphs = _render(doc, '<ul><li style="text-align: center">пункт</li></ul>')
    assert paragraphs[0].alignment == WD_ALIGN_PARAGRAPH.CENTER


# --- вложенность: свой уровень и своя связка нумерации -----------------------

def test_nested_list_keeps_its_own_level(doc):
    """Вложенный список — отдельный w:num на своём ilvl: считает независимо
    и стартует заново, ступенька отступа приходит из геометрии уровня."""
    paragraphs = _render(
        doc, "<ul><li>верх<ul><li>вложен</li></ul></li><li>ещё</li></ul>"
    )
    assert _texts(paragraphs) == ["верх", "вложен", "ещё"]
    assert _ilvls(paragraphs) == [0, 1, 0]
    outer, inner, back = _num_ids(paragraphs)
    assert outer == back              # возврат в тот же список
    assert inner != outer             # вложенный — своя нумерация


def test_nested_list_keeps_own_list_type(doc):
    """Тип берётся у БЛИЖАЙШЕГО списка: <ol> внутри <ul> остаётся нумерованным."""
    paragraphs = _render(doc, "<ul><li>маркер<ol><li>номер</li></ol></li></ul>")
    assert _texts(paragraphs) == ["маркер", "номер"]
    bullet_num, number_num = _num_ids(paragraphs)
    assert _abstract_of(doc, bullet_num) != _abstract_of(doc, number_num)


def test_deeply_nested_list_keeps_each_level(doc):
    paragraphs = _render(
        doc,
        "<ul><li>1<ul><li>2<ul><li>3</li></ul></li></ul></li></ul>",
    )
    assert _texts(paragraphs) == ["1", "2", "3"]
    assert _ilvls(paragraphs) == [0, 1, 2]
    assert len(set(_num_ids(paragraphs))) == 3


def test_render_level_clamped_at_eight(doc):
    """Уровень глубже 8 в w:numPr не уезжает — Word такого ilvl не знает."""
    html = "<ul>" * 12 + "<li>дно</li>" + "</ul>" * 12
    paragraphs = _render(doc, html)
    assert _ilvls(paragraphs) == [8]


# --- inline-форматирование внутри пункта -------------------------------------

def test_inline_formatting_inside_item_survives(doc):
    paragraphs = _render(
        doc,
        '<ul><li><b>жирно</b> и <i>курсивом</i> и <u>подчёркнуто</u></li></ul>',
    )
    runs = paragraphs[0].runs
    assert [r.text for r in runs] == ["жирно", " и ", "курсивом", " и ", "подчёркнуто"]
    assert runs[0].bold is True
    assert runs[2].italic is True
    assert runs[4].underline is True


def test_size_span_inside_item_survives(doc):
    paragraphs = _render(
        doc, '<ul><li>обычный <span style="font-size: 20px">крупный</span></li></ul>'
    )
    runs = paragraphs[0].runs
    assert runs[0].font.size == Pt(12)
    assert runs[1].font.size == Pt(15)  # 20px × 0.75


def test_base_italic_applies_inside_item(doc):
    """Курсивный хост (поля нарушения) курсивит и текст пунктов."""
    paragraphs = _render(doc, "<ul><li>пункт</li></ul>", base_italic=True)
    assert paragraphs[0].runs[0].italic is True


# --- смешанный HTML: порядок сохраняется -------------------------------------

def test_mixed_content_keeps_order(doc):
    paragraphs = _render(
        doc,
        "<div>интро</div><ul><li>раз</li><li>два</li></ul><div>хвост</div>",
    )
    assert _texts(paragraphs) == ["интро", "раз", "два", "хвост"]
    intro, first, second, tail = _num_ids(paragraphs)
    assert (intro, tail) == (None, None)
    assert first == second is not None


def test_two_lists_separated_by_paragraph(doc):
    """Изоляция §3.1: соседние списки не видят друг друга — разные numId,
    поэтому второй стартует с 1, а не продолжает счёт первого."""
    paragraphs = _render(
        doc,
        "<ul><li>маркер</li></ul><div>между</div><ol><li>номер</li></ol>",
    )
    assert _texts(paragraphs) == ["маркер", "между", "номер"]
    bullet, plain, number = _num_ids(paragraphs)
    assert plain is None
    assert bullet is not None and number is not None
    assert bullet != number


def test_two_adjacent_numbered_lists_do_not_share_count(doc):
    """Два соседних <ol> — разные нумерации; счёт второго начинается заново."""
    paragraphs = _render(
        doc, "<ol><li>a</li><li>b</li></ol><ol><li>c</li></ol>"
    )
    first, second, third = _num_ids(paragraphs)
    assert first == second
    assert third != first
    # Оба списка стартуют с 1 — start уровня в общем abstractNum.
    assert _abstract_of(doc, first) == _abstract_of(doc, third)


def test_separate_render_calls_do_not_share_numbering(doc):
    """Разные текстблоки/поля нарушения — разные вызовы конвертера, значит
    разные numId (локальный кеш instance→num_id живёт на один вызов)."""
    first = _render(doc, "<ol><li>из первого</li></ol>")
    second = _render(doc, "<ol><li>из второго</li></ol>")
    assert _num_ids(first) != _num_ids(second)


def test_list_inside_block_element(doc):
    """Список внутри <div> не съедает текст блока до себя."""
    paragraphs = _render(doc, "<div>до<ul><li>пункт</li></ul></div>")
    assert _texts(paragraphs) == ["до", "пункт"]
    assert _num_ids(paragraphs)[0] is None
    assert _num_ids(paragraphs)[1] is not None


# --- обе точки входа общего конвертера ---------------------------------------

def test_list_in_act_textblock(doc):
    """Точка входа 1 — текстблок акта (DocxFormatter._render_textblock)."""
    schema = TextBlockSchema(
        id="tb1", nodeId="n1",
        content="<div>интро</div><ul><li>раз</li><li>два</li></ul>",
    )
    before = len(doc.paragraphs)
    DocxFormatter()._render_textblock(doc, schema)
    paragraphs = doc.paragraphs[before:]
    assert _texts(paragraphs) == ["интро", "раз", "два"]
    intro, first, second = _num_ids(paragraphs)
    assert intro is None
    assert first == second is not None


def test_list_in_violation_rich_field(doc):
    """Точка входа 2 — rich-поле нарушения (_labeled_paragraph rich=True).

    Метка поля живёт в первом абзаце, который и становится первым пунктом:
    нумерацию получают ВСЕ пункты списка, включая абзац с меткой.
    """
    before = len(doc.paragraphs)
    _labeled_paragraph(
        doc, "Причины:", "<ul><li>раз</li><li>два</li></ul>",
        italic=True, size_pt=Sizes.violation_pt, rich=True,
    )
    paragraphs = doc.paragraphs[before:]
    assert _texts(paragraphs) == ["Причины: раз", "два"]
    num_ids = _num_ids(paragraphs)
    assert None not in num_ids
    assert len(set(num_ids)) == 1
    assert paragraphs[0].runs[0].underline is True  # метка осталась меткой


def test_numbered_list_in_violation_rich_field(doc):
    before = len(doc.paragraphs)
    _labeled_paragraph(
        doc, "Причины:", "<div>вступление</div><ol><li>раз</li></ol>",
        italic=True, size_pt=Sizes.violation_pt, rich=True,
    )
    paragraphs = doc.paragraphs[before:]
    assert _texts(paragraphs) == ["Причины: вступление", "раз"]
    intro, item = _num_ids(paragraphs)
    assert intro is None
    assert item is not None
