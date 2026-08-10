"""Builder обычных таблиц (metrics / risk / generic) из TableSchema."""
import re

from docx.document import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt

from app.domains.acts.formatters.docx.styles import (
    CENTERED_MERGED_HEADER_TEXTS,
    Borders,
    Fonts,
    Margins,
    Page,
    Palette,
    Sizes,
)
from app.domains.acts.schemas.act_content import TableGridSchema, TableSchema

# Рабочая ширина листа = ширина страницы − левое поле − правое поле (в твипах).
# Используется как основа пропорций колонок (w:gridCol). Сама таблица тянется
# на 100% колонки текста через w:tblW type="pct" w="5000" — как в эталоне.
USABLE_WIDTH_DXA = Page.width_twips - Margins.left - Margins.right  # 10346

# w:tblW в процентах: 5000 = 100% (единица измерения pct — 1/50 процента).
_TBLW_PCT_FULL = "5000"


def _normalize_text(text: str) -> str:
    """Нормализует текст ячейки: strip + схлопывание множественных пробелов."""
    return re.sub(r"\s+", " ", (text or "").strip())


def build_table(doc: Document, schema: TableGridSchema) -> None:
    """Создаёт docx-таблицу по сетке (учитывает colSpan / rowSpan).

    Принимает и TableSchema (таблица-узел дерева), и EmbeddedTableSchema
    (блок-таблица нарушения) — используется только сетка grid/colWidths.
    """
    rows = len(schema.grid)
    cols = len(schema.grid[0]) if rows else 0
    if rows == 0 or cols == 0:
        return

    table = doc.add_table(rows=rows, cols=cols)
    _apply_borders(table)
    _set_table_width(table, cols, schema.colWidths)

    for r, row in enumerate(schema.grid):
        for c, cell_schema in enumerate(row):
            if cell_schema.isSpanned:
                continue
            cell = table.rows[r].cells[c]
            if cell_schema.colSpan > 1 or cell_schema.rowSpan > 1:
                _merge_cells(table, r, c, cell_schema.colSpan, cell_schema.rowSpan)

            _fill_cell(
                cell, cell_schema.content,
                is_header=cell_schema.isHeader,
                col_span=cell_schema.colSpan,
            )

    apply_table_pagination(table, schema)


# Дети w:tblPr, которые по схеме идут ПОСЛЕ w:tblInd. tblInd надо вставлять
# перед первым из них, иначе порядок невалиден и Word ругается на содержимое.
_TBLPR_AFTER_IND = frozenset({
    "tblBorders", "tblShd", "tblLayout", "tblCellMar", "tblLook",
    "tblCaption", "tblDescription",
})


def set_table_left_indent_zero(table) -> None:
    """Выставляет tblInd=0 — левая граница таблицы совпадает с полем страницы.

    Без явного tblInd Word сдвигает таблицу влево на величину поля ячейки
    (~108 твипов), и таблицы «вылезают» левее основного текста.
    """
    tbl_pr = table._tbl.tblPr
    ind = tbl_pr.find(qn("w:tblInd"))
    if ind is None:
        ind = OxmlElement("w:tblInd")
        anchor = None
        for child in tbl_pr:
            if child.tag.rsplit("}", 1)[-1] in _TBLPR_AFTER_IND:
                anchor = child
                break
        if anchor is not None:
            anchor.addprevious(ind)
        else:
            tbl_pr.append(ind)
    ind.set(qn("w:type"), "dxa")
    ind.set(qn("w:w"), "0")


def _compute_col_widths(cols: int, col_widths: list[int]) -> list[int]:
    """Распределяет USABLE_WIDTH_DXA по колонкам пропорционально col_widths.

    Если col_widths пуст или сумма ≤ 0 — делит поровну. Остаток от округления
    добавляется к последней колонке, чтобы сумма строго равнялась USABLE.
    """
    if not col_widths or len(col_widths) != cols or sum(col_widths) <= 0:
        base = USABLE_WIDTH_DXA // cols
        widths = [base] * cols
    else:
        total = sum(col_widths)
        widths = [round(USABLE_WIDTH_DXA * w / total) for w in col_widths]
    # Подгоняем сумму строго к USABLE: корректируем последнюю колонку.
    widths[-1] += USABLE_WIDTH_DXA - sum(widths)
    return widths


def _set_table_width(table, cols: int, col_widths: list[int]) -> None:
    """Задаёт ширину таблицы на 100% колонки текста и раскладку колонок — как в эталоне.

    Эталон НЕ задаёт w:tblInd и ставит w:tblW type="pct" w="5000" (=100%):
    тогда левая И правая границы таблицы совпадают с краями текста. Наш прежний
    вариант (tblInd=0 + dxa) сдвигал таблицу влево на поле ячейки (~108 тв).
    Раскладка fixed + явные w:gridCol/w:tcW — чтобы Word не пересчитывал колонки.
    """
    widths = _compute_col_widths(cols, col_widths)

    tbl_pr = table._tbl.tblPr
    # tblInd убираем: при pct=100% он только смещал бы таблицу от края текста.
    ind = tbl_pr.find(qn("w:tblInd"))
    if ind is not None:
        tbl_pr.remove(ind)
    tbl_w = tbl_pr.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.insert(0, tbl_w)  # tblW — первый среди детей ширины
    tbl_w.set(qn("w:type"), "pct")
    tbl_w.set(qn("w:w"), _TBLW_PCT_FULL)

    tbl_layout = tbl_pr.find(qn("w:tblLayout"))
    if tbl_layout is None:
        tbl_layout = OxmlElement("w:tblLayout")
        tbl_pr.append(tbl_layout)
    tbl_layout.set(qn("w:type"), "fixed")

    # tblGrid: явные ширины колонок.
    grid = table._tbl.find(qn("w:tblGrid"))
    if grid is not None:
        for col_el, w in zip(grid.findall(qn("w:gridCol")), widths):
            col_el.set(qn("w:w"), str(w))

    # tcW на каждой ячейке — фиксирует ширину независимо от объединений.
    for row in table.rows:
        for c, cell in enumerate(row.cells):
            if c >= cols:
                continue
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.find(qn("w:tcW"))
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                tc_pr.append(tc_w)
            tc_w.set(qn("w:type"), "dxa")
            tc_w.set(qn("w:w"), str(widths[c]))


