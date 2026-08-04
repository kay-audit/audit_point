/**
 * Модуль обработки вставки из буфера обмена
 * Поддержка Ctrl+V для изображений и текста
 */

import { ViolationManager, isEditableTarget } from './violation-core.js';
import { Notifications } from '../../shared/notifications.js';
import { AppConfig } from '../../shared/app-config.js';
import { textBlockManager } from '../textblock/textblock-core.js';
import {
    CONTENT_TYPE_CASE,
    CONTENT_TYPE_FREE_TEXT,
} from './violation-content-item.js';
import { promptPasteChoice } from './violation-paste-choice.js';

/**
 * Строгий маркер кейса: «Кейс» + номер + разделитель в начале строки.
 * Флаг i ловит «кейс» в любом регистре; класс разделителей —
 * точка / двоеточие / скобка / дефис / en-dash / em-dash. Требует РОВНО
 * такой префикс: «Кейсы …», «Кейс 7 без разделителя» — уже не кейс.
 */
const CASE_PREFIX_RE = /^Кейс\s*\d+\s*[.:)\-–—]/i;

/**
 * Определяет тип вставляемого из буфера текста и очищает содержимое.
 * Кейс — только при строгом совпадении CASE_PREFIX_RE; тогда снимается
 * РОВНО совпавший префикс (не фиксированные 4 символа). Иначе — произвольный
 * текст без изменений.
 *
 * @param {string} textContent - Оригинальный текст буфера (ожидается .trim()'нутым)
 * @returns {{type: string, content: string}}
 */
export function parseClipboardText(textContent) {
    if (CASE_PREFIX_RE.test(textContent)) {
        return {
            type: CONTENT_TYPE_CASE,
            content: textContent.replace(CASE_PREFIX_RE, '').trim(),
        };
    }
    return { type: CONTENT_TYPE_FREE_TEXT, content: textContent };
}

/**
 * true, если вставку с редактируемым target'ом всё же нужно перехватить ради
 * КАРТИНОК (§5.8): каретка стоит в rich-поле зоны дополнительного контента
 * (кейс / свободный текст / подпись), а в буфере есть image-элементы.
 *
 * Редактор поверхности читает из буфера только text/html|text/plain — файлы он
 * молча игнорирует, поэтому до этой ветки вставить картинку с клавиатуры можно
 * было, только сфокусировав сам контейнер зоны (клик по пустому месту).
 *
 * Строго ограничено зоной: rich-поля нарушения вне `.additional-content-wrapper`
 * (нарушено / установлено / причины / …) и текстблоки под предикат не попадают —
 * их поведение прежнее (#19).
 *
 * @param {EventTarget} target - e.target события paste
 * @param {DataTransferItemList} items - e.clipboardData.items
 * @returns {boolean}
 */
export function shouldInterceptImagesFromEditable(target, items) {
    if (!items || !isEditableTarget(target)) return false;
    if (!target.closest || !target.closest('.additional-content-wrapper')) return false;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) return true;
    }
    return false;
}

/**
 * Есть ли в буфере ТЕКСТ (а не только картинка).
 *
 * text/plain — основной сигнал: Excel и Word кладут его всегда. text/html
 * учитываем только по ВИДИМОМУ тексту, потому что чисто картиночный буфер тоже
 * несёт html: «Копировать изображение» браузера кладёт один <img> при пустом
 * plain (тот же кейс описан в _insertSanitizedHtml, textblock-editor.js). До
 * сравнения вырезаем служебную обвязку — комментарии Word (`<!--[if …]-->`) и
 * `<style>`/`<script>` Excel, иначе пустой скопированный диапазон выглядел бы
 * как текст.
 *
 * @param {string} html - Содержимое text/html буфера
 * @param {string} plain - Содержимое text/plain буфера
 * @returns {boolean}
 */
export function clipboardHasText(html, plain) {
    if (plain && plain.trim()) return true;
    if (!html) return false;
    const visible = html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/gi, ' ');
    return visible.trim().length > 0;
}

/**
 * Маршрут буфера при вставке в зону дополнительных материалов:
 *  - `'images'` — только картинки → прежний конвейер зоны (диалог качества);
 *  - `'combo'`  — картинки И текст → выбор пользователя (№5), иначе один Ctrl+V
 *                 давал бы два результата: текст вставил бы редактор поля, а
 *                 картинку — обработчик зоны;
 *  - `'text'`   — только текст;
 *  - `'none'`   — вставлять нечего.
 *
 * hasImages — по РЕАЛЬНО извлечённым файлам, а не по типам items: буфер с
 * image-элементом, из которого не достаётся File, вставить картинкой нельзя.
 *
 * @param {{hasImages: boolean, html: string, plain: string}} payload
 * @returns {'images'|'combo'|'text'|'none'}
 */
export function classifyClipboardPayload({ hasImages, html, plain }) {
    const hasText = clipboardHasText(html, plain);
    if (hasImages) return hasText ? 'combo' : 'images';
    return hasText ? 'text' : 'none';
}

