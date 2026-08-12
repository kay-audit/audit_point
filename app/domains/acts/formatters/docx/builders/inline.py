"""Inline HTML → docx runs.

Поддерживает <b>, <strong>, <i>, <em>, <u>, <s>/<strike>/<del>,
<span style="font-size: ...">, <span style="text-decoration: line-through">,
<br>, <a href="...">. Блочные теги (<div>/<p>/<li>/<h1>..<h6>) внутри
переданного фрагмента рендерятся как мягкий перенос строки между блоками.
Любой другой тег игнорируется (содержимое сохраняется).

TB-1: ВЕРХНЕУРОВНЕВЫЕ <div>/<p> rich-контента (текстблок, rich-поля нарушения,
подпись картинки, пункты списка) — отдельные абзацы Word со своим
выравниванием из style="text-align". Разбиение делает split_block_segments
(ниже), материализация сегментов в абзацы — общий render_block_segments
(V14, тоже ниже): каждый сегмент → свой w:p → apply_inline_html только для
внутренностей.

Зачёркивание (M.19): Chromium execCommand('strikeThrough') эмитит <strike>
(тег-форма, styleWithCSS в приложении не включается); CSS-форма
text-decoration(-line): line-through поддержана для вставленного извне
контента, прошедшего bleach (text-decoration в ALLOWED_CSS_PROPERTIES).

Спец-разметка редактора текстблоков:
    <span class="text-footnote" data-footnote-text="...">якорь</span>
        → видимый текст + нативная сноска Word после него.
    <span class="text-link" data-link-url="https://...">текст</span>
        → гиперссылка (как <a href>).

Размеры font-size:
    px → pt: умножение на 0.75 (16px → 12pt)
    pt    : без изменений
"""
import re
from html.parser import HTMLParser
from dataclasses import dataclass, replace

from docx.document import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.shared import Pt
from docx.text.paragraph import Paragraph
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE

from app.domains.acts.formatters.docx.footnotes import add_footnote
from app.domains.acts.formatters.docx.styles import Fonts


# Схемы, допустимые во ВНЕШНИХ гиперссылках DOCX. Зеркало фронтового
# validateLinkUrl (textblock-links-footnotes.js): веб, почта, телефон, ftp и
# локальные файлы. Якоря '#...' обрабатываются как ВНУТРЕННИЕ ссылки (w:anchor)
# в _open_hyperlink. javascript:/data:/vbscript: сюда не попадают → текст plain.
_SAFE_LINK_PREFIXES = ("http://", "https://", "mailto:", "tel:", "ftp://", "file:")


def _is_safe_url(href: str) -> bool:
    return href.strip().lower().startswith(_SAFE_LINK_PREFIXES)


@dataclass(frozen=True)
class _RunState:
    bold: bool = False
    italic: bool = False
    underline: bool = False
    strike: bool = False
    size_pt: float = 12.0


_PX_TO_PT = 0.75
# Блочные теги: их граница = перенос строки (Enter в contenteditable → <div>).
_BLOCK_TAGS = frozenset({"div", "p", "li", "h1", "h2", "h3", "h4", "h5", "h6"})
_SIZE_RE = re.compile(r"font-size\s*:\s*(\d+(?:\.\d+)?)\s*(px|pt)", re.IGNORECASE)
# Зачёркивание CSS-формой: и text-decoration, и text-decoration-line.
_STRIKE_RE = re.compile(r"text-decoration(?:-line)?\s*:\s*[^;]*line-through", re.IGNORECASE)


def apply_inline_html(
    paragraph: Paragraph, html: str, base_size_pt: float, *, base_italic: bool = False
) -> None:
    """Парсит html-фрагмент и добавляет runs в paragraph."""
    if not html:
        return
    parser = _InlineParser(paragraph, base_size_pt, base_italic)
    parser.feed(html)
    parser.close()


