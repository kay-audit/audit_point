"""Ratchet: в документных CSS-зонах кегль задаётся ДОКУМЕНТНЫМИ токенами.

Документные зоны — файлы, которыми рисуется сам акт в предпросмотре
(`static/css/constructor/preview/*`, кроме интерфейсной обвязки, см.
`ZONE_FILES`). Кегль в них обязан приходить из документных токенов
(`--doc-font-size` / `--doc-font-size-small`, зеркало
`app/domains/acts/formatters/docx/styles.py::Sizes`), а не из UI-шкалы
`--font-size-*` и не литералом в пунктах.

Зачем ratchet. UI-токен `--font-size-sm` на портале прибит к 12px
(`static/css/portal/layout/density.css`), а 12px — это ровно 9pt, то есть
печатный «мелкий» кегль. Совпадение СЛУЧАЙНОЕ: рядом, в том же диалоге версий,
поля нарушения стоят на честном документном значении. Пока таблица тянула
`--font-size-sm`, правка базовой плотности портала уводила её от печатного
кегля, а нарушения оставались на месте — и разъезд был бы виден только глазами.

Зона покрытия — ЧЕСТНО ограничена. Ratchet смотрит только на объявления
`font-size` и только в файлах `ZONE_FILES`. Он НЕ ловит: кегль, заданный
инлайн-стилем из JS; поверхности ПРАВКИ (`constructor/textblock/*`,
`constructor/violation/*`, `constructor/table/*`) — там документные и
интерфейсные правила живут вперемешку, и это отдельный разбор; вычисленное
значение в живом каскаде — его сторожит
`tests/playwright/specs/32-document-parity.spec.ts`.

Образец жанра — `tests/test_connection_budget.py`.
"""

import pathlib
import re

STATIC_CSS = pathlib.Path(__file__).resolve().parent.parent / "static" / "css"

# Файлы, которые рисуют ДОКУМЕНТ. Намеренно НЕ входят соседи из того же
# каталога: `preview-base.css` (панель-холст под листом) и `preview-menu.css`
# (хром модалки предпросмотра) — это интерфейс вокруг документа, и кегль там
# обязан быть интерфейсным.
ZONE_FILES = (
    "constructor/preview/preview-page.css",
    "constructor/preview/preview-table.css",
    "constructor/preview/preview-typography.css",
    "constructor/preview/preview-violation.css",
    "constructor/preview/preview-cover.css",
)

# Разрешённые объявления `font-size: var(--font-size-*)` в документных зонах:
# (файл, нормализованный селектор) -> ПОЧЕМУ здесь допустим интерфейсный токен.
# Любая новая запись — это осознанное решение, а не «тест мешает».
ALLOWED_UI_TOKEN_FONT_SIZES = {
    (
        "constructor/preview/preview-table.css",
        ".preview-table",
    ): (
        "Вкладка «Сравнение» диалога версий (.diff-content) эмитит ГОЛУЮ "
        "<table class=\"preview-table\"> без обёртки (diff-renderer.js::"
        "_renderDiffTable) и по решению из docs/architecture/"
        "textblock-editor-architecture.md §13 живёт по интерфейсному кеглю: "
        "это инструмент сверки, а не отрисовка листа. Документный кегль всё, "
        "что вышло из общего рендера, получает соседним правилом "
        "`.preview-table-wrapper .preview-table` — его наличие сторожит "
        "test_wrapper_tables_use_document_font_size ниже, и без него эта "
        "запись перестаёт быть допущением и становится протечкой."
    ),
    (
        "constructor/preview/preview-table.css",
        ".preview-table-caption",
    ): (
        "Мёртвое правило: элемент <caption class=\"preview-table-caption\"> "
        "рендерами не создаётся ни на одной поверхности. Не удаляем — чужой "
        "мёртвый код, зафиксирован как известный."
    ),
    (
        "constructor/preview/preview-typography.css",
        ".preview pre",
    ): (
        "Блок преформатированного кода. В акте не печатается (DOCX-билдер "
        "<pre> не знает), на экране — служебная врезка, кегль интерфейсный."
    ),
}

