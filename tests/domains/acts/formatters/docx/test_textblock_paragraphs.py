"""TB-1: текстблок в DOCX — верхнеуровневые блочные элементы → отдельные w:p.

Прежняя модель «один w:p + w:br на все блоки» не выражала per-line
выравнивание. Теперь каждый верхнеуровневый <div>/<p> — свой абзац Word со
своим jc (дефолт justify); <br> и вложенные блочные теги внутри сегмента
остаются мягкими переносами w:br; контент вне блочной разметки (голый
текст/span — легаси) уходит в абзац с дефолтным justify, а не теряется.
"""
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt

from app.domains.acts.formatters.docx import DocxFormatter
from app.domains.acts.formatters.docx.builders.inline import (
    BlockSegment,
    split_block_segments,
)
from app.domains.acts.schemas.act_content import TextBlockSchema


def _render(doc, content, formatter=None):
    """Рендерит текстблок в doc, возвращает ДОБАВЛЕННЫЕ абзацы."""
    schema = TextBlockSchema(id="tb1", nodeId="n1", content=content)
    before = len(doc.paragraphs)
    (formatter or DocxFormatter())._render_textblock(doc, schema)
    return doc.paragraphs[before:]


def _count_breaks(p) -> int:
    return len(p._p.findall(".//" + qn("w:br")))


# --- split_block_segments: сегментация ---------------------------------------


def test_split_plain_text_single_anonymous_segment():
    assert split_block_segments("Просто текст") == [BlockSegment(None, "Просто текст")]


def test_split_divs_carry_own_alignment():
    segments = split_block_segments(
        '<div style="text-align: left">l</div>'
        '<div style="text-align: center">c</div>'
        '<div style="text-align: right">r</div>'
    )
    assert segments == [
        BlockSegment("left", "l"), BlockSegment("center", "c"), BlockSegment("right", "r"),
    ]


def test_split_align_value_case_insensitive():
    segments = split_block_segments('<div style="TEXT-ALIGN: JUSTIFY;">j</div>')
    assert segments == [BlockSegment("justify", "j")]


def test_split_leading_bare_content_grouped_before_block():
    segments = split_block_segments('интро<div style="text-align: center;">блок</div>')
    assert segments == [BlockSegment(None, "интро"), BlockSegment("center", "блок")]


def test_split_placeholder_br_normalized_to_empty():
    segments = split_block_segments("<div>a</div><div><br></div><div>b</div>")
    assert segments == [
        BlockSegment(None, "a"), BlockSegment(None, ""), BlockSegment(None, "b"),
    ]


def test_split_nested_block_stays_inside_segment():
    segments = split_block_segments("<div>a<div>вложен</div></div>")
    assert segments == [BlockSegment(None, "a<div>вложен</div>")]


def test_split_nested_aligned_block_becomes_own_segment():
    """S1: вложенный блок со СВОИМ text-align — отдельный сегмент с этим
    выравниванием; куски родителя до/после — сегменты с align родителя."""
    segments = split_block_segments(
        '<div style="text-align: center">a'
        '<div style="text-align: right">b</div>c</div>'
    )
    assert segments == [
        BlockSegment("center", "a"),
        BlockSegment("right", "b"),
        BlockSegment("center", "c"),
    ]


def test_split_nested_aligned_only_child_no_empty_parent_segment():
    """Родитель без собственного текста, только вложенный aligned-блок — пустой
    сегмент-родитель НЕ плодится."""
    segments = split_block_segments(
        '<div style="text-align: center">'
        '<div style="text-align: right">x</div></div>'
    )
    assert segments == [BlockSegment("right", "x")]


def test_split_interblock_whitespace_dropped():
    segments = split_block_segments("<div>a</div>\n  <div>b</div>")
    assert segments == [BlockSegment(None, "a"), BlockSegment(None, "b")]


def test_split_entities_pass_through_unescaped_once():
    """Entity-ссылки доезжают до сегмента ДОСЛОВНО — повторного
    экранирования/раскодирования нет, &lt; не превращается в тег."""
    segments = split_block_segments("a &amp; b<div>c &lt;tag&gt;</div>")
    assert segments == [
        BlockSegment(None, "a &amp; b"), BlockSegment(None, "c &lt;tag&gt;"),
    ]


def test_split_unclosed_block_not_lost():
    assert split_block_segments("<div>незакрыт") == [BlockSegment(None, "незакрыт")]


def test_split_list_markup_gives_item_segments():
    """V14.1: <li> — такая же граница сегмента, как div/p, со стилем своего
    списка (прежде весь <ul> оставался одним анонимным сегментом с мягкими
    переносами). Полное покрытие списков — test_rich_lists.py."""
    assert split_block_segments("<ul><li>x</li><li>y</li></ul>") == [
        BlockSegment(None, "x", "List Bullet"),
        BlockSegment(None, "y", "List Bullet"),
    ]


def test_split_empty_and_whitespace_content():
    assert split_block_segments("") == []
    assert split_block_segments("   ") == []


# --- _render_textblock: модель абзацев ---------------------------------------