class _InlineParser(HTMLParser):
    def __init__(self, paragraph: Paragraph, base_size_pt: float, base_italic: bool = False):
        super().__init__(convert_charrefs=True)
        self.paragraph = paragraph
        self.stack: list[_RunState] = [_RunState(size_pt=base_size_pt, italic=base_italic)]
        self._hyperlink: OxmlElement | None = None
        # Параллельно стеку span'ов: что делать при их закрытии.
        # ("footnote", текст) | ("link", None) | ("plain", None)
        self._span_kinds: list[tuple[str, str | None]] = []
        # Был ли уже выведен видимый контент (run/перенос) — чтобы не ставить
        # перенос ПЕРЕД самым первым блоком (иначе пустая первая строка).
        self._produced_output = False
        # BUG-5: следующий текстовый run идёт сразу за номером сноски — его
        # ведущий обычный пробел делаем неразрывным (см. _add_run).
        self._after_footnote_ref = False
        # BUG-3: под выравниванием «по ширине» (w:jc both) Word растягивает
        # ТОЛЬКО обычный пробел U+0020 (U+00A0 не тянется). Разделитель перед
        # словом-якорем сноски тогда растягивается и отрывает блок «слово+номер»
        # от предыдущего слова — под justify делаем его неразрывным (см.
        # _open_span footnote-ветку). Выравнивание известно: formatter.py
        # выставляет paragraph.alignment ДО apply_inline_html.
        self._justify = paragraph.alignment == WD_ALIGN_PARAGRAPH.JUSTIFY
        # BUG-3: последний run параграфа на момент открытия footnote-span —
        # ориентир, чтобы strip хвостового пробела якоря не задел предыдущий run.
        self._footnote_run_before: OxmlElement | None = None
        # #6: перенос-граница блока (<div>/<p>) уже поставлен, а следующий <br>
        # может быть placeholder'ом пустого блока (<div><br></div>) — тогда его
        # НЕ дублируем. Флаг сбрасывается на первом же реальном контенте/переносе.
        self._boundary_break_pending = False
        # Обычный <br> не превращается в w:br НЕМЕДЛЕННО, а откладывается.
        # Браузер не рисует строку для <br> в хвосте непустого блока
        # (<div>a<br></div> = одна строка «a») — решение "нужен ли перенос"
        # переносится на момент СЛЕДУЮЩЕГО вывода: реальный контент
        # материализует его (_flush_soft_break), граница блока замещает его
        # своим переносом (тихий сброс), конец фрагмента роняет его молча.
        self._soft_break_pending = False

    @property
    def state(self) -> _RunState:
        return self.stack[-1]

    def handle_starttag(self, tag, attrs):
        current = self.state
        if tag == "a":
            href = dict(attrs).get("href", "")
            if href and self._open_hyperlink(href):
                self.stack.append(replace(current, underline=True))
                return
            self.stack.append(current)
            return
        if tag in ("b", "strong"):
            self.stack.append(replace(current, bold=True))
        elif tag in ("i", "em"):
            self.stack.append(replace(current, italic=True))
        elif tag == "u":
            self.stack.append(replace(current, underline=True))
        elif tag in ("s", "strike", "del"):
            self.stack.append(replace(current, strike=True))
        elif tag == "span":
            self._open_span(dict(attrs), current)
        elif tag == "br":
            # Void-тег: кадр НЕ пушим (как в handle_startendtag), иначе
            # закрывающий </b> снял бы лишний кадр вместо bold-фрейма и
            # текст после </b> остался бы жирным (H7). </br>, если придёт,
            # игнорируется в handle_endtag.
            self._handle_br()
        elif tag in _BLOCK_TAGS:
            # Граница блока = перенос строки. Перед содержимым нового блока
            # вставляем перенос, но НЕ перед первым (guard по _produced_output).
            # Кадр пушим — парный close-tag снимет его в handle_endtag (len>1).
            if self._produced_output:
                self._add_break()
                # #6: перенос уже стоит; placeholder-<br> пустого блока не дублируем.
                self._boundary_break_pending = True
                # Отложенный хвостовой <br> предыдущего блока замещён этим
                # переносом-границей — сбрасываем БЕЗ материализации, иначе
                # получили бы два переноса вместо одного.
                self._soft_break_pending = False
            self.stack.append(current)
        else:
            self.stack.append(current)

    def handle_startendtag(self, tag, attrs):
        """Обрабатывает self-closing теги вида <br/>."""
        if tag == "br":
            self._handle_br()
        else:
            self.handle_starttag(tag, attrs)
            self.handle_endtag(tag)

    def _open_span(self, attrs: dict, current: "_RunState") -> None:
        """Открывает <span>: footnote-якорь, ссылку или обычный span."""
        cls = attrs.get("class", "")
        if "text-footnote" in cls:
            # BUG-3: под justify разделитель перед словом-якорем делаем
            # неразрывным, иначе блок «слово-якорь + номер» отрывается от
            # предыдущего слова (Word тянет только U+0020).
            if self._justify:
                self._nbsp_trailing_space_before_footnote()
            # Снимок последнего run'а ДО якоря — чтобы strip хвостового пробеля
            # якоря (BUG-3) не задел предыдущий run, если якорь без текста.
            existing_runs = self.paragraph._p.findall(qn("w:r"))
            self._footnote_run_before = existing_runs[-1] if existing_runs else None
            # Якорь рендерим обычным текстом; сноску добавим при закрытии.
            self._span_kinds.append(("footnote", attrs.get("data-footnote-text")))
            # EXP-1: капсула-сноска со своим font-size (увеличенная/уменьшенная) —
            # видимый якорь экспортируется этим кеглем, а не базовым.
            size = _extract_size_pt(attrs)
            self.stack.append(replace(current, size_pt=size) if size else current)
            return
        url = attrs.get("data-link-url", "")
        if "text-link" in cls and url and self._open_hyperlink(url):
            self._span_kinds.append(("link", None))
            # EXP-1: капсула-ссылка со своим font-size — текст ссылки
            # экспортируется этим кеглем (w:sz run'а внутри w:hyperlink).
            size = _extract_size_pt(attrs)
            state = replace(current, underline=True)
            self.stack.append(replace(state, size_pt=size) if size else state)
            return
        size = _extract_size_pt(attrs)
        self._span_kinds.append(("plain", None))
        state = current
        if size:
            state = replace(state, size_pt=size)
        if _STRIKE_RE.search(attrs.get("style", "")):
            state = replace(state, strike=True)
        self.stack.append(state)

    def handle_endtag(self, tag):
        if tag == "br":
            # Void-тег: handle_starttag кадр не пушил — снимать нечего.
            return
        if tag == "a" and self._hyperlink is not None:
            self._close_hyperlink()
        if tag == "span" and self._span_kinds:
            kind, payload = self._span_kinds.pop()
            # EXP-3: критерий пустоты тела сноски — payload.strip() (зеркало
            # фронт-нумерации numberFootnotes: text.trim()). «Пробельная» сноска
            # сноской не становится — иначе экспорт и превью разошлись бы.
            if kind == "footnote" and payload and payload.strip():
                # BUG-3: хвостовой обычный пробел ВНУТРИ якоря (например из
                # вставки Word) дал бы растяжимую щель между якорем и номером
                # под justify — срезаем его перед добавлением сноски.
                self._strip_trailing_anchor_space()
                # footnoteReference вставляется напрямую через paragraph.add_run(),
                # минуя _add_run — отложенный <br> перед бестекстовым якорем
                # иначе не материализовался бы, и номер сноски "прилип" бы
                # к предыдущей строке.
                self._flush_soft_break()
                add_footnote(self.paragraph, payload)
                # Номер сноски только что вставлен — следующий текстовый run
                # должен начинаться с неразрывного пробела (BUG-5).
                self._after_footnote_ref = True
            elif kind == "link":
                self._close_hyperlink()
        if len(self.stack) > 1:
            self.stack.pop()

    def handle_data(self, data):
        if data:
            self._add_run(data)

    def close(self) -> None:
        """Конец фрагмента: хвостовой отложенный <br> невидим (как в браузере
        для <br> в конце непустого блока) — молча роняем его без break'а."""
        super().close()
        self._soft_break_pending = False

    def _add_run(self, text: str) -> None:
        # Защита (гибрид Варианта 2): caret-guard'ы (U+FEFF) — рантайм-only во
        # фронте и стрипаются при сохранении; на случай рассинхрона срезаем их и
        # из DOCX-текста. Заодно срезаем U+200B — якорь размера из applyFontSize
        # (collapsed-caret), намеренно живущий в content, но в <w:t> ему не место
        # (#8): невидимый zero-width не должен утечь в Word.
        if "\uFEFF" in text or "\u200B" in text:
            text = text.replace("\uFEFF", "").replace("\u200B", "")
            if not text:
                return
        # BUG-5: текст сразу после сноски, начинающийся с ОБЫЧНОГО пробела-
        # разделителя, под выравниванием «по ширине» (w:jc both) отрывал бы номер
        # сноски — Word растягивает обычные пробелы. Делаем этот первый пробел
        # неразрывным (U+00A0): номер «прилипает» к последующему слову. Работает
        # для любого контента (старого/нового), т.к. нормализуется на экспорте.
        if self._after_footnote_ref:
            self._after_footnote_ref = False
            if text.startswith(" "):
                text = "\u00A0" + text[1:]
        # #6: \u043F\u043E\u0448\u0451\u043B \u0440\u0435\u0430\u043B\u044C\u043D\u044B\u0439 \u0432\u0438\u0434\u0438\u043C\u044B\u0439 \u043A\u043E\u043D\u0442\u0435\u043D\u0442 \u2014 \u0441\u043D\u0438\u043C\u0430\u0435\u043C \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 placeholder-<br>
        # (\u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 <br> \u0443\u0436\u0435 \u043D\u0430\u0441\u0442\u043E\u044F\u0449\u0438\u0439 \u043F\u0435\u0440\u0435\u043D\u043E\u0441, \u0430 \u043D\u0435 \u043F\u0443\u0441\u0442\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430 \u0431\u043B\u043E\u043A\u0430).
        self._boundary_break_pending = False
        # Перед новым видимым run'ом материализуем отложенный <br>.
        self._flush_soft_break()
        self._produced_output = True
        # Вне <a> используем высокоуровневый API python-docx — он создаёт
        # `w:r` с привычным порядком элементов (важно для обратной совместимости
        # с тестами, читающими p.runs/run.bold/run.font.size).
        if self._hyperlink is None:
            run = self.paragraph.add_run(text)
            run.font.name = Fonts.main
            run.font.size = Pt(self.state.size_pt)
            run.bold = self.state.bold
            run.italic = self.state.italic
            if self.state.underline:
                run.underline = True
            if self.state.strike:
                run.font.strike = True
            return

        # Внутри <a> конструируем `w:r` напрямую через oxml,
        # чтобы родителем стал именно `w:hyperlink`, а не `w:p`.
        r_el = OxmlElement("w:r")
        r_pr = OxmlElement("w:rPr")

        rfonts = OxmlElement("w:rFonts")
        rfonts.set(qn("w:ascii"), Fonts.main)
        rfonts.set(qn("w:hAnsi"), Fonts.main)
        r_pr.append(rfonts)

        sz = OxmlElement("w:sz")
        sz.set(qn("w:val"), str(int(self.state.size_pt * 2)))
        r_pr.append(sz)

        if self.state.bold:
            r_pr.append(OxmlElement("w:b"))
        if self.state.italic:
            r_pr.append(OxmlElement("w:i"))
        if self.state.strike:
            r_pr.append(OxmlElement("w:strike"))
        if self.state.underline:
            u = OxmlElement("w:u")
            u.set(qn("w:val"), "single")
            r_pr.append(u)

        color = OxmlElement("w:color")
        color.set(qn("w:val"), "0563C1")
        r_pr.append(color)

        r_el.append(r_pr)

        t_el = OxmlElement("w:t")
        t_el.set(qn("xml:space"), "preserve")
        t_el.text = text
        r_el.append(t_el)

        self._hyperlink.append(r_el)

    def _handle_br(self) -> None:
        """Перенос от тега <br>.

        #6: если <br> — placeholder пустого блока (<div><br></div>), он идёт
        сразу за переносом-границей блока без промежуточного контента. Граница
        блока уже дала визуальный разрыв этой пустой строки, поэтому <br> НЕ
        дублируем (иначе одна пустая строка превращалась бы в две). Несколько
        пустых блоков подряд остаются несколькими пустыми строками: у каждого
        своя граница-перенос.

        Иначе (обычный <br>) перенос НЕ добавляется немедленно — браузер не
        рисует строку для <br> в хвосте непустого блока (<div>a<br></div> =
        одна строка «a»), а contenteditable часто оставляет такой хвостовой
        <br> после правок. Поэтому решение откладывается (_soft_break_pending)
        до следующего вывода: реальный контент материализует его
        (_flush_soft_break), граница блока замещает его своим переносом (тихий
        сброс), конец фрагмента роняет его молча (close()). Два <br> подряд —
        первый флешится реальным переносом (иначе оба слились бы в один при
        следующей материализации), второй взводится заново.
        """
        if self._boundary_break_pending:
            self._boundary_break_pending = False
            return
        self._flush_soft_break()
        self._soft_break_pending = True

    def _flush_soft_break(self) -> None:
        """Материализует отложенный <br> перед новым видимым контентом.

        Без материализации перенос между отложенным <br> и следующим run'ом/
        ссылкой/номером сноски потерялся бы — контент "прилип" бы к предыдущей
        строке вместо начала новой."""
        if self._soft_break_pending:
            self._soft_break_pending = False
            self._add_break()

    def _add_break(self) -> None:
        """Реальный OOXML-перенос строки (<w:br/>).

        Литеральный '\\n' внутри <w:t> Word НЕ интерпретирует как разрыв
        (схлопывает в пробел) — видимый перенос даёт только элемент w:br.
        """
        self._produced_output = True
        if self._hyperlink is None:
            run = self.paragraph.add_run()
            run.font.name = Fonts.main
            run.font.size = Pt(self.state.size_pt)
            run.add_break(WD_BREAK.LINE)
            return
        # Внутри <a>: w:br отдельным w:r внутри w:hyperlink.
        r_el = OxmlElement("w:r")
        r_el.append(OxmlElement("w:br"))
        self._hyperlink.append(r_el)

    def _nbsp_trailing_space_before_footnote(self) -> None:
        """BUG-3: заменяет единственный хвостовой U+0020 текста, ПРИМЫКАЮЩЕГО к
        якорю сноски, на U+00A0 — под justify слово-якорь со своим номером не
        отрывается от предыдущего слова. Несколько пробелов: рвём только
        последний (стык слово↔якорь), более ранние остаются растяжимыми.

        #7: примыкающий элемент ищем по ПОСЛЕДНЕМУ значимому ребёнку <w:p>. Если
        это прямой w:r — правим его хвостовой пробел. Если это w:hyperlink (сноска
        идёт сразу за ссылкой) — НЕ трогаем ничего: прямые w:r лежат ПЕРЕД
        ссылкой и к сноске не примыкают (иначе неразрывили бы чужое слово)."""
        for el in reversed(self.paragraph._p):
            tag = el.tag.rsplit("}", 1)[-1]
            if tag == "hyperlink":
                # Примыкает ссылка, а не прямой run — no-op (как обещает докстринг).
                return
            if tag != "r":
                continue  # pPr / bookmark / прочее — пропускаем
            t = el.find(qn("w:t"))
            if t is None or not t.text:
                continue  # пустой run (например, w:br) — ищем текст глубже
            if t.text.endswith(" "):
                t.text = t.text[:-1] + chr(0xA0)
                t.set(qn("xml:space"), "preserve")
            return

    def _strip_trailing_anchor_space(self) -> None:
        """BUG-3: срезает хвостовые обычные пробелы у текста ЯКОРЯ сноски —
        иначе они дали бы растяжимую щель между якорем и номером под justify.
        Стрипаем только run, добавленный ВНУТРИ footnote-span (сравнение со
        снимком _footnote_run_before), чтобы у пустого якоря не задеть
        предыдущий run."""
        runs = self.paragraph._p.findall(qn("w:r"))
        if not runs:
            return
        last = runs[-1]
        if last is self._footnote_run_before:
            return  # якорь без текста — собственный run не добавлялся
        t = last.find(qn("w:t"))
        if t is not None and t.text and t.text.endswith(" "):
            t.text = t.text.rstrip(" ")

    def _open_hyperlink(self, href: str) -> bool:
        """Создаёт w:hyperlink. Якорь '#...' → внутренняя ссылка (w:anchor),
        безопасная внешняя схема → external relationship (r:id). Небезопасный
        протокол (javascript: и т.п.) отклоняется → текст останется plain.

        Ссылка строится прямым oxml (не нативным API): python-docx 1.2.0 умеет
        гиперссылки только на ЧТЕНИЕ (Paragraph.hyperlinks / класс Hyperlink),
        метода записи add_hyperlink нет. К тому же ссылка-капсула несёт свои
        run'ы с форматированием (цвет, кегль EXP-1, начертание) — простой
        текст+URL их бы не выразил."""
        # Отложенный <br> материализуется здесь, ДО смены self._hyperlink —
        # иначе он попал бы в _add_break() уже с НОВЫМ значением контекста
        # (перенос между двумя ссылками вложился бы во вторую вместо уровня
        # параграфа).
        self._flush_soft_break()
        href = href.strip()
        hyperlink = OxmlElement("w:hyperlink")
        if href.startswith("#"):
            # Внутри-документный якорь (закладка) — без external relationship.
            hyperlink.set(qn("w:anchor"), href[1:])
        elif _is_safe_url(href):
            part = self.paragraph.part
            r_id = part.relate_to(href, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
            hyperlink.set(qn("r:id"), r_id)
        else:
            return False
        self.paragraph._p.append(hyperlink)
        self._hyperlink = hyperlink
        return True

    def _close_hyperlink(self) -> None:
        # Отложенный <br>, вставленный ВНУТРИ ссылки (до </a>), материализуется
        # здесь, ДО сброса self._hyperlink — иначе он "утёк" бы наружу на
        # уровень параграфа вместо того, чтобы остаться внутри w:hyperlink.
        self._flush_soft_break()
        self._hyperlink = None


def _extract_size_pt(attrs: dict) -> float | None:
    style = attrs.get("style", "")
    match = _SIZE_RE.search(style)
    if not match:
        return None
    value = float(match.group(1))
    unit = match.group(2).lower()
    return value * _PX_TO_PT if unit == "px" else value


# ---------------------------------------------------------------------------
# TB-1: разбиение контента текстблока на верхнеуровневые сегменты-абзацы.
# ---------------------------------------------------------------------------

# Void-теги HTML: элемент не открывается, на глубину вложенности не влияют.
# Для сегментации важен <br>; остальные — страховка для легаси-контента.
_VOID_TAGS = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
})