/**
 * Снимок текущей каретки: диалог уводит фокус, и к моменту ответа живого
 * выделения в поле уже нет. cloneRange — чтобы последующие правки выделения
 * (в т.ч. внутри диалога) не мутировали снимок.
 * @returns {Range|null}
 */
function captureCaretRange() {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return null;
    return selection.getRangeAt(0).cloneRange();
}

/**
 * Вставляет СНЯТЫЙ буфер в rich-поле после диалога: возвращает фокус (без него
 * поверхность не смонтирована и finalizeEdit не закоммитит правку в модель),
 * восстанавливает каретку и отдаёт данные конвейеру редактора — санитизация
 * Word-HTML, реконструкция капсул, нативный undo и сток в модель там же, где у
 * обычного Ctrl+V. Не пережившая диалог каретка (поле перерисовали) заменяется
 * позицией в конце поля.
 *
 * @param {HTMLElement} field - contenteditable-хост rich-поля
 * @param {Range|null} range - Снимок каретки до диалога
 * @param {string} html - Содержимое text/html буфера
 * @param {string} plain - Содержимое text/plain буфера
 */
function insertTextIntoRichField(field, range, html, plain) {
    if (!field || typeof textBlockManager.pasteClipboardPayload !== 'function') return;

    field.focus?.();

    const selection = window.getSelection?.();
    if (selection) {
        const alive = range && range.startContainer
            && (range.startContainer === field || field.contains?.(range.startContainer));
        const target = alive ? range : _caretAtFieldEnd(field);
        if (target) {
            selection.removeAllRanges();
            selection.addRange(target);
        }
    }

    textBlockManager.pasteClipboardPayload(field, html, plain);
}

/**
 * Каретка в конце поля — запасная позиция, если снимок не пережил диалог.
 * @param {HTMLElement} field
 * @returns {Range|null}
 */
function _caretAtFieldEnd(field) {
    if (typeof document.createRange !== 'function') return null;
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    return range;
}

