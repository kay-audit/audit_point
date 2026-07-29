"""Тесты MarkdownUtils.escape_inline и экранирования картинки в markdown_formatter (#7).

Баг (найден код-ревью): в `_add_image` символы экранировались по одному
`.replace()` без предварительного экранирования обратного слэша. Из-за
этого `\\]` в подписи превращалось в `\\\\]` (экранированный слэш +
НЕэкранированный `]`), что преждевременно закрывало alt-скобку и позволяло
пользовательскому тексту «впрыснуть» поддельную ссылку/картинку
`](target)` в экспортированный документ. Аналогично для `"` в title и для
`*`/`[`/`]` в текстовом fallback черновика (пустой url).

Источник правила экранирования — CommonMark spec, backslash escapes:
любой ASCII punctuation может быть экранирован `\\`, и обратный слэш
экранируется ПЕРВЫМ (иначе он «съедает» экранирование следующего символа).

Task 6: caption стал rich-HTML-полем (rich-редактор подписи) — конвертируется
через HTMLUtils.html_to_markdown (как кейс/свободный текст) и больше НЕ
экранируется по `*` в текстовом fallback черновика (пустой url) — иначе
конвертированная разметка (**bold**) сама превращалась бы в текст тегов.
filename остаётся дословным plain-полем и экранируется как раньше.

#15 (найден код-ревью): caption в текстовом fallback черновика вставлялся
БЕЗ экранирования `[`/`]` — подпись `[текст](url)` давала живую MD-ссылку
(структурный аналог #7, только в draft-ветке, не в alt). Экранирование по
`[]` ПОСЛЕ конвертации теперь применяется в обеих ветках `_add_image` —
паритет с alt-веткой (непустой url), где защита от структурного разрыва
`![...]` уже сдвинута после html_to_markdown (см. TestAddImageUrlBranchEscaping).
"""
from app.domains.acts.formatters.markdown_formatter import MarkdownFormatter
from app.domains.acts.formatters.utils.markdown_utils import MarkdownUtils
from app.domains.acts.settings import ActsSettings


def _md() -> MarkdownFormatter:
    return MarkdownFormatter(settings=None, acts_settings=ActsSettings())


class TestEscapeInlineBackslashFirst:
    """Обратный слэш обязан экранироваться раньше остальных символов."""

    def test_trailing_backslash_before_special_char_does_not_defeat_escape(self):
        # "x\]" наивной заменой ']' -> '\]' стало бы "x\\]" (экранированный
        # слэш + голая ']'). Правильно: сначала слэш -> "x\\", затем ']' ->
        # "x\\\]" — скобка остаётся экранированной.
        out = MarkdownUtils.escape_inline("x\\]", "[]")
        assert out == "x\\\\\\]"
        # В итоговой строке НЕ должно быть непарной (неэкранированной) ']'.
        assert not _has_unescaped_char(out, "]")

    def test_bare_backslash_is_escaped(self):
        assert MarkdownUtils.escape_inline("a\\b", "[]") == "a\\\\b"

    def test_quote_after_backslash_does_not_defeat_escape(self):
        out = MarkdownUtils.escape_inline('x\\"', '"')
        assert not _has_unescaped_char(out, '"')

    def test_newline_and_cr_collapse_to_space(self):
        assert MarkdownUtils.escape_inline("a\nb\rc", "[]") == "a b c"

    def test_no_special_chars_untouched_besides_backslash(self):
        assert MarkdownUtils.escape_inline("plain text", "[]") == "plain text"


def _has_unescaped_char(text: str, ch: str) -> bool:
    """Возвращает True, если в тексте есть НЕэкранированное вхождение ch."""
    i = 0
    found = False
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == ch:
            found = True
        i += 1
    return found


