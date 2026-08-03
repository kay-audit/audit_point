/**
 * Общий предикат «элемент — текстовый редактор».
 *
 * Три подсистемы решают один и тот же вопрос — «принадлежит ли клавиатурное
 * событие полю ввода»: глобальные хоткеи Ctrl+Z (undo-delete.js) и Ctrl+C/Ctrl+V
 * (node-clipboard.js) внутри поля не перехватываются (там живёт браузерный
 * undo/clipboard), а зона дополнительного контента нарушения не забирает
 * Ctrl+V (#19) и Escape (§5.9), когда каретка стоит в поле. Раньше у каждой
 * подсистемы была своя копия предиката, и копии разошлись: версия нарушений
 * матчила ЛЮБОЙ `<input>`, включая чекбокс «Дополнительный контент», — с
 * фокусом на нём Escape уходил в никуда вместо сброса зоны.
 */

/**
 * Типы `<input>`, которые НЕ являются текстовым полем: клавиатурное событие в
 * них редактору не принадлежит. Всё остальное (text, search, email, url, tel,
 * number, password, date/time-семейство, отсутствующий type) — текстовый ввод.
 */
const NON_TEXT_INPUT_TYPES = new Set([
    'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'range', 'image',
]);

/**
 * true, если элемент — редактируемое поле: `<textarea>`, `<select>`, текстовый
 * `<input>` либо contenteditable-редактор (rich-поле нарушения, текстблок).
 *
 * Для contenteditable проверяются оба признака: `isContentEditable` (реальный
 * DOM — свойство истинно и у потомков редактируемого хоста) и `closest(
 * '[contenteditable="true"]')` (работает на detached-узлах и на тест-стабах,
 * у которых нет `isContentEditable`). `closest` может отсутствовать у не-Element
 * целей события (document/window) — отсюда проверка перед вызовом.
 *
 * @param {EventTarget|Element|null} target - Элемент (e.target события или document.activeElement)
 * @returns {boolean}
 */
export function isEditableTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
        return !NON_TEXT_INPUT_TYPES.has(String(target.type || '').toLowerCase());
    }
    if (target.isContentEditable) return true;
    return target.closest ? !!target.closest('[contenteditable="true"]') : false;
}
