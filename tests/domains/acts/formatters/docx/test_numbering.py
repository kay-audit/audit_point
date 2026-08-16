"""Тесты регистрации рубрикатора и нумераций списков через oxml."""
import pytest
from docx import Document
from docx.oxml.ns import qn

from app.domains.acts.formatters.docx.numbering import (
    create_list_num,
    ensure_list_abstract,
    ensure_rubricator,
)


def test_ensure_rubricator_returns_int_num_id(doc):
    num_id = ensure_rubricator(doc)
    assert isinstance(num_id, int)
    assert num_id >= 1


def test_ensure_rubricator_creates_abstract_num_with_9_levels(doc):
    """Один новый abstractNum добавляется, и он содержит ровно 9 уровней."""
    baseline = len(doc.part.numbering_part.element.findall(qn("w:abstractNum")))
    ensure_rubricator(doc)
    numbering_part = doc.part.numbering_part.element
    abstract = numbering_part.findall(qn("w:abstractNum"))
    # добавлен ровно один наш abstractNum
    assert len(abstract) == baseline + 1
    # наш — последний (append-стратегия)
    our_abstract = abstract[-1]
    levels = our_abstract.findall(qn("w:lvl"))
    assert len(levels) == 9


def test_abstract_num_uses_multilevel_not_hybrid(doc):
    """multiLevelType=multilevel; hybrid сбросил бы счёт уровня 0."""
    ensure_rubricator(doc)
    numbering_part = doc.part.numbering_part.element
    abstract = numbering_part.findall(qn("w:abstractNum"))[-1]
    mlt = abstract.find(qn("w:multiLevelType"))
    assert mlt.get(qn("w:val")) == "multilevel"


def test_level_text_format(doc):
    """lvl0=%1., lvl1=%1.%2., lvl2=%1.%2.%3., ..."""
    ensure_rubricator(doc)
    numbering_part = doc.part.numbering_part.element
    abstract = numbering_part.findall(qn("w:abstractNum"))[-1]
    levels = abstract.findall(qn("w:lvl"))
    expected = [f"{'.'.join(f'%{i + 1}' for i in range(n + 1))}." for n in range(9)]
    actual = [lvl.find(qn("w:lvlText")).get(qn("w:val")) for lvl in levels]
    assert actual == expected


def test_no_lvl_override(doc):
    """Никаких lvlOverride — счёт продолжается без сбросов."""
    ensure_rubricator(doc)
    num = doc.part.numbering_part.element.findall(qn("w:num"))[-1]
    assert num.find(qn("w:lvlOverride")) is None


def test_ensure_rubricator_idempotent(doc):
    """Повторный вызов возвращает тот же num_id, без дубликатов."""
    baseline = len(doc.part.numbering_part.element.findall(qn("w:abstractNum")))
    num_id1 = ensure_rubricator(doc)
    num_id2 = ensure_rubricator(doc)
    assert num_id1 == num_id2
    abstracts = doc.part.numbering_part.element.findall(qn("w:abstractNum"))
    # добавлен ровно один, повтор не плодит дубли
    assert len(abstracts) == baseline + 1


def test_num_format_decimal_on_all_levels(doc):
    ensure_rubricator(doc)
    abstract = doc.part.numbering_part.element.findall(qn("w:abstractNum"))[-1]
    for lvl in abstract.findall(qn("w:lvl")):
        fmt = lvl.find(qn("w:numFmt"))
        assert fmt.get(qn("w:val")) == "decimal"


def test_all_levels_flush_left(doc):
    """Эталон: все уровни прижаты к левому краю (left=0, firstLine=0, без hanging)."""
    ensure_rubricator(doc)
    abstract = doc.part.numbering_part.element.findall(qn("w:abstractNum"))[-1]
    levels = abstract.findall(qn("w:lvl"))
    for ilvl, lvl in enumerate(levels):
        ind = lvl.find(qn("w:pPr")).find(qn("w:ind"))
        assert ind is not None, f"w:ind отсутствует для ilvl={ilvl}"
        assert ind.get(qn("w:left")) == "0", f"left должен быть 0 для ilvl={ilvl}"
        assert ind.get(qn("w:firstLine")) == "0", f"firstLine должен быть 0 для ilvl={ilvl}"
        assert ind.get(qn("w:hanging")) is None, f"hanging не должен задаваться для ilvl={ilvl}"


def test_level_alignment_rubricator_right_items_left(doc):
    """ilvl=0 (рубрикатор) — номер вправо; ilvl>=1 (пункты) — влево."""
    ensure_rubricator(doc)
    abstract = doc.part.numbering_part.element.findall(qn("w:abstractNum"))[-1]
    for ilvl, lvl in enumerate(abstract.findall(qn("w:lvl"))):
        jc = lvl.find(qn("w:lvlJc"))
        assert jc is not None, f"lvlJc отсутствует для ilvl={ilvl}"
        expected = "right" if ilvl == 0 else "left"
        assert jc.get(qn("w:val")) == expected, f"ilvl={ilvl} ожидался {expected}"


