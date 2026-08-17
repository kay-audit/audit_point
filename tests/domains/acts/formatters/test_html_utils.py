"""Тесты HTMLUtils: разворот спец-span'ов (ссылка/сноска) в TXT/MD.

Фикс #1: вложенный <span> внутри ссылки/сноски больше не обрывает текст —
сканер ищет ПАРНЫЙ </span> по глубине (раньше нежадная регулярка `(.*?)`
останавливалась на первом внутреннем </span>).
"""

import pytest

from app.domains.acts.formatters.utils.html_utils import HTMLUtils


_LINK = '<span class="text-link" data-link-url="https://x.ru/d">'
_FOOT = '<span class="text-footnote" data-footnote-text="прим">'


class TestNestedSpanLinks:
    def test_clean_html_link_with_nested_span_keeps_full_text(self):
        src = f'{_LINK}пред <span style="font-size:18px">внутр</span> кон</span>'
        out = HTMLUtils.clean_html(src)
        assert out == "пред внутр кон (https://x.ru/d)"

    def test_markdown_link_with_nested_span_keeps_full_text(self):
        src = f'{_LINK}пред <span style="font-size:18px">внутр</span> кон</span>'
        out = HTMLUtils.html_to_markdown(src)
        assert out == "[пред внутр кон](https://x.ru/d)"

    def test_clean_html_leading_bold_word_in_link(self):
        # Сценарий из отчёта: первое слово жирное (вложенный span).
        src = f'{_LINK}<span style="font-weight:700">См.</span> документацию</span>'
        out = HTMLUtils.clean_html(src)
        assert out == "См. документацию (https://x.ru/d)"

    def test_two_sibling_links_not_merged(self):
        src = (
            '<span class="text-link" data-link-url="a">x</span>'
            ' y '
            '<span class="text-link" data-link-url="b">z</span>'
        )
        out = HTMLUtils.clean_html(src)
        assert out == "x (a) y z (b)"

    def test_footnote_with_nested_formatting(self):
        src = f'{_FOOT}<b>якорь</b></span>'
        out = HTMLUtils.clean_html(src)
        assert out == "якорь (сноска: прим)"

    def test_markdown_footnote_with_nested_formatting(self):
        src = f'{_FOOT}<b>якорь</b></span>'
        out = HTMLUtils.html_to_markdown(src)
        assert out == "**якорь** (сноска: прим)"


class TestBlockBoundaries:
    """Границы <div>/<p> → переносы строк (Задача 5).

    Раньше вырезание тегов убирало границы блоков без следа — многострочное
    rich-поле схлопывалось в одну строку («<div>a</div><div>b</div>» → «ab»).

    Параметризовано по обеим функциям (V22): clean_html и html_to_markdown
    делят один и тот же 3-шаговый перевод границ блоков
    (``_convert_block_boundaries``), различается только строка переноса
    ("\\n" против MD hard break "  \\n") — тестовые фикстуры общие.
    """

    @pytest.mark.parametrize(
        "func, src, expected",
        [
            (HTMLUtils.clean_html, "<div>a</div><div><br></div><div>b</div>", "a\n\nb"),
            (HTMLUtils.html_to_markdown, "<div>a</div><div><br></div><div>b</div>", "a  \n  \nb"),
            (HTMLUtils.clean_html, "<div>a</div><div>b</div>", "a\nb"),
            (HTMLUtils.html_to_markdown, "<div>a</div><div>b</div>", "a  \nb"),
            # <br> прямо перед закрытием блока невидим в браузере — перенос
            # уже даёт граница блока, второй (от самого <br>) не добавляется.
            (HTMLUtils.clean_html, "<div>a<br></div><div>b</div>", "a\nb"),
            (HTMLUtils.html_to_markdown, "<div>a<br></div><div>b</div>", "a  \nb"),
            # Ведущая пустая строка поля легитимна — rstrip хвостовой, не ведущий.
            (HTMLUtils.clean_html, "<div><br></div><div>b</div>", "\nb"),
            (HTMLUtils.html_to_markdown, "<div><br></div><div>b</div>", "  \nb"),
        ],
        ids=[
            "clean-blank-line-placeholder",
            "markdown-blank-line-placeholder",
            "clean-two-blocks-join",
            "markdown-two-blocks-join",
            "clean-trailing-br-not-doubled",
            "markdown-trailing-br-not-doubled",
            "clean-leading-empty-block",
            "markdown-leading-empty-block",
        ],
    )
    def test_block_boundary_conversion(self, func, src, expected):
        assert func(src) == expected


