"""Export-parity golden-тест (Б-2.3) + сверка нумерации DOCX (Б-2.4).

Политика: проверяется ПОЛНОТА ДАННЫХ (presence маркеров фикстуры в выводе
каждого формата), НЕ байтовое равенство и НЕ равенство подписей-ярлыков
(решение Д.3: подписи в форматах различаются осознанно).

Вызов форматтеров повторяет ExportService.save_act:
- DOCX: DocxFormatter().format(ExportContext(metadata, content));
- MD/TXT: formatter.format(content.model_dump(mode='python') + metadata).

Известные потери данных зафиксированы xfail(strict=True) — починка потери
переведёт тест в XPASS и потребует снять xfail (фикс задокументирован).
Рефактор форматтеров (walker) без зелёного golden — запрещён (Б-2.3),
см. README.md в этом пакете.
"""
import pytest
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.oxml.ns import qn

from app.domains.acts.formatters.docx import DocxFormatter, ExportContext
from app.domains.acts.formatters.docx.numbering import ensure_rubricator
from app.domains.acts.formatters.markdown_formatter import MarkdownFormatter
from app.domains.acts.formatters.text_formatter import TextFormatter
from app.domains.acts.settings import ActsSettings

from tests.domains.acts.golden.fixture_act import (
    GOLDEN_IMAGES,
    LABELS_NEVER_RENDERED,
    MARKER_ATTACHED_TBL_CELL,
    MARKER_FOOTNOTE_TEXT,
    MARKER_IMG_FILENAME,
    MARKER_LINK_URL,
    MARKERS_ALL_FORMATS,
    build_golden_act,
    build_golden_act_dict,
    build_golden_metadata,
    expected_item_numbers,
)


# ---------------------------------------------------------------------------
# Сборка выводов (по одному разу на сессию — форматтеры детерминированы)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def golden_content():
    return build_golden_act()


@pytest.fixture(scope="module")
def golden_docx(golden_content):
    """Document, собранный тем же путём, что ExportService (fmt='docx')."""
    ctx = ExportContext(
        metadata=build_golden_metadata(),
        content=golden_content,
        images=GOLDEN_IMAGES,
    )
    return DocxFormatter(settings=None, acts_settings=ActsSettings()).format(ctx)


def _data_dict(content) -> dict:
    """Повторяет подготовку данных ExportService для txt/md."""
    data = content.model_dump(mode="python")
    data["metadata"] = build_golden_metadata().model_dump(mode="python")
    data["images"] = GOLDEN_IMAGES
    return data


@pytest.fixture(scope="module")
def golden_md(golden_content) -> str:
    return MarkdownFormatter(
        settings=None, acts_settings=ActsSettings()
    ).format(_data_dict(golden_content))


@pytest.fixture(scope="module")
def golden_txt(golden_content) -> str:
    return TextFormatter(
        settings=None, acts_settings=ActsSettings()
    ).format(_data_dict(golden_content))


def _docx_body_text(doc) -> str:
    """Весь текст body: параграфы, таблицы, runs внутри w:hyperlink."""
    return "".join(t.text or "" for t in doc.element.body.iter(qn("w:t")))


def _docx_footnotes_text(doc) -> str:
    """Текст footnotes-части (native сноски Word); '' — если части нет."""
    try:
        part = doc.part.part_related_by(RELATIONSHIP_TYPE.FOOTNOTES)
    except KeyError:
        return ""
    return "".join(t.text or "" for t in part._element.iter(qn("w:t")))


def _missing(markers: list[str], output: str) -> list[str]:
    return [m for m in markers if m not in output]


# ---------------------------------------------------------------------------
# Базовая гарантия: фикстура валидна по строгой схеме
# ---------------------------------------------------------------------------

def test_fixture_passes_strict_schema():
    """Эталон проходит ActDataSchema (extra='forbid', кросс-валидатор ссылок)."""
    content = build_golden_act()
    assert len(content.tables) == 9
    assert len(content.textBlocks) == 1
    assert len(content.violations) == 1


