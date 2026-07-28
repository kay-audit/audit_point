/**
 * Единый предикат пустоты rich-полей нарушения (#12, V24).
 *
 * Устраняет рассинхрон: рендер-подсветка `--empty` при пересоздании DOM
 * считала пустоту по сырому HTML модели (`!item.content?.trim()`), а
 * live-обработчик ввода — по `field.textContent` (без учёта caret-guard'ов и
 * капсул). После стирания текста и пере-рендера класс мог слетать с визуально
 * пустого поля. Здесь — одна формула для обоих случаев + write-path
 * нормализации пустого коммита (violation-field-surface.js).
 *
 * Формула зеркалит _toggleEmptyClass (textblock-editor.js:405-411): пусто =
 * нет видимого текста (без caret-guard U+FEFF/якорь-невидимки U+200B) И нет
 * значимых inline-элементов (капсулы ссылок/сносок, картинки).
 *
 * isFieldEmpty принимает ЛИБО живой DOM-элемент поля (live-ввод — textContent/
 * querySelector, как в _toggleEmptyClass), ЛИБО сырое HTML-значение модели
 * (первичный рендер до создания DOM-поля, write-path commit) — тегово-
 * нейтральная проверка строки. `<br>`/пустой `<div><br></div>`-остаток (что
 * оставляет очищенный contenteditable до нормализации коммита) считается
 * пустым для строкового случая.
 */

const INVISIBLE_CHARS_RE = new RegExp('[\\uFEFF\\u200B]', 'g');
const SIGNIFICANT_INLINE_SELECTOR = '.text-link, .text-footnote, img';
// Строковый эквивалент SIGNIFICANT_INLINE_SELECTOR: значимый inline-элемент
// определяем по маркеру в самой HTML-строке, ДО срезания тегов — иначе
// капсула без видимого текста (пустой data-link-url и т.п.) или картинка
// ошибочно сочлась бы пустой.
const SIGNIFICANT_INLINE_MARKER_RE = /<img[\s>]|class="[^"]*\b(?:text-link|text-footnote)\b/;

/**
 * @param {HTMLElement|string} source - Живой элемент поля ИЛИ сырой HTML модели
 * @returns {boolean} true — визуально пусто
 */
export function isFieldEmpty(source) {
    if (source == null) return true;
    if (typeof source === 'string') {
        if (SIGNIFICANT_INLINE_MARKER_RE.test(source)) return false;
        const text = source.replace(/<[^>]*>/g, '').replace(INVISIBLE_CHARS_RE, '').trim();
        return text.length === 0;
    }
    const hasText = (source.textContent || '').replace(INVISIBLE_CHARS_RE, '').trim().length > 0;
    const hasInlineEl = typeof source.querySelector === 'function'
        && source.querySelector(SIGNIFICANT_INLINE_SELECTOR) !== null;
    return !hasText && !hasInlineEl;
}

/**
 * Тумблер класса `--empty` на targetEl по пустоте source (isFieldEmpty).
 * Заменяет тройной дубль тумблера (createCaseElement/createFreeTextElement,
 * violation-rendering.js; renderList, violation-core.js).
 * @param {HTMLElement} targetEl - Элемент, получающий класс
 * @param {string} className - Имя класса (например 'content-item-wrapper--empty')
 * @param {HTMLElement|string} source - Проверяемый элемент/значение (isFieldEmpty)
 */
export function toggleEmptyClass(targetEl, className, source) {
    targetEl.classList.toggle(className, isFieldEmpty(source));
}
