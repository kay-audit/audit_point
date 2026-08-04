/**
 * Единый мутатор полей нарушения с read-only-guard (#33 + #1).
 *
 * Единственная точка записи в объект violation из формы: раньше каждое поле
 * писалось своим inline-обработчиком напрямую в объект, а read-only-guard
 * стоял только у «Нарушено»/«Установлено». Теперь все записи формы проходят
 * через эти методы, и каждый в НАЧАЛЕ зовёт ValidationCore.requireWrite:
 * в режиме просмотра запись не выполняется и возвращается false (обойти нельзя,
 * defense-in-depth для программных путей paste/DnD).
 *
 * Каждый метод отвечает за три вещи: (1) requireWrite-guard, (2) запись
 * значения, (3) обновление превью. Тип превью-вызова сохранён из исходных
 * обработчиков: scheduleTypingBlock — для печатного ввода (текст/подпись),
 * updateBlock — для дискретных действий (тумблеры, add/remove пункта, ширина).
 *
 * Changelog (аудит правок) здесь НЕ трогается: правки нарушений фиксируются
 * diff-ом при сохранении (violation-audit.js, pre-flush hook), а не per-keystroke.
 */
import { PreviewManager } from '../preview/preview.js';
import { ViolationManager } from './violation-core.js';
import { ValidationCore } from '../validation/validation-core.js';

/**
 * Разбирает путь поля нарушения (до 2 уровней): плоский 'violated' либо
 * точечный 'reasons.content'/'reasons.enabled'. Общая точка для write
 * (setViolationField ниже) и read (_readViolationField, violation-field-surface.js)
 * — раньше их разбор пути расходился (read защищён `?.`, write — нет), V23.
 * @param {string} path - Путь поля
 * @returns {{key: string, subKey: (string|null)}}
 */
export function parseFieldPath(path) {
    const parts = path.split('.');
    return { key: parts[0], subKey: parts.length > 1 ? parts[1] : null };
}

/**
 * Планирует превью для нарушения: typing (декоративный debounce печати) либо
 * discrete (немедленный ре-рендер блока).
 * @param {string} violationId - ID нарушения
 * @param {boolean} discrete - true → updateBlock, false → scheduleTypingBlock
 */
function _schedulePreview(violationId, discrete) {
    if (discrete) {
        PreviewManager.updateBlock('violation', violationId);
    } else {
        PreviewManager.scheduleTypingBlock('violation', violationId);
    }
}

export const violationMutations = {
    /**
     * Точечная запись поля нарушения по пути (до 2 уровней).
     * Плоские пути: 'violated', 'established'. Точечные: '<key>.content'
     * (текст → typing-превью) и '<key>.enabled' (тумблер → discrete-превью).
     * @param {Object} violation - Объект нарушения
     * @param {string} path - Путь поля ('violated' | 'reasons.content' | ...)
     * @param {*} value - Записываемое значение
     * @returns {boolean} true — записано; false — заблокировано read-only
     */
    setViolationField(violation, path, value) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        const { key, subKey } = parseFieldPath(path);
        let discrete;
        if (subKey === null) {
            // violated/established — печатный ввод текста.
            violation[key] = value;
            discrete = false;
        } else {
            violation[key][subKey] = value;
            // *.enabled — дискретный тумблер; *.content — печатный ввод.
            discrete = subKey === 'enabled';
        }

        _schedulePreview(violation.id, discrete);
        return true;
    },

    /**
     * Пишет пункт маркированного списка по индексу (печатный ввод).
     * Поле списка задаётся именем (как в renderList), а не прибито к
     * descriptionList — убирает латентную связанность мутатора с одним полем.
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldName - Имя поля-списка ('descriptionList' | ...)
     * @param {number} index - Индекс пункта
     * @param {string} value - Новое значение пункта
     * @returns {boolean} true — записано; false — заблокировано read-only
     */
    setViolationListItem(violation, fieldName, index, value) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        violation[fieldName].items[index] = value;
        _schedulePreview(violation.id, false);
        return true;
    },

    /**
     * Добавляет пустой пункт в список (дискретное действие).
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldName - Имя поля-списка ('descriptionList' | ...)
     * @returns {boolean} true — добавлено; false — заблокировано read-only
     */
    addViolationListItem(violation, fieldName) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        violation[fieldName].items.push('');
        _schedulePreview(violation.id, true);
        return true;
    },

    /**
     * Удаляет пункт списка по индексу (дискретное действие).
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldName - Имя поля-списка ('descriptionList' | ...)
     * @param {number} index - Индекс пункта
     * @returns {boolean} true — удалено; false — заблокировано read-only
     */
    removeViolationListItem(violation, fieldName, index) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        violation[fieldName].items.splice(index, 1);
        _schedulePreview(violation.id, true);
        return true;
    },

    /**
     * Пишет поле элемента дополнительного контента (кейс/картинка/текст).
     * content/caption — печатный ввод (typing-превью); width — дискретное
     * действие (discrete-превью).
     * @param {Object} violation - Объект нарушения
     * @param {Object} item - Элемент additionalContent.items[]
     * @param {'content'|'caption'|'width'} field - Имя поля элемента
     * @param {*} value - Записываемое значение
     * @returns {boolean} true — записано; false — заблокировано read-only
     */
    setContentItemField(violation, item, field, value) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        item[field] = value;
        _schedulePreview(violation.id, field === 'width');
        return true;
    },

    /**
     * Переставляет элемент дополнительного контента (drag-and-drop, §5.10a).
     * Раньше handleDrop сплайсил items напрямую, мимо мутаторного слоя:
     * read-only держался только на том, что draggable не выставляется в режиме
     * просмотра, — программный путь гейта не имел.
     *
     * toIndex — позиция вставки В ИСХОДНОМ массиве (как её считает dragover),
     * поэтому при движении вниз она уменьшается на 1: удаление элемента с
     * fromIndex сдвигает всё, что правее, влево.
     *
     * DOM не трогаем (в этом модуле его нет вовсе): перерисовку контейнера
     * делает вызывающая сторона, превью — мутатор, как у соседей.
     *
     * @param {Object} violation - Объект нарушения
     * @param {number} fromIndex - Индекс перетаскиваемого элемента
     * @param {number} toIndex - Позиция вставки в исходном массиве
     * @returns {boolean} true — переставлено; false — read-only либо
     *          fromIndex вне границ массива
     */
    moveContentItem(violation, fromIndex, toIndex) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        const items = violation.additionalContent.items;
        if (fromIndex < 0 || fromIndex >= items.length) return false;

        const [moved] = items.splice(fromIndex, 1);
        if (fromIndex < toIndex) toIndex -= 1;
        toIndex = Math.max(0, Math.min(toIndex, items.length));
        items.splice(toIndex, 0, moved);

        // Порядок элементов — позиция в массиве, отдельного поля order нет (#24).
        _schedulePreview(violation.id, true);
        return true;
    },
};

// Домешиваем мутатор в прототип ViolationManager (как остальные violation-*).
Object.assign(ViolationManager.prototype, violationMutations);

// Window-globals для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
    window.violationMutations = violationMutations;
}
