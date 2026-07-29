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
