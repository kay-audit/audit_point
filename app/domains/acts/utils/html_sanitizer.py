"""
Санитизация HTML-контента пользовательских полей акта.

Защищает от XSS: textBlock.content, узлы дерева (node.content) и rich-поля
нарушения (violated/established, reasons/measures/consequences/responsible —
состав см. ``violation_fields.VIOLATION_FIELDS``, флаг ``rich``;
additionalContent.items[] типов case/freeText — поле content, типа image —
поле caption, Task 6) — везде реальный HTML, который рендерится через
innerHTML на фронте и парсится inline.py при DOCX-экспорте. textBlock/tree
чистит sanitize_html (bleach), rich-поля нарушения — sanitize_rich_html
(nh3, см. его докстринг).

Plain-text поля нарушения (descriptionList.items[],
additionalContent.items[].filename/url) через этот модуль НЕ
чистятся: нигде не рендерятся как innerHTML (превью — textContent, DOCX —
add_run литерально), поэтому bleach/nh3 там не нужны и вредны — портили бы
текст («&» → «&amp;») и могли терять его часть («a<b» трактовался как
начало тега).

Whitelist тегов/атрибутов согласован с фронтовым рендерингом через
innerHTML. Опасные теги (script/iframe/svg/object) и on*-обработчики
выкусываются, javascript:-схемы протокол-фильтр блокирует.
"""

from __future__ import annotations

import re
from functools import lru_cache

import bleach
import nh3
from bleach.css_sanitizer import CSSSanitizer
from bleach.html5lib_shim import Filter
from bleach.sanitizer import Cleaner

from app.domains.acts.violation_fields import VIOLATION_FIELDS


# Фолбэк-дефолты allowlist'а (импорт-тайм/тесты, пока реестр настроек пуст).
# ИСТОЧНИК ИСТИНЫ в рантайме — ACTS__SANITIZER__* (settings.py:SanitizerSettings);
# bleach-конфиг собирается из настроек в каждом sanitize_html (см. _sanitizer_cfg).
# Дефолты SanitizerSettings обязаны совпадать с этими константами.
_FALLBACK_TAGS = [
    "p", "br", "b", "strong", "i", "em", "u", "s", "strike", "del", "span", "a",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "div",
]

# Whitelist CSS-свойств для inline-style. Соответствует тому, что реально
# эмитит/читает редактор текстблоков (textblock-toolbar.js: span.style.fontSize
# + execCommand bold/italic/underline/strikeThrough; textblock-formatting.js:
# parent.style.{fontSize,fontWeight,fontStyle,textDecoration,color,backgroundColor}).
# Всё прочее (position, behavior, url(...) и т.п.) CSSSanitizer вырежет.
_FALLBACK_CSS = [
    "font-size",
    "color",
    "background-color",
    "font-weight",
    "font-style",
    "text-decoration",
    # Внешний контент шлёт зачёркивание и так: без него DOCX-парсер
    # (inline.py _STRIKE_RE) ловит line-through, но bleach срезал бы свойство.
    "text-decoration-line",
    # TB-1: per-line выравнивание — execCommand justify* пишет text-align в
    # style блочных элементов; без свойства центрирование пропадало на PUT.
    "text-align",
]

# data-footnote-* / data-link-* несут текст сноски и URL ссылки — без них
# DOCX-экспорт теряет содержимое при сохранении контента. Значения безопасны:
# фронт рендерит их через textContent/escapeHtml, экспорт фильтрует протокол
# ссылки (см. inline.py).
_FALLBACK_DATA_ATTRS = [
    "data-footnote-id", "data-footnote-text",
    "data-link-id", "data-link-url",
]

ALLOWED_PROTOCOLS = ["http", "https", "mailto"]


def _acts_settings():
    """ActsSettings из реестра; на старте/в тестах (реестр пуст) — дефолты.

    Ленивый импорт: модуль импортируется задолго до discover_domains, а реестр
    заполняется на старте. Санитизация зовётся на save-пути (реестр уже жив),
    поэтому читать настройки внутри безопасно.
    """
    try:
        from app.core.settings_registry import get as _get
        from app.domains.acts import DOMAIN_NAME
        from app.domains.acts.settings import ActsSettings
        return _get(DOMAIN_NAME, ActsSettings)
    except Exception:
        from app.domains.acts.settings import ActsSettings
        return ActsSettings()


