"""Проверка стилевых констант: Times New Roman, размеры под эталон, margins, defaults."""
from docx import Document
from docx.enum.text import WD_LINE_SPACING

from docx.oxml.ns import qn

from app.domains.acts.formatters.docx.styles import (
    Fonts,
    Margins,
    Page,
    Sizes,
    Spacing,
    add_blank_line,
    apply_document_defaults,
    ensure_footnote_styles,
)


def test_main_font_is_times_new_roman():
    assert Fonts.main == "Times New Roman"


def test_body_sizes_are_12pt():
    """Основной текст — 12pt (тело, лейблы, заголовки, шапка)."""
    assert Sizes.body_pt == 12
    assert Sizes.cover_label_pt == 12


def test_table_sizes_are_9pt():
    """Таблицы (данные и заголовки) под эталон — 9pt."""
    assert Sizes.table_data_pt == 9
    assert Sizes.table_header_pt == 9


def test_footnote_size_is_9pt():
    """Расшифровка сноски под эталон — 9pt (как таблицы)."""
    assert Sizes.footnote_pt == 9


def test_blank_line_size_is_6pt():
    assert Sizes.blank_line_pt == 6


def test_page_size_is_a4():
    """Размер страницы точно как эталон: A4 (11906×16838 твипов)."""
    assert Page.width_twips == 11906
    assert Page.height_twips == 16838


def test_margins_match_etalon():
    """Поля страницы в твипах, точно как эталон."""
    assert Margins.top == 567
    assert Margins.bottom == 567
    assert Margins.left == 851
    assert Margins.right == 709
    assert Margins.header == 567
    assert Margins.footer == 397


def test_spacing_single_line_3pt_after():
    assert Spacing.line_single == WD_LINE_SPACING.SINGLE
    assert Spacing.before_pt == 0
    assert Spacing.after_pt == 3


def test_apply_document_defaults_sets_normal_style():
    doc = Document()
    apply_document_defaults(doc)
    normal = doc.styles["Normal"]
    assert normal.font.name == "Times New Roman"
    assert normal.font.size.pt == 12
    pf = normal.paragraph_format
    assert pf.line_spacing_rule == WD_LINE_SPACING.SINGLE
    assert pf.space_after.pt == 3
    assert pf.space_before.pt == 0


def test_add_blank_line_has_no_spacing_and_6pt_mark():
    """Пустая строка-распорка: без текста, 6pt-метка, нулевые интервалы."""
    doc = Document()
    para = add_blank_line(doc)
    assert para.text == ""
    pf = para.paragraph_format
    assert pf.space_before.pt == 0
    assert pf.space_after.pt == 0
    sz = para._p.find(qn("w:pPr")).find(qn("w:rPr")).find(qn("w:sz"))
    assert sz is not None
    assert sz.get(qn("w:val")) == "12"  # 6pt × 2 half-points


def test_ensure_footnote_styles_registers_both_styles():
    doc = Document()
    ensure_footnote_styles(doc)
    ids = {s.get(qn("w:styleId")) for s in doc.styles.element.findall(qn("w:style"))}
    assert "FootnoteText" in ids
    assert "FootnoteReference" in ids


def test_footnote_reference_style_is_superscript():
    doc = Document()
    ensure_footnote_styles(doc)
    ref = next(
        s for s in doc.styles.element.findall(qn("w:style"))
        if s.get(qn("w:styleId")) == "FootnoteReference"
    )
    vert = ref.find(qn("w:rPr")).find(qn("w:vertAlign"))
    assert vert is not None
    assert vert.get(qn("w:val")) == "superscript"


def test_ensure_footnote_styles_idempotent():
    doc = Document()
    ensure_footnote_styles(doc)
    ensure_footnote_styles(doc)
    ref_count = sum(
        1 for s in doc.styles.element.findall(qn("w:style"))
        if s.get(qn("w:styleId")) == "FootnoteReference"
    )
    assert ref_count == 1