def test_centered_div_becomes_centered_paragraph(doc):
    paras = _render(doc, '<div style="text-align: center;">Центр</div>')
    assert len(paras) == 1
    assert paras[0].alignment == WD_ALIGN_PARAGRAPH.CENTER
    assert paras[0].text == "Центр"


def test_three_divs_three_paragraphs_with_own_alignment(doc):
    paras = _render(
        doc,
        '<div style="text-align: left;">лево</div>'
        '<div style="text-align: center;">центр</div>'
        '<div style="text-align: right;">право</div>',
    )
    assert [p.alignment for p in paras] == [
        WD_ALIGN_PARAGRAPH.LEFT, WD_ALIGN_PARAGRAPH.CENTER, WD_ALIGN_PARAGRAPH.RIGHT,
    ]
    assert [p.text for p in paras] == ["лево", "центр", "право"]


def test_div_without_align_defaults_to_justify(doc):
    paras = _render(doc, "<div>обычный</div>")
    assert len(paras) == 1
    assert paras[0].alignment == WD_ALIGN_PARAGRAPH.JUSTIFY


def test_plain_inline_content_single_justify_paragraph(doc):
    """Контент без блочной разметки (легаси) — один w:p justify, не теряется."""
    paras = _render(doc, "Просто <b>текст</b>")
    assert len(paras) == 1
    assert paras[0].alignment == WD_ALIGN_PARAGRAPH.JUSTIFY
    assert paras[0].text == "Просто текст"
    bold = next(r for r in paras[0].runs if r.text == "текст")
    assert bold.bold is True


def test_leading_bare_text_before_block_not_lost(doc):
    """Голый текст перед первым блочным элементом — первый w:p с justify."""
    paras = _render(doc, 'интро<div style="text-align: center;">блок</div>')
    assert [p.text for p in paras] == ["интро", "блок"]
    assert paras[0].alignment == WD_ALIGN_PARAGRAPH.JUSTIFY
    assert paras[1].alignment == WD_ALIGN_PARAGRAPH.CENTER


def test_leading_size_span_keeps_size_in_first_paragraph(doc):
    """Верхнеуровневый span «размер на каретке» уходит в первый w:p
    с сохранением размера (20px → 15pt)."""
    paras = _render(
        doc, '<span style="font-size: 20px;">якорь</span><div>блок</div>'
    )
    assert [p.text for p in paras] == ["якорь", "блок"]
    assert paras[0].runs[0].font.size == Pt(15)


def test_empty_div_placeholder_becomes_empty_paragraph(doc):
    """<div><br></div> — пустой абзац-строка: без runs и без w:br
    (сам абзац уже даёт строку, w:br удвоил бы её)."""
    paras = _render(doc, "<div>a</div><div><br></div><div>b</div>")
    assert [p.text for p in paras] == ["a", "", "b"]
    middle = paras[1]
    assert len(middle.runs) == 0
    assert _count_breaks(middle) == 0


def test_br_inside_block_stays_soft_break(doc):
    paras = _render(doc, "<div>a<br>b</div>")
    assert len(paras) == 1
    assert _count_breaks(paras[0]) == 1


def test_nested_div_stays_soft_break_in_same_paragraph(doc):
    paras = _render(doc, "<div>a<div>вложен</div></div>")
    assert len(paras) == 1
    assert _count_breaks(paras[0]) == 1
    assert "a" in paras[0].text and "вложен" in paras[0].text


def test_nested_aligned_div_becomes_own_paragraph(doc):
    """S1: вложенный блок со своим text-align рендерится отдельным w:p с этим
    выравниванием — превью (каскад) и DOCX больше не расходятся."""
    paras = _render(
        doc,
        '<div style="text-align: center;">верх'
        '<div style="text-align: right;">вложен-право</div>низ</div>',
    )
    assert [p.text for p in paras] == ["верх", "вложен-право", "низ"]
    assert [p.alignment for p in paras] == [
        WD_ALIGN_PARAGRAPH.CENTER,
        WD_ALIGN_PARAGRAPH.RIGHT,
        WD_ALIGN_PARAGRAPH.CENTER,
    ]


def test_footnote_in_centered_line(doc):
    """Сноска (прямой oxml) переживает разбиение: живёт в СВОЁМ w:p."""
    paras = _render(
        doc,
        '<div>первая строка</div>'
        '<div style="text-align: center;">Слово '
        '<span class="text-footnote" data-footnote-text="прим">якорь</span></div>',
    )
    assert len(paras) == 2
    centered = paras[1]
    assert centered.alignment == WD_ALIGN_PARAGRAPH.CENTER
    refs = centered._p.findall(".//" + qn("w:footnoteReference"))
    assert len(refs) == 1
    # Первый абзац сносок не содержит.
    assert not paras[0]._p.findall(".//" + qn("w:footnoteReference"))


