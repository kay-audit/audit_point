/**
 * Модуль Drag & Drop для элементов контента
 * Перестановка элементов внутри дополнительного контента
 */

import { ViolationManager } from './violation-core.js';
import {
    CONTENT_TYPE_CASE,
    CONTENT_TYPE_FREE_TEXT,
    CONTENT_TYPE_IMAGE,
} from './violation-content-item.js';
import { computeAdditionalContentNumbers } from './violation-numbering.js';

// Расширение ViolationManager
Object.assign(ViolationManager.prototype, {
    /**
     * Обработчик начала перетаскивания с созданием миниатюры
     * @param {Event} e - Событие dragstart
     * @param {Object} violation - Объект нарушения
     * @param {number} index - Индекс перетаскиваемого элемента
     * @param {Object} item - Данные элемента
     */
    handleDragStart(e, violation, index, item) {
        const wrapper = e.currentTarget;
        wrapper.classList.add('dragging');

        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.id);

        // Создаем миниатюру
        const miniature = this.createDragMiniature(item, index, violation.additionalContent.items);
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
     * Создает миниатюру элемента для drag-and-drop
     * @param {Object} item - Данные элемента
     * @param {number} index - Индекс элемента
     * @param {Array} allItems - Все элементы
     * @returns {HTMLElement} Миниатюра
     */
    createDragMiniature(item, index, allItems) {
        const miniature = document.createElement('div');
        miniature.className = 'drag-miniature';

        let label = '';
        let icon = '';

        if (item.type === CONTENT_TYPE_CASE) {
            const caseNumbers = computeAdditionalContentNumbers(allItems);
            const caseNumber = caseNumbers[index]?.number;
            icon = '📋';
            label = `Кейс ${caseNumber}`;
        } else if (item.type === CONTENT_TYPE_IMAGE) {
            const imageNumber = this.getTypeSequentialNumber(allItems, CONTENT_TYPE_IMAGE, index);
            icon = '🖼️';
            label = `Изображение ${imageNumber}`;
        } else if (item.type === CONTENT_TYPE_FREE_TEXT) {
            const textNumber = this.getTypeSequentialNumber(allItems, CONTENT_TYPE_FREE_TEXT, index);
            icon = '📝';
            label = `Текст ${textNumber}`;
        }

        miniature.innerHTML = `${icon} ${label}`;
        return miniature;
    },

    /**
     * Обработчик входа в зону элемента
     * @param {Event} e - Событие dragenter
     */
    handleDragEnter(e) {
        e.preventDefault();
    },

    /**
     * Обработчик перемещения над элементом с плавным визуальным перемещением
     * @param {Event} e - Событие dragover
     * @param {Object} violation - Объект нарушения
     * @param {HTMLElement} container - Контейнер элементов
     */
    handleDragOver(e, violation, container) {
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
     * Обработчик сброса элемента - фиксирует новый порядок в данных
     * @param {Event} e - Событие drop
     * @param {Object} violation - Объект нарушения
     * @param {number} targetIndex - Индекс целевого элемента
     * @param {HTMLElement} container - Контейнер элементов
     */
    handleDrop(e, violation, targetIndex, container) {
        e.preventDefault();
        e.stopPropagation();

        const draggingElement = document.querySelector('.dragging');
        if (!draggingElement) return;

        const items = violation.additionalContent.items;
        const draggedId = draggingElement.dataset.itemId;
        const fromIndex = items.findIndex(item => item.id === draggedId);
        if (fromIndex === -1) return;

        // Позиция вставки: точная из dragover (учитывает верх/низ половину
        // элемента), иначе — индекс элемента под курсором (fallback без dragover).
        const toIndex = this.lastDragOverIndex !== null ? this.lastDragOverIndex : targetIndex;

        // Index-based перестановка (#6): DOM больше НЕ сдвинут оптимистично,
        // порядок считаем из данных. Сам splice — в мутаторе (§5.10a), там же
        // read-only-guard и превью; отказ мутатора не коммитим.
        if (!this.moveContentItem(violation, fromIndex, toIndex)) return;

        // Коммит состоялся — handleDragEnd не должен перерисовывать повторно.
        this._dropCommitted = true;

        // Перерисовываем с обновленными индексами
        this.renderContentItems(violation, container);
    },

    /**
     * Обработчик окончания перетаскивания
     * @param {Event} e - Событие dragend
     * @param {Object} violation - Объект нарушения
     * @param {HTMLElement} container - Контейнер элементов
     */
    handleDragEnd(e, violation, container) {
        e.target.classList.remove('dragging');

        // Снимаем индикатор позиции.
        this.removeInsertIndicators(container);

        // Если drop не зафиксировал новый порядок (Esc/промах мимо зоны) —
        // восстанавливаем DOM из данных: фантома от прежнего оптимистичного
        // сдвига больше нет, но re-render идемпотентно гарантирует чистоту
        // (в т.ч. после внутреннего drop через контейнер файлов).
        if (!this._dropCommitted) {
            this.renderContentItems(violation, container);
        }

        // Сбрасываем флаг коммита и последний индекс для следующего drag.
        this._dropCommitted = false;
        this.lastDragOverIndex = null;
    }
});
