"""
Утилиты для работы с HTML-контентом.

Предоставляет функции для очистки, конвертации и парсинга HTML.
"""

import html
import re

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
        # <br> непосредственно перед закрытием блока (div/p) невидим в
        # браузере (в т.ч. placeholder пустой строки <div><br></div>) —
        # перенос даст сама граница блока (ниже), поэтому такой <br>
        # вырезаем ДО общей замены <br> -> \n, иначе строка задвоится.
        clean = re.sub(
            r"<br\s*/?>\s*(</(?:div|p)>)", r"\1", content, flags=re.IGNORECASE,
        )

        # Замена оставшихся <br> на переносы строк
        clean = re.sub(r"<br\s*/?>", "\n", clean, flags=re.IGNORECASE)

        # Границы блоков (div/p) -> перенос строки; открывающие теги
        # вырезает общий стрип тегов ниже.
        clean = re.sub(r"</(?:div|p)>", "\n", clean, flags=re.IGNORECASE)

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
        - <u> -> удаление (Markdown не поддерживает)
        - <br> -> hard break (два пробела + \\n)

        Args:
            content: HTML-контент

        Returns:
            Markdown-текст
        """
        # <br> непосредственно перед закрытием блока (div/p) невидим в
        # браузере — перенос даст граница блока (ниже), вырезаем ДО общей
        # замены <br> -> hard break, иначе строка задвоится.
        result = re.sub(
            r"<br\s*/?>\s*(</(?:div|p)>)", r"\1", content, flags=re.IGNORECASE,
        )

        # <br> -> Markdown hard break
        result = re.sub(r"<br\s*/?>", "  \n", result, flags=re.IGNORECASE)

        # Границы блоков (div/p) -> Markdown hard break; открывающие теги
        # вырезает общий стрип тегов ниже.
        result = re.sub(r"</(?:div|p)>", "  \n", result, flags=re.IGNORECASE)

        # Спец-span'ы редактора: ссылка → [текст](url), сноска —
        # inline «якорь (сноска: текст)» (без блока сносок: конвертер
        # работает с фрагментом и не знает контекста документа).
        result = _resolve_special_spans(result, lambda inner, url: f"[{inner}]({url})")

        # <b>, <strong> -> **текст**
        result = re.sub(
            r"<(?:b|strong)>(.+?)</(?:b|strong)>",
            r"**\1**",
            result,
            flags=re.DOTALL,
        )

        # <i>, <em> -> *текст*
        result = re.sub(
            r"<(?:i|em)>(.+?)</(?:i|em)>",
            r"*\1*",
            result,
            flags=re.DOTALL,
        )

        # <u> -> текст (underline не поддерживается в Markdown)
        result = re.sub(r"<u>(.+?)</u>", r"\1", result, flags=re.DOTALL)

        # Удаление остальных тегов
        result = re.sub(r"<[^>]+>", "", result)

        # Декодирование HTML-сущностей
        result = html.unescape(result)

        # Хвостовые переносы от последней границы блока убираем; ведущий
        # перенос (пустая первая строка поля) — легитимен, не трогаем.
        return result.rstrip()

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
