"""
Утилиты для работы с HTML-контентом.

Предоставляет функции для очистки, конвертации и парсинга HTML.
"""

import html
import re
from html.parser import HTMLParser

# Спец-разметка редактора текстблоков (см. docx/builders/inline.py):
# <span class="text-link" data-link-url="...">текст</span> — ссылка,
# <span class="text-footnote" data-footnote-text="...">якорь</span> — сноска.
# Данные живут в атрибутах: вырезание тегов «как есть» их теряет, поэтому
# такие span'ы разворачиваются в текстовый вид ДО общего вырезания тегов.
#
# Разбор — сканером с учётом ВЛОЖЕННОСТИ span'ов (а не нежадной регуляркой
# `(.*?)</span>`): если внутри ссылки есть вложенный <span> (часть текста
# форматирована отдельно), нежадный матч обрывал ссылку на первом внутреннем
# </span>, и хвост текста «вываливался» наружу. Сканер ищет ПАРНЫЙ </span>
# по глубине — текст ссылки/сноски не рвётся и соседние span'ы не склеиваются.
_TAG_RE = re.compile(r"<[^>]+>")
_SPAN_OPEN_RE = re.compile(r"<span\b[^>]*>", re.IGNORECASE)
_SPAN_CLOSE_RE = re.compile(r"</span\s*>", re.IGNORECASE)
_LINK_ATTR_RE = re.compile(r'\bdata-link-url="([^"]*)"', re.IGNORECASE)
_FOOTNOTE_ATTR_RE = re.compile(r'\bdata-footnote-text="([^"]*)"', re.IGNORECASE)


def _capture_span_inner(content: str, start: int) -> tuple[str, int]:
    """Возвращает (внутренний HTML, индекс_после_закрывающего_span).

    Идёт от ``start`` (сразу после открывающего <span>) до ПАРНОГО </span>,
    считая вложенные span'ы по глубине. Незакрытый span — забираем остаток.
    """
    depth = 1
    i, n = start, len(content)
    while i < n:
        m = _TAG_RE.match(content, i) if content[i] == "<" else None
        if m:
            tag = m.group(0)
            if _SPAN_OPEN_RE.match(tag):
                depth += 1
            elif _SPAN_CLOSE_RE.match(tag):
                depth -= 1
                if depth == 0:
                    return content[start:i], m.end()
            i = m.end()
        else:
            i += 1
    return content[start:], n


def _convert_block_boundaries(content: str, break_str: str) -> str:
    """Схлопывает границы блоков (div/p) и <br> в перенос ``break_str``.

    Общий шаг для ``clean_html`` (перенос — "\\n") и ``html_to_markdown``
    (перенос — Markdown hard break "  \\n"). <br> непосредственно перед
    закрытием блока невидим в браузере (перенос даёт сама граница блока),
    поэтому вырезаем его ДО общей замены <br> -> break_str, иначе строка
    задвоится.
    """
    result = re.sub(
        r"<br\s*/?>\s*(</(?:div|p)>)", r"\1", content, flags=re.IGNORECASE,
    )
    result = re.sub(r"<br\s*/?>", break_str, result, flags=re.IGNORECASE)
    result = re.sub(r"</(?:div|p)>", break_str, result, flags=re.IGNORECASE)
    return result


_LIST_OPEN_RE = re.compile(r"<(ul|ol)\b[^>]*>", re.IGNORECASE)
_LIST_CLOSE_RE = re.compile(r"</(ul|ol)\s*>", re.IGNORECASE)
_LI_OPEN_RE = re.compile(r"<li\b[^>]*>", re.IGNORECASE)
_LI_CLOSE_RE = re.compile(r"</li\s*>", re.IGNORECASE)

# Отступ на уровень вложенности (общий для TXT и MD — см. _convert_lists).
_LIST_INDENT_UNIT = "  "