// Расширение ViolationManager
Object.assign(ViolationManager.prototype, {
    /**
     * Настраивает глобальный обработчик вставки изображений и текста из буфера обмена.
     *
     * Слушатель в фазе ПЕРЕХВАТА (третий аргумент true): обработчик rich-поля
     * (EditorController вешает paste на сам элемент поверхности) на всплытии
     * отработал бы РАНЬШЕ и успел вставить текст комбинированного буфера ещё до
     * того, как мы спросим пользователя (№5). Из capture мы первые и можем
     * погасить событие через stopPropagation. Для остальных веток фаза ничего
     * не меняет: они либо возвращаются рано, либо только preventDefault'ят.
     */
    setupPasteHandler() {
        document.addEventListener('paste', async (e) => {
            // Режим просмотра: вставка в дополнительный контент запрещена (#1).
            // Глобальный слушатель живёт всегда — guard именно здесь обязателен.
            if (AppConfig.readOnlyMode?.isReadOnly) return;

            // Получаем данные из буфера обмена
            const items = e.clipboardData?.items;
            if (!items) {
                return;
            }

            // Стандартную вставку в поля ввода и contenteditable-редактор
            // (текстблок) не перехватываем — даже если мышь/фокус рядом с зоной
            // нарушения (#19). Без этого Ctrl+V в текстблоке уходил бы в
            // дополнительный контент по hover-модели.
            // Исключение §5.8 — каретка в rich-поле САМОЙ зоны и в буфере
            // картинки: их редактор поверхности игнорирует, забираем себе
            // ТОЛЬКО ветку картинок (текстовая ниже отключена для editable).
            const targetIsEditable = isEditableTarget(e.target);
            const interceptImages = shouldInterceptImagesFromEditable(e.target, items);
            if (targetIsEditable && !interceptImages) return;

            // Целевую зону определяем по ФОКУСУ (activeElement), а НЕ по hover (#19):
            // hover-модель (currentActiveContainer/cursorInsertPosition) осталась
            // только для визуального индикатора позиции при drag файлов. Контейнер
            // зоны focusable (tabindex=0) — клик по нему даёт фокус.
            // В §5.8-ветке фокус стоит на самом rich-поле, лежащем ВНУТРИ зоны, —
            // путь тот же closest, но считаем его от e.target, чтобы зона бралась
            // строго от каретки, породившей событие.
            const focusSource = interceptImages ? e.target : document.activeElement;
            const targetContainer = focusSource && focusSource.closest
                ? focusSource.closest('.additional-content-wrapper')
                : null;
            if (!targetContainer) {
                return;
            }

            const itemsContainer = targetContainer.querySelector('.additional-content-items');
            const violationId = itemsContainer?.dataset.violationId;

            if (!violationId) {
                return;
            }

            // Получаем violation из хранилища
            const violation = this.activeViolations.get(violationId);
            if (!violation) {
                console.error('Violation not found in storage:', violationId);
                return;
            }

            // Под focus-моделью вставляем в КОНЕЦ зоны (#19): позиция курсора мыши
            // неактуальна — вставка инициирована с клавиатуры по фокусу.
            const insertIndex = violation.additionalContent.items.length;

            // Собираем ВСЕ картинки буфера (не только последнюю, #28) и
            // отдельно наличие текста.
            const imageFiles = [];
            let textItem = null;

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.type.indexOf('image') !== -1) {
                    const file = item.getAsFile();
                    if (file) imageFiles.push(file);
                } else if (item.type === 'text/plain') {
                    textItem = item;
                }
            }

            // Строки буфера снимаем ЗДЕСЬ, синхронно: clipboardData живёт только
            // внутри обработчика, а решение по комбинированному буферу приходит
            // из диалога — уже после await.
            const html = e.clipboardData.getData('text/html') || '';
            const plain = e.clipboardData.getData('text/plain') || '';

            // Комбинированный буфер (Excel/Word: текст + растр) при каретке в
            // rich-поле зоны — спрашиваем пользователя (№5). Гасим событие
            // ПОЛНОСТЬЮ: без stopPropagation обработчик поля вставил бы текст
            // сам, в обход выбора. Каретку снимаем до диалога — он уводит фокус.
            const richField = targetIsEditable && e.target.closest
                ? e.target.closest('[contenteditable="true"]')
                : null;
            if (imageFiles.length > 0 && richField
                    && classifyClipboardPayload({ hasImages: true, html, plain }) === 'combo') {
                e.preventDefault();
                e.stopPropagation();

                await this.pasteCombinedClipboard(violation, targetContainer, insertIndex, {
                    imageFiles,
                    html,
                    plain,
                    field: richField,
                    range: captureCaretRange(),
                });
                return;
            }

            // Картинки идут ТЕМ ЖЕ конвейером, что drop/upload (#28):
            // filterAcceptedImageFiles → диалог качества (Q3) → ресайз → bulk (#29).
            // Собственного FileReader и логики «только последняя картинка» больше нет.
            if (imageFiles.length > 0) {
                e.preventDefault();

                // Тип-валидация ДО чтения (H6/#26) — warning с причиной отказа.
                const accepted = this.filterAcceptedImageFiles(imageFiles, violation);
                if (accepted.length === 0) return;

                // insertIndex зафиксирован синхронно ДО async-чтения (приемлемо);
                // тост об успехе с верным числом покажет insertImageFilesInOrder.
                this.promptQualityThenInsertImages(violation, targetContainer, insertIndex, accepted);
            }
            // Текст обрабатываем только если картинок в буфере нет И каретка не
            // в редактируемом поле: в §5.8-ветке текст вставляет редактор
            // поверхности (его handler отрабатывает следом за нашим capture),
            // наша текстовая ветка добавила бы дубль отдельным элементом зоны.
            else if (textItem && !targetIsEditable) {
                const textContent = plain.trim();

                if (textContent) {
                    e.preventDefault();

                    // Строгий маркер кейса (#5): «Кейс N<разделитель>» снимается
                    // ровно по совпадению, иначе — произвольный текст как есть.
                    const { type, content } = parseClipboardText(textContent);
                    const message = type === CONTENT_TYPE_CASE
                        ? 'Кейс добавлен из буфера обмена'
                        : 'Текст добавлен из буфера обмена';

                    // Единый гейт лимита (#4) уже мог отказать (Notifications.warning
                    // показан внутри) — тогда false, и success не зовём, чтобы не
                    // подтверждать вставку, которой не произошло. updateBlock делает
                    // сама addContentItemAtPosition — без двойного апдейта (#29).
                    const added = this.addContentItemAtPosition(violation, type, targetContainer, insertIndex, {
                        content: content
                    });
                    if (!added) return;

                    Notifications.success(message);
                }
            }
        }, true);
    },

    /**
     * Разводит комбинированный буфер по СУЩЕСТВУЮЩИМ конвейерам после выбора
     * пользователя (№5): текст — конвейером редактора в поле с кареткой,
     * картинки — конвейером зоны (тип-валидация → диалог качества → ресайз →
     * bulk), тем же, что у drag&drop и выбора файлов.
     *
     * Порядок «текст → картинки» обязателен: вставка картинок перерисовывает
     * элементы зоны, а текст к этому моменту уже сложен в модель
     * (insertTextIntoRichField → finalizeEdit → commit поверхности).
     *
     * @param {Object} violation - Объект нарушения
     * @param {HTMLElement} container - Контейнер зоны (.additional-content-wrapper)
     * @param {number} insertIndex - Позиция вставки картинок (конец зоны)
     * @param {{imageFiles: File[], html: string, plain: string,
     *          field: HTMLElement, range: Range|null}} payload - Снимок буфера и каретки
     */
    async pasteCombinedClipboard(violation, container, insertIndex, payload) {
        const choice = await promptPasteChoice();
        if (!choice) return; // отмена — не вставляем ничего

        if (choice === 'text' || choice === 'both') {
            insertTextIntoRichField(payload.field, payload.range, payload.html, payload.plain);
        }

        if (choice === 'image' || choice === 'both') {
            // Тип-валидация ДО чтения (H6/#26) — warning с причиной отказа.
            const accepted = this.filterAcceptedImageFiles(payload.imageFiles, violation);
            if (accepted.length === 0) return;
            await this.promptQualityThenInsertImages(violation, container, insertIndex, accepted);
        }
    }
});
