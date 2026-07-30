/**
 * Модуль обработки вставки из буфера обмена
 * Поддержка Ctrl+V для изображений и текста
 */

import { ViolationManager, isEditableTarget } from './violation-core.js';
import { Notifications } from '../../shared/notifications.js';
import { AppConfig } from '../../shared/app-config.js';
import {
    CONTENT_TYPE_CASE,
    CONTENT_TYPE_FREE_TEXT,
} from './violation-content-item.js';

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

// Расширение ViolationManager
Object.assign(ViolationManager.prototype, {
    /**
     * Настраивает глобальный обработчик вставки изображений и текста из буфера обмена
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
            // в редактируемом поле: в §5.8-ветке текст уже вставил редактор
            // поверхности (его handler отрабатывает раньше по bubbling), наша
            // текстовая ветка добавила бы дубль отдельным элементом зоны.
            else if (textItem && !targetIsEditable) {
                const textContent = e.clipboardData.getData('text/plain').trim();

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
        });
    }
});
