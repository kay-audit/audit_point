"""Страж №1: документные CSS-токены — зеркало питоновского эталона DOCX.

Документная секция `static/css/base/variables/typography.css`
(`--doc-font-size`, `--doc-font-size-small`, `--doc-line-height`,
`--doc-list-indent`) — РУЧНАЯ копия констант DOCX-экспорта
(`app/domains/acts/formatters/docx/styles.py` и `.../numbering.py`).
Импортировать Python в CSS нечем, поэтому разъезд ловится только здесь: пока
он не пойман, экран показывает не тот кегль и не ту втяжку, которые уйдут
в Word, — то есть предпросмотр врёт про печать.

Зона теста честно ограничена РАВЕНСТВОМ ЗНАЧЕНИЙ «CSS ↔ Python». Он не
проверяет, что токены кем-то потребляются и что мимо них не заведён литерал, —
это зона ratchet'а `tests/test_document_css_font_size_ratchet.py`.
"""

import pathlib
import re

from docx.enum.text import WD_LINE_SPACING

from app.domains.acts.formatters.docx import numbering
from app.domains.acts.formatters.docx.styles import Sizes, Spacing

TYPOGRAPHY_CSS = (
    pathlib.Path(__file__).resolve().parent.parent
    / "static"
    / "css"
    / "base"
    / "variables"
    / "typography.css"
)

# Межстрочный интервал документа: 1.15 — НЕ вычисляемая величина, а константа.
# В Word «одинарный» задан как w:line=240/lineRule=auto (Spacing.line_single),
# то есть множитель 1.0 к КЕГЛЮ ПЛЮС естественный межстрочный зазор гарнитуры;
# у Times New Roman этот зазор даёт на экране ~1.15. Арифметически из
# WD_LINE_SPACING.SINGLE это число не выводится, поэтому здесь оно прибито
# гвоздём, а тест сторожит две вещи: что число в CSS не уехало и что питоновская
# сторона по-прежнему просит у Word именно «одинарный», а не кратный интервал.
EXPECTED_LINE_HEIGHT = "1.15"

# Твипы на пункт: 1pt = 20 twips (единица w:ind в OOXML).
TWIPS_PER_PT = 20


def _read_tokens() -> dict[str, str]:
    """Достаёт значения всех `--doc-*` токенов из typography.css."""
    css = TYPOGRAPHY_CSS.read_text(encoding="utf-8")
    # Комментарии документной секции сами содержат имена токенов и числа —
    # вырезаем их, чтобы regex не подцепил пример из текста.
    css = re.sub(r"/\*.*?\*/", " ", css, flags=re.S)
    return {
        name: value.strip()
        for name, value in re.findall(r"(--doc-[a-z-]+)\s*:\s*([^;]+);", css)
    }


def _pt(value: str) -> float:
    """Число из значения в пунктах; падает внятно, если единица не pt."""
    match = re.fullmatch(r"(\d+(?:\.\d+)?)pt", value)
    assert match, f"ожидалось значение в пунктах, получено {value!r}"
    return float(match.group(1))


def test_doc_font_size_matches_docx_body_size() -> None:
    """--doc-font-size == Sizes.body_pt (тело акта)."""
    tokens = _read_tokens()
    assert "--doc-font-size" in tokens, (
        "токен --doc-font-size пропал из static/css/base/variables/typography.css"
    )
    assert _pt(tokens["--doc-font-size"]) == float(Sizes.body_pt), (
        f"кегль тела разъехался: CSS --doc-font-size = {tokens['--doc-font-size']}, "
        f"DOCX Sizes.body_pt = {Sizes.body_pt}pt "
        "(app/domains/acts/formatters/docx/styles.py)"
    )


def test_doc_font_size_small_matches_docx_table_size() -> None:
    """--doc-font-size-small == Sizes.table_data_pt (мелкий кегль документа)."""
    tokens = _read_tokens()
    assert "--doc-font-size-small" in tokens, (
        "токен --doc-font-size-small пропал из "
        "static/css/base/variables/typography.css"
    )
    assert _pt(tokens["--doc-font-size-small"]) == float(Sizes.table_data_pt), (
        f"мелкий кегль разъехался: CSS --doc-font-size-small = "
        f"{tokens['--doc-font-size-small']}, DOCX Sizes.table_data_pt = "
        f"{Sizes.table_data_pt}pt (app/domains/acts/formatters/docx/styles.py)"
    )


def test_docx_small_sizes_are_one_number() -> None:
    """Четыре «мелкие» сущности DOCX держат ОДИН кегль.

    CSS-сторона у них одна (`--doc-font-size-small`), поэтому расхождение любой
    из них с `table_data_pt` означает, что одним токеном их больше не описать —
    и на экране одна из сущностей поедет молча.
    """
    same = {
        "table_data_pt": Sizes.table_data_pt,
        "table_header_pt": Sizes.table_header_pt,
        "violation_pt": Sizes.violation_pt,
        "footnote_pt": Sizes.footnote_pt,
    }
    assert len(set(same.values())) == 1, (
        "«мелкие» размеры DOCX разошлись и одним CSS-токеном "
        f"--doc-font-size-small больше не описываются: {same}"
    )