def test_item_levels_have_space_suffix(doc):
    """Пункты (ilvl>=1): текст идёт сразу после номера (w:suff=space)."""
    ensure_rubricator(doc)
    abstract = doc.part.numbering_part.element.findall(qn("w:abstractNum"))[-1]
    levels = abstract.findall(qn("w:lvl"))
    # ilvl=0 — без suff (рубрикатор), ilvl>=1 — suff=space
    assert levels[0].find(qn("w:suff")) is None
    for ilvl, lvl in enumerate(levels[1:], start=1):
        suff = lvl.find(qn("w:suff"))
        assert suff is not None, f"suff отсутствует для ilvl={ilvl}"
        assert suff.get(qn("w:val")) == "space"


def test_apply_numbering_attaches_numpr(doc):
    from app.domains.acts.formatters.docx.numbering import apply_numbering
    num_id = ensure_rubricator(doc)
    p = doc.add_paragraph()
    apply_numbering(p, num_id, ilvl=1)
    num_pr = p._p.find(qn("w:pPr")).find(qn("w:numPr"))
    assert num_pr is not None
    assert num_pr.find(qn("w:ilvl")).get(qn("w:val")) == "1"
    assert num_pr.find(qn("w:numId")).get(qn("w:val")) == str(num_id)


# ---------------------------------------------------------------------------
# Нумерации списков rich-HTML (<ul>/<ol>): один abstractNum на тип, свой num
# на каждый элемент списка. Геометрия СОЗНАТЕЛЬНО отличается от рубрикатора.
# ---------------------------------------------------------------------------

_UL_GLYPHS = ["•", "◦", "▪"]
_OL_FORMATS = ["decimal", "lowerLetter", "lowerRoman"]


def _abstract_by_id(doc, abstract_id: int):
    root = doc.part.numbering_part.element
    for abstract in root.findall(qn("w:abstractNum")):
        if int(abstract.get(qn("w:abstractNumId"))) == abstract_id:
            return abstract
    raise AssertionError(f"abstractNum {abstract_id} не найден")


def _num_by_id(doc, num_id: int):
    root = doc.part.numbering_part.element
    for num in root.findall(qn("w:num")):
        if int(num.get(qn("w:numId"))) == num_id:
            return num
    raise AssertionError(f"num {num_id} не найден")


@pytest.mark.parametrize("kind", ["ul", "ol"])
def test_ensure_list_abstract_idempotent(doc, kind):
    """Один abstractNum на тип за документ: повтор не плодит дублей."""
    baseline = len(doc.part.numbering_part.element.findall(qn("w:abstractNum")))
    first = ensure_list_abstract(doc, kind)
    second = ensure_list_abstract(doc, kind)
    assert first == second
    abstracts = doc.part.numbering_part.element.findall(qn("w:abstractNum"))
    assert len(abstracts) == baseline + 1


def test_ul_and_ol_abstracts_are_separate(doc):
    """Маркированный и нумерованный — разные abstractNum (разная геометрия)."""
    assert ensure_list_abstract(doc, "ul") != ensure_list_abstract(doc, "ol")


def test_list_abstract_does_not_reuse_rubricator(doc):
    """Рубрикатор и списки не делят abstractNum — у них разные уровни."""
    rubricator_num = ensure_rubricator(doc)
    rubricator_abstract = int(
        _num_by_id(doc, rubricator_num).find(qn("w:abstractNumId")).get(qn("w:val"))
    )
    assert ensure_list_abstract(doc, "ul") != rubricator_abstract
    assert ensure_list_abstract(doc, "ol") != rubricator_abstract


@pytest.mark.parametrize("kind", ["ul", "ol"])
def test_list_abstract_has_9_levels(doc, kind):
    abstract = _abstract_by_id(doc, ensure_list_abstract(doc, kind))
    assert len(abstract.findall(qn("w:lvl"))) == 9


@pytest.mark.parametrize("kind", ["ul", "ol"])
def test_list_levels_start_at_one(doc, kind):
    abstract = _abstract_by_id(doc, ensure_list_abstract(doc, kind))
    for lvl in abstract.findall(qn("w:lvl")):
        assert lvl.find(qn("w:start")).get(qn("w:val")) == "1"


def test_ul_levels_are_bullets_with_cycling_glyphs(doc):
    """Маркеры «как в Word» (C1): • ◦ ▪ с циклом по 3 уровням."""
    abstract = _abstract_by_id(doc, ensure_list_abstract(doc, "ul"))
    for ilvl, lvl in enumerate(abstract.findall(qn("w:lvl"))):
        assert lvl.find(qn("w:numFmt")).get(qn("w:val")) == "bullet"
        assert lvl.find(qn("w:lvlText")).get(qn("w:val")) == _UL_GLYPHS[ilvl % 3]