def _convert_lists(content: str, *, blank_line_around: bool = False) -> str:
    """Схлопывает <ul>/<ol>/<li> в синтетические <div>-абзацы с текстовым
    маркером перед содержимым пункта («- » для <ul>, «N. » для <ol>, счётчик
    свой у каждого списка). Маркер — обычный текст, поэтому дальше идёт по
    тому же конвейеру, что и остальной контент пункта: <div>-границы доедут
    до общего ``_convert_block_boundaries`` (запускать эту функцию — ДО него).

    Вложенность БОЛЬШЕ НЕ СПЛЮЩИВАЕТСЯ: каждый уровень получает отступ
    (``_LIST_INDENT_UNIT`` на уровень, level = глубина списка, 0-based) —
    общее для TXT и MD. Маркер не меняется по уровню (тот же «- »/«N. », что
    и на уровне 0) — для .txt/.md это plain-text/Markdown-выгрузка, а не
    визуальный рендер «как в Word» (та схема — DOCX/CSS, см. inline.py и
    numbering.py); Markdown-нумерованный список к тому же поддерживает только
    цифровые маркеры.

    Счётчик своего списка (``list_stack``) стартует с 0 при КАЖДОМ открытии
    <ul>/<ol>, в том числе вложенном, — нумерация вложенного списка всегда
    начинается заново, независимо от соседних списков того же уровня.

    Чисто пробельный текст МЕЖДУ тегами списка (не внутри <li>, например
    отступы разметки между <ul> и первым <li>) отбрасывается — иначе
    появлялись бы пустые строки из форматирования исходного HTML.

    blank_line_around: обернуть ВЕРХНЕУРОВНЕВЫЙ список пустой строкой между
    ним и соседним контентом (Markdown-конвенция для однозначного
    распознавания списка рендерером) — True для ``html_to_markdown``, False
    для ``clean_html`` (TXT в таком обрамлении не нуждается).
    """
    out: list[str] = []
    # Текст МЕЖДУ тегами списка вне <li> копится тут и фильтруется на
    # пробельность при следующей структурной границе (см. _flush_pending).
    pending: list[str] = []
    list_stack: list[list] = []  # [kind ("ul"/"ol"), counter]
    li_open = False

    def _flush_pending() -> None:
        text = "".join(pending)
        pending.clear()
        if text.strip():
            out.append(text)

    i, n = 0, len(content)
    while i < n:
        if content[i] == "<":
            m = _TAG_RE.match(content, i)
            if m:
                tag = m.group(0)
                list_open_m = _LIST_OPEN_RE.match(tag)
                if list_open_m:
                    if li_open:
                        out.append("</div>")
                        li_open = False
                    else:
                        _flush_pending()
                        if (
                            not list_stack and blank_line_around
                            and out and "".join(out).strip()
                        ):
                            out.append("<div></div>")
                    list_stack.append([list_open_m.group(1).lower(), 0])
                    i = m.end()
                    continue
                if _LIST_CLOSE_RE.match(tag):
                    if li_open:
                        out.append("</div>")
                        li_open = False
                    if list_stack:
                        list_stack.pop()
                        if not list_stack:
                            _flush_pending()
                            if blank_line_around and content[m.end():].strip():
                                out.append("<div></div>")
                    i = m.end()
                    continue
                if _LI_OPEN_RE.match(tag) and list_stack:
                    if li_open:
                        out.append("</div>")
                    else:
                        _flush_pending()
                    kind, count = list_stack[-1]
                    count += 1
                    list_stack[-1][1] = count
                    indent = _LIST_INDENT_UNIT * (len(list_stack) - 1)
                    marker = "-" if kind == "ul" else f"{count}."
                    out.append(f"<div>{indent}{marker} ")
                    li_open = True
                    i = m.end()
                    continue
                if _LI_CLOSE_RE.match(tag) and li_open:
                    out.append("</div>")
                    li_open = False
                    i = m.end()
                    continue
                # Прочий тег (span/b/i/a/… или <li> вне списка/уже закрытый)
                # — как есть; вне <li> внутри списка фильтруется наравне с
                # текстом (см. pending выше).
                (out if (li_open or not list_stack) else pending).append(tag)
                i = m.end()
                continue
        nxt = content.find("<", i)
        chunk = content[i:] if nxt == -1 else content[i:nxt]
        (out if (li_open or not list_stack) else pending).append(chunk)
        if nxt == -1:
            break
        i = nxt

    if li_open:
        out.append("</div>")
    _flush_pending()
    return "".join(out)