_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)
_FONT_SIZE_RE = re.compile(r"font-size\s*:\s*([^;}]+)")
_UI_TOKEN_RE = re.compile(r"var\(\s*--font-size-[a-z0-9]+", re.I)
_PT_LITERAL_RE = re.compile(r"^\d+(?:\.\d+)?pt$")


def _declarations(rel_path: str) -> list[tuple[str, str]]:
    """Пары (селектор, значение) для каждого объявления font-size в файле.

    Комментарии вырезаются до разбора: они полны примеров вида
    `font-size: 9pt` и без вырезания дали бы ложные срабатывания.
    Селектор — прелюдия НЕПОСРЕДСТВЕННО охватывающего блока, поэтому разбор
    корректен и внутри `@media`.
    """
    text = _COMMENT_RE.sub(" ", (STATIC_CSS / rel_path).read_text(encoding="utf-8"))
    found: list[tuple[str, str]] = []
    for match in _FONT_SIZE_RE.finditer(text):
        head = text[: match.start()]
        open_brace = head.rfind("{")
        if open_brace == -1:
            continue
        prelude_start = max(
            head.rfind("}", 0, open_brace), head.rfind("{", 0, open_brace)
        ) + 1
        selector = " ".join(head[prelude_start:open_brace].split())
        found.append((selector, match.group(1).strip()))
    return found


def test_no_new_ui_token_font_sizes_in_document_zones() -> None:
    """UI-шкала в документных зонах — только по явному списку допущений."""
    leaks = [
        (rel_path, selector, value)
        for rel_path in ZONE_FILES
        for selector, value in _declarations(rel_path)
        if _UI_TOKEN_RE.search(value)
        and (rel_path, selector) not in ALLOWED_UI_TOKEN_FONT_SIZES
    ]
    assert not leaks, (
        "Интерфейсный токен кегля в документной зоне. Документ печатается "
        "в пунктах, а --font-size-* — плотность страницы: она разная в "
        "конструкторе (корень 12px) и на портале (13px) и правится независимо "
        "от Word. Возьми --doc-font-size / --doc-font-size-small либо, если "
        "интерфейсный кегль тут осознан, внеси запись в "
        "ALLOWED_UI_TOKEN_FONT_SIZES с объяснением ПОЧЕМУ. Найдено: "
        + "; ".join(f"{path} :: {sel} -> {val}" for path, sel, val in leaks)
    )


def test_allowlist_has_no_stale_entries() -> None:
    """В списке допущений нет записей про уже исчезнувшие правила."""
    real = {
        (rel_path, selector)
        for rel_path in ZONE_FILES
        for selector, value in _declarations(rel_path)
        if _UI_TOKEN_RE.search(value)
    }
    stale = sorted(set(ALLOWED_UI_TOKEN_FONT_SIZES) - real)
    assert not stale, (
        "ALLOWED_UI_TOKEN_FONT_SIZES описывает правила, которых в CSS больше "
        "нет, — список допущений протух и перестал что-либо охранять: "
        + "; ".join(f"{path} :: {sel}" for path, sel in stale)
    )


def test_no_pt_literals_in_document_zone_font_sizes() -> None:
    """Кегль в пунктах — через токен, а не числом на месте.

    Литерал `9pt` не хуже токена ровно до момента, когда эталон DOCX сдвинется:
    токен правится в одной точке и сверяется с Python
    (`tests/test_document_typography_tokens.py`), а литералы приходится
    вылавливать grep'ом по каталогу.
    """
    literals = [
        (rel_path, selector, value)
        for rel_path in ZONE_FILES
        for selector, value in _declarations(rel_path)
        if _PT_LITERAL_RE.match(value)
    ]
    assert not literals, (
        "Кегль документа задан литералом в пунктах вместо токена "
        "--doc-font-size / --doc-font-size-small: "
        + "; ".join(f"{path} :: {sel} -> {val}" for path, sel, val in literals)
    )


