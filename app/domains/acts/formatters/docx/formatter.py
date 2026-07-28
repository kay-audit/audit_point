"""DocxFormatter — фасад над builders'ами.

Принимает ExportContext, возвращает python-docx Document.
"""
from docx import Document as new_document
from docx.document import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt

from app.domains.acts.block_types import NODE_TYPE_TABLE
from app.domains.acts.formatters.docx.builders.cover import build_cover_block
from app.domains.acts.formatters.docx.builders.header_footer import apply_header_footer
from app.domains.acts.formatters.docx.builders.inline import (
    _PX_TO_PT,
    render_block_segments,
)
from app.domains.acts.formatters.docx.builders.rubricator import build_rubricator_plate
from app.domains.acts.formatters.docx.builders.signature import build_signature
from app.domains.acts.formatters.docx.builders.tables import build_table
from app.domains.acts.formatters.docx.builders.violation import build_violation
from app.domains.acts.formatters.docx.context import ExportContext
from app.domains.acts.formatters.docx.numbering import apply_numbering, ensure_rubricator
from app.domains.acts.formatters.tree_walker import WalkContext, collect_blocks, walk
from app.domains.acts.formatters.docx.styles import (
    Fonts,
    Sizes,
    add_blank_line,
    apply_document_defaults,
    ensure_footnote_styles,
)
# Текстблок: размер базы — единый экранный дефолт настроек
# (ACTS__TEXTBLOCKS__FONT_SIZE_DEFAULT, 16px) через px→pt ×0.75 = 12pt (EXP-2);
# выравнивание — per-line из style="text-align" блочных элементов content
# (TB-1: HTML — источник истины). Начертание (жирный/курсив/подчёркивание) —
# только из inline-тегов content (B-1).
# Фолбэк размера, когда форматтер собран без настроек (юнит-тесты DocxFormatter()).
_DEFAULT_TB_FONT_SIZE_PX = 16

# px → pt (16px → 12pt) — единый источник в builders/inline.py (_PX_TO_PT).
# Карта text-align → выравнивание Word — там же (ALIGNMENT_MAP), рядом с
# split_block_segments (общий потребитель — и текстблок, и rich-поля нарушения).


class DocxFormatter:
    """Stateless форматер. settings/acts_settings приняты для совместимости
    с ExportService.__init__ — реально не используются."""

    def __init__(self, settings=None, acts_settings=None):
        self._settings = settings
        self._acts_settings = acts_settings

    def format(self, ctx: ExportContext) -> Document:  # type: ignore[name-defined]
        doc = new_document()
        apply_document_defaults(doc)
        ensure_footnote_styles(doc)
        apply_header_footer(doc, ctx.metadata)
        build_cover_block(doc, ctx.metadata)
        num_id = ensure_rubricator(doc)
        self._render_tree(doc, ctx, num_id)
        build_signature(doc, ctx.metadata)
        _enable_update_fields(doc)
        _disable_shift_return_expansion(doc)
        return doc

    def _render_tree(self, doc, ctx: ExportContext, num_id: int) -> None:
        # Обход дерева — единый walker, представление — в визиторе.
        visitor = _DocxTreeVisitor(self, doc, num_id)
        walk(ctx.content.tree or {}, visitor, collect_blocks(ctx.content))

    def _render_item(self, doc, node, *, num_id, ilvl) -> None:
        para = doc.add_paragraph()
        para.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        apply_numbering(para, num_id, ilvl=ilvl)
        label = node.get("customLabel") or node.get("label", "")
        run = para.add_run(label)
        run.font.name = Fonts.main
        run.font.size = Pt(Sizes.body_pt)
        # Пункт — жирный заголовок (как рубрикатор): текст и авто-номер.
        run.bold = True
        _set_mark_bold(para)

        if node.get("content"):
            # content пункта — plain-текст из textarea (M.4): выводится дословно,
            # без HTML-парсинга — литеральные `<`/`&` не искажаются (паритет MD/TXT).
            body_para = doc.add_paragraph()
            body_para.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            body_run = body_para.add_run(node["content"])
            body_run.font.name = Fonts.main
            body_run.font.size = Pt(Sizes.body_pt)

    def _render_textblock(self, doc, schema) -> None:
        """Текстблок: верхнеуровневые блочные элементы content → отдельные w:p.

        Выравнивание — per-line из style="text-align" каждого верхнеуровневого
        <div>/<p> (TB-1: источник истины — HTML), дефолт JUSTIFY. Геометрия
        сегментов → абзацев (ALIGNMENT_MAP, space_after промежуточных w:p) —
        общий helper render_block_segments (V14), единый для текстблока,
        rich-полей нарушения, подписи картинки и пунктов списка.

        Размер базы — единый экранный дефолт настроек ×0.75 (EXP-2: 16px → 12pt);
        span'ы с собственным font-size конвертируются тем же ×0.75 в
        apply_inline_html. Начертание (жирный/курсив/подчёркивание) задаётся
        ИСКЛЮЧИТЕЛЬНО inline-тегами <b>/<i>/<u> в content (B-1): apply_inline_html
        выставляет run.bold/italic/underline per-run.
        """
        # EXP-4: пустой текстблок не печатает пустой абзац — гейт тем же
        # критерием, что превью (_hasContent = content.trim() истинно). Пустой
        # или пробельный content не даёт ни одного w:p (раньше — пустой
        # абзац-строка, «висевшая» в DOCX там, где превью блок не рисует).
        if not schema.content or not schema.content.strip():
            return
        base_px = (
            self._acts_settings.textblocks.font_size_default
            if self._acts_settings is not None
            else _DEFAULT_TB_FONT_SIZE_PX
        )
        base_size_pt = base_px * _PX_TO_PT
        render_block_segments(
            doc, schema.content,
            base_size_pt=base_size_pt,
            default_alignment=WD_ALIGN_PARAGRAPH.JUSTIFY,
        )

    def _add_table_title(self, doc, node) -> None:
        """Заголовок таблицы: жирная подпись без нумерации (таблица — не пункт)."""
        title = node.get("customLabel") or node.get("label", "")
        if not title:
            return
        para = doc.add_paragraph()
        para.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        # Заголовок не отрывается от своей таблицы и не делится между страницами
        # (контроль переносов — п.4: keepNext связывает заголовок с таблицей).
        para.paragraph_format.keep_with_next = True
        para.paragraph_format.keep_together = True
        run = para.add_run(title)
        run.font.name = Fonts.main
        run.font.size = Pt(Sizes.body_pt)
        run.bold = True


