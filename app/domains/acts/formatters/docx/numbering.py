"""Регистрация multilevel-рубрикатора и нумераций списков через oxml.

Рубрикатор — один abstractNum + один num на весь документ, без lvlOverride.
Используется и плашками-таблицами, и параграфами после них.
Подробности: docs/superpowers/specs/numbering-pattern.md

Списки rich-HTML — отдельная связка: один abstractNum на ТИП (ul/ol) за
документ, но свой w:num на КАЖДЫЙ элемент <ul>/<ol>. Отсюда изоляция:
соседние списки не видят друг друга, каждый стартует с 1, вложенный
считает независимо. Геометрия уровней списков сознательно отличается от
рубрикаторной (ненулевой w:ind, lvlText без накопления) — см.
ensure_list_abstract.
"""
from docx.document import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

_MARKER_ATTR = "actsDocxRubricator"  # маркер для идемпотентности

# Маркеры идемпотентности для abstractNum списков. Вешаются на сам
# w:abstractNum, а не на w:num (как у рубрикатора): нумераций теперь много,
# а abstract — ровно по одному на тип списка.
_LIST_MARKER_ATTRS = {"ul": "actsDocxListUl", "ol": "actsDocxListOl"}

# Маркеры уровней «как в Word» (C1), цикл по 3 уровням.
_UL_BULLETS = ("•", "◦", "▪")
_OL_FORMATS = ("decimal", "lowerLetter", "lowerRoman")
_OL_SUFFIXES = (".", ")", ".")

# Геометрия отступа пункта: ступенька на уровень + выступ под маркер (twips).
_LIST_INDENT_STEP = 720
_LIST_HANGING = 360


def ensure_rubricator(doc: Document) -> int:
    """Регистрирует рубрикатор (или возвращает существующий num_id).

    Идемпотентно. Безопасно вызывать многократно.
    """
    numbering_part = doc.part.numbering_part
    root = numbering_part.element

    # Идемпотентность через маркер.
    for existing_num in root.findall(qn("w:num")):
        if existing_num.get(_MARKER_ATTR) == "1":
            return int(existing_num.get(qn("w:numId")))

    abstract_id = _next_id(root, qn("w:abstractNum"), qn("w:abstractNumId"))
    num_id = _next_id(root, qn("w:num"), qn("w:numId"))

    num = _build_num(num_id, abstract_id)
    num.set(_MARKER_ATTR, "1")

    _insert_abstract_num(root, _build_abstract_num(abstract_id))
    _insert_num(root, num)

    return num_id


def ensure_list_abstract(doc: Document, kind: str) -> int:
    """Регистрирует abstractNum для списков типа kind ('ul'/'ol').

    Идемпотентно: за документ создаётся ровно один abstract на тип,
    повторный вызов возвращает уже существующий abstractNumId.
    """
    root = doc.part.numbering_part.element
    marker = _LIST_MARKER_ATTRS[kind]

    for existing in root.findall(qn("w:abstractNum")):
        if existing.get(marker) == "1":
            return int(existing.get(qn("w:abstractNumId")))

    abstract_id = _next_id(root, qn("w:abstractNum"), qn("w:abstractNumId"))
    abstract = _build_list_abstract_num(abstract_id, kind)
    abstract.set(marker, "1")
    _insert_abstract_num(root, abstract)
    return abstract_id


def create_list_num(doc: Document, kind: str) -> int:
    """Заводит НОВУЮ нумерацию для одного элемента <ul>/<ol>.

    Свежий w:num на каждый вызов — именно здесь рождается изоляция списков:
    два соседних <ol> получают разные numId и каждый стартует с 1. Abstract
    при этом общий на тип (ensure_list_abstract).
    """
    root = doc.part.numbering_part.element
    abstract_id = ensure_list_abstract(doc, kind)
    num_id = _next_id(root, qn("w:num"), qn("w:numId"))
    _insert_num(root, _build_num(num_id, abstract_id))
    return num_id


def apply_numbering(paragraph, num_id: int, ilvl: int) -> None:
    """Привязывает параграф к рубрикатору на нужном уровне.

    Безопасно для параграфов внутри ячеек таблиц — Word сохраняет
    сквозную нумерацию вне зависимости от tbl-границ.
    """
    p_pr = paragraph._p.get_or_add_pPr()
    # Снести предыдущий numPr если был, чтобы не плодить дубли.
    for old in p_pr.findall(qn("w:numPr")):
        p_pr.remove(old)
    num_pr = OxmlElement("w:numPr")
    ilvl_el = OxmlElement("w:ilvl")
    ilvl_el.set(qn("w:val"), str(ilvl))
    num_id_el = OxmlElement("w:numId")
    num_id_el.set(qn("w:val"), str(num_id))
    num_pr.append(ilvl_el)
    num_pr.append(num_id_el)
    p_pr.append(num_pr)


# ---------------------------------------------------------------------------
# Внутренние хелперы
# ---------------------------------------------------------------------------

def _next_id(root, tag: str, id_attr: str) -> int:
    existing = [int(el.get(id_attr)) for el in root.findall(tag) if el.get(id_attr)]
    return (max(existing) + 1) if existing else 1