# text-align из inline-style блочного элемента. Прочие значения (start/end/
# -webkit-*) сознательно не распознаются — рендер применит дефолт justify.
_TEXT_ALIGN_RE = re.compile(
    r"text-align\s*:\s*(left|center|right|justify)\b", re.IGNORECASE
)

# Сегмент из одного placeholder-<br> (пустая строка contenteditable:
# <div><br></div>) — сам абзац уже даёт строку, w:br удвоил бы её.
_PLACEHOLDER_BR_RE = re.compile(r"^\s*<br\b[^>]*>\s*$", re.IGNORECASE)


# Списки rich-HTML (V14.1): тег списка → built-in стиль абзаца Word. "List
# Bullet" — тот же стиль, которым уже размечались пункты descriptionList, так
# что оформление акта не меняется. Стиль несёт маркер/нумерацию и отступ; для
# нумерованных списков Word ведёт СКВОЗНУЮ нумерацию стиля "List Number" —
# два отдельных <ol> в одном документе продолжают счёт, а не начинают с 1
# (ограничение built-in стилей, отдельный numId под каждый список не заводим).
LIST_TAG_STYLES = {"ul": "List Bullet", "ol": "List Number"}


@dataclass(frozen=True)
class BlockSegment:
    """Верхнеуровневый «абзац» контента текстблока.

    alignment — значение text-align блочного элемента (None = не задано,
    рендер подставит дефолт justify); html — внутренняя разметка сегмента
    (пустая строка = пустой абзац-строка); list_style — стиль абзаца для
    сегмента-пункта списка (LIST_TAG_STYLES ближайшего <ul>/<ol>), None у
    обычного сегмента.
    """
    alignment: str | None
    html: str
    list_style: str | None = None


