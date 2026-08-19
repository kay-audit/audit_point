/**
 * Безопасная вставка HTML.
 *
 * Использует DOMPurify (static/vendor/dompurify/purify.min.js); если vendor
 * не загружен — fallback на `textContent`, чтобы НИ В КАКОМ случае не
 * вставлять непроверенный HTML.
 *
 * Защищает: textblock-editor, preview-violation-renderer, diff-renderer,
 * preview-textblock-renderer, chat-renderer.
 *
 * Профили (5.2.3):
 * - 'acts' — строгий allowlist, СИНХРОННЫЙ с бэк-whitelist
 *   app/domains/acts/utils/html_sanitizer.py (ALLOWED_TAGS/ALLOWED_ATTRS,
 *   включая s/strike/del из M.19 и data-атрибуты ссылок/сносок). Inline-style
 *   дополнительно фильтруется до ALLOWED_CSS_PROPERTIES бэка (ACTS_CSS_PROPERTIES)
 *   хуком afterSanitizeAttributes — превью совпадает с сохранённым/экспортом.
 *   Используется рендерами контента актов (preview-textblock-renderer).
 * - default — прежний blocklist-конфиг: его используют чат (markdown →
 *   strong/em/code/br) и diff-renderer (ins/del) — менять без аудита
 *   потребителей нельзя (shared-модуль).
 */

const DEFAULT_CONFIG = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: [
        'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur',
        'onchange', 'oninput', 'onsubmit', 'onreset', 'onkeydown', 'onkeyup',
        'onkeypress', 'onmousedown', 'onmouseup', 'onmousemove', 'onmouseout',
        'onmouseenter', 'onmouseleave', 'ondblclick', 'oncontextmenu', 'onwheel',
        'onpaste', 'oncopy', 'oncut', 'ondrag', 'ondragstart', 'ondragend',
        'ondragenter', 'ondragleave', 'ondragover', 'ondrop', 'onresize',
        'onscroll', 'onselect', 'ontoggle', 'onanimationstart', 'onanimationend',
        'onanimationiteration', 'ontransitionstart', 'ontransitionend',
        'onbeforeinput', 'onpointerdown', 'onpointerup', 'onpointermove',
        'onpointerover', 'onpointerout', 'onpointerenter', 'onpointerleave',
        'onpointercancel', 'ongotpointercapture', 'onlostpointercapture',
        'ontouchstart', 'ontouchend', 'ontouchmove', 'ontouchcancel',
    ],
};

// Allowlist CSS-свойств для inline-style профиля 'acts' — зеркало бэкового
// ALLOWED_CSS_PROPERTIES (app/domains/acts/utils/html_sanitizer.py). JS не
// импортирует Python — СИНХРОНИЗИРОВАТЬ ВРУЧНУЮ (страж: sanitize-profiles.test.mjs).
// Хардкод-ФОЛБЭК зеркала бэк-whitelist (html_sanitizer.py / SanitizerSettings).
// Источник истины в рантайме — GET /acts/limits (секция sanitizer), применяется
// через applyActsAllowlist(); до ответа сервера и офлайн действует этот фолбэк.
// Страж паритета фолбэка с бэком — tests/js/sanitize-profiles.test.mjs.
export const ACTS_CSS_PROPERTIES = [
    'font-size', 'color', 'background-color',
    'font-weight', 'font-style', 'text-decoration', 'text-decoration-line',
    // TB-1: per-line выравнивание — execCommand justify* пишет text-align
    // в style блочных элементов; без свойства в allowlist превью теряло центр.
    'text-align',
];
const ACTS_TAGS_FALLBACK = [
    'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
    'span', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div',
];
// DOMPurify не разделяет атрибуты по тегам — объединение бэковых
// a[href,title] + span[class,style,data-*] + *[class].
const ACTS_ATTR_FALLBACK = [
    'href', 'title', 'class', 'style',
    'data-footnote-id', 'data-footnote-text',
    'data-link-id', 'data-link-url',
];

// Активный конфиг профиля 'acts' — изначально фолбэк, перезаписывается
// applyActsAllowlist() после ответа /acts/limits. Массивы — КОПИИ, чтобы
// мутация не затронула экспортируемый фолбэк ACTS_CSS_PROPERTIES (страж-тест).
const ACTS_CONFIG = {
    ALLOWED_TAGS: [...ACTS_TAGS_FALLBACK],
    ALLOWED_ATTR: [...ACTS_ATTR_FALLBACK],
    // Кастомный ключ (DOMPurify его игнорирует): allowlist CSS-свойств для
    // хука afterSanitizeAttributes. Только профиль 'acts' его несёт.
    __cssAllowlist: [...ACTS_CSS_PROPERTIES],
};

export const SAFE_HTML_PROFILES = {
    acts: ACTS_CONFIG,
};