# ---------------------------------------------------------------------------
# Полнота данных: каждый маркер фикстуры присутствует в выводе формата
# ---------------------------------------------------------------------------

def test_docx_contains_all_markers(golden_docx):
    missing = _missing(MARKERS_ALL_FORMATS, _docx_body_text(golden_docx))
    assert missing == [], f"DOCX потерял маркеры: {missing}"


def test_md_contains_all_markers(golden_md):
    # Плюс маркеры, для которых текстовые форматы — единственный носитель:
    # содержимое таблицы item-узла и плейсхолдер картинки с именем файла.
    markers = MARKERS_ALL_FORMATS + [MARKER_ATTACHED_TBL_CELL, MARKER_IMG_FILENAME]
    missing = _missing(markers, golden_md)
    assert missing == [], f"MD потерял маркеры: {missing}"


def test_txt_contains_all_markers(golden_txt):
    markers = MARKERS_ALL_FORMATS + [MARKER_ATTACHED_TBL_CELL, MARKER_IMG_FILENAME]
    missing = _missing(markers, golden_txt)
    assert missing == [], f"TXT потерял маркеры: {missing}"


def test_no_format_renders_unlabeled_field_labels(golden_docx, golden_md, golden_txt):
    """Поля с labeled=False выводятся без заголовка во всех трёх форматах.

    Их контент при этом обязан доезжать (маркеры GOLDEN_V_CM_*/PM/FREETEXT
    входят в MARKERS_ALL_FORMATS) — проверяется presence-тестами выше.
    """
    outputs = {
        "docx": _docx_body_text(golden_docx),
        "md": golden_md,
        "txt": golden_txt,
    }
    for fmt, output in outputs.items():
        present = [label for label in LABELS_NEVER_RENDERED if label in output]
        assert present == [], f"{fmt}: выведены лишние метки полей: {present}"


# ---------------------------------------------------------------------------
# DOCX-специфичные носители данных: inline shape, hyperlink rel, footnote
# ---------------------------------------------------------------------------

def test_docx_violation_image_embedded_as_inline_shape(golden_docx):
    """Картинка нарушения встроена как inline shape (не плейсхолдер)."""
    assert len(golden_docx.inline_shapes) >= 1
    # Плейсхолдер «Изображение: …» не должен появляться при успешном встраивании.
    assert f"Изображение: {MARKER_IMG_FILENAME}" not in _docx_body_text(golden_docx)


def test_docx_link_url_preserved_in_relationships(golden_docx):
    """URL ссылки текстблока (data-link-url) сохранён как hyperlink relationship."""
    targets = [
        rel.target_ref
        for rel in golden_docx.part.rels.values()
        if rel.reltype == RELATIONSHIP_TYPE.HYPERLINK
    ]
    assert any(MARKER_LINK_URL in t for t in targets), (
        f"hyperlink с {MARKER_LINK_URL} не найден среди relationships: {targets}"
    )


def test_docx_footnote_text_preserved(golden_docx):
    """Текст сноски (data-footnote-text) попал в footnotes-часть документа."""
    assert MARKER_FOOTNOTE_TEXT in _docx_footnotes_text(golden_docx)


# ---------------------------------------------------------------------------
# Бывшие известные потери данных (зафиксированы xfail strict, починены
# веткой export-tree-walker — теперь обычные регрессионные ассерты)
# ---------------------------------------------------------------------------

def test_docx_item_node_attached_table_rendered(golden_docx):
    """Узел type='item' с tableId: DOCX рендерит и пункт, и таблицу (как MD/TXT)."""
    assert MARKER_ATTACHED_TBL_CELL in _docx_body_text(golden_docx)


def test_md_link_url_preserved(golden_md):
    """URL ссылки текстблока (data-link-url) выводится в MD как [текст](url)."""
    assert MARKER_LINK_URL in golden_md