# text-align сегмента → выравнивание Word. Потребитель — render_block_segments
# (ниже): текстблок, rich-поля нарушения, подпись картинки, пункты списка;
# дефолт (align=None либо нераспознанное значение) — default_alignment хоста
# через .get().
ALIGNMENT_MAP = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
}


def split_block_segments(html: str) -> list[BlockSegment]:
    """Режет content на верхнеуровневые сегменты-абзацы для DOCX.

    Верхнеуровневый <div>/<p> → отдельный сегмент со своим text-align.
    Смежный контент ВНЕ блочных элементов (голый текст, span «размера на
    каретке», <br> — легаси-разметка) группируется в анонимный сегмент без
    выравнивания: он не теряется, а уходит в абзац с дефолтным justify.
    Вложенные блочные теги остаются внутри html сегмента — apply_inline_html
    рендерит их мягкими переносами w:br, как раньше. Пустой/пробельный
    контент даёт пустой список (рендер сам добавит абзац-строку).

    Списки (V14.1): <ul>/<ol> сами абзаца не дают, а задают list_style своим
    <li>; каждый <li> — отдельный сегмент (свой абзац Word со стилем списка).
    Вложенные списки СПЛЮЩИВАЮТСЯ: пункт вложенного списка становится обычным
    сегментом того же уровня со стилем СВОЕГО списка — текст сохраняется,
    ступенька отступа теряется (built-in стили "List Bullet 2"/"List Number 2"
    сознательно не используются, см. LIST_TAG_STYLES).
    """
    if not html:
        return []
    splitter = _TopLevelSplitter()
    splitter.feed(html)
    splitter.close()
    return splitter.finish()


