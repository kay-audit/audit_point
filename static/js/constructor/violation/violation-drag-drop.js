/**
 * Drag & Drop блоков ВНУТРИ одного поля нарушения.
 *
 * Полезная нагрузка перетаскивания — {violationId, fieldKey, blockId}: drop в
 * контейнер другого поля (или другого нарушения) игнорируется, перенос блоков
 * между полями — сознательный non-goal первой итерации (спека §7).
 * Перестановка — мутатором moveBlock (там read-only-guard и превью).
 */

import { ViolationManager } from './violation-core.js';
import { BLOCK_TYPES } from './violation-block-types.js';

/** MIME-тип полезной нагрузки внутреннего перетаскивания блока. */
const DRAG_PAYLOAD_TYPE = 'application/x-violation-block';

/** Подписи и иконки миниатюры по типу блока. */
const DRAG_MINIATURE = {
    [BLOCK_TYPES.TEXT]: ['📝', 'Текст'],
    [BLOCK_TYPES.IMAGE]: ['🖼️', 'Изображение'],
    [BLOCK_TYPES.TABLE]: ['📊', 'Таблица'],
};

/**
 * Читает полезную нагрузку перетаскивания: из dataTransfer (drop), иначе — из
 * снимка на менеджере (dragover: getData во время drag браузер не отдаёт).
 * @param {Event} e - Событие drag&drop
 * @param {ViolationManager} manager
 * @returns {{violationId: string, fieldKey: string, blockId: string}|null}
 */
function readDragPayload(e, manager) {
    try {
        const raw = e.dataTransfer?.getData(DRAG_PAYLOAD_TYPE);
        if (raw) return JSON.parse(raw);
    } catch (_) { /* нечитаемый payload — падаем на снимок ниже */ }
    return manager._dragPayload || null;
}

/**
 * Принадлежит ли перетаскиваемый блок ИМЕННО этому полю этого нарушения.
 * @param {Object|null} payload - Полезная нагрузка перетаскивания
 * @param {Object} violation - Объект нарушения
 * @param {string} fieldKey - Ключ поля реестра
 * @returns {boolean}
 */
function isSameField(payload, violation, fieldKey) {
    return !!payload && payload.violationId === violation.id && payload.fieldKey === fieldKey;
}

