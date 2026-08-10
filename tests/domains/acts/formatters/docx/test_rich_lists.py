"""V14.1: списки rich-HTML (<ul>/<ol>/<li>) в DOCX.

Списки живут в rich-редакторе ВООБЩЕ (решение владельца, спека §2.3), поэтому
учится им ОБЩИЙ конвертер render_block_segments — единственный путь rich-HTML →
абзацы для всех потребителей: текстблоки акта, rich-поля нарушения, подписи
картинок. Каждый <li> — свой абзац Word со стилем "List Bullet" (маркированный)
или "List Number" (нумерованный); вложенные списки сплющиваются в тот же
уровень с сохранением текста и типа своего списка.
"""
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt, Twips

from app.domains.acts.formatters.docx import DocxFormatter
from app.domains.acts.formatters.docx.builders.inline import (
    BlockSegment,
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


def _styles(paragraphs) -> list[str]:
    return [p.style.name for p in paragraphs]


def _texts(paragraphs) -> list[str]:
    return [p.text for p in paragraphs]


# --- сегментация: <li> → сегмент со стилем списка ----------------------------

def test_ul_items_become_bullet_segments():
    assert split_block_segments("<ul><li>раз</li><li>два</li></ul>") == [
        BlockSegment(None, "раз", "List Bullet"),
        BlockSegment(None, "два", "List Bullet"),
    ]


def test_ol_items_become_number_segments():
    assert split_block_segments("<ol><li>раз</li><li>два</li></ol>") == [
        BlockSegment(None, "раз", "List Number"),
        BlockSegment(None, "два", "List Number"),
    ]


def test_list_tag_itself_gives_no_segment():
    """<ul>/<ol> — только носитель стиля для своих <li>, своего абзаца не даёт."""
    assert split_block_segments("<ul></ul>") == []


def test_whitespace_between_list_tags_ignored():
    """Переносы строк разметки между <ul> и <li> не превращаются в абзацы."""
    assert split_block_segments("<ul>\n  <li>раз</li>\n  <li>два</li>\n</ul>") == [
        BlockSegment(None, "раз", "List Bullet"),
        BlockSegment(None, "два", "List Bullet"),
    ]


def test_unclosed_list_items_closed_by_list_end():
    """Разметка без </li> (<ul><li>a<li>b</ul>) даёт те же два пункта."""
    assert split_block_segments("<ul><li>раз<li>два</ul>") == [
        BlockSegment(None, "раз", "List Bullet"),
        BlockSegment(None, "два", "List Bullet"),
    ]


def test_orphan_li_without_list_stays_raw():
    """<li> вне <ul>/<ol> — не пункт: остаётся сырьём сегмента (мягкий перенос,
    прежнее поведение), стиля списка не получает."""
    assert split_block_segments("<li>сирота</li>") == [
        BlockSegment(None, "<li>сирота</li>", None),
    ]


def test_li_own_text_align_kept():
    assert split_block_segments('<ol><li style="text-align: right">пункт</li></ol>') == [
        BlockSegment("right", "пункт", "List Number"),
    ]


# --- рендер: пункт = абзац со стилем списка ----------------------------------

def test_bullet_list_one_paragraph_per_item(doc):
    paragraphs = _render(doc, "<ul><li>раз</li><li>два</li><li>три</li></ul>")
    assert _texts(paragraphs) == ["раз", "два", "три"]
    assert _styles(paragraphs) == ["List Bullet"] * 3


def test_numbered_list_uses_list_number_style(doc):
    paragraphs = _render(doc, "<ol><li>раз</li><li>два</li></ol>")
    assert _texts(paragraphs) == ["раз", "два"]
    assert _styles(paragraphs) == ["List Number", "List Number"]


def test_list_item_default_alignment_applies(doc):
    paragraphs = _render(doc, "<ul><li>пункт</li></ul>")
    assert paragraphs[0].alignment == WD_ALIGN_PARAGRAPH.JUSTIFY


def test_list_item_own_alignment_overrides_default(doc):
    paragraphs = _render(doc, '<ul><li style="text-align: center">пункт</li></ul>')
    assert paragraphs[0].alignment == WD_ALIGN_PARAGRAPH.CENTER


# --- вложенность: сплющивание в тот же уровень -------------------------------

def test_nested_list_flattened_keeping_text(doc):
    """Вложенный список сплющивается: текст сохраняется, ступенька отступа —
    нет (стилей "List Bullet 2" сознательно не заводим)."""
    paragraphs = _render(
        doc, "<ul><li>верх<ul><li>вложен</li></ul></li><li>ещё</li></ul>"
    )
    assert _texts(paragraphs) == ["верх", "вложен", "ещё"]
    assert _styles(paragraphs) == ["List Bullet"] * 3
    assert all(p.paragraph_format.left_indent is None for p in paragraphs)


def test_nested_list_keeps_own_list_type(doc):
    """Тип берётся у БЛИЖАЙШЕГО списка: <ol> внутри <ul> остаётся нумерованным."""
    paragraphs = _render(doc, "<ul><li>маркер<ol><li>номер</li></ol></li></ul>")
    assert _texts(paragraphs) == ["маркер", "номер"]
    assert _styles(paragraphs) == ["List Bullet", "List Number"]


def test_deeply_nested_list_flattened_to_single_level(doc):
    paragraphs = _render(
        doc,
        "<ul><li>1<ul><li>2<ul><li>3</li></ul></li></ul></li></ul>",
    )
    assert _texts(paragraphs) == ["1", "2", "3"]
    assert _styles(paragraphs) == ["List Bullet"] * 3


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
    assert _styles(paragraphs) == ["Normal", "List Bullet", "List Bullet", "Normal"]


def test_two_lists_separated_by_paragraph(doc):
    paragraphs = _render(
        doc,
        "<ul><li>маркер</li></ul><div>между</div><ol><li>номер</li></ol>",
    )
    assert _texts(paragraphs) == ["маркер", "между", "номер"]
    assert _styles(paragraphs) == ["List Bullet", "Normal", "List Number"]


def test_list_inside_block_element(doc):
    """Список внутри <div> не съедает текст блока до себя."""
    paragraphs = _render(doc, "<div>до<ul><li>пункт</li></ul></div>")
    assert _texts(paragraphs) == ["до", "пункт"]
    assert _styles(paragraphs) == ["Normal", "List Bullet"]


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
    assert _styles(paragraphs) == ["Normal", "List Bullet", "List Bullet"]


def test_list_in_violation_rich_field(doc):
    """Точка входа 2 — rich-поле нарушения (_labeled_paragraph rich=True).

    Метка поля живёт в первом абзаце, который и становится первым пунктом:
    маркер получают ВСЕ пункты списка, включая абзац с меткой.
    """
    before = len(doc.paragraphs)
    _labeled_paragraph(
        doc, "Причины:", "<ul><li>раз</li><li>два</li></ul>",
        italic=True, size_pt=Sizes.violation_pt, rich=True,
    )
    paragraphs = doc.paragraphs[before:]
    assert _texts(paragraphs) == ["Причины: раз", "два"]
    assert _styles(paragraphs) == ["List Bullet", "List Bullet"]
    assert paragraphs[0].runs[0].underline is True  # метка осталась меткой


def test_numbered_list_in_violation_rich_field(doc):
    before = len(doc.paragraphs)
    _labeled_paragraph(
        doc, "Причины:", "<div>вступление</div><ol><li>раз</li></ol>",
        italic=True, size_pt=Sizes.violation_pt, rich=True,
    )
    paragraphs = doc.paragraphs[before:]
    assert _texts(paragraphs) == ["Причины: вступление", "раз"]
    assert _styles(paragraphs) == ["Normal", "List Number"]


# --- регрессия: стиль ХОСТА (пункты descriptionList) не сломан ---------------

def test_host_paragraph_style_still_first_only(doc):
    """Хост-стиль (paragraph_style) по-прежнему только на первом абзаце,
    продолжение — обычный абзац с отступом под текст маркера."""
    paragraphs = _render(
        doc, "<div>первая</div><div>вторая</div>", paragraph_style="List Bullet"
    )
    assert _styles(paragraphs) == ["List Bullet", "Normal"]
    assert paragraphs[1].paragraph_format.left_indent == Twips(360)


def test_own_list_style_wins_over_host_style(doc):
    """Список из самого HTML сильнее хост-стиля: маркер у каждого пункта,
    и продолжению-пункту не навешивается отступ хоста (он в стиле списка)."""
    paragraphs = _render(
        doc, "<ul><li>раз</li><li>два</li></ul>", paragraph_style="List Bullet"
    )
    assert _styles(paragraphs) == ["List Bullet", "List Bullet"]
    assert all(p.paragraph_format.left_indent is None for p in paragraphs)
