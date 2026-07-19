"""Тесты HTMLUtils: разворот спец-span'ов (ссылка/сноска) в TXT/MD.

Фикс #1: вложенный <span> внутри ссылки/сноски больше не обрывает текст —
сканер ищет ПАРНЫЙ </span> по глубине (раньше нежадная регулярка `(.*?)`
останавливалась на первом внутреннем </span>).
"""

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
    """

    def test_clean_html_blank_line_placeholder_between_blocks(self):
        src = "<div>a</div><div><br></div><div>b</div>"
        assert HTMLUtils.clean_html(src) == "a\n\nb"

    def test_markdown_blank_line_placeholder_between_blocks(self):
        src = "<div>a</div><div><br></div><div>b</div>"
        assert HTMLUtils.html_to_markdown(src) == "a  \n  \nb"

    def test_clean_html_two_blocks_join_with_newline(self):
        src = "<div>a</div><div>b</div>"
        assert HTMLUtils.clean_html(src) == "a\nb"

    def test_markdown_two_blocks_join_with_newline(self):
        src = "<div>a</div><div>b</div>"
        assert HTMLUtils.html_to_markdown(src) == "a  \nb"

    def test_clean_html_trailing_br_before_close_not_doubled(self):
        # <br> прямо перед закрытием блока невидим в браузере — перенос уже
        # даёт граница блока, второй (от самого <br>) не должен добавляться.
        src = "<div>a<br></div><div>b</div>"
        assert HTMLUtils.clean_html(src) == "a\nb"

    def test_markdown_trailing_br_before_close_not_doubled(self):
        src = "<div>a<br></div><div>b</div>"
        assert HTMLUtils.html_to_markdown(src) == "a  \nb"

    def test_clean_html_leading_empty_block_keeps_leading_newline(self):
        # Ведущая пустая строка поля легитимна — rstrip хвостовой, не ведущий.
        src = "<div><br></div><div>b</div>"
        assert HTMLUtils.clean_html(src) == "\nb"

    def test_markdown_leading_empty_block_keeps_leading_newline(self):
        src = "<div><br></div><div>b</div>"
        assert HTMLUtils.html_to_markdown(src) == "  \nb"


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