def test_doc_list_indent_matches_docx_indent_step() -> None:
    """--doc-list-indent == _LIST_INDENT_STEP твипов, переведённых в пункты."""
    tokens = _read_tokens()
    assert "--doc-list-indent" in tokens, (
        "токен --doc-list-indent пропал из static/css/base/variables/typography.css"
    )
    expected_pt = numbering._LIST_INDENT_STEP / TWIPS_PER_PT
    assert _pt(tokens["--doc-list-indent"]) == expected_pt, (
        f"втяжка списка разъехалась: CSS --doc-list-indent = "
        f"{tokens['--doc-list-indent']}, DOCX _LIST_INDENT_STEP = "
        f"{numbering._LIST_INDENT_STEP} твипов = {expected_pt}pt "
        "(app/domains/acts/formatters/docx/numbering.py)"
    )


def test_doc_space_after_matches_docx_normal_spacing() -> None:
    """--doc-space-after == Spacing.after_pt (интервал после ЛЮБОГО абзаца)."""
    tokens = _read_tokens()
    assert "--doc-space-after" in tokens, (
        "токен --doc-space-after пропал из static/css/base/variables/typography.css"
    )
    assert _pt(tokens["--doc-space-after"]) == float(Spacing.after_pt), (
        f"вертикальный ритм разъехался: CSS --doc-space-after = "
        f"{tokens['--doc-space-after']}, DOCX Spacing.after_pt = "
        f"{Spacing.after_pt}pt (app/domains/acts/formatters/docx/styles.py)"
    )


def test_docx_has_no_space_before_paragraphs() -> None:
    """Интервал ДО абзаца в Word нулевой — поэтому у листа нет верхних margin'ов.

    Правила предпросмотра выставляют `margin-top: 0` всему содержимому листа и
    полагаются именно на это: воздух в акте создаёт только интервал ПОСЛЕ
    предыдущего абзаца (плюс пустая строка-распорка, см. тест ниже). Если
    эталон когда-нибудь заведёт ненулевой `space_before`, отдельного токена под
    него в CSS не окажется, и лист начнёт врать про печать молча.
    """
    assert Spacing.before_pt == 0, (
        "DOCX завёл ненулевой интервал ДО абзаца "
        f"(Spacing.before_pt = {Spacing.before_pt}pt), а предпросмотр строится "
        "на допущении «верхних отступов на листе нет». Нужен парный токен в "
        "static/css/base/variables/typography.css и правила под него."
    )


def test_doc_blank_line_matches_docx_spacer_size() -> None:
    """--doc-blank-line-size == Sizes.blank_line_pt (пустая строка-распорка).

    Сама высота распорки — произведение кегля её метки на одинарный интервал,
    поэтому в CSS она собирается `calc`-ом из двух уже сверенных токенов;
    здесь сторожится множимое.
    """
    tokens = _read_tokens()
    assert "--doc-blank-line-size" in tokens, (
        "токен --doc-blank-line-size пропал из "
        "static/css/base/variables/typography.css"
    )
    assert _pt(tokens["--doc-blank-line-size"]) == float(Sizes.blank_line_pt), (
        f"высота распорки разъехалась: CSS --doc-blank-line-size = "
        f"{tokens['--doc-blank-line-size']}, DOCX Sizes.blank_line_pt = "
        f"{Sizes.blank_line_pt}pt (app/domains/acts/formatters/docx/styles.py)"
    )
    assert tokens.get("--doc-blank-line") == (
        "calc(var(--doc-blank-line-size) * var(--doc-line-height))"
    ), (
        "--doc-blank-line обязан считаться из кегля метки и одинарного "
        "интервала, а не быть отдельным числом: иначе правка любого из двух "
        "множителей уводит распорку от Word. Получено: "
        f"{tokens.get('--doc-blank-line')!r}"
    )


def test_doc_line_height_pinned_to_word_single() -> None:
    """--doc-line-height == 1.15 при «одинарном» интервале на стороне DOCX."""
    tokens = _read_tokens()
    assert tokens.get("--doc-line-height") == EXPECTED_LINE_HEIGHT, (
        f"межстрочный разъехался: CSS --doc-line-height = "
        f"{tokens.get('--doc-line-height')!r}, ожидался {EXPECTED_LINE_HEIGHT!r} — "
        "экранный эквивалент вордовского «одинарного»"
    )
    assert Spacing.line_single is WD_LINE_SPACING.SINGLE, (
        "DOCX больше не просит у Word «одинарный» интервал "
        f"(Spacing.line_single = {Spacing.line_single!r}), а CSS всё ещё рисует "
        f"{EXPECTED_LINE_HEIGHT} — экранный эквивалент именно одинарного"
    )
