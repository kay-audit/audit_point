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
 * move/удаление пачки блоков, ширина картинки, порядок полей).
 *
 * Changelog (аудит правок) здесь НЕ трогается: правки нарушений фиксируются
 * diff-ом при сохранении (violation-audit.js, pre-flush hook), а не per-keystroke.
 */
import { PreviewManager } from '../preview/preview.js';
import { ViolationManager } from './violation-core.js';
import { ValidationCore } from '../validation/validation-core.js';
import { MANDATORY_FIELD_KEYS, isValidFieldOrder } from './violation-fields.js';

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

/**
 * Чистый планировщик перестановки: куда встанут элементы, если пачку с
 * индексами movedIndices перенести на позицию вставки toIndex.
 *
 * toIndex — позиция В ИСХОДНОМ массиве (как её считает dragover: 0 — над
 * первым элементом, N — под последним), поэтому её нужно уменьшить на число
 * переносимых элементов, лежащих ЛЕВЕЕ неё. Одиночный блок при движении вниз
 * даёт классическое «toIndex -= 1» — тот же случай, только счёт общий.
 *
 * Переносимые идут прогоном в исходном относительном порядке — набор может
 * быть несмежным (Ctrl-клики), после переноса он всегда смежен.
 *
 * Общий и для мутатора, и для drop-индикатора: «честный no-op» (порядок не
 * меняется) обязан одинаково гаситься и в модели, и в подсветке.
 *
 * @param {number} count - Длина массива
 * @param {number[]} movedIndices - Индексы переносимых элементов
 * @param {number} toIndex - Позиция вставки в исходном массиве
 * @returns {number[]|null} Новый порядок как индексы исходного массива;
 *          null — переносить нечего либо порядок не меняется
 */
export function planBlocksReorder(count, movedIndices, toIndex) {
    const moved = [...new Set(movedIndices || [])]
        .filter(index => Number.isInteger(index) && index >= 0 && index < count)
        .sort((a, b) => a - b);
    if (moved.length === 0) return null;

    const movedSet = new Set(moved);
    const rest = [];
    for (let i = 0; i < count; i++) {
        if (!movedSet.has(i)) rest.push(i);
    }

    const shift = moved.filter(index => index < toIndex).length;
    const at = Math.max(0, Math.min(toIndex - shift, rest.length));
    const order = [...rest.slice(0, at), ...moved, ...rest.slice(at)];

    return order.some((source, index) => source !== index) ? order : null;
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

        // Критерий валидности — общий с чтением (getOrderedFieldKeys), но
        // реакция разная: читатель молча падает на стандартный порядок,
        // мутатор отказывает в записи.
        if (orderOrNull !== null && !isValidFieldOrder(orderOrNull)) return false;

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
     * Переставляет ПАЧКУ блоков внутри поля (drag-and-drop, §5.10a): выделенные
     * блоки уходят непрерывным прогоном в исходном относительном порядке.
     *
     * Одиночное перетаскивание — частный случай пачки из одного блока;
     * отдельного moveBlock больше нет. Порядок считает чистый
     * planBlocksReorder: он же отвечает на вопрос «а меняется ли порядок
     * вообще» — no-op не пишет в модель и не планирует превью, поэтому
     * перетаскивание «на то же место» не помечает акт изменённым.
     *
     * DOM не трогаем: перерисовку контейнера делает вызывающая сторона,
     * превью — мутатор, как у соседей. Перенос блоков МЕЖДУ полями —
     * сознательный non-goal первой итерации (см. спеку §7).
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {string[]} blockIds - id перетаскиваемых блоков (порядок не важен)
     * @param {number} toIndex - Позиция вставки В ИСХОДНОМ массиве (её считает
     *        dragover: 0 — над первым блоком, N — под последним)
     * @returns {boolean} true — переставлено; false — read-only, блоков нет
     *          либо порядок не меняется
     */
    moveBlocks(violation, fieldKey, blockIds, toIndex) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        const blocks = violation?.[fieldKey]?.blocks;
        if (!Array.isArray(blocks)) return false;

        const moving = new Set(blockIds || []);
        const movedIndices = [];
        blocks.forEach((block, index) => {
            if (block && moving.has(block.id)) movedIndices.push(index);
        });

        const order = planBlocksReorder(blocks.length, movedIndices, toIndex);
        if (!order) return false;

        // Массив пересобираем НА МЕСТЕ: ссылку на blocks держат и снимок
        // аудита, и резолвер встроенных таблиц — подмена массива их осиротит.
        const reordered = order.map(index => blocks[index]);
        blocks.splice(0, blocks.length, ...reordered);

        // Порядок блоков — позиция в массиве, отдельного поля order нет (#24).
        _schedulePreview(violation.id, true);
        return true;
    },

    /**
     * Удаляет ПАЧКУ блоков поля по id (групповое удаление меню/Delete).
     * Одно превью на всю пачку; несуществующие id молча игнорируются.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {string[]} blockIds - id удаляемых блоков
     * @returns {boolean} true — удалён хотя бы один; false — read-only либо
     *          ни один id не найден
     */
    removeBlocks(violation, fieldKey, blockIds) {
        if (ValidationCore.requireWrite('cannotEdit')) return false;

        const blocks = violation?.[fieldKey]?.blocks;
        if (!Array.isArray(blocks)) return false;

        const doomed = new Set(blockIds || []);
        const survivors = blocks.filter(block => !(block && doomed.has(block.id)));
        if (survivors.length === blocks.length) return false;

        blocks.splice(0, blocks.length, ...survivors);
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