def _insert_abstract_num(root, abstract: OxmlElement) -> None:
    """Вставляет abstractNum после последнего существующего.

    Половина инварианта «все w:abstractNum строго ДО всех w:num» (иначе Word
    считает файл повреждённым); вторая половина — _insert_num. Единственная
    точка соблюдения инварианта: и рубрикатор, и списки идут через неё.
    """
    existing = root.findall(qn("w:abstractNum"))
    if existing:
        existing[-1].addnext(abstract)
    else:
        root.insert(0, abstract)


def _insert_num(root, num: OxmlElement) -> None:
    """Вставляет num перед первым существующим — см. _insert_abstract_num."""
    first_num = root.find(qn("w:num"))
    if first_num is not None:
        first_num.addprevious(num)
    else:
        root.append(num)


def _build_abstract_num(abstract_id: int) -> OxmlElement:
    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), str(abstract_id))

    mlt = OxmlElement("w:multiLevelType")
    mlt.set(qn("w:val"), "multilevel")
    abstract.append(mlt)

    for ilvl in range(9):
        abstract.append(_build_level(ilvl))

    return abstract


def _build_level(ilvl: int) -> OxmlElement:
    lvl = OxmlElement("w:lvl")
    lvl.set(qn("w:ilvl"), str(ilvl))

    start = OxmlElement("w:start")
    start.set(qn("w:val"), "1")
    lvl.append(start)

    fmt = OxmlElement("w:numFmt")
    fmt.set(qn("w:val"), "decimal")
    lvl.append(fmt)

    # Порядок дочерних w:lvl по схеме: start, numFmt, [suff], lvlText, lvlJc, pPr.
    if ilvl >= 1:
        # Текст идёт сразу после номера (через пробел), а не по табстопу.
        suff = OxmlElement("w:suff")
        suff.set(qn("w:val"), "space")
        lvl.append(suff)

    lvl_text = OxmlElement("w:lvlText")
    lvl_text.set(qn("w:val"), ".".join(f"%{i + 1}" for i in range(ilvl + 1)) + ".")
    lvl.append(lvl_text)

    # ilvl=0 — номер рубрикатора в узкой ячейке плашки, прижат вправо (к заголовку).
    # ilvl>=1 — номера пунктов прижаты к ЛЕВОМУ краю и нарастают вправо: «5.»
    # стоит у поля, «5.1.1.» — длиннее, но левый край номера всегда на поле.
    lvl_jc = OxmlElement("w:lvlJc")
    lvl_jc.set(qn("w:val"), "right" if ilvl == 0 else "left")
    lvl.append(lvl_jc)

    p_pr = OxmlElement("w:pPr")
    ind = OxmlElement("w:ind")
    # Все уровни прижаты к левому краю (left=0, firstLine=0): за левое поле
    # ничего не выходит, абзац не сдвигается вправо при углублении.
    ind.set(qn("w:left"), "0")
    ind.set(qn("w:firstLine"), "0")
    p_pr.append(ind)
    lvl.append(p_pr)

    return lvl


def _build_list_abstract_num(abstract_id: int, kind: str) -> OxmlElement:
    abstract = OxmlElement("w:abstractNum")
    abstract.set(qn("w:abstractNumId"), str(abstract_id))

    mlt = OxmlElement("w:multiLevelType")
    mlt.set(qn("w:val"), "multilevel")
    abstract.append(mlt)

    for ilvl in range(9):
        abstract.append(_build_list_level(ilvl, kind))

    return abstract


def _build_list_level(ilvl: int, kind: str) -> OxmlElement:
    """Уровень списка. Геометрия НЕ рубрикаторная — расхождение намеренное.

    Отличий два. Первое: lvlText берёт только счётчик ТЕКУЩЕГО уровня
    («%2.», а не «%1.%2.») — каждый уровень считает независимо (C1). Второе:
    w:ind с ненулевым left — без него ступенька вложенности в Word не видна
    (у рубрикатора left=0, и «гармонизировать» их нельзя).
    """
    lvl = OxmlElement("w:lvl")
    lvl.set(qn("w:ilvl"), str(ilvl))

    start = OxmlElement("w:start")
    start.set(qn("w:val"), "1")
    lvl.append(start)

    fmt = OxmlElement("w:numFmt")
    fmt.set(qn("w:val"), "bullet" if kind == "ul" else _OL_FORMATS[ilvl % 3])
    lvl.append(fmt)

    lvl_text = OxmlElement("w:lvlText")
    if kind == "ul":
        lvl_text.set(qn("w:val"), _UL_BULLETS[ilvl % 3])
    else:
        lvl_text.set(qn("w:val"), f"%{ilvl + 1}{_OL_SUFFIXES[ilvl % 3]}")
    lvl.append(lvl_text)

    lvl_jc = OxmlElement("w:lvlJc")
    lvl_jc.set(qn("w:val"), "left")
    lvl.append(lvl_jc)

    p_pr = OxmlElement("w:pPr")
    ind = OxmlElement("w:ind")
    ind.set(qn("w:left"), str(_LIST_INDENT_STEP * (ilvl + 1)))
    ind.set(qn("w:hanging"), str(_LIST_HANGING))
    p_pr.append(ind)
    lvl.append(p_pr)

    return lvl


def _build_num(num_id: int, abstract_id: int) -> OxmlElement:
    num = OxmlElement("w:num")
    num.set(qn("w:numId"), str(num_id))

    ref = OxmlElement("w:abstractNumId")
    ref.set(qn("w:val"), str(abstract_id))
    num.append(ref)

    return num