class _DocxTreeVisitor:
    """Визитор tree-walker'а для DOCX: представление узлов дерева.

    Контекст обхода (depth) транслируется в Word-нумерацию: дети корня
    (depth 0) — плашки рубрикатора (уровень 0 multilevel-списка), вложенные
    пункты — ilvl = depth. Рендеринг делегируется builders'ам и методам
    DocxFormatter — сами builders walker'ом не затронуты.
    """

    def __init__(self, formatter: DocxFormatter, doc, num_id: int):
        self._fmt = formatter
        self._doc = doc
        self._num_id = num_id

    def on_item_enter(self, node: dict, ctx: WalkContext) -> None:
        if ctx.depth == 0:
            # Раздел верхнего уровня: плашка рубрикатора с распорками.
            add_blank_line(self._doc)
            build_rubricator_plate(self._doc, self._num_id, node.get("label", ""))
            add_blank_line(self._doc)
            return
        # Пункт: выводятся и название, и нумерация уровня (ilvl = depth).
        self._fmt._render_item(self._doc, node, num_id=self._num_id, ilvl=ctx.depth)

    def on_item_exit(self, node: dict, ctx: WalkContext) -> None:
        pass

    def on_table(self, node: dict, schema, ctx: WalkContext) -> None:
        if schema is None:
            return
        if node.get("type") == NODE_TYPE_TABLE:
            # Узел-таблица: только заголовок, без нумерации (не пункт).
            # Прикреплённой к пункту таблице заголовком служит сам пункт.
            self._fmt._add_table_title(self._doc, node)
        build_table(self._doc, schema)
        # Пустая строка-распорка после любой таблицы.
        add_blank_line(self._doc)

    def on_textblock(self, node: dict, schema, ctx: WalkContext) -> None:
        if schema is not None:
            # Текстблок: без заголовка и без нумерации — только содержимое.
            self._fmt._render_textblock(self._doc, schema)

    def on_violation(self, node: dict, schema, ctx: WalkContext) -> None:
        if schema is not None:
            # Нарушение: без заголовка и без нумерации (см. build_violation).
            build_violation(self._doc, schema)