def _resolve_special_spans(content: str, link_fmt) -> str:
    """Разворачивает спец-span'ы (ссылка/сноска) в текстовый вид.

    ``link_fmt(inner, url)`` форматирует ссылку (TXT: «текст (url)», MD:
    «[текст](url)»); сноска — всегда «якорь (сноска: текст)». Внутренний HTML
    сохраняется как есть — вложенные теги обработает общий конвейер ниже
    (вырезание тегов / markdown-замены), а финальный html.unescape снимет
    экранирование атрибутов один раз (как и прежняя регулярка).
    """
    out: list[str] = []
    i, n = 0, len(content)
    while i < n:
        if content[i] == "<":
            m = _TAG_RE.match(content, i)
            if m:
                tag = m.group(0)
                if _SPAN_OPEN_RE.match(tag):
                    link = _LINK_ATTR_RE.search(tag)
                    foot = _FOOTNOTE_ATTR_RE.search(tag)
                    if link or foot:
                        inner, end = _capture_span_inner(content, m.end())
                        if link:
                            out.append(link_fmt(inner, link.group(1)))
                        else:
                            out.append(f"{inner} (сноска: {foot.group(1)})")
                        i = end
                        continue
                out.append(tag)
                i = m.end()
                continue
        nxt = content.find("<", i)
        if nxt == -1:
            out.append(content[i:])
            break
        out.append(content[i:nxt])
        i = nxt
    return "".join(out)


# ---------------------------------------------------------------------------
# Узловой HTML → Markdown конвертер (html_to_markdown).
#
# В отличие от clean_html (выход инертен — plain text), MD-вывод парсится как
# разметка. Поэтому текст пользователя нельзя отдавать в .md сырым: `[t](url)`
# ожил бы как ссылка, а буквальный `<script>` (nh3 хранит его как `&lt;…&gt;`)
# — как сырой HTML-тег. Узловой парсер эмитит РАЗМЕТКУ только для распознанных
# тегов, а ТЕКСТ узлов экранирует. Границы блоков сводятся к переносам тем же
# _convert_block_boundaries, что и clean_html (единая байт-семантика).
# ---------------------------------------------------------------------------

# Схемы, допустимые в MD-ссылке (зеркало DOCX inline.py _SAFE_LINK_PREFIXES и
# фронтового validateLinkUrl). Небезопасная/пустая схема ссылкой не становится —
# капсула деградирует в обычный текст (как javascript:/data: в DOCX-экспорте).
_SAFE_LINK_PREFIXES = ("http://", "https://", "mailto:", "tel:", "ftp://", "file:")


def _is_safe_link_url(url: str) -> bool:
    u = url.strip().lower()
    return u.startswith("#") or u.startswith(_SAFE_LINK_PREFIXES)