def test_footnote_nbsp_under_justify_per_paragraph(doc):
    """NBSP-обвязка сноски (BUG-3) работает per-paragraph: justify-абзац
    (дефолт) получает неразрывный пробел перед якорем."""
    paras = _render(
        doc,
        "<div>первая</div>"
        '<div>Слово <span class="text-footnote" data-footnote-text="прим">якорь</span></div>',
    )
    justified = paras[1]
    assert justified.alignment == WD_ALIGN_PARAGRAPH.JUSTIFY
    texts = []
    for r in justified._p.findall(qn("w:r")):
        t = r.find(qn("w:t"))
        if t is not None and t.text:
            texts.append(t.text)
    assert any(chr(0xA0) in t for t in texts)


def test_footnotes_in_different_segments_get_distinct_ids(doc):
    """Две сноски в РАЗНЫХ сегментах одного текстблока — разные footnote-id:
    счётчик документный (add_footnote), разбиение на w:p его не сбрасывает."""
    paras = _render(
        doc,
        '<div>a <span class="text-footnote" data-footnote-text="один">я1</span></div>'
        '<div>b <span class="text-footnote" data-footnote-text="два">я2</span></div>',
    )
    ids = [
        ref.get(qn("w:id"))
        for p in paras
        for ref in p._p.findall(".//" + qn("w:footnoteReference"))
    ]
    assert len(ids) == 2
    assert len(set(ids)) == 2


def test_footnote_nbsp_not_applied_in_centered_paragraph(doc):
    """В center-абзаце Word не растягивает пробелы — NBSP-замена не нужна
    и не делается (та же семантика, что была у не-justify рендера)."""
    paras = _render(
        doc,
        '<div style="text-align: center;">Слово '
        '<span class="text-footnote" data-footnote-text="прим">якорь</span></div>',
    )
    texts = []
    for r in paras[0]._p.findall(qn("w:r")):
        t = r.find(qn("w:t"))
        if t is not None and t.text:
            texts.append(t.text)
    assert not any(chr(0xA0) in t for t in texts)


def test_hyperlink_survives_block_split(doc):
    paras = _render(
        doc,
        "<div>до</div>"
        '<div style="text-align: right;">'
        '<span class="text-link" data-link-url="https://example.com/">тут</span></div>',
    )
    assert len(paras) == 2
    assert paras[1].alignment == WD_ALIGN_PARAGRAPH.RIGHT
    links = paras[1]._p.findall(qn("w:hyperlink"))
    assert len(links) == 1
    assert not paras[0]._p.findall(qn("w:hyperlink"))


def test_empty_content_renders_nothing(doc):
    """EXP-4: пустой текстблок не печатает пустой абзац — гейт тем же критерием,
    что превью (_hasContent). Раньше пустой content давал висячий пустой w:p."""
    assert _render(doc, "") == []
    assert _render(doc, "   ") == []
    assert _render(doc, "\n\t ") == []


def test_base_font_size_applies_to_every_paragraph(doc):
    """Базовый размер — экранный дефолт настроек ×0.75 (16px → 12pt, EXP-2) —
    применяется каждому сегменту (форматтер без настроек → фолбэк 16px)."""
    paras = _render(doc, "<div>один</div><div>два</div>")
    for p in paras:
        assert p.runs[0].font.size == Pt(12)


def test_base_font_size_follows_settings_default(doc):
    """EXP-2: база = ACTS__TEXTBLOCKS__FONT_SIZE_DEFAULT ×0.75. 20px → 15pt."""
    from app.domains.acts.settings import ActsSettings, TextblocksSettings
    fmt = DocxFormatter(acts_settings=ActsSettings(
        textblocks=TextblocksSettings(font_size_default=20)))
    paras = _render(doc, "<div>текст</div>", formatter=fmt)
    assert paras[0].runs[0].font.size == Pt(15)


# --- вертикальная геометрия: спейсинг разбитого блока -------------------------


def test_intermediate_paragraphs_zero_space_after(doc):
    """Инвариант геометрии: границы сегментов — бывшие w:br, поэтому
    промежуточные w:p идут с явным space_after=0; Normal-спейсинг (3pt after)
    сохраняет только последний w:p — как у прежнего единственного абзаца."""
    paras = _render(doc, "<div>раз</div><div>два</div><div>три</div>")
    spacings = [p.paragraph_format.space_after for p in paras]
    # None = прямого форматирования нет, наследуется Normal (прежнее значение).
    assert spacings == [Pt(0), Pt(0), None]


def test_empty_line_paragraph_also_zero_spacing_except_last(doc):
    """Пустая строка (<div><br></div>) не ломает раскладку: пустой w:p в
    середине блока тоже без межабзацного интервала."""
    paras = _render(doc, "<div>a</div><div><br></div><div>b</div>")
    spacings = [p.paragraph_format.space_after for p in paras]
    assert spacings == [Pt(0), Pt(0), None]


def test_single_paragraph_keeps_inherited_spacing(doc):
    """Одноабзацный контент — без прямого спейсинга: геометрия побайтно
    совпадает со старой моделью (всё от Normal)."""
    for content in ("Просто текст", '<div style="text-align: center;">один</div>'):
        paras = _render(doc, content)
        assert len(paras) == 1
        assert paras[0].paragraph_format.space_after is None
        assert paras[0].paragraph_format.space_before is None