def _set_mark_bold(paragraph) -> None:
    """Делает метку абзаца жирной — чтобы авто-номер пункта тоже был жирным.

    Номер списка наследует начертание от метки абзаца (pPr/rPr), а не от run'а
    с текстом, поэтому жирность номера задаётся именно здесь.
    """
    p_pr = paragraph._p.get_or_add_pPr()
    r_pr = p_pr.find(qn("w:rPr"))
    if r_pr is None:
        r_pr = OxmlElement("w:rPr")
        p_pr.append(r_pr)
    if r_pr.find(qn("w:b")) is None:
        r_pr.append(OxmlElement("w:b"))


# Элементы CT_Settings, которые по схеме OOXML идут ПОСЛЕ w:updateFields.
# updateFields обязан стоять перед первым из них, иначе Word считает
# settings.xml некорректным и игнорирует флаг (NUMPAGES «застревает» на 1).
_SETTINGS_AFTER_UPDATE_FIELDS = frozenset({
    "hdrShapeDefaults", "footnotePr", "endnotePr", "compat", "rsids", "mathPr",
    "themeFontLang", "clrSchemeMapping", "doNotAutoCompressPictures", "shapeDefaults",
    "decimalSymbol", "listSeparator", "docId", "defaultImageDpi", "chartTrackingRefBased",
})


# Булевы опции CT_Compat, которые по схеме OOXML идут ПЕРЕД
# w:doNotExpandShiftReturn (единственные, кому он не должен предшествовать).
# Всё остальное (useFELayout, compatSetting, ...) идёт ПОСЛЕ. В дефолтном
# шаблоне python-docx их нет, поэтому элемент становится первым ребёнком
# <w:compat>; набор нужен на случай, если python-docx когда-то добавит их.
_COMPAT_BEFORE_SHIFT_RETURN = frozenset({
    "useSingleBorderforContiguousCells", "wpJustification", "noTabHangInd",
    "noLeading", "spaceForUL", "noColumnBalance",
    "balanceSingleByteDoubleByteWidth", "noExtraLineSpacing",
    "doNotLeaveBackslashAlone", "ulTrailSpace",
})


def _enable_update_fields(doc) -> None:
    """Помечает поля документа на пересчёт при открытии (w:updateFields).

    Вставляет флаг в схемо-корректную позицию (перед compat/rsids/mathPr/...),
    иначе Word игнорирует его и не пересчитывает NUMPAGES/PAGE — кэш «1».
    """
    settings = doc.settings.element
    if settings.find(qn("w:updateFields")) is not None:
        return
    el = OxmlElement("w:updateFields")
    el.set(qn("w:val"), "true")
    anchor = None
    for child in settings:
        if child.tag.rsplit("}", 1)[-1] in _SETTINGS_AFTER_UPDATE_FIELDS:
            anchor = child
            break
    if anchor is not None:
        anchor.addprevious(el)
    else:
        settings.append(el)


def _disable_shift_return_expansion(doc) -> None:
    """Отключает раздувание строк с мягким переносом под «по ширине»
    (`<w:doNotExpandShiftReturn/>` в `<w:compat>`).

    Enter в редакторе текстблоков превращается в `<w:br>` (мягкий перенос),
    поэтому абзац акта — это один `<w:p>` с несколькими строками. Без этой
    настройки Word силой растягивает КОРОТКУЮ такую строку на всю ширину
    абзаца, и единственная щель на ней (например стык «слово-якорь ↔ номер
    сноски») баллонит. Настройка касается ТОЛЬКО строк с явным переносом —
    естественно переносимый (word-wrap) текст остаётся выровненным по ширине.

    CT_Compat — фиксированная xsd:sequence: `doNotExpandShiftReturn` обязан идти
    ПОСЛЕ узкого набора более ранних булевых опций и ПЕРЕД всеми прочими
    (useFELayout, compatSetting, ...). Вставляем перед первым ребёнком, который
    по схеме идёт после нас — иначе settings.xml схемо-невалиден и строгие
    потребители (LibreOffice, валидаторы) могут отбросить весь part (#13).
    """
    settings = doc.settings.element
    compat = settings.find(qn("w:compat"))
    if compat is None:
        compat = OxmlElement("w:compat")
        settings.append(compat)
    if compat.find(qn("w:doNotExpandShiftReturn")) is not None:
        return
    el = OxmlElement("w:doNotExpandShiftReturn")
    anchor = None
    for child in compat:
        if child.tag.rsplit("}", 1)[-1] not in _COMPAT_BEFORE_SHIFT_RETURN:
            anchor = child
            break
    if anchor is not None:
        anchor.addprevious(el)
    else:
        compat.append(el)