class TestLists:
    """Ревью #4: <ul>/<ol>/<li> больше не склеиваются («перввтор») — каждый
    пункт на своей строке с маркером (clean_html: "- "/"N. "; html_to_markdown:
    полноценный markdown-список, обёрнутый пустой строкой от соседнего
    контента). Вложенные списки больше НЕ сплющиваются: получают отступ по
    уровню (4 пробела/уровень — CommonMark-безопасно и для «- », и для
    «N. », см. _LIST_INDENT_UNIT) и независимый счётчик; маркер по уровню не
    меняется — тот же «- »/«N. », что и на уровне 0 (см. _convert_lists)."""

    def test_clean_html_bullet_items_on_own_lines(self):
        assert HTMLUtils.clean_html("<ul><li>перв</li><li>втор</li></ul>") == "- перв\n- втор"

    def test_clean_html_numbered_items_honest_numbering(self):
        assert HTMLUtils.clean_html("<ol><li>перв</li><li>втор</li></ol>") == "1. перв\n2. втор"

    def test_clean_html_orphan_li_stays_raw(self):
        """<li> вне <ul>/<ol> — не пункт: маркер не ставится (сырой текст)."""
        assert HTMLUtils.clean_html("<li>сирота</li>") == "сирота"

    def test_clean_html_whitespace_between_list_tags_ignored(self):
        src = "<ul>\n  <li>раз</li>\n  <li>два</li>\n</ul>"
        assert HTMLUtils.clean_html(src) == "- раз\n- два"

    def test_clean_html_unclosed_li_closed_by_sibling(self):
        assert HTMLUtils.clean_html("<ul><li>раз<li>два</ul>") == "- раз\n- два"

    def test_clean_html_nested_list_indented_with_own_numbering(self):
        """Вложенный список больше не сплющивается: получает отступ (4
        пробела) и независимый счётчик (нумерация вложенного <ol>
        начинается с 1)."""
        src = "<ul><li>маркер<ol><li>номер</li></ol></li></ul>"
        assert HTMLUtils.clean_html(src) == "- маркер\n    1. номер"

    def test_clean_html_nested_list_counter_restarts_per_instance(self):
        """Каждый вложенный список — свой счётчик: второй вложенный <ol>
        стартует заново с 1, а не продолжает первый."""
        src = (
            "<ul>"
            "<li>a<ol><li>x</li><li>y</li></ol></li>"
            "<li>b<ol><li>z</li></ol></li>"
            "</ul>"
        )
        expected = "- a\n    1. x\n    2. y\n- b\n    1. z"
        assert HTMLUtils.clean_html(src) == expected

    def test_clean_html_nested_ol_in_ol_keeps_numbering_at_both_levels(self):
        """Регрессия ревью: родитель <ol> (маркер «N. », content indent 3) с
        отступом 2 пробела делал вложенный пункт СИБЛИНГОМ для CommonMark-
        рендерера (перенумерация, вложенность разваливалась). При 4 пробелах
        оба уровня остаются нумерованными списками, внешний счёт не сбивается."""
        src = "<ol><li>a<ol><li>x</li><li>y</li></ol></li><li>b</li></ol>"
        expected = "1. a\n    1. x\n    2. y\n2. b"
        assert HTMLUtils.clean_html(src) == expected

    def test_clean_html_inline_formatting_inside_item_stripped(self):
        src = "<ul><li><b>жирно</b> текст</li></ul>"
        assert HTMLUtils.clean_html(src) == "- жирно текст"

    def test_clean_html_list_no_blank_lines_around(self):
        """TXT не оборачивает список пустыми строками (не markdown)."""
        src = "<div>интро</div><ul><li>раз</li></ul><div>хвост</div>"
        assert HTMLUtils.clean_html(src) == "интро\n- раз\nхвост"

    def test_markdown_bullet_items_are_real_list_syntax(self):
        out = HTMLUtils.html_to_markdown("<ul><li>перв</li><li>втор</li></ul>")
        assert out == "- перв  \n- втор"

    def test_markdown_numbered_items_honest_numbering(self):
        out = HTMLUtils.html_to_markdown("<ol><li>перв</li><li>втор</li></ol>")
        assert out == "1. перв  \n2. втор"

    def test_markdown_list_wrapped_in_blank_lines(self):
        """Markdown-конвенция: список обособлен пустой строкой от соседних
        абзацев по обе стороны — иначе рендерер может не распознать список."""
        src = "<div>интро</div><ul><li>раз</li><li>два</li></ul><div>хвост</div>"
        out = HTMLUtils.html_to_markdown(src)
        assert out == "интро  \n  \n- раз  \n- два  \n  \nхвост"

    def test_markdown_list_alone_has_no_stray_blank_lines(self):
        """Список без соседнего контента не обрастает лишними пустыми строками."""
        assert HTMLUtils.html_to_markdown("<ul><li>раз</li></ul>") == "- раз"

    def test_markdown_nested_list_indented_with_own_numbering(self):
        """Вложенный список больше не сплющивается: отступ 4 пробела на
        уровень, независимый счётчик (нумерация вложенного <ol> с 1)."""
        src = "<ul><li>маркер<ol><li>номер</li></ol></li></ul>"
        assert HTMLUtils.html_to_markdown(src) == "- маркер  \n    1. номер"

    def test_markdown_nested_list_indent_scales_with_level_not_glyph(self):
        """MD не меняет символ маркера по уровням (Markdown-список
        поддерживает только «-»/«N.») — только отступ 4 пробела на уровень."""
        src = "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>"
        expected = "- a  \n    - b  \n        - c"
        assert HTMLUtils.html_to_markdown(src) == expected

    def test_markdown_nested_ol_in_ol_keeps_numbering_at_both_levels(self):
        """Регрессия ревью, MD-вариант: вложенный <ol> в <ol> — отступ 4
        пробела (CommonMark-безопасно для content indent «N. » = 3), оба
        уровня нумерованы, внешний счёт не сбивается."""
        src = "<ol><li>a<ol><li>x</li><li>y</li></ol></li><li>b</li></ol>"
        expected = "1. a  \n    1. x  \n    2. y  \n2. b"
        assert HTMLUtils.html_to_markdown(src) == expected

    def test_markdown_inline_formatting_inside_item_survives(self):
        src = "<ul><li><b>жирно</b> текст</li></ul>"
        assert HTMLUtils.html_to_markdown(src) == "- **жирно** текст"

    def test_markdown_link_capsule_inside_item_survives(self):
        src = f'<ul><li>{_LINK}текст</span></li></ul>'
        assert HTMLUtils.html_to_markdown(src) == "- [текст](https://x.ru/d)"


class TestSimpleCasesUnchanged:
    def test_plain_link_without_nesting(self):
        src = f'{_LINK}текст</span>'
        assert HTMLUtils.clean_html(src) == "текст (https://x.ru/d)"

    def test_markdown_plain_link(self):
        src = f'{_LINK}текст</span>'
        assert HTMLUtils.html_to_markdown(src) == "[текст](https://x.ru/d)"

    def test_no_special_spans_strips_tags(self):
        assert HTMLUtils.clean_html("<p>просто <b>текст</b></p>") == "просто текст"

    def test_entities_unescaped_once(self):
        # Амперсанд в url экранирован один раз; снимается финальным unescape.
        src = '<span class="text-link" data-link-url="a?x=1&amp;y=2">т</span>'
        assert HTMLUtils.clean_html(src) == "т (a?x=1&y=2)"
