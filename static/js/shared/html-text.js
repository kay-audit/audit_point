/**
 * Утилиты перевода плоского текста в rich HTML-разметку.
 *
 * Единый дом для plainToRichHtml — вынесен из violation-core.js (V25), чтобы
 * потребители (формализатор, корректор через _insertCorrected) не заводили
 * свои копии. chat-renderer.js держит свою копию сознательно — другой домен
 * (markdown-вывод LLM), связывать его с этим модулем не следует.
 */
import { SafeHTML } from './sanitize.js';

/**
 * Плоская строка → rich HTML: экранирует спецсимволы и переводит `\n` → `<br>`
 * (зеркало `_insertCorrected` в corrector-popover.js). Без этого `\n` не
 * отрисовался бы, а `&`/`<` из текста попали бы в rich-модель как невалидный HTML.
 * @param {string} v - Плоское значение (текст LLM/пользователя)
 * @returns {string} HTML для setViolationField/renderActContent
 */
export function plainToRichHtml(v) {
    return SafeHTML.escapeHtml(v).replace(/\n/g, '<br>');
}