def _sanitizer_cfg():
    """Текущий allowlist санитайзера (теги/css/data-атрибуты) из настроек."""
    return _acts_settings().sanitizer


@lru_cache(maxsize=8)
def _css_sanitizer_for(props: tuple[str, ...]) -> CSSSanitizer:
    """CSSSanitizer для текущего набора CSS-свойств (кэш по кортежу).

    Без css_sanitizer bleach 6.x вырезает значение style целиком и сыпет
    NoCssSanitizerWarning на каждый clean(); пересоздавать его на каждый clean
    дорого. Свойства теперь из настроек, поэтому кэшируем по кортежу свойств.
    """
    return CSSSanitizer(allowed_css_properties=list(props))


# TB-1 (per-tag политика): блочные теги несут ТОЛЬКО text-align с
# enum-значением — зеркало фактического контракта редактора: font-size
# эмитится на span (Range-хирургия), text-align — на блоках (execCommand
# justify*). div-level font-size отрисовался бы превью, но DOCX его
# игнорирует (_extract_size_pt читается только у span) — был бы новый шов
# превью↔экспорт. Зеркало фронта — BLOCK_STYLE_TAGS в sanitize.js.
_BLOCK_STYLE_TAGS = frozenset({"div", "p"})
# Значение — строго enum: мусор (inherit/start/left-x) срезает style целиком.
_BLOCK_TEXT_ALIGN_RE = re.compile(
    r"(?:^|;)\s*text-align\s*:\s*(left|center|right|justify)\s*(?:;|$)",
    re.IGNORECASE,
)


class _BlockStyleFilter(Filter):
    """Пост-фильтр токенов bleach: у div/p оставляет в style только text-align.

    CSSSanitizer per-tag не умеет (режет по общему allowlist до этого шага) —
    фильтр идёт по уже санитизированному токен-потоку перед сериализацией и
    перезаписывает style блочных тегов; без валидного text-align атрибут
    снимается целиком.
    """

    def __iter__(self):
        for token in super().__iter__():
            if (
                token.get("type") in ("StartTag", "EmptyTag")
                and token.get("name") in _BLOCK_STYLE_TAGS
            ):
                data = token.get("data") or {}
                key = (None, "style")
                if key in data:
                    match = _BLOCK_TEXT_ALIGN_RE.search(data[key] or "")
                    if match:
                        data[key] = f"text-align: {match.group(1).lower()}"
                    else:
                        del data[key]
            yield token


# TB-6: мягкий кламп font-size к [min,max] из настроек. Кламп — по px (редактор
# эмитит именно px); значение в диапазоне остаётся дословным — паритетные
# фикстуры (font-size: 20px) не переформатируются. Не-px размер (pt/em/%/rem)
# редактор не создаёт — он приходит из прямого API/внешней вставки и убирается
# целиком (_strip_nonpx_font_size), иначе обошёл бы границы (500pt проходит мимо
# клампа) и рассогласовал превью↔DOCX (em/%/rem превью рендерит, inline._SIZE_RE
# роняет).
_FONT_SIZE_PX_RE = re.compile(
    r"font-size\s*:\s*(\d+(?:\.\d+)?)\s*px",
    re.IGNORECASE,
)

# Одно объявление font-size с единицей ≠ px (или без единицы) внутри style —
# вместе с примыкающим ';', чтобы не осталось пустой декларации. Негативный
# lookahead пропускает валидный <N>px (его обрабатывает кламп).
_FONT_SIZE_NONPX_DECL_RE = re.compile(
    r"font-size\s*:\s*(?!\s*\d+(?:\.\d+)?\s*px\b)[^;]*;?",
    re.IGNORECASE,
)


def _strip_nonpx_font_size(style: str) -> str:
    """Убирает из style объявления font-size в НЕ-px единицах (pt/em/%/rem…).

    Редактор эмитит размер только в px; не-px приходит из прямого API/внешней
    вставки. Оставленный, он либо обошёл бы границы клампа (font-size:500pt), либо
    рассогласовал превью↔DOCX (em/%/rem превью показывает, а inline._SIZE_RE не
    распознаёт). Удаляем объявление целиком — оба рендера падают на базовый
    размер. px не трогаем: его зажимает _clamp_font_size_px.
    """
    return _FONT_SIZE_NONPX_DECL_RE.sub("", style)