def test_txt_link_url_preserved(golden_txt):
    """URL ссылки текстблока (data-link-url) выводится в TXT как «текст (url)»."""
    assert MARKER_LINK_URL in golden_txt


def test_md_footnote_text_preserved(golden_md):
    """Текст сноски (data-footnote-text) выводится в MD inline: «(сноска: …)»."""
    assert MARKER_FOOTNOTE_TEXT in golden_md


def test_txt_footnote_text_preserved(golden_txt):
    """Текст сноски (data-footnote-text) выводится в TXT inline: «(сноска: …)»."""
    assert MARKER_FOOTNOTE_TEXT in golden_txt


# ---------------------------------------------------------------------------
# Б-2.4: сверка Word-нумерации DOCX с node.number фикстуры
# ---------------------------------------------------------------------------

def _simulate_word_numbering(doc) -> list[str]:
    """Симулирует multilevel-нумерацию Word для параграфов рубрикатора.

    Literal-номеров в Word XML нет: Word считает их при открытии. Правила
    multilevel: счётчик на каждый уровень, инкремент при параграфе своего
    уровня, сброс всех более глубоких. Уровни start=1, формат decimal —
    как в numbering.ensure_rubricator.

    Возвращает последовательность вычисленных номеров («1», «1.1», …)
    в порядке следования параграфов body (включая параграфы внутри
    таблиц-плашек — lxml iter обходит документ в document order).
    """
    num_id = ensure_rubricator(doc)  # идемпотентен: вернёт существующий id
    counters = [0] * 9
    numbers: list[str] = []
    for p in doc.element.body.iter(qn("w:p")):
        p_pr = p.find(qn("w:pPr"))
        if p_pr is None:
            continue
        num_pr = p_pr.find(qn("w:numPr"))
        if num_pr is None:
            continue
        num_id_el = num_pr.find(qn("w:numId"))
        if num_id_el is None or num_id_el.get(qn("w:val")) != str(num_id):
            continue
        ilvl_el = num_pr.find(qn("w:ilvl"))
        ilvl = int(ilvl_el.get(qn("w:val"))) if ilvl_el is not None else 0
        counters[ilvl] += 1
        for deeper in range(ilvl + 1, len(counters)):
            counters[deeper] = 0
        numbers.append(".".join(str(counters[i]) for i in range(ilvl + 1)))
    return numbers


def test_docx_numbering_matches_node_numbers(golden_docx):
    """Б-2.4: авто-нумерация Word совпадает с node.number структурных узлов.

    Сверка по узлам type='item' (DFS-порядок дерева = document order DOCX);
    узлы таблиц/текстблоков/нарушений в DOCX сознательно не нумеруются и
    в node.number несут нечисловые метки («Таблица 1») — они вне сверки.
    """
    expected = expected_item_numbers()
    actual = _simulate_word_numbering(golden_docx)
    assert actual == expected, (
        f"Нумерация DOCX разошлась с node.number: ожидалось {expected}, "
        f"получено {actual}"
    )


def test_expected_numbers_cover_fixture_depth():
    """Самопроверка фикстуры: 4 уровня вложенности и пункт после таблиц."""
    expected = expected_item_numbers()
    assert "1.1.1.1" in expected  # 4-й уровень
    assert expected == ["1", "1.1", "1.1.1", "1.1.1.1", "1.2", "2", "2.1"]


def test_fixture_dict_and_schema_roundtrip_consistent():
    """model_dump после валидации сохраняет маркеры дерева (нормализация C4)."""
    dumped_tree = build_golden_act().model_dump(mode="python")["tree"]
    raw_tree = build_golden_act_dict()["tree"]

    def labels(node):
        out = [node.get("label") or ""]
        for ch in node.get("children", []):
            out.extend(labels(ch))
        return out

    assert labels(dumped_tree) == labels(raw_tree)