/**
 * B-5/Е2: применяет allowlist санитайзера, полученный с GET /acts/limits
 * (секция sanitizer бэка). Перезаписывает активный профиль 'acts'. При
 * расхождении серверного и фолбэк-набора — console.warn (диагностика дрейфа
 * фронт↔бэк), но НЕ падаем: офлайн/ошибка сети → остаётся фолбэк.
 * @param {{allowed_tags?:string[], allowed_css_properties?:string[],
 *          allowed_data_attrs?:string[]}} sanitizerCfg
 */
export function applyActsAllowlist(sanitizerCfg) {
    if (!sanitizerCfg || typeof sanitizerCfg !== 'object') return;
    const { allowed_tags, allowed_css_properties, allowed_data_attrs } = sanitizerCfg;
    if (Array.isArray(allowed_tags) && allowed_tags.length) {
        _warnIfDrift('теги', allowed_tags, ACTS_TAGS_FALLBACK);
        ACTS_CONFIG.ALLOWED_TAGS = [...allowed_tags];
    }
    if (Array.isArray(allowed_css_properties) && allowed_css_properties.length) {
        _warnIfDrift('css', allowed_css_properties, ACTS_CSS_PROPERTIES);
        ACTS_CONFIG.__cssAllowlist = [...allowed_css_properties];
    }
    if (Array.isArray(allowed_data_attrs) && allowed_data_attrs.length) {
        // Бэк отдаёт только data-атрибуты span; фронтовый ALLOWED_ATTR плоский,
        // дополняем базовыми href/title/class/style (паритет составов).
        const merged = ['href', 'title', 'class', 'style', ...allowed_data_attrs];
        _warnIfDrift('атрибуты', merged, ACTS_ATTR_FALLBACK);
        ACTS_CONFIG.ALLOWED_ATTR = merged;
    }
}

function _warnIfDrift(label, server, fallback) {
    const a = [...server].sort().join(',');
    const b = [...fallback].sort().join(',');
    if (a !== b) {
        console.warn(
            `SafeHTML: allowlist '${label}' с сервера расходится с хардкод-фолбэком. `
            + 'Сервер — источник истины; обнови фолбэк в sanitize.js при следующем релизе.',
            { server, fallback },
        );
    }
}

// Активный CSS-allowlist на время одного синхронного вызова DOMPurify.sanitize.
// sanitize синхронен → переинициализации/реентрантности нет; хук читает эту
// переменную и фильтрует node.style до разрешённых свойств (для профиля acts).
let _activeCssAllowlist = null;
let _cssHookRegistered = false;

// TB-1 (per-tag политика): блочные теги несут ТОЛЬКО text-align с
// enum-значением — зеркало фактического контракта редактора: font-size
// эмитится на span (Range-хирургия applyFontSize), text-align — на блоках
// (execCommand justify*). div-level font-size отрисовался бы в превью, но
// DOCX его игнорирует (_extract_size_pt читается только у span) — был бы
// новый шов превью↔экспорт. Зеркало бэка — _BLOCK_STYLE_TAGS в
// html_sanitizer.py.
const BLOCK_STYLE_TAGS = ['div', 'p'];
// Пункт списка — блок с исключением: сверх text-align ему разрешён собственный
// font-size, потому что ::marker наследует кегль от САМОГО <li> (а не от
// вложенного span), и DOCX печатает маркер меткой абзаца из того же значения.
// Прочие свойства пункту не нужны: DOCX их у <li> не читает. Зеркало бэка —
// _ITEM_STYLE_TAGS в html_sanitizer.py.
const ITEM_STYLE_TAGS = ['li'];
const TEXT_ALIGN_VALUES = ['left', 'center', 'right', 'justify'];

/**
 * Пер-элементная фильтрация inline-style профиля с CSS-allowlist: блочным
 * тегам (div/p) остаётся только text-align с enum-значением, пункту списка —
 * text-align плюс собственный font-size (размер маркера), остальным — свойства
 * из allowlist. Чистая функция (страж-тест гоняет её в node без DOM); хук ниже
 * скармливает ей пары из node.style.
 * @param {string} tagName - имя тега (регистр любой)
 * @param {Array<[string,string]>} declarations - пары [свойство, значение]
 * @param {string[]} cssAllowlist - allowlist свойств для не-блочных тегов
 * @returns {string[]} строки-декларации, которые остаются
 */
export function filterCssDeclarations(tagName, declarations, cssAllowlist) {
    const tag = String(tagName || '').toLowerCase();
    const isBlock = BLOCK_STYLE_TAGS.includes(tag);
    const isItem = ITEM_STYLE_TAGS.includes(tag);
    const kept = [];
    for (const [prop, value] of declarations) {
        if (isBlock || isItem) {
            if (prop === 'text-align') {
                const v = String(value || '').trim().toLowerCase();
                if (!TEXT_ALIGN_VALUES.includes(v)) continue;
                kept.push(`text-align:${v};`);
            } else if (isItem && prop === 'font-size' && cssAllowlist.includes(prop)) {
                kept.push(`font-size:${value};`);
            }
        } else if (cssAllowlist.includes(prop)) {
            kept.push(`${prop}:${value};`);
        }
    }
    return kept;
}

