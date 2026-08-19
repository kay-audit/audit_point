"""Стилевые константы для DOCX-экспорта актов.

Все значения нормализованы относительно эталона
(docs/Эталонный акт.docx): шрифт Times New Roman, тело 12pt, сноски 10pt,
одинарный межстрочный интервал, 3pt после абзаца.
"""
from docx.document import Document
from docx.enum.text import WD_LINE_SPACING
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsmap, qn
from docx.shared import Pt


class Palette:
    """Hex-цвета (без `#`) для shading и borders."""
    rubricator_shade = "DEEAF6"
    table_header_shade = "D9D9D9"
    table_border = "000000"
    body_text = "000000"


class Fonts:
    main = "Times New Roman"


class Sizes:
    """Все размеры в pt (не half-points).

    Под эталон: основной текст 12pt; таблицы и сноски — 9pt.
    Рубрикатор относится к обычному тексту (12pt), хоть и лежит внутри таблицы.
    """
    body_pt = 12
    violation_pt = 9  # поля нарушения (Нарушено/Установлено/описание/доп.контент) — 9pt курсивом
    table_data_pt = 9
    table_header_pt = 9
    footnote_pt = 9  # расшифровка сноски — 9pt, как таблицы
    cover_label_pt = 12
    blank_line_pt = 6  # высота пустой строки-распорки


class Page:
    """Размер страницы в твипах (dxa), точно как эталон: A4 210×297 мм."""
    width_twips = 11906
    height_twips = 16838


class Margins:
    """Поля страницы в твипах (dxa), точно как эталон."""
    top = 567
    bottom = 567
    left = 851
    right = 709
    header = 567
    footer = 397


class Spacing:
    """Межстрочный интервал и отступы абзацев под эталон.

    Эталон: одинарный интервал (line=240), 3pt после абзаца, 0 до.
    """
    line_single = WD_LINE_SPACING.SINGLE
    before_pt = 0
    after_pt = 3


class Borders:
    table_default = {"sz": 4, "val": "single", "color": "000000"}
    cover_table_none = {"val": "nil"}


# Тексты объединённых по горизонтали ячеек шапки, которые остаются по ЦЕНТРУ
# (а не выравниваются по ширине JUSTIFY, как прочие склеенные шапки).
# Набор (frozenset) — чтобы при необходимости настроить несколько таких шапок.
# ВАЖНО: правка формулировки шапки в шаблонах таблиц требует синхронной правки
# этого набора, иначе ячейка перестанет центрироваться. Сравнение — по тексту,
# нормализованному так же, как в builder'е (_normalize_text: strip + схлоп пробелов).
CENTERED_MERGED_HEADER_TEXTS: frozenset[str] = frozenset({
    "Количество клиентов / элементов, ед.",
})


def apply_document_defaults(doc: Document) -> None:  # type: ignore[name-defined]
    """Настраивает стиль Normal под эталон: TNR 12pt, одинарный интервал, 3pt после.

    Все абзацы документа наследуют Normal, поэтому единая правка стиля задаёт
    типографику всего акта без перебора билдеров.
    """
    normal = doc.styles["Normal"]
    normal.font.name = Fonts.main
    normal.font.size = Pt(Sizes.body_pt)

    pf = normal.paragraph_format
    pf.line_spacing_rule = Spacing.line_single
    pf.space_before = Pt(Spacing.before_pt)
    pf.space_after = Pt(Spacing.after_pt)


def add_blank_line(doc, size_pt: int = Sizes.blank_line_pt):
    """Добавляет пустую строку-распорку без текста и без интервальных отступов.

    Высота строки задаётся размером метки абзаца (size_pt). Интервалы
    before/after принудительно обнулены. Используется до/после рубрикатора
    и после таблиц.
    """
    para = doc.add_paragraph()
    pf = para.paragraph_format
    pf.line_spacing_rule = Spacing.line_single
    pf.space_before = Pt(0)
    pf.space_after = Pt(0)
    # Размер метки абзаца → высота пустой строки.
    p_pr = para._p.get_or_add_pPr()
    r_pr = p_pr.find(qn("w:rPr"))
    if r_pr is None:
        r_pr = OxmlElement("w:rPr")
        p_pr.append(r_pr)
    for tag in ("w:sz", "w:szCs"):
        el = OxmlElement(tag)
        el.set(qn("w:val"), str(size_pt * 2))
        r_pr.append(el)
    return para


def ensure_footnote_styles(doc: Document) -> None:  # type: ignore[name-defined]
    """Регистрирует стили FootnoteText/FootnoteReference, как в эталоне.

    Дефолтный шаблон python-docx их не содержит. Надстрочность циферки-ссылки
    обеспечивается символьным стилем FootnoteReference (как в оригинале), а не
    inline-vertAlign. FootnoteText задаёт 9pt и нулевые интервалы у расшифровки.
    """
    styles_el = doc.styles.element
    existing = {s.get(qn("w:styleId")) for s in styles_el.findall(qn("w:style"))}
    ns = nsmap["w"]
    half = Sizes.footnote_pt * 2

    if "FootnoteText" not in existing:
        styles_el.append(parse_xml(
            f'<w:style xmlns:w="{ns}" w:type="paragraph" w:styleId="FootnoteText">'
            f'<w:name w:val="footnote text"/>'
            f'<w:basedOn w:val="Normal"/>'
            f'<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
            f'<w:rPr><w:rFonts w:ascii="{Fonts.main}" w:hAnsi="{Fonts.main}"/>'
            f'<w:sz w:val="{half}"/><w:szCs w:val="{half}"/></w:rPr>'
            f'</w:style>'
        ))

    if "FootnoteReference" not in existing:
        styles_el.append(parse_xml(
            f'<w:style xmlns:w="{ns}" w:type="character" w:styleId="FootnoteReference">'
            f'<w:name w:val="footnote reference"/>'
            f'<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>'
            f'</w:style>'
        ))