def _apply_borders(table) -> None:
    tbl_pr = table._element.find(qn("w:tblPr"))
    borders = OxmlElement("w:tblBorders")
    for tag in ("top", "left", "bottom", "right", "insideH", "insideV"):
        b = OxmlElement(f"w:{tag}")
        b.set(qn("w:val"), Borders.table_default["val"])
        b.set(qn("w:sz"), str(Borders.table_default["sz"]))  # 4 × 1/8pt = 0.5pt
        b.set(qn("w:color"), Palette.table_border)
        borders.append(b)
    tbl_pr.append(borders)


def _merge_cells(table, r, c, col_span: int, row_span: int) -> None:
    # Зажимаем конец объединения в границы матрицы: схема уже отбраковывает
    # выходящие за пределы span'ы (TableSchema.validate_structure), но это
    # defense-in-depth — битый span никогда не должен ронять builder IndexError'ом.
    end_r = min(r + row_span - 1, len(table.rows) - 1)
    end_c = min(c + col_span - 1, len(table.rows[r].cells) - 1)
    start_cell = table.rows[r].cells[c]
    end_cell = table.rows[end_r].cells[end_c]
    start_cell.merge(end_cell)


def _fill_cell(cell, text: str, *, is_header: bool, col_span: int = 1) -> None:
    if is_header:
        _set_cell_shade(cell, Palette.table_header_shade)
    # Выравнивание: по высоте всегда по центру. По ширине — объединённые по
    # горизонтали ячейки (colSpan>1) прижимаются влево (явный LEFT, не JUSTIFY —
    # чтобы предпросмотр совпадал с .docx WYSIWYG), одиночные — по центру.
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    para = cell.paragraphs[0]
    # Исключение: шапки из CENTERED_MERGED_HEADER_TEXTS (например «Количество
    # клиентов / элементов, ед.») всегда по центру, даже когда склеены по
    # горизонтали (встречается в шапках риск-таблиц). Конфиг — в styles.py.
    if col_span > 1 and _normalize_text(text) not in CENTERED_MERGED_HEADER_TEXTS:
        para.alignment = WD_ALIGN_PARAGRAPH.LEFT
    else:
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    # Удаляем все существующие runs из XML-параграфа перед добавлением своего
    for r_el in para._p.findall(qn("w:r")):
        para._p.remove(r_el)
    size = Sizes.table_header_pt if is_header else Sizes.table_data_pt
    run = para.add_run(text or "")
    run.font.name = Fonts.main
    run.font.size = Pt(size)
    run.bold = is_header
    # Размер метки абзаца — чтобы и пустые ячейки имели кегль 9pt, а не 12pt.
    _set_mark_size(para, size)


def _set_mark_size(paragraph, size_pt: int) -> None:
    """Задаёт размер метки абзаца (управляет кеглем пустой ячейки)."""
    p_pr = paragraph._p.get_or_add_pPr()
    r_pr = p_pr.find(qn("w:rPr"))
    if r_pr is None:
        r_pr = OxmlElement("w:rPr")
        p_pr.append(r_pr)
    for tag in ("w:sz", "w:szCs"):
        el = OxmlElement(tag)
        el.set(qn("w:val"), str(size_pt * 2))
        r_pr.append(el)


def _set_cell_shade(cell, fill_hex: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill_hex)
    tc_pr.append(shd)


def _set_row_flag(row, tag: str) -> None:
    """Идемпотентно добавляет флаг строки в trPr (tag: 'w:cantSplit' | 'w:tblHeader')."""
    tr_pr = row._tr.get_or_add_trPr()
    if tr_pr.find(qn(tag)) is None:
        tr_pr.append(OxmlElement(tag))


def _header_row_count(schema: TableSchema) -> int:
    """Число ведущих (подряд от строки 0) строк, в которых есть ячейка isHeader.

    Шапка может быть многострочной. Считаем подряд идущие сверху строки, пока
    в строке встречается хотя бы одна заголовочная ячейка; первая строка без
    заголовков обрывает счёт (строки шапки в OOXML должны идти подряд от первой).
    """
    count = 0
    for row in schema.grid:
        if any(cell.isHeader for cell in row):
            count += 1
        else:
            break
    return count


def apply_table_pagination(table, schema: TableSchema) -> None:
    """Управляет переносами таблицы штатными свойствами OOXML.

    - cantSplit на КАЖДУЮ строку — строка не делится между страницами (4.x);
    - tblHeader на строки шапки — шапка повторяется на каждой странице (4.4);
    - keepNext (keep_with_next) на абзацы ячеек шапки — строки шапки и первая
      строка данных не отрываются друг от друга (4.2, 4.3).
    """
    header_rows = _header_row_count(schema)
    for idx, row in enumerate(table.rows):
        _set_row_flag(row, "w:cantSplit")
        if idx < header_rows:
            _set_row_flag(row, "w:tblHeader")
            for cell in row.cells:
                for para in cell.paragraphs:
                    para.paragraph_format.keep_with_next = True
