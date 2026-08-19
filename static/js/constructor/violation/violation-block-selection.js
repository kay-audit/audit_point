/**
 * Мультивыделение блоков ОДНОГО поля нарушения — чистое состояние.
 *
 * Модуль сознательно без импортов: выделение — это Set идентификаторов блоков,
 * якорь диапазона и адрес поля (violationId + fieldKey). Ни DOM, ни менеджер,
 * ни AppState здесь не участвуют — вся проводка (слушатели, классы, групповые
 * мутации) живёт в violation-blocks.js, а состояние висит на ViolationManager.
 *
 * ПОЧЕМУ НЕ В AppState: `selectedNode`/`selectedCells` входят в trackedProperties
 * Proxy состояния (state-core.js) — запись пометила бы акт несохранённым от
 * простого клика по шапке блока. Выделение — эфемерный UI, в документ не входит
 * и в сохранение не попадает.
 *
 * ПОЧЕМУ ПО id, А НЕ ПО DOM-ССЫЛКАМ: renderBlocks перерисовывает контейнер поля
 * целиком (`container.innerHTML = ''`), и любые ссылки на обёртки протухают
 * после первой же вставки/перестановки. Классы выделения восстанавливаются по
 * id после каждой перерисовки (_syncBlockSelectionClasses), а id исчезнувших
 * блоков вычищаются там же (prune).
 *
 * Выделение живёт строго в границах пары (violationId, fieldKey): клик по шапке
 * блока другого поля начинает выделение заново там.
 */

/**
 * Форма слова «блок» для счётного текста групповых операций («Удалить 3
 * блока»). Живёт здесь, а не в app-config: текст нужен и меню
 * (context-menu-violation.js), и диалогу подтверждения (violation-blocks.js),
 * а этот модуль — единственный, который импортируют оба без риска цикла.
 *
 * @param {number} count - Число блоков
 * @returns {'блок'|'блока'|'блоков'}
 */
export function pluralizeBlocks(count) {
    if (count % 10 === 1 && count % 100 !== 11) return 'блок';
    if (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20)) return 'блока';
    return 'блоков';
}

/**
 * Состояние мультивыделения блоков поля нарушения.
 *
 * Инвариант: непустой `ids` всегда сопровождается непустой парой
 * (violationId, fieldKey) — «висящего» выделения без адреса поля не бывает.
 */
export class BlockSelection {
    constructor() {
        /** @type {string|null} Нарушение, которому принадлежит выделение. */
        this.violationId = null;
        /** @type {string|null} Поле реестра, которому принадлежит выделение. */
        this.fieldKey = null;
        /** @type {Set<string>} id выделенных блоков (порядок — не хранится). */
        this.ids = new Set();
        /** @type {string|null} Якорь Shift-диапазона — последний клик БЕЗ Shift. */
        this.anchorId = null;
    }

    /**
     * @returns {boolean} true, если не выделено ни одного блока
     */
    isEmpty() {
        return this.ids.size === 0;
    }

    /**
     * @returns {number} Число выделенных блоков
     */
    size() {
        return this.ids.size;
    }

    /**
     * Принадлежит ли текущее выделение этому полю этого нарушения.
     * @param {string} violationId - ID нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @returns {boolean}
     */
    isScope(violationId, fieldKey) {
        return this.violationId === violationId && this.fieldKey === fieldKey;
    }

    /**
     * Выделен ли КОНКРЕТНЫЙ блок конкретного поля.
     * @param {string} violationId - ID нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {string} blockId - ID блока
     * @returns {boolean}
     */
    isSelected(violationId, fieldKey, blockId) {
        return this.isScope(violationId, fieldKey) && this.ids.has(blockId);
    }

    /**
     * Выделенные id этого поля В ПОРЯДКЕ ПОЛЯ — групповые операции (drag,
     * удаление) обязаны видеть блоки в их исходном относительном порядке.
     * Чужое поле — пустой массив.
     *
     * @param {string} violationId - ID нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {string[]} orderedIds - id блоков поля в порядке хранения
     * @returns {string[]}
     */
    idsInOrder(violationId, fieldKey, orderedIds) {
        if (!this.isScope(violationId, fieldKey)) return [];
        return orderedIds.filter(id => this.ids.has(id));
    }