class _TopLevelSplitter(HTMLParser):
    """Собирает сегменты-абзацы, реконструируя сырой HTML из событий парсера.

    convert_charrefs=False + get_starttag_text: entity-ссылки и атрибуты
    вложенной разметки доезжают до apply_inline_html дословно, без
    повторного экранирования.

    Граница сегмента-абзаца — блочный <div>/<p>, который несёт СВОЁ
    выравнивание, а не только верхнеуровневый (TB-1/S1). Вложенный блок со своим
    text-align уходит в отдельный w:p с этим выравниванием — в браузере он и так
    на своей строке со своим align (text-align наследуется, own-align
    перекрывает). Вложенный блок БЕЗ align остаётся сырым внутри сегмента
    (мягкий перенос w:br, наследует align родителя) — прежнее поведение. Так
    превью (каскад CSS) и DOCX не расходятся по выравниванию.

    Пункт списка <li> — тоже граница сегмента (V14.1): открывающий <ul>/<ol>
    кладёт свой стиль на стек списков, каждый <li> внутри становится
    контейнером с этим стилем. Сам <ul>/<ol> абзаца не даёт.
    """

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self._segments: list[BlockSegment] = []
        self._buf: list[str] = []
        # Стек открытых блоков-КОНТЕЙНЕРОВ (границ сегмента): элемент —
        # [align, emitted_child, list_style]. Пусто = верхний уровень
        # (анонимный сегмент).
        self._ctx_stack: list[list] = []
        # Стек открытых <ul>/<ol>: элемент — (стиль абзаца, глубина _ctx_stack
        # на момент открытия). Глубина нужна, чтобы </ul> закрыл незакрытые
        # <li> (частая разметка вида <ul><li>a<li>b</ul>).
        self._list_stack: list[tuple[str, int]] = []
        # Глубина открытых НЕ-контейнерных элементов (span/b/… и вложенных div/p
        # без align) внутри текущего буфера. Пока >0 — мы внутри сырой разметки
        # сегмента, новые div/p там тоже сырые (буфер держим сбалансированным).
        self._inner_depth = 0

    def handle_starttag(self, tag, attrs):
        raw = self.get_starttag_text() or ""
        if tag in _VOID_TAGS:
            self._buf.append(raw)
            return
        if self._inner_depth == 0:
            if tag in LIST_TAG_STYLES:
                self._open_list(LIST_TAG_STYLES[tag])
                return
            if tag == "li" and self._list_stack:
                # Пункт — свой абзац со стилем БЛИЖАЙШЕГО списка: вложенный
                # список сплющивается в тот же уровень (см. split_block_segments).
                # Собственный text-align <li> приоритетнее; при его отсутствии
                # наследуется align объемлющего контейнера (открытого div/p с
                # align — только такие контейнеры и попадают в _ctx_stack, см.
                # ветку "div"/"p" ниже), как в браузере (text-align наследуется).
                own_align = _extract_text_align(dict(attrs))
                inherited_align = own_align if own_align is not None else (
                    self._ctx_stack[-1][0] if self._ctx_stack else None
                )
                self._open_container(
                    inherited_align,
                    list_style=self._list_stack[-1][0],
                )
                return
            if tag in ("div", "p"):
                align = _extract_text_align(dict(attrs))
                # Контейнер: верхнеуровневый блок ЛИБО вложенный со своим align.
                if not self._ctx_stack or align is not None:
                    self._open_container(align)
                    return
        # Прочее (span/b/i/a/hN, <li> вне списка и вложенные div/p без align) —
        # сырьё сегмента.
        self._buf.append(raw)
        self._inner_depth += 1

    def handle_startendtag(self, tag, attrs):
        # Self-closing (<br/>) — элемент не открывается, глубина не растёт.
        self._buf.append(self.get_starttag_text() or "")

    def handle_endtag(self, tag):
        if tag in _VOID_TAGS:
            return
        if self._inner_depth > 0:
            self._inner_depth -= 1
            self._buf.append(f"</{tag}>")
            return
        if tag in LIST_TAG_STYLES and self._list_stack:
            self._close_list()
            return
        if self._ctx_stack:
            self._close_container()
        # else: непарный закрывающий тег на верхнем уровне — игнор.

    def handle_data(self, data):
        if data:
            self._buf.append(data)

    def handle_entityref(self, name):
        self._buf.append(f"&{name};")

    def handle_charref(self, name):
        self._buf.append(f"&#{name};")

    def finish(self) -> list[BlockSegment]:
        """Хвост после конца ввода: закрываем недозакрытые контейнеры и остаток."""
        while self._ctx_stack:
            self._close_container()
        self._flush_anonymous()
        return self._segments

    def _open_container(self, align: str | None, list_style: str | None = None) -> None:
        self._flush_before_block()
        self._ctx_stack.append([align, False, list_style])

    def _close_container(self) -> None:
        inner = _normalize_segment_html("".join(self._buf))
        self._buf.clear()
        align, emitted_child, list_style = self._ctx_stack.pop()
        if inner:
            self._segments.append(BlockSegment(align, inner, list_style))
        elif not emitted_child:
            # Пустой блок-лист = пустая строка-абзац (как <div><br></div>).
            self._segments.append(BlockSegment(align, "", list_style))
        # else: пустой хвост после дочерних сегментов — не плодим пустой абзац.

    def _open_list(self, style: str) -> None:
        """<ul>/<ol>: своего абзаца не даёт, только задаёт стиль пунктам."""
        self._flush_before_block()
        self._list_stack.append((style, len(self._ctx_stack)))

    def _close_list(self) -> None:
        """</ul>/</ol>: закрывает пункты, оставшиеся незакрытыми внутри списка."""
        _, depth = self._list_stack.pop()
        while len(self._ctx_stack) > depth:
            self._close_container()

    def _flush_before_block(self) -> None:
        """Сброс накопленного куска перед новой границей (контейнер/список)."""
        if self._ctx_stack:
            self._flush_partial()          # частичный кусок родителя (его align)
            self._ctx_stack[-1][1] = True  # у родителя появился дочерний сегмент
        else:
            self._flush_anonymous()        # верхнеуровневый анонимный кусок

    def _flush_partial(self) -> None:
        """Кусок текущего контейнера ДО вложенного блока — свой сегмент с align
        и стилем списка контейнера; чисто пробельный кусок пропускаем (браузер
        его схлопывает). Так текст пункта ДО вложенного списка
        (<li>текст<ul>…</ul></li>) остаётся маркированным."""
        text = "".join(self._buf)
        self._buf.clear()
        if not text.strip(" \t\r\n"):
            return
        align, _, list_style = self._ctx_stack[-1]
        self._segments.append(
            BlockSegment(align, _normalize_segment_html(text), list_style)
        )

    def _flush_anonymous(self) -> None:
        text = "".join(self._buf)
        self._buf.clear()
        # Межблочные ASCII-пробелы браузер схлопывает — абзац из них не
        # делаем. &nbsp;/U+00A0 сюда не попадают (не в " \t\r\n").
        if not text.strip(" \t\r\n"):
            return
        self._segments.append(BlockSegment(None, _normalize_segment_html(text)))


