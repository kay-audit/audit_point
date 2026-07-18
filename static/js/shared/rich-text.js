/**
 * Извлечение видимого plain-текста из rich DOM-фрагмента.
 *
 * Единый источник для корректора (сверка «текст не изменился с момента
 * отправки в LLM» — `_rangeText`/`_textChanged` в corrector-popover.js),
 * формализатора (rich-поля нарушений → текст для LLM) и свода ячеек
 * (код процесса из rich-ячейки). Раньше логика жила только в корректоре —
 * вынесена сюда, чтобы остальные потребители не заводили свои копии.
 */

/**
 * Сериализация DOM-фрагмента в plain-текст, зеркалящая Selection.toString:
 * текстовые узлы — как есть, <br> → \n, закрытие блочного элемента —
 * граница-\n (если строка ещё не завершена переводом). Инлайновые узлы
 * (span-капсулы ссылок/сносок и т.п.) переносов не добавляют, их текст
 * входит в результат как видимый текст.
 *
 * @param {Node} el Корневой DOM-узел (обычно контейнер с cloneContents()).
 * @returns {string} Видимый текст с переводами строк на месте <br> и границ блоков.
 */
export function serializeVisibleText(el) {
    const BLOCK = /^(?:DIV|P|LI|UL|OL|TR|TABLE|THEAD|TBODY|SECTION|ARTICLE|BLOCKQUOTE|PRE|FIGURE|FIGCAPTION|HEADER|FOOTER|ASIDE|NAV|MAIN|DL|DD|DT|H[1-6])$/;
    let out = '';
    const walk = (node) => {
        for (const child of node.childNodes) {
            if (child.nodeType === 3) {
                out += child.textContent;
            } else if (child.nodeType === 1) {
                if (child.tagName === 'BR') { out += '\n'; continue; }
                const block = BLOCK.test(child.tagName);
                if (block && out && !out.endsWith('\n')) out += '\n';
                walk(child);
                if (block && out && !out.endsWith('\n')) out += '\n';
            }
        }
    };
    walk(el);
    return out;
}

window.serializeVisibleText = serializeVisibleText;