def test_ol_levels_cycle_number_formats(doc):
    """1. / a) / i. с циклом по 3 уровням (C1)."""
    abstract = _abstract_by_id(doc, ensure_list_abstract(doc, "ol"))
    for ilvl, lvl in enumerate(abstract.findall(qn("w:lvl"))):
        assert lvl.find(qn("w:numFmt")).get(qn("w:val")) == _OL_FORMATS[ilvl % 3]


def test_ol_lvl_text_uses_only_current_level(doc):
    """Счёт уровней независимый: lvlText НЕ накапливает %1.%2 как рубрикатор."""
    abstract = _abstract_by_id(doc, ensure_list_abstract(doc, "ol"))
    suffixes = [".", ")", "."]
    expected = [f"%{ilvl + 1}{suffixes[ilvl % 3]}" for ilvl in range(9)]
    actual = [
        lvl.find(qn("w:lvlText")).get(qn("w:val"))
        for lvl in abstract.findall(qn("w:lvl"))
    ]
    assert actual == expected


@pytest.mark.parametrize("kind", ["ul", "ol"])
def test_list_levels_indent_by_depth(doc, kind):
    """Ступенька вложенности: left = 720×(уровень+1), hanging = 360.

    Намеренное расхождение с рубрикатором (там left=0) — без отступа
    вложенность в Word не видна.
    """
    abstract = _abstract_by_id(doc, ensure_list_abstract(doc, kind))
    for ilvl, lvl in enumerate(abstract.findall(qn("w:lvl"))):
        ind = lvl.find(qn("w:pPr")).find(qn("w:ind"))
        assert ind.get(qn("w:left")) == str(720 * (ilvl + 1))
        assert ind.get(qn("w:hanging")) == "360"


@pytest.mark.parametrize("kind", ["ul", "ol"])
def test_list_levels_left_aligned(doc, kind):
    abstract = _abstract_by_id(doc, ensure_list_abstract(doc, kind))
    for lvl in abstract.findall(qn("w:lvl")):
        assert lvl.find(qn("w:lvlJc")).get(qn("w:val")) == "left"


def test_create_list_num_gives_fresh_id_each_call(doc):
    """Изоляция списков рождается здесь: свой w:num на каждый <ul>/<ol>."""
    ids = [create_list_num(doc, "ol") for _ in range(3)]
    assert len(set(ids)) == 3


def test_create_list_num_reuses_abstract_of_its_kind(doc):
    """Разные num одного типа ссылаются на ОДИН abstractNum."""
    baseline = len(doc.part.numbering_part.element.findall(qn("w:abstractNum")))
    first, second = create_list_num(doc, "ul"), create_list_num(doc, "ul")
    abstract_ids = {
        _num_by_id(doc, num_id).find(qn("w:abstractNumId")).get(qn("w:val"))
        for num_id in (first, second)
    }
    assert len(abstract_ids) == 1
    assert len(doc.part.numbering_part.element.findall(qn("w:abstractNum"))) == baseline + 1


def test_create_list_num_has_no_lvl_override(doc):
    """Без lvlOverride: сброс счёта обеспечивает отдельный num, а не override."""
    num_id = create_list_num(doc, "ol")
    assert _num_by_id(doc, num_id).find(qn("w:lvlOverride")) is None


def test_abstract_nums_precede_nums_after_list_registration(doc):
    """Инвариант OOXML: все w:abstractNum строго ДО всех w:num.

    Нарушение — Word объявляет файл повреждённым. Проверяем на смеси
    рубрикатора и нескольких списков обоих типов.
    """
    ensure_rubricator(doc)
    create_list_num(doc, "ul")
    create_list_num(doc, "ol")
    create_list_num(doc, "ul")
    root = doc.part.numbering_part.element
    tags = [
        child.tag.rsplit("}", 1)[-1]
        for child in root
        if child.tag.rsplit("}", 1)[-1] in ("abstractNum", "num")
    ]
    assert tags == sorted(tags, key=lambda t: 0 if t == "abstractNum" else 1)


def test_list_num_ids_do_not_collide_with_rubricator(doc):
    """num_id рубрикатора не переиспользуется списками (иначе общий счёт)."""
    rubricator = ensure_rubricator(doc)
    list_ids = [create_list_num(doc, "ul"), create_list_num(doc, "ol")]
    assert rubricator not in list_ids
    assert len(set(list_ids)) == 2


def test_ensure_rubricator_stays_idempotent_after_lists(doc):
    """Маркер рубрикатора на w:num не путается с нумерациями списков."""
    first = ensure_rubricator(doc)
    create_list_num(doc, "ul")
    create_list_num(doc, "ol")
    assert ensure_rubricator(doc) == first