def _normalize_segment_html(inner: str) -> str:
    if _PLACEHOLDER_BR_RE.match(inner):
        return ""
    return inner


def _extract_text_align(attrs: dict) -> str | None:
    match = _TEXT_ALIGN_RE.search(attrs.get("style") or "")
    return match.group(1).lower() if match else None


# ---------------------------------------------------------------------------
# V14: общая геометрия «сегменты → абзацы документа» — единственный потребитель
# split_block_segments/ALIGNMENT_MAP/apply_inline_html для ЛЮБОГО rich-контента
# (текстблок, скалярные rich-поля нарушения, подпись картинки, пункты списка).
# ---------------------------------------------------------------------------

def render_block_segments(
    doc: Document,
    html: str,
    *,
    base_size_pt: float,
    base_italic: bool = False,
    default_alignment=WD_ALIGN_PARAGRAPH.JUSTIFY,
    first_paragraph: Paragraph | None = None,
) -> list[Paragraph]:
    """HTML → абзацы документа: единая геометрия рендера для всех хостов.

    Режет html через split_block_segments; каждый сегмент — свой w:p.
    text-align сегмента (ALIGNMENT_MAP) переопределяет default_alignment
    хоста, сегмент без align получает default_alignment (текстблок и
    rich-поля — justify, подпись картинки — center, см. вызывающий код).
    Промежуточные абзацы (бывшие границы w:br) получают space_after=Pt(0);
    последний — без прямого форматирования (наследует Normal), как у
    прежней одноабзацной модели.

    Список из самого HTML (V14.1, <ul>/<ol>) — сегмент-пункт получает СВОЙ
    list_style на любой позиции, включая first_paragraph (метка поля
    «Причины:» тогда стоит внутри первого пункта — маркер у всех пунктов
    списка одинаковый).

    first_paragraph — если хост уже создал первый абзац сам (например,
    _labeled_paragraph уже вписал в него метку "Причины:"), он используется
    повторно для первого сегмента вместо нового doc.add_paragraph(): метка
    остаётся на первом абзаце, продолжения — обычные абзацы без неё.
    """
    segments = split_block_segments(html)
    if not segments:
        # Нет верхнеуровневых сегментов (пустой/пробельный html) — единственный
        # абзац с дефолтным выравниванием; apply_inline_html на исходном html
        # безопасен (no-op на пустой строке).
        para = first_paragraph if first_paragraph is not None else doc.add_paragraph()
        para.alignment = default_alignment
        apply_inline_html(para, html, base_size_pt=base_size_pt, base_italic=base_italic)
        return [para]

    paragraphs: list[Paragraph] = []
    for i, segment in enumerate(segments):
        if i == 0:
            if first_paragraph is not None:
                para = first_paragraph
                if segment.list_style:
                    para.style = segment.list_style
            else:
                para = doc.add_paragraph(style=segment.list_style)
        else:
            para = doc.add_paragraph(style=segment.list_style)
        para.alignment = ALIGNMENT_MAP.get(segment.alignment, default_alignment)
        apply_inline_html(para, segment.html, base_size_pt=base_size_pt, base_italic=base_italic)
        paragraphs.append(para)

    for para in paragraphs[:-1]:
        para.paragraph_format.space_after = Pt(0)
    return paragraphs