function ensureCssAllowlistHook() {
    if (_cssHookRegistered) return;
    const DP = window.DOMPurify;
    if (!DP || typeof DP.addHook !== 'function') return;
    // Хук НЕ мутирует allowlist-массивы (advisory GHSA про мутацию конфига
    // из хуков) — только пер-вызовная перезапись style конкретного элемента.
    DP.addHook('afterSanitizeAttributes', (node) => {
        if (!_activeCssAllowlist) return;
        if (!node || !node.style || typeof node.hasAttribute !== 'function') return;
        if (!node.hasAttribute('style')) return;
        const declarations = [];
        for (let i = node.style.length - 1; i >= 0; i--) {
            const prop = node.style[i]; // уже kebab-case
            declarations.push([prop, node.style.getPropertyValue(prop)]);
        }
        const kept = filterCssDeclarations(node.tagName, declarations, _activeCssAllowlist);
        if (kept.length) node.setAttribute('style', kept.join(''));
        else node.removeAttribute('style');
    });
    _cssHookRegistered = true;
}

function resolveConfig(extraConfig) {
    if (!extraConfig) return DEFAULT_CONFIG;
    if (typeof extraConfig === 'string') {
        return SAFE_HTML_PROFILES[extraConfig] || DEFAULT_CONFIG;
    }
    return Object.assign({}, DEFAULT_CONFIG, extraConfig);
}

/**
 * Строгий whitelist для markdown-вывода LLM в чате.
 *
 * ВАЖНО: USE_PROFILES: false нейтрализует USE_PROFILES из DEFAULT_CONFIG при
 * shallow-merge (Object.assign) — иначе профиль перекрыл бы ALLOWED_TAGS.
 * img/svg/math/input запрещены сознательно: markdown-injection в LLM-чатах —
 * известный вектор эксфильтрации (автозагрузка картинок) и mXSS; картинки
 * приходят отдельным типизированным блоком 'image'.
 * class разрешён для подсветки кода (span.hljs-*).
 */
const CHAT_MD_CONFIG = {
    USE_PROFILES: false,
    ALLOWED_TAGS: [
        'p', 'br', 'hr', 'blockquote', 'ul', 'ol', 'li',
        'strong', 'em', 'del', 'code', 'pre', 'a', 'span',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'start', 'align'],
};

let fallbackWarned = false;

function warnFallbackOnce() {
    if (fallbackWarned) return;
    fallbackWarned = true;
    const msg = 'SafeHTML: DOMPurify не загружен (static/vendor/dompurify/purify.min.js). '
        + 'HTML заменяется на текстовое представление. Подключи vendor-файл в шаблоне.';
    console.error(msg);
    // B-18: на проде консоль никто не смотрит — шлём в ErrorBoundary, чтобы
    // отсутствие vendor было видно в серверном логе клиентских ошибок. Через
    // window (прямой импорт ErrorBoundary создал бы цикл sanitize↔error-boundary).
    try {
        window.ErrorBoundary?._reportToServer?.({
            category: 'sanitize-fallback',
            message: msg,
        });
    } catch (_) {
        /* репортер не должен сам падать */
    }
}

function _purify(str, extraConfig) {
    ensureCssAllowlistHook();
    const cfg = resolveConfig(extraConfig);
    _activeCssAllowlist = cfg.__cssAllowlist || null;
    try {
        return window.DOMPurify.sanitize(str, cfg);
    } finally {
        _activeCssAllowlist = null;
    }
}

function sanitize(html, extraConfig) {
    if (html == null) return '';
    const str = String(html);
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
        return _purify(str, extraConfig);
    }
    warnFallbackOnce();
    return escapeHtml(str);
}

function set(el, html, extraConfig) {
    if (!el) return;
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
        el.innerHTML = _purify(String(html ?? ''), extraConfig);
        return;
    }
    warnFallbackOnce();
    el.textContent = String(html ?? '');
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export const SafeHTML = { set, sanitize, escapeHtml };
window.SafeHTML = SafeHTML;

/**
 * CORE-1: единая точка рендера пользовательского контента акта (текстблок-
 * редактор, превью) — всегда профилем 'acts'. Раньше редактор звал
 * SafeHTML.set(el, html) БЕЗ профиля (дефолтный blocklist DEFAULT_CONFIG
 * пропускал теги вне allowlist'а, например <img src=...> из легаси-контента) —
 * редактируемая поверхность расходилась с тем, что реально допускает
 * бэк-санитайзер и что отрисует превью.
 * @param {HTMLElement} el
 * @param {string} html
 */
export function renderActContent(el, html) {
    set(el, html, 'acts');
}

export { CHAT_MD_CONFIG };