// Расширение ViolationManager
Object.assign(ViolationManager.prototype, {
    /**
     * Начало перетаскивания блока: полезная нагрузка + миниатюра.
     * @param {Event} e - Событие dragstart
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {number} index - Индекс перетаскиваемого блока
     * @param {Object} block - Блок
     */
    handleDragStart(e, violation, fieldKey, index, block) {
        const wrapper = e.currentTarget;
        wrapper.classList.add('dragging');

        const payload = { violationId: violation.id, fieldKey, blockId: block.id };
        this._dragPayload = payload;

        e.dataTransfer.effectAllowed = 'move';
        // text/plain — маркер ВНУТРЕННЕГО drag для приёма файлов
        // (violation-file-upload.js различает drag по составу types).
        e.dataTransfer.setData('text/plain', block.id);
        e.dataTransfer.setData(DRAG_PAYLOAD_TYPE, JSON.stringify(payload));

        // Создаем миниатюру
        const miniature = this.createDragMiniature(block);
        miniature.style.position = 'absolute';
        miniature.style.top = '-1000px';
        miniature.id = 'drag-miniature-temp';
        document.body.appendChild(miniature);

        e.dataTransfer.setDragImage(miniature, 20, 20);

        // Удаляем миниатюру после начала перетаскивания
        setTimeout(() => {
            const temp = document.getElementById('drag-miniature-temp');
            if (temp) temp.remove();
        }, 0);

        // Сбрасываем последний индекс и флаг коммита при начале перетаскивания.
        this.lastDragOverIndex = null;
        this._dropCommitted = false;
    },

    /**
     * Создает миниатюру блока для drag-and-drop
     * @param {Object} block - Блок
     * @returns {HTMLElement} Миниатюра
     */
    createDragMiniature(block) {
        const miniature = document.createElement('div');
        miniature.className = 'drag-miniature';

        const [icon, label] = DRAG_MINIATURE[block.type] || ['', ''];
        miniature.innerHTML = `${icon} ${label}`;
        return miniature;
    },

    /**
     * Обработчик входа в зону блока
     * @param {Event} e - Событие dragenter
     */
    handleDragEnter(e) {
        e.preventDefault();
    },

    /**
     * Перемещение над блоком: индикатор позиции вставки.
     * @param {Event} e - Событие dragover
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер блоков поля
     */
    handleDragOver(e, violation, fieldKey, container) {
        // Блок из другого поля/нарушения — зону не подсвечиваем и drop не примем.
        if (!isSameField(this._dragPayload, violation, fieldKey)) return;

        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const draggingElement = document.querySelector('.dragging');
        if (!draggingElement) return;

        const currentElement = e.target.closest('.content-item-wrapper');

        if (!currentElement || currentElement === draggingElement) {
            return;
        }

        // Получаем границы текущего элемента
        const rect = currentElement.getBoundingClientRect();
        const mouseY = e.clientY;
        const elementMiddle = rect.top + rect.height / 2;

        // Определяем, в какую половину элемента попал курсор
        const isTopHalf = mouseY < elementMiddle;

        // Получаем индекс текущего элемента
        const allWrappers = [...container.querySelectorAll('.content-item-wrapper')];
        const currentIndex = allWrappers.indexOf(currentElement);

        // Проверяем, изменилась ли позиция с последнего вызова
        const targetPosition = isTopHalf ? currentIndex : currentIndex + 1;

        if (this.lastDragOverIndex === targetPosition) {
            return; // Позиция не изменилась, не делаем ничего
        }

        this.lastDragOverIndex = targetPosition;

        // Рисуем индикатор позиции вместо физического сдвига элемента (#6):
        // DOM больше не переставляется оптимистично, порядок вычисляется в
        // handleDrop index-based'ом. При Esc/промахе нечего откатывать.
        this.updateInsertIndicator(container, targetPosition);
    },

    /**
     * Обработчик выхода курсора из зоны элемента
     * @param {Event} e - Событие dragleave
     */
    handleDragLeave(e) {
        // Оставляем пустым, визуальное перемещение происходит в handleDragOver
    },

    /**
     * Сброс блока — фиксирует новый порядок в данных.
     * @param {Event} e - Событие drop
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {number} targetIndex - Индекс целевого блока
     * @param {HTMLElement} container - Контейнер блоков поля
     */
    handleDrop(e, violation, fieldKey, targetIndex, container) {
        const payload = readDragPayload(e, this);
        // Чужое поле/нарушение — молча игнорируем (перенос между полями не поддержан).
        if (!isSameField(payload, violation, fieldKey)) return;

        e.preventDefault();
        e.stopPropagation();

        const blocks = violation?.[fieldKey]?.blocks || [];
        const fromIndex = blocks.findIndex(block => block.id === payload.blockId);
        if (fromIndex === -1) return;

        // Позиция вставки: точная из dragover (учитывает верх/низ половину
        // элемента), иначе — индекс блока под курсором (fallback без dragover).
        const toIndex = this.lastDragOverIndex !== null ? this.lastDragOverIndex : targetIndex;

        // Index-based перестановка (#6): DOM больше НЕ сдвинут оптимистично,
        // порядок считаем из данных. Сам splice — в мутаторе (§5.10a), там же
        // read-only-guard и превью; отказ мутатора не коммитим.
        if (!this.moveBlock(violation, fieldKey, fromIndex, toIndex)) return;

        // Коммит состоялся — handleDragEnd не должен перерисовывать повторно.
        this._dropCommitted = true;

        // Перерисовываем с обновленными индексами
        this.renderBlocks(violation, fieldKey, container);
    },

    /**
     * Окончание перетаскивания.
     * @param {Event} e - Событие dragend
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер блоков поля
     */
    handleDragEnd(e, violation, fieldKey, container) {
        e.target.classList.remove('dragging');

        // Снимаем индикатор позиции.
        this.removeInsertIndicators(container);

        // Если drop не зафиксировал новый порядок (Esc/промах мимо зоны) —
        // восстанавливаем DOM из данных: фантома от прежнего оптимистичного
        // сдвига больше нет, но re-render идемпотентно гарантирует чистоту
        // (в т.ч. после внутреннего drop через контейнер файлов).
        if (!this._dropCommitted) {
            this.renderBlocks(violation, fieldKey, container);
        }

        // Сбрасываем состояние для следующего drag.
        this._dropCommitted = false;
        this.lastDragOverIndex = null;
        this._dragPayload = null;
    }
});