def _clamp_font_size_px(style: str, min_px: int, max_px: int) -> str:
    """Зажимает каждое font-size:<N>px в style-строке к [min_px, max_px].

    В диапазоне — возвращает исходное совпадение без изменений (не
    переформатирует). Вне — переписывает границей (целое из настроек).
    """

    def _repl(match: re.Match) -> str:
        value = float(match.group(1))
        clamped = min(float(max_px), max(float(min_px), value))
        if clamped == value:
            return match.group(0)
        num = int(clamped) if clamped == int(clamped) else clamped
        return f"font-size: {num}px"

    return _FONT_SIZE_PX_RE.sub(_repl, style)


class _FontSizeClampFilter(Filter):
    """Пост-фильтр токенов bleach: мягко зажимает font-size в inline-style к
    границам [font_size_min, font_size_max] из настроек (TB-6).

    Числовой проход после bleach/CSSSanitizer: легаси-контент, прямой API или
    внешняя вставка могли принести размер вне диапазона редактора — санитайзер
    приводит его к границе, а НЕ отвергает акт (после вырезания formatting-
    объекта серверная схема размер не валидирует). Границы читаются из настроек
    на каждый clean (реестр уже жив на save-пути; в тестах — дефолты 8/72).
    div/p сюда доходят уже без font-size (его снял _BlockStyleFilter), поэтому
    практически затрагивает span.
    """

    def __iter__(self):
        tb = _acts_settings().textblocks
        min_px, max_px = tb.font_size_min, tb.font_size_max
        for token in super().__iter__():
            if token.get("type") in ("StartTag", "EmptyTag"):
                data = token.get("data") or {}
                key = (None, "style")
                style = data.get(key)
                if style and "font-size" in style.lower():
                    style = _strip_nonpx_font_size(style)
                    style = _clamp_font_size_px(style, min_px, max_px)
                    # Осталась пустая/только-разделители строка (был лишь не-px
                    # font-size) — снимаем style целиком.
                    if style.strip(" ;\t\r\n"):
                        data[key] = style
                    else:
                        data.pop(key, None)
            yield token


def sanitize_html(html: str | None) -> str:
    """
    Чистит произвольный HTML до безопасного подмножества.

    Возвращает пустую строку для None/пустых значений. Не-строковые
    значения приводятся к str(): защитный fallback для случаев, когда
    Pydantic пропустил неожиданный тип.

    Теги/CSS-свойства/data-атрибуты берутся из настроек ACTS__SANITIZER__*
    в рантайме (единый источник с фронтом, B-5).
    """
    if html is None:
        return ""
    if not isinstance(html, str):
        html = str(html)
    if not html:
        return ""
    cfg = _sanitizer_cfg()
    attributes = {
        "a": ["href", "title"],
        "span": ["class", "style", *cfg.allowed_data_attrs],
        # TB-1: style на блочных тегах несёт per-line text-align; состав
        # свойств режет до единственного text-align пост-фильтр
        # _BlockStyleFilter (CSSSanitizer до него — по общему allowlist).
        "div": ["class", "style"],
        "p": ["class", "style"],
        "*": ["class"],
    }
    # Cleaner вместо bleach.clean ради filters= (bleach.clean собирает такой
    # же Cleaner на каждый вызов — по цене эквивалентно).
    cleaner = Cleaner(
        tags=cfg.allowed_tags,
        attributes=attributes,
        protocols=ALLOWED_PROTOCOLS,
        css_sanitizer=_css_sanitizer_for(tuple(cfg.allowed_css_properties)),
        strip=True,
        # _BlockStyleFilter первым (снимает font-size с div/p), затем кламп
        # оставшихся (на span) к границам настроек — TB-6.
        filters=[_BlockStyleFilter, _FontSizeClampFilter],
    )
    return cleaner.clean(html)