def _escape_md_text(text: str) -> str:
    r"""Экранирует MD-спецсимволы в ТЕКСТОВОМ узле rich-поля.

    Состав (по CommonMark 0.30, приоритет — безопасность вывода при сохранении
    читаемости):
      ``\``  — первым, иначе гасит экранирование следующего символа;
      ``[`` ``]`` — против впрыска поддельной ссылки/картинки ``[t](url)``
        (`(`/`)` без предшествующих скобок инертны — их не трогаем);
      ``<`` ``>`` — как HTML-сущности ``&lt;``/``&gt;``: буквальный ``<`` (nh3
        хранит пользовательский ``<script>`` как ``&lt;…&gt;``, парсер декодирует
        его обратно) НЕ должен выйти сырым — иначе CommonMark пропустит его как
        inline-HTML (XSS-класс при рендере .md без санитайза). Сущность безопасна
        и при рендере через движок, игнорирующий backslash-escapes; ``&gt;``
        заодно гасит blockquote, если строка после границы блока начинается с
        ``>``;
      ``*`` — выделение; ``*`` рвёт даже ВНУТРИ слова (``a*b*c``), поэтому
        экранируется;
      ``` ` ``` — код-спан (может «проглотить» кусок текста до следующего
        бэктика).

    ``_`` сознательно НЕ экранируем: по CommonMark 0.30 ``_`` ВНУТРИ слова
    (окружён буквенно-цифровыми) эмфазой не становится (правило snake_case), а
    подчёркивания в реальном контенте (идентификаторы, url-фрагменты, snake_case)
    повсеместны — их экранирование засорило бы вывод ``\_`` без выигрыша в
    безопасности. Пограничный ``_слово_`` с пробелами вокруг — редкий чисто
    косметический (не security) случай.

    ``&`` тоже не трогаем: он уже декодирован ровно один раз (как прежний
    финальный ``html.unescape``), тест-паритет ждёт живой ``&`` в выводе.
    Пробелы/переносы строк несут структуру границ блоков — не экранируются.
    """
    text = text.replace("\\", "\\\\")
    text = text.replace("<", "&lt;").replace(">", "&gt;")
    for ch in ("[", "]", "`", "*"):
        text = text.replace(ch, "\\" + ch)
    return text


def _md_link_destination(url: str) -> str:
    r"""URL как destination MD-ссылки (без внешних скобок).

    Пробелы/табы/переносы требуют ``<...>``-формы (обычный destination их не
    допускает); внутри ``<...>`` угловые скобки экранируются. Иначе — обычная
    форма с экранированием ``(``/``)`` (иначе ``)`` в URL преждевременно закрыл
    бы ссылку) и обратного слэша.
    """
    url = url.strip()
    if any(c in url for c in " \t\r\n"):
        inner = (
            url.replace("\\", "\\\\").replace("<", "\\<").replace(">", "\\>")
        )
        inner = inner.replace("\r", " ").replace("\n", " ").replace("\t", " ")
        return f"<{inner}>"
    return url.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _format_md_link(text: str, url: str) -> str:
    """Готовая MD-ссылка ``[текст](url)`` для безопасной схемы; иначе — только
    текст (небезопасная/пустая схема ссылкой не становится). ``text`` уже
    экранирован (текстовые узлы), ``url`` готовится под destination."""
    if not _is_safe_link_url(url):
        return text
    return f"[{text}]({_md_link_destination(url)})"