class TestAddImageUrlBranchEscaping:
    """url-присутствующая ветка `_add_image`: `![alt](url "title")`."""

    def test_caption_with_escaped_bracket_cannot_splice_link(self):
        lines: list[str] = []
        item = {
            "caption": "before\\](http://evil.example)after",
            "filename": "f.png",
            "url": "http://good.example/img.png",
        }
        _md()._add_image(lines, item)
        out = "\n".join(lines)

        # alt-текст — между первой '[' и первой НЕэкранированной ']'.
        alt = _extract_between_unescaped(out, "[", "]")
        assert alt == "before\\](http://evil.example)after"
        # Настоящий url акта должен остаться единственной ссылкой.
        assert "(http://good.example/img.png " in out

    def test_filename_with_quote_cannot_close_title_early(self):
        lines: list[str] = []
        item = {
            "caption": "",
            "filename": 'evil.png" onclick="alert(1)',
            "url": "http://good.example/img.png",
        }
        _md()._add_image(lines, item)
        out = "\n".join(lines)

        title = _extract_between_unescaped(out, '"', '"', start_after=out.index("("))
        assert title == 'evil.png" onclick="alert(1)'

    def test_newline_in_caption_collapses_to_space(self):
        lines: list[str] = []
        item = {
            "caption": "line1\nline2",
            "filename": "f.png",
            "url": "http://good.example/img.png",
        }
        _md()._add_image(lines, item)
        out = "\n".join(lines)
        assert "line1 line2" in out
        assert "line1\nline2" not in out


class TestAddImageDraftBranchEscaping:
    """Пустой url (черновик): `*{filename}* - {caption}` / `*{filename}*`."""

    def test_caption_html_bold_converted_not_escaped(self):
        """Task 6: caption — rich HTML, конвертируется через html_to_markdown
        (как кейс/свободный текст, add_case/add_free_text в
        violation_render.py). Экранирование caption (#15) — только по '[]',
        `**bold**` эти символы не содержит и доходит до markdown-вывода как
        есть. filename остаётся plain и экранируется по-прежнему
        (test_filename_with_asterisk_does_not_break_italic_wrapper ниже).
        """
        lines: list[str] = []
        item = {
            "caption": "<b>bold</b> caption",
            "filename": "f.png",
            "url": "",
        }
        _md()._add_image(lines, item)
        out = "\n".join(lines)

        assert "*f.png* - **bold** caption" in out

    def test_caption_fake_link_escaped_but_bold_stays_live(self):
        """#15: caption после html_to_markdown вставлялся в текстовый
        fallback без экранирования '[]' — подпись `[текст](url)` давала
        живую MD-ссылку. Паритет с url-веткой (TestAddImageUrlBranchEscaping):
        экранируем ТОЛЬКО '[]' — bold/italic (**...**/*...*) остаются живой
        разметкой (Task 6)."""
        lines: list[str] = []
        item = {
            "caption": "<b>bold</b> [evil](http://x)",
            "filename": "f.png",
            "url": "",
        }
        _md()._add_image(lines, item)
        out = "\n".join(lines)

        assert "**bold**" in out
        assert "\\[evil\\](http://x)" in out
        assert "[evil](http://x)" not in out

    def test_filename_with_asterisk_does_not_break_italic_wrapper(self):
        lines: list[str] = []
        item = {"caption": "", "filename": "e*vil.png", "url": ""}
        _md()._add_image(lines, item)
        out = "\n".join(lines)
        assert out.startswith("*e\\*vil.png*")

    def test_newline_in_filename_collapses_to_space(self):
        lines: list[str] = []
        item = {"caption": "", "filename": "a\nb.png", "url": ""}
        _md()._add_image(lines, item)
        out = "\n".join(lines)
        assert "a b.png" in out
        assert "a\nb.png" not in out


def _extract_between_unescaped(text: str, open_ch: str, close_ch: str, start_after: int = 0) -> str:
    """Возвращает ДЕКОДИРОВАННОЕ содержимое между open_ch и первым
    НЕэкранированным close_ch (декодирует `\\x` -> `x` по пути, как это
    делает парсер Markdown при разборе backslash escapes)."""
    start = text.index(open_ch, start_after) + 1
    i = start
    out = []
    while i < len(text):
        if text[i] == "\\" and i + 1 < len(text):
            out.append(text[i + 1])
            i += 2
            continue
        if text[i] == close_ch:
            return "".join(out)
        out.append(text[i])
        i += 1
    raise AssertionError(f"Не найден непарный {close_ch!r} после позиции {start}")
