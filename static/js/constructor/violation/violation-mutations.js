/**
 * Единый мутатор нарушения с read-only-guard (#33 + #1) — блочная модель.
 *
 * Единственная точка записи в объект violation из формы: каждый метод в
 * НАЧАЛЕ зовёт ValidationCore.requireWrite — в режиме просмотра запись не
 * выполняется и возвращается false (defense-in-depth для программных путей
 * paste/DnD).
 *
 * Модель: каждое поле реестра — контейнер {enabled, blocks}; блок адресуется
 * стабильным id (не индексом — индексы плывут при DnD). Порядок блоков —
 * позиция в массиве; порядок полей — violation.fieldOrder (null = стандарт).
 *
 * Каждый метод отвечает за три вещи: (1) requireWrite-guard, (2) запись
 * значения, (3) обновление превью: scheduleTypingBlock — печатный ввод
 * (текст/подпись), updateBlock — дискретные действия (тумблеры, add/remove/
 * move блока, ширина картинки, порядок полей).
 *
 * Changelog (аудит правок) здесь НЕ трогается: правки нарушений фиксируются
 * diff-ом при сохранении (violation-audit.js, pre-flush hook), а не per-keystroke.
 */
import { PreviewManager } from '../preview/preview.js';
import { ViolationManager } from './violation-core.js';
import { ValidationCore } from '../validation/validation-core.js';
import { VIOLATION_FIELD_KEYS, MANDATORY_FIELD_KEYS } from './violation-fields.js';

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

/**
 * Находит блок поля по id. Общая точка чтения для мутатора и поверхностей.
 * @param {Object} violation - Объект нарушения
 * @param {string} fieldKey - Ключ поля реестра
 * @param {string} blockId - ID блока
 * @returns {Object|null}
 */
export function findBlock(violation, fieldKey, blockId) {
    const blocks = violation?.[fieldKey]?.blocks;
    if (!Array.isArray(blocks)) return null;
    return blocks.find(b => b && b.id === blockId) || null;
}

export const violationMutations = {
    /**
     * Тумблер поля (дискретное действие). Mandatory-поля (Нарушено/
     * Установлено) выключить нельзя — запись игнорируется.
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {boolean} enabled - Новое состояние
     * @returns {boolean} true — записано; false — read-only/mandatory
     */
    setFieldEnabled(violation, fieldKey, enabled) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;
        if (!enabled && MANDATORY_FIELD_KEYS.includes(fieldKey)) return false;
        if (!violation[fieldKey]) return false;

        violation[fieldKey].enabled = !!enabled;
        _schedulePreview(violation.id, true);
        return true;
    },

    /**
     * Пользовательский порядок полей (модалка «Порядок полей»).
     * null — вернуть стандартное расположение (данные полей не трогаются).
     * Невалидная перестановка (не все ключи реестра ровно по разу) отклоняется.
     * @param {Object} violation - Объект нарушения
     * @param {string[]|null} orderOrNull - Порядок ключей либо null
     * @returns {boolean} true — записано; false — read-only/невалидный порядок
     */
    setFieldOrder(violation, orderOrNull) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        if (orderOrNull !== null) {
            if (!Array.isArray(orderOrNull)) return false;
            if (orderOrNull.length !== VIOLATION_FIELD_KEYS.length) return false;
            const known = new Set(VIOLATION_FIELD_KEYS);
            const seen = new Set();
            for (const key of orderOrNull) {
                if (!known.has(key) || seen.has(key)) return false;
                seen.add(key);
            }
        }

        violation.fieldOrder = orderOrNull === null ? null : [...orderOrNull];
        _schedulePreview(violation.id, true);
        return true;
    },

    /**
     * Пишет атрибут блока по id (content/caption — печатный ввод; width и
     * прочее — дискретное действие).
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {string} blockId - ID блока
     * @param {string} attr - Имя атрибута блока ('content'|'caption'|'width'|...)
     * @param {*} value - Записываемое значение
     * @returns {boolean} true — записано; false — read-only/блок не найден
     */
    setBlockField(violation, fieldKey, blockId, attr, value) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        const block = findBlock(violation, fieldKey, blockId);
        if (!block) return false;

        block[attr] = value;
        _schedulePreview(violation.id, attr !== 'content' && attr !== 'caption');
        return true;
    },

    /**
     * Вставляет готовый блок (фабрики violation-block-types.js) в поле.
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {Object} block - Готовый блок
     * @param {number} [index] - Позиция вставки (по умолчанию — в конец)
     * @returns {boolean} true — вставлено; false — read-only/нет контейнера
     */
    addBlock(violation, fieldKey, block, index = undefined) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        const container = violation[fieldKey];
        if (!container || !Array.isArray(container.blocks)) return false;

        const at = index === undefined
            ? container.blocks.length
            : Math.max(0, Math.min(index, container.blocks.length));
        container.blocks.splice(at, 0, block);
        _schedulePreview(violation.id, true);
        return true;
    },

    /**
     * Удаляет блок поля по id (дискретное действие).
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {string} blockId - ID блока
     * @returns {boolean} true — удалено; false — read-only/блок не найден
     */
    removeBlock(violation, fieldKey, blockId) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        const blocks = violation?.[fieldKey]?.blocks;
        if (!Array.isArray(blocks)) return false;
        const idx = blocks.findIndex(b => b && b.id === blockId);
        if (idx === -1) return false;

        blocks.splice(idx, 1);
        _schedulePreview(violation.id, true);
        return true;
    },

    /**
     * Переставляет блок внутри поля (drag-and-drop, §5.10a).
     *
     * toIndex — позиция вставки В ИСХОДНОМ массиве (как её считает dragover),
     * поэтому при движении вниз она уменьшается на 1: удаление элемента с
     * fromIndex сдвигает всё, что правее, влево.
     *
     * DOM не трогаем: перерисовку контейнера делает вызывающая сторона,
     * превью — мутатор, как у соседей. Перенос блока МЕЖДУ полями —
     * сознательный non-goal первой итерации (см. спеку §7).
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {number} fromIndex - Индекс перетаскиваемого блока
     * @param {number} toIndex - Позиция вставки в исходном массиве
     * @returns {boolean} true — переставлено; false — read-only либо
     *          fromIndex вне границ массива
     */
    moveBlock(violation, fieldKey, fromIndex, toIndex) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        const blocks = violation?.[fieldKey]?.blocks;
        if (!Array.isArray(blocks)) return false;
        if (fromIndex < 0 || fromIndex >= blocks.length) return false;

        const [moved] = blocks.splice(fromIndex, 1);
        if (fromIndex < toIndex) toIndex -= 1;
        toIndex = Math.max(0, Math.min(toIndex, blocks.length));
        blocks.splice(toIndex, 0, moved);

        // Порядок блоков — позиция в массиве, отдельного поля order нет (#24).
        _schedulePreview(violation.id, true);
        return true;
    },
};

// Домешиваем мутатор в прототип ViolationManager (как остальные violation-*).
Object.assign(ViolationManager.prototype, violationMutations);

// Window-globals для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
    window.violationMutations = violationMutations;
    window.findViolationBlock = findBlock;
}
