"""
Санитизация HTML-контента пользовательских полей акта.

Защищает от XSS: textBlock.content, узлы дерева (node.content) и блоки
полей нарушения (10 полей реестра ``violation_fields.VIOLATION_FIELDS``,
блочная модель ``{enabled, blocks}`` — content text-блока и caption
image-блока несут реальный HTML, который рендерится через innerHTML на
фронте и парсится inline.py при DOCX-экспорте). textBlock/tree чистит
sanitize_html (bleach), блоки полей нарушения — sanitize_rich_html (nh3,
см. его докстринг).

Plain-text поля image-блока (url/filename) через этот модуль НЕ чистятся:
нигде не рендерятся как innerHTML (DOCX — add_run литерально), поэтому
bleach/nh3 там не нужны и вредны — портили бы текст («&» → «&amp;») и
могли терять его часть («a<b» трактовался как начало тега). Ячейки
table-блока — тот же инвариант, что у больших таблиц акта (B8): рендерятся
только как текст (textContent/add_run), поэтому санитайзер их не трогает.

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


# TB-6: мягкий кламп font-size к [min,max] из настроек. Единица контракта —
# ПУНКТЫ: редактор эмитит pt, границы настроек — тоже pt, и ровно это число
# уходит в Word. Значение в диапазоне остаётся дословным — паритетные фикстуры
# (font-size: 20pt) не переформатируются.
#
# px редактор не создаёт — он приходит из прямого API/внешней вставки (Word,
# браузер), и вырезать его молча значило бы терять заданный автором кегль.
# Поэтому px КОНВЕРТИРУЕТСЯ в pt (×0.75) и клампится наравне с pt: превью и
# DOCX (inline._SIZE_RE читает обе единицы) получают одно значение.
#
# Прочие единицы (em/%/rem/без единицы) убираются целиком
# (_strip_unsupported_font_size): относительный размер не с чем сравнивать при
# клампе, а превью его отрисовало бы — был бы шов превью↔DOCX.
_PX_TO_PT = 0.75

# Объявление font-size в поддержанной единице (pt — как есть, px — с
# конвертацией). Зеркало inline._SIZE_RE DOCX-экспорта.
_FONT_SIZE_RE = re.compile(
    r"font-size\s*:\s*(\d+(?:\.\d+)?)\s*(pt|px)",
    re.IGNORECASE,
)

# Одно объявление font-size с неподдержанной единицей (или без единицы) внутри
# style — вместе с примыкающим ';', чтобы не осталось пустой декларации.
# Негативный lookahead пропускает валидные <N>pt/<N>px (их обрабатывает кламп).
_FONT_SIZE_OTHER_DECL_RE = re.compile(
    r"font-size\s*:\s*(?!\s*\d+(?:\.\d+)?\s*(?:pt|px)\b)[^;]*;?",
    re.IGNORECASE,
)


def _strip_unsupported_font_size(style: str) -> str:
    """Убирает из style объявления font-size в единицах кроме pt/px (em/%/rem…).

    Относительный размер невозможно зажать границами [min,max] (они в pt), а
    превью его отрисовало бы — DOCX (inline._SIZE_RE) нет. Удаляем объявление
    целиком: оба рендера падают на базовый размер. pt/px не трогаем — их
    приводит к пунктам и зажимает _clamp_font_size_pt.
    """
    return _FONT_SIZE_OTHER_DECL_RE.sub("", style)


def _clamp_font_size_pt(style: str, min_pt: int, max_pt: int) -> str:
    """Приводит каждое font-size в style-строке к пунктам и зажимает к [min,max].

    pt в диапазоне — возвращает исходное совпадение без изменений (не
    переформатирует). px — всегда переписывает пунктами (×0.75), даже если
    результат в диапазоне: единица контракта одна. Вне диапазона — граница
    из настроек.
    """

    def _repl(match: re.Match) -> str:
        value = float(match.group(1))
        unit = match.group(2).lower()
        size_pt = value * _PX_TO_PT if unit == "px" else value
        clamped = min(float(max_pt), max(float(min_pt), size_pt))
        if unit == "pt" and clamped == value:
            return match.group(0)
        num = int(clamped) if clamped == int(clamped) else clamped
        return f"font-size: {num}pt"

    return _FONT_SIZE_RE.sub(_repl, style)


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
        min_pt, max_pt = tb.font_size_min, tb.font_size_max
        for token in super().__iter__():
            if token.get("type") in ("StartTag", "EmptyTag"):
                data = token.get("data") or {}
                key = (None, "style")
                style = data.get(key)
                if style and "font-size" in style.lower():
                    style = _strip_unsupported_font_size(style)
                    style = _clamp_font_size_pt(style, min_pt, max_pt)
                    # Осталась пустая/только-разделители строка (был лишь
                    # неподдержанный font-size) — снимаем style целиком.
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
    style = _clamp_font_size_pt(
        _strip_unsupported_font_size(value or ""), tb.font_size_min, tb.font_size_max
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


# Единственный атрибут блока, несущий rich-HTML, по типу блока.
#
# ``text`` → ``content``, ``image`` → ``caption``: обоим нужна ровно одна и та
# же обработка, различалось только имя атрибута (V20 — две побайтово
# одинаковые функции).
#
# Чего в карте НЕТ и почему:
#  - ``table`` — ячейки встроенной таблицы хранятся дословно, тот же инвариант
#    B8, что у больших таблиц акта (см. TestSaveContentTableCellsStoredVerbatim
#    в tests/security/test_xss_act_content_backend.py): все потребители
#    рендерят ячейку как текст (textContent/add_run), а не как HTML, поэтому
#    санитизация была бы не нужна и вредна (портила бы легитимные "<", "&");
#  - ``url``/``filename`` image-блока — plain-текст, нигде не рендерятся как
#    innerHTML (DOCX — add_run литерально), формат url валидирует схема;
#    санитайзер исказил бы base64-данные.
_RICH_ATTR_BY_BLOCK_TYPE = {"text": "content", "image": "caption"}


def _sanitize_rich_attr(block, attr: str) -> None:
    """Чистит один rich-HTML-атрибут блока — общий для объектной и dict-формы.

    dict-форма: отсутствующий ключ не появляется, явный None не подменяется
    на '' (V18/#11 — легитимное отсутствие значения не должно маскироваться
    санитайзером). obj-форма (Pydantic ``ViolationTextBlockSchema`` /
    ``ViolationImageBlockSchema``) шлёт значение уже строкой (дефолт ""),
    None там не встречается — гард на этом пути защитный, на случай прямого
    вызова с сырым объектом.
    """
    if isinstance(block, dict):
        if attr in block and block.get(attr) is not None:
            block[attr] = sanitize_rich_html(block.get(attr))
    else:
        value = getattr(block, attr, None)
        if value is not None:
            setattr(block, attr, sanitize_rich_html(value))


def _sanitize_block(block) -> None:
    """Диспетчер по типу блока поля нарушения (text/image/table).

    Тип → атрибут по карте ``_RICH_ATTR_BY_BLOCK_TYPE`` (там же — почему
    table и plain-поля картинки не чистятся). Тип вне карты — пропуск без
    изменений: 422 на такой блок отбивает схема раньше, санитайзер не место
    для валидации.
    """
    block_type = block.get("type") if isinstance(block, dict) else getattr(block, "type", None)
    # isinstance-гард: в dict-форме (restore из БД) type — произвольный JSON,
    # а нехешируемое значение уронило бы .get() на TypeError.
    attr = _RICH_ATTR_BY_BLOCK_TYPE.get(block_type) if isinstance(block_type, str) else None
    if attr is not None:
        _sanitize_rich_attr(block, attr)


def _sanitize_violation_common(v) -> None:
    """Единственный источник семантики обхода нарушения — общий для обj- и
    dict-формы (V18: копии walker'ов расходились, гард в одной из веток не
    зеркалился в другую).

    Цикл по реестру VIOLATION_FIELDS (все 10 полей — единая форма
    ``{enabled, blocks}``, санитизация не зависит от mandatory/small) →
    по блокам поля → _sanitize_block. Отсутствующее/None-поле или
    blocks не-список — пропускаются без исключения (те же None-гварды,
    что раньше стояли на уровне поля/item, теперь на уровне поля/блока).
    """
    for f in VIOLATION_FIELDS:
        field = v.get(f.key) if isinstance(v, dict) else getattr(v, f.key, None)
        blocks = field.get("blocks") if isinstance(field, dict) else getattr(field, "blocks", None)
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            _sanitize_block(block)


def _sanitize_violation_obj(v) -> None:
    """Чистит rich-блоки одного нарушения (объектная форма — ViolationSchema).

    Реестр-driven обход VIOLATION_FIELDS: по всем 10 полям (единая форма
    ``{enabled, blocks}``) → по блокам поля → text.content и image.caption
    через sanitize_rich_html. table-блоки не трогаются (ячейки хранятся
    дословно, см. докстринг _sanitize_block). image.url/filename — plain,
    не трогаются (см. докстринг sanitize_act_data). Семантика обхода — в
    _sanitize_violation_common (единый источник для обеих форм, см. её
    докстринг).
    """
    _sanitize_violation_common(v)


def _sanitize_violation_dict(v: dict) -> None:
    """Зеркало _sanitize_violation_obj для dict-формы (restore pre-snapshot путь).

    Семантика обхода — в _sanitize_violation_common (единый источник для
    обеих форм, см. её докстринг).
    """
    if not isinstance(v, dict):
        return
    _sanitize_violation_common(v)


def sanitize_act_data(data) -> None:
    """
    Чистит HTML-поля ActDataSchema до безопасного подмножества.

    Изменяет объект на месте. Покрывает:
    - textBlocks[*].content
    - tree nodes[*].content (рекурсивно — узлы могут содержать HTML)
    - violations[*] — блоки всех 10 полей реестра VIOLATION_FIELDS: у
      text-блока content, у image-блока caption — через sanitize_rich_html
      (см. _sanitize_violation_obj).

    Plain-text поля image-блока (url/filename) СОЗНАТЕЛЬНО не трогаются:
    нигде не рендерятся как innerHTML, bleach/nh3 там только портили бы
    текст и теряли его часть (см. модульный docstring). url валидирует
    ViolationImageBlockSchema (data:image-whitelist + лимит длины) —
    санитайзер исказил бы base64-данные.

    Ячейки table-блока тоже не трогаются — тот же инвариант, что у больших
    таблиц акта (B8, см. докстринг _sanitize_block).
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
    полей тот же — textBlocks/tree/violations (rich-блоки по реестру, см.
    _sanitize_violation_dict). Таблицы (узла и table-блока) и plain-поля
    нарушений не трогаются — хранятся дословно (см. docstring
    sanitize_act_data). Изменяет dict на месте; отсутствующие ключи
    пропускает, новых не добавляет.
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