    /** Полный сброс выделения (адрес поля и якорь тоже). */
    clear() {
        this.violationId = null;
        this.fieldKey = null;
        this.ids.clear();
        this.anchorId = null;
    }

    /**
     * Забывает id блоков, которых в поле больше нет (удаление, откат, загрузка
     * другого акта). Чужое поле не трогает. Опустевшее выделение сбрасывается
     * целиком — «адрес без блоков» нарушал бы инвариант класса.
     *
     * @param {string} violationId - ID нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {string[]} orderedIds - id блоков поля в порядке хранения
     * @returns {boolean} true — состав выделения изменился
     */
    prune(violationId, fieldKey, orderedIds) {
        if (!this.isScope(violationId, fieldKey)) return false;

        const alive = new Set(orderedIds);
        let changed = false;
        for (const id of [...this.ids]) {
            if (!alive.has(id)) {
                this.ids.delete(id);
                changed = true;
            }
        }
        if (this.anchorId !== null && !alive.has(this.anchorId)) {
            this.anchorId = null;
        }
        if (this.ids.size === 0 && changed) this.clear();
        return changed;
    }

    /**
     * Клик по шапке блока: обычный — единичное выделение, Ctrl — toggle,
     * Shift — диапазон от якоря. Якорь двигают только клики БЕЗ Shift
     * (стандартная семантика списков: Shift растягивает от последнего
     * «настоящего» клика, а не от предыдущего конца диапазона).
     *
     * Клик в ДРУГОЕ поле начинает выделение там с нуля — модификаторы при этом
     * игнорируются: продолжать нечего (диапазон между полями невозможен,
     * toggle к чужому выделению — тоже).
     *
     * @param {string} violationId - ID нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {string} blockId - ID блока, по шапке которого кликнули
     * @param {{ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean}} modifiers - Модификаторы клика
     * @param {string[]} orderedIds - id блоков поля в порядке хранения
     * @returns {boolean} true — состояние выделения изменилось
     */
    applyClick(violationId, fieldKey, blockId, modifiers, orderedIds) {
        const before = this._snapshot();

        if (!this.isScope(violationId, fieldKey)) {
            this.clear();
            this.violationId = violationId;
            this.fieldKey = fieldKey;
            this.ids = new Set([blockId]);
            this.anchorId = blockId;
            return this._snapshot() !== before;
        }

        const ctrl = !!(modifiers?.ctrlKey || modifiers?.metaKey);
        const shift = !!modifiers?.shiftKey;
        const anchorIndex = this.anchorId === null ? -1 : orderedIds.indexOf(this.anchorId);

        if (shift && anchorIndex !== -1) {
            const targetIndex = orderedIds.indexOf(blockId);
            if (targetIndex !== -1) {
                const from = Math.min(anchorIndex, targetIndex);
                const to = Math.max(anchorIndex, targetIndex);
                // Диапазон ЗАМЕЩАЕТ выделение (а не дополняет): повторный
                // Shift+клик сужает/расширяет ту же полосу от якоря.
                this.ids = new Set(orderedIds.slice(from, to + 1));
                return this._snapshot() !== before;
            }
        }

        if (ctrl) {
            if (this.ids.has(blockId)) this.ids.delete(blockId);
            else this.ids.add(blockId);
            this.anchorId = blockId;
            // Ctrl мог снять последний блок — адрес поля без блоков не держим.
            if (this.ids.size === 0) this.clear();
            return this._snapshot() !== before;
        }

        this.ids = new Set([blockId]);
        this.anchorId = blockId;
        return this._snapshot() !== before;
    }

    /**
     * Строковый снимок состояния для сравнения «изменилось ли выделение».
     * Порядок id нормализуется — Set не гарантирует его стабильности между
     * пересборками (`new Set(...)` в ветках выше).
     * @returns {string}
     * @private
     */
    _snapshot() {
        return `${this.violationId} ${this.fieldKey} ${[...this.ids].sort().join(',')}`;
    }
}