def test_wrapper_tables_use_document_font_size() -> None:
    """Таблицы из общего рендера получают документный «мелкий» кегль.

    `PreviewTableRenderer` кладёт таблицу в `.preview-table-wrapper`
    (preview-table-renderer.js), и правило целится именно в КОРЕНЬ РЕНДЕРА:
    так документный кегль достаёт и до листа A4, и до диалога версий, который
    листа не строит, — но не задевает вкладку «Сравнение» с её голой таблицей
    без обёртки. Тем же приёмом в проекте чинили гарнитуру, см.
    docs/architecture/textblock-editor-architecture.md §13.
    """
    decls = dict(_declarations("constructor/preview/preview-table.css"))
    assert ".preview-table-wrapper .preview-table" in decls, (
        "Пропало правило `.preview-table-wrapper .preview-table` — таблицы "
        "общего рендера снова остались на интерфейсном кегле базового "
        "`.preview-table` (тот стоит на --font-size-sm ради вкладки «Сравнение»)"
    )
    assert decls[".preview-table-wrapper .preview-table"] == (
        "var(--doc-font-size-small)"
    ), (
        "Кегль таблиц общего рендера обязан приходить из "
        "--doc-font-size-small (Sizes.table_data_pt в DOCX), получено: "
        + decls[".preview-table-wrapper .preview-table"]
    )


def test_item_headings_use_document_font_size() -> None:
    """Заголовок пункта печатается документным кеглем, а не UI-шкалой.

    В Word пункт любой глубины идёт одним кеглем и жирным
    (`docx/formatter.py::_render_item` — `Sizes.body_pt` + `run.bold`), глубину
    несёт номер рубрикатора. Прицел — класс `preview-heading`, который вешает
    `PreviewManager._renderHeading`, а не тег: `h1`–`h6` разрешены санитайзером
    внутри контента текстблока, и правило по голому тегу задело бы ЧУЖИЕ
    заголовки, которые Word печатает плоским текстом (`_BLOCK_TAGS` в
    `docx/builders/inline.py`).
    """
    decls = dict(_declarations("constructor/preview/preview-typography.css"))
    assert ".preview-heading" in decls, (
        "Пропало правило `.preview-heading` — заголовки пунктов снова остались "
        "на UI-шкале (--font-size-xl/lg/base), то есть на ПЛОТНОСТИ интерфейса: "
        "на корне 12px это 11.25pt/10.1pt/9pt по уровням вместо печатных 12pt"
    )
    assert decls[".preview-heading"] == "var(--doc-font-size)", (
        "Кегль заголовка пункта обязан приходить из --doc-font-size "
        "(Sizes.body_pt в DOCX), получено: " + decls[".preview-heading"]
    )


def test_content_headings_are_flattened_to_body_text() -> None:
    """Заголовки из контента наследуют кегль тела, как в Word.

    `h1`–`h6` проходят allowlist санитайзера (`shared/sanitize.js`), но в DOCX
    они входят в `_BLOCK_TAGS`: тег режется в абзац базового кегля, `bold` не
    выставляется. Без явного правила лист рисовал бы UA-дефолт (1.5em bold) —
    то, чего в выгруженном файле не будет.
    """
    flatten = [
        (selector, value)
        for selector, value in _declarations(
            "constructor/preview/preview-typography.css"
        )
        if "h1" in selector and "h6" in selector
    ]
    assert flatten, (
        "Пропало правило-сплющивание заголовков внутри контента "
        "(.preview-textblock-content / .preview-violation): чужие h1–h6 вернулись "
        "к UA-дефолту и рисуются крупнее и жирнее, чем напечатает Word"
    )
    assert all(value == "inherit" for _, value in flatten), (
        "Заголовок из контента обязан наследовать кегль тела, получено: "
        + "; ".join(f"{sel} -> {val}" for sel, val in flatten)
    )