def _rich_attribute_filter(tag: str, attr: str, value: str) -> str | None:
    """attribute_filter для nh3.clean (sanitize_rich_html): per-tag правила style.

    nh3 не поддерживает bleach-подобные пост-фильтры токен-потока — вместо
    _BlockStyleFilter/_FontSizeClampFilter та же логика (TB-1/TB-6) применяется
    здесь per-атрибут, после общего filter_style_properties. Возврат None
    снимает атрибут целиком (как del в _BlockStyleFilter).
    """
    if attr != "style":
        return value
    if tag in _BLOCK_STYLE_TAGS:
        match = _BLOCK_TEXT_ALIGN_RE.search(value or "")
        return f"text-align: {match.group(1).lower()}" if match else None
    tb = _acts_settings().textblocks
    style = _clamp_font_size_px(
        _strip_nonpx_font_size(value or ""), tb.font_size_min, tb.font_size_max
    )
    style = style.strip(" ;\t\r\n")
    return style or None


def sanitize_rich_html(html: str | None) -> str:
    """
    Чистит rich-HTML полей нарушения (описание/меры/последствия и т.п.) до
    безопасного подмножества через nh3 — allowlist тот же (ACTS__SANITIZER__*),
    что у sanitize_html и фронтового DOMPurify, но движок другой: nh3
    (Rust/ammonia) вместо bleach.

    Отдельная функция, а не замена sanitize_html: текстблоки (Option A)
    остаются на bleach — своя история регрессий (TB-1/TB-6/B-5), рисковать
    их покрытием ради унификации движка не нужно. sanitize_rich_html — под
    rich-редактор полей нарушения (1.2.x).

    link_rel=None: без этого nh3 сам добавляет rel="noopener noreferrer" на
    каждый <a>, а ни bleach (sanitize_html), ни фронтовый DOMPurify этого не
    делают — по умолчанию получилось бы новое расхождение рендер↔экспорт для
    ссылочных капсул (data-link-*).

    Неидемпотентна на обычном тексте: "&" сериализуется как "&amp;" (как и в
    sanitize_html) — ожидаемое поведение HTML-санитайзера, вход/выход всегда
    HTML, а не plain text.

    Возвращает пустую строку для None/пустых значений; не-строковые значения
    приводятся к str() (тот же защитный fallback, что в sanitize_html).
    """
    if html is None:
        return ""
    if not isinstance(html, str):
        html = str(html)
    if not html:
        return ""
    cfg = _sanitizer_cfg()
    return nh3.clean(
        html,
        tags=set(cfg.allowed_tags),
        attributes={
            "a": {"href", "title"},
            "span": {"class", "style", *cfg.allowed_data_attrs},
            "div": {"class", "style"},
            "p": {"class", "style"},
            "*": {"class"},
        },
        attribute_filter=_rich_attribute_filter,
        filter_style_properties=set(cfg.allowed_css_properties),
        url_schemes={"http", "https", "mailto"},
        strip_comments=True,
        link_rel=None,
    )


def sanitize_plain_text(text: str | None) -> str:
    """
    Чистит plain-текстовое поле: вырезает ВСЕ теги (пустой whitelist).

    Для полей, которые по контракту — просто текст (строки descriptionList,
    подпись/имя файла картинки): HTML-теги в них не легитимны, поэтому
    выкусываются целиком, остаточные спецсимволы bleach экранирует.
    """
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    if not text:
        return ""
    return bleach.clean(text, tags=[], attributes={}, strip=True)


def sanitize_tree_nodes(node: dict) -> None:
    """Рекурсивно чистит content в узлах дерева (узлы хранятся как dict)."""
    if not isinstance(node, dict):
        return
    if "content" in node and node["content"] is not None:
        node["content"] = sanitize_html(node["content"])
    children = node.get("children")
    if isinstance(children, list):
        for child in children:
            sanitize_tree_nodes(child)