class _MarkdownParser(HTMLParser):
    """HTML-фрагмент → Markdown: распознанные теги дают разметку, текст узлов
    экранируется (_escape_md_text).

    Маппинг тегов — зеркало прежней реализации: ``b``/``strong`` → ``**``,
    ``i``/``em`` → ``*``, ``u`` разворачивается (Markdown не имеет подчёркивания).
    Спец-span'ы редактора: ``data-link-url`` → ссылка ``[текст](url)``,
    ``data-footnote-text`` → ``якорь (сноска: текст)`` (ссылка приоритетнее —
    как в прежнем _resolve_special_spans). Прочие теги отбрасываются, их текст
    сохраняется.

    Текст ссылки/сноски копится в отдельном буфере (стек _out), чтобы
    вложенная разметка (``<b>`` внутри ссылки) и вложенные span'ы не рвали
    капсулу — на закрытии буфер оборачивается в ``[...]``/``(сноска: …)``.

    Границы блоков (``<br>``/``</div>``/``</p>``) сюда НЕ доезжают тегами: их
    заранее сводит в переносы _convert_block_boundaries, поэтому парсер видит
    только открывающие ``<div>``/``<p>`` (отбрасываются) и текст с переносами.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        # Стек буферов вывода; [0] — корневой. Открытие ссылки/сноски пушит
        # новый буфер (захват текста капсулы), закрытие — снимает и оборачивает.
        self._out: list[list[str]] = [[]]
        # Параллельно span'ам: ("link", url) | ("footnote", text) | ("plain", None).
        self._span_kinds: list[tuple[str, str | None]] = []

    def _emit(self, s: str) -> None:
        self._out[-1].append(s)

    def handle_data(self, data: str) -> None:
        if data:
            self._emit(_escape_md_text(data))

    def handle_starttag(self, tag, attrs):
        if tag in ("b", "strong"):
            self._emit("**")
        elif tag in ("i", "em"):
            self._emit("*")
        elif tag == "u":
            pass  # Подчёркивания в Markdown нет — тег разворачивается.
        elif tag == "span":
            self._open_span(dict(attrs))
        # div/p/br/прочее — отбрасываются (текст сохраняется).

    def handle_endtag(self, tag):
        if tag in ("b", "strong"):
            self._emit("**")
        elif tag in ("i", "em"):
            self._emit("*")
        elif tag == "span":
            self._close_span()

    def _open_span(self, attrs: dict) -> None:
        # Ключ — наличие атрибута (как прежний _resolve_special_spans); ссылка
        # приоритетнее сноски. Пустой/небезопасный url отсеет _format_md_link.
        url = attrs.get("data-link-url")
        foot = attrs.get("data-footnote-text")
        if url is not None:
            self._span_kinds.append(("link", url))
            self._out.append([])
        elif foot is not None:
            self._span_kinds.append(("footnote", foot))
            self._out.append([])
        else:
            self._span_kinds.append(("plain", None))

    def _close_span(self) -> None:
        if not self._span_kinds:
            return  # Непарный </span> — игнорируем.
        kind, payload = self._span_kinds.pop()
        if kind == "link":
            inner = "".join(self._out.pop())
            self._emit(_format_md_link(inner, payload))
        elif kind == "footnote":
            inner = "".join(self._out.pop())
            self._emit(f"{inner} (сноска: {_escape_md_text(payload)})")
        # plain — своего буфера нет, текст уже в текущем.

    def close(self) -> None:
        super().close()
        # Непарные открытые капсулы (маловероятно после nh3) — закрываем, чтобы
        # накопленный текст не потерялся и _out схлопнулся в корневой буфер.
        while self._span_kinds:
            self._close_span()

    def result(self) -> str:
        return "".join(self._out[0])


class HTMLUtils:
    """
    Stateless класс-утилита для работы с HTML.

    Все методы статические для удобства использования.
    """

    @staticmethod
    def clean_html(content: str) -> str:
        """
        Удаляет все HTML-теги и декодирует HTML-сущности.

        Args:
            content: HTML-контент

        Returns:
            Очищенный plain text
        """
        # Списки (<ul>/<ol>/<li>) -> синтетические <div>-абзацы с маркером
        # («- » / «N. ») — ДО общего перевода границ блоков, чтобы их </div>
        # тоже дали перенос строки (иначе пункты списка склеивались бы в одну
        # строку, см. _convert_lists).
        clean = _convert_lists(content)

        # Границы блоков (div/p) и <br> -> перенос строки (общий шаг с
        # html_to_markdown, см. _convert_block_boundaries); открывающие
        # теги вырезает общий стрип тегов ниже.
        clean = _convert_block_boundaries(clean, "\n")

        # Спец-span'ы редактора: ссылка → «текст (url)», сноска →
        # «якорь (сноска: текст)» — иначе данные атрибутов теряются.
        clean = _resolve_special_spans(clean, lambda inner, url: f"{inner} ({url})")

        # Удаление всех HTML-тегов
        clean = re.sub(r"<[^>]+>", "", clean)

        # Декодирование HTML-сущностей (&nbsp;, &lt; и т.д.)
        clean = html.unescape(clean)

        # Хвостовые переносы от последней границы блока убираем; ведущий
        # перенос (пустая первая строка поля) — легитимен, не трогаем.
        return clean.rstrip()

    @staticmethod
    def html_to_markdown(content: str) -> str:
        """
        Конвертирует HTML в Markdown синтаксис.

        Поддерживает:
        - <b>, <strong> -> **bold**
        - <i>, <em> -> *italic*
        - <u> -> разворачивается (Markdown не поддерживает подчёркивание)
        - <br>/</div>/</p> -> перенос строки (MD hard break "  \\n")
        - <ul>/<ol>/<li> -> markdown-список («- пункт» / «N. пункт»),
          обрамлённый пустой строкой от соседнего контента; вложенные уровни —
          отступ 2 пробела на уровень (маркер тот же, что на уровне 0: буква/
          римское сломали бы markdown-синтаксис нумерованного списка)
        - спец-span'ы редактора: ссылка -> [текст](url), сноска ->
          «якорь (сноска: текст)»

        Узловой парсер (_MarkdownParser): распознанные теги дают разметку, а
        ТЕКСТ узлов экранируется (_escape_md_text) — иначе пользовательский
        `[t](url)` ожил бы ссылкой, а буквальный `<script>` (nh3 хранит его
        как `&lt;…&gt;`) — сырым HTML при рендере .md. В отличие от clean_html
        финального html.unescape НЕТ: сущности декодирует parser (convert_charrefs)
        в handle_data, где текст сразу экранируется.

        Args:
            content: HTML-контент

        Returns:
            Markdown-текст
        """
        # Списки -> синтетические <div>-абзацы с маркером (см. _convert_lists),
        # ДО перевода границ блоков — та же причина, что и в clean_html.
        # blank_line_around=True: список — markdown-разметка, для однозначного
        # распознавания рендерером нужна пустая строка от соседнего контента.
        pre = _convert_lists(content, blank_line_around=True)

        # Границы блоков (div/p) и <br> -> MD hard break тем же 3-шаговым
        # переводом, что и clean_html (_convert_block_boundaries): байт-семантика
        # границ не меняется. Открывающие <div>/<p> отбросит parser.
        pre = _convert_block_boundaries(pre, "  \n")

        parser = _MarkdownParser()
        parser.feed(pre)
        parser.close()

        # Хвостовые переносы от последней границы блока убираем; ведущий
        # перенос (пустая первая строка поля) — легитимен, не трогаем.
        return parser.result().rstrip()

    @staticmethod
    def extract_style_property(
            html_element: str,
            property_name: str,
            default: str = "",
    ) -> str:
        """
        Извлекает значение CSS-свойства из style атрибута.

        Args:
            html_element: HTML-строка элемента
            property_name: Имя CSS-свойства (например, 'text-align')
            default: Значение по умолчанию

        Returns:
            Значение свойства или default
        """
        # Извлечение style атрибута
        style_match = re.search(r'style=["\']([^"\']*)["\']', html_element)
        if not style_match:
            return default

        style_str = style_match.group(1)

        # Поиск конкретного свойства
        prop_pattern = rf"{re.escape(property_name)}\s*:\s*([^;]+)"
        prop_match = re.search(prop_pattern, style_str)

        return prop_match.group(1).strip() if prop_match else default

    @staticmethod
    def parse_style_dict(style_string: str) -> dict[str, str]:
        """
        Парсит CSS-строку стилей в словарь.

        Args:
            style_string: CSS строка (например, 'color: red; font-size: 14px')

        Returns:
            Словарь {property: value}
        """
        styles: dict[str, str] = {}
        if not style_string:
            return styles

        for item in style_string.split(";"):
            if ":" not in item:
                continue

            prop, value = item.split(":", 1)
            styles[prop.strip()] = value.strip()

        return styles