def _sanitize_violation_obj(v) -> None:
    """Чистит rich-поля одного нарушения (объектная форма — ViolationSchema).

    Реестр-driven обход VIOLATION_FIELDS: чистятся только поля с rich=True
    (violated/established/reasons/measures/consequences/responsible), через
    sanitize_rich_html. Отдельно — rich-поля элементов additionalContent (не в
    реестре, item-level): content у case/freeText, caption у image (Task 6).
    Plain-поля (descriptionList.items[], filename/url элементов
    additionalContent) не трогаются — см. докстринг sanitize_act_data.
    """
    for f in VIOLATION_FIELDS:
        if not f.rich:
            continue
        if f.kind == "pair":
            setattr(v, f.key, sanitize_rich_html(getattr(v, f.key)))
        elif f.kind == "optional_text":
            sub = getattr(v, f.key)
            sub.content = sanitize_rich_html(sub.content)

    # additionalContent — дескриптор rich=False (контейнер), но его
    # case/freeText-элементы несут rich-текст и чистятся по типу item,
    # независимо от флага контейнера; у image caption теперь тоже rich
    # (Task 6, rich-редактор подписи) — может быть None (легаси-данные без
    # подписи), тогда не трогаем; filename/url — plain, не трогаем.
    for it in v.additionalContent.items:
        if it.type in ("case", "freeText"):
            it.content = sanitize_rich_html(it.content)
        elif it.type == "image" and it.caption is not None:
            it.caption = sanitize_rich_html(it.caption)


def _sanitize_violation_dict(v: dict) -> None:
    """Зеркало _sanitize_violation_obj для dict-формы (restore pre-snapshot путь)."""
    if not isinstance(v, dict):
        return
    for f in VIOLATION_FIELDS:
        if not f.rich:
            continue
        if f.kind == "pair":
            if f.key in v:
                v[f.key] = sanitize_rich_html(v.get(f.key))
        elif f.kind == "optional_text":
            sub = v.get(f.key)
            if isinstance(sub, dict) and "content" in sub:
                sub["content"] = sanitize_rich_html(sub.get("content"))

    additional = v.get("additionalContent")
    items = additional.get("items") if isinstance(additional, dict) else None
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict) and it.get("type") in ("case", "freeText"):
                it["content"] = sanitize_rich_html(it.get("content"))
            elif isinstance(it, dict) and it.get("type") == "image" and it.get("caption") is not None:
                it["caption"] = sanitize_rich_html(it.get("caption"))


def sanitize_act_data(data) -> None:
    """
    Чистит HTML-поля ActDataSchema до безопасного подмножества.

    Изменяет объект на месте. Покрывает:
    - textBlocks[*].content
    - tree nodes[*].content (рекурсивно — узлы могут содержать HTML)
    - violations[*] — rich-поля по реестру VIOLATION_FIELDS (violated/
      established/reasons/measures/consequences/responsible,
      additionalContent.items[] типов case/freeText, типа image — caption,
      Task 6) через sanitize_rich_html (см. _sanitize_violation_obj).

    Plain-text поля нарушения (descriptionList.items[], additionalContent.
    items[].filename) СОЗНАТЕЛЬНО не трогаются: нигде не рендерятся
    как innerHTML, bleach/nh3 там только портили бы текст и теряли его часть
    (см. модульный docstring и TestSaveContentViolationRichFieldsSanitized).

    url элементов additionalContent тоже не чистится: его формат
    (data:image-whitelist + лимит длины) валидирует ViolationContentItemSchema,
    а санитайзер исказил бы base64-данные.
    """
    for block in data.textBlocks.values():
        block.content = sanitize_html(block.content)

    sanitize_tree_nodes(data.tree)

    for v in data.violations.values():
        _sanitize_violation_obj(v)


def sanitize_act_content_dict(content: dict) -> None:
    """
    Чистит HTML-поля контента в dict-форме {tree, textBlocks, violations}.

    Зеркало sanitize_act_data для контента, загруженного из БД как plain-dict
    (pre-snapshot в AuditLogService.restore_version, pbe-6): состав очищаемых
    полей тот же — textBlocks/tree/violations (rich-поля по реестру, см.
    _sanitize_violation_dict). Таблицы и plain-поля нарушений не трогаются —
    хранятся дословно (см. docstring sanitize_act_data). Изменяет dict на
    месте; отсутствующие ключи пропускает, новых не добавляет.
    """
    if not isinstance(content, dict):
        return

    for block in (content.get("textBlocks") or {}).values():
        if isinstance(block, dict) and "content" in block:
            block["content"] = sanitize_html(block["content"])

    tree = content.get("tree")
    if isinstance(tree, dict):
        sanitize_tree_nodes(tree)

    for v in (content.get("violations") or {}).values():
        if isinstance(v, dict):
            _sanitize_violation_dict(v)
