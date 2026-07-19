/**
 * Модуль рендеринга элементов дополнительного контента
 * Создание DOM-элементов для кейсов, изображений и текста
 */

import { ViolationManager } from './violation-core.js';
import { AppConfig } from '../../shared/app-config.js';
import {
    CONTENT_TYPE_CASE,
    CONTENT_TYPE_FREE_TEXT,
    CONTENT_TYPE_IMAGE,
} from './violation-content-item.js';
import { renderImageWithFallback } from './violation-image-render.js';
import { computeAdditionalContentNumbers } from './violation-numbering.js';

/**
 * Опции селекта ширины картинки (Б-1.4): [значение item.width, подпись].
 * 0 — «Авто»: натуральный размер с потолком по полезной ширине листа.
 */
export const IMAGE_WIDTH_OPTIONS = [
    [0, 'Авто'],
    [25, '25%'],
    [50, '50%'],
    [75, '75%'],
    [100, '100%'],
];

// Расширение ViolationManager
Object.assign(ViolationManager.prototype, {
    /**
     * Отрисовывает все элементы в порядке добавления
     * Вычисляет нумерацию для последовательных кейсов
     * @param {Object} violation - Объект нарушения
     * @param {HTMLElement} container - Контейнер для элементов
     */
    renderContentItems(violation, container, isReadOnly = AppConfig.readOnlyMode?.isReadOnly) {
        container.innerHTML = '';

        // Вычисляем нумерацию для последовательных кейсов
        const itemsWithNumbers = computeAdditionalContentNumbers(violation.additionalContent.items);

        violation.additionalContent.items.forEach((item, index) => {
            let itemElement;

            if (item.type === CONTENT_TYPE_CASE) {
                const caseNumber = itemsWithNumbers[index]?.number;
                itemElement = this.createCaseElement(violation, item, index, caseNumber, isReadOnly);
            } else if (item.type === CONTENT_TYPE_IMAGE) {
                const imageNumber = this.getTypeSequentialNumber(violation.additionalContent.items, CONTENT_TYPE_IMAGE, index);
                itemElement = this.createImageElement(violation, item, index, imageNumber, isReadOnly);
            } else if (item.type === CONTENT_TYPE_FREE_TEXT) {
                const textNumber = this.getTypeSequentialNumber(violation.additionalContent.items, CONTENT_TYPE_FREE_TEXT, index);
                itemElement = this.createFreeTextElement(violation, item, index, textNumber, isReadOnly);
            }

            if (itemElement) {
                // Добавляем ID элемента в dataset для корректного удаления
                itemElement.dataset.itemId = item.id;
                itemElement.dataset.itemIndex = index;

                // Добавляем drag-and-drop атрибуты (только если не режим чтения)
                itemElement.draggable = !isReadOnly;

                // Обработчики перетаскивания (только если не режим чтения)
                if (!isReadOnly) {
                    itemElement.addEventListener('dragstart', (e) => this.handleDragStart(e, violation, index, item));
                    itemElement.addEventListener('dragover', (e) => this.handleDragOver(e, violation, container));
                    itemElement.addEventListener('dragenter', (e) => this.handleDragEnter(e));
                    itemElement.addEventListener('dragleave', (e) => this.handleDragLeave(e));
                    itemElement.addEventListener('drop', (e) => this.handleDrop(e, violation, index, container));
                    itemElement.addEventListener('dragend', (e) => this.handleDragEnd(e, violation, container));
                }

                container.appendChild(itemElement);
            }
        });

        // Сбрасываем последний индекс
        this.lastDragOverIndex = null;
    },

    /**
     * Получает порядковый номер элемента определенного типа (не прерываемый)
     * @param {Array} items - Массив элементов
     * @param {string} type - Тип элемента
     * @param {number} currentIndex - Текущий индекс
     * @returns {number} Порядковый номер
     */
    getTypeSequentialNumber(items, type, currentIndex) {
        let count = 0;
        for (let i = 0; i <= currentIndex; i++) {
            if (items[i].type === type) {
                count++;
            }
        }
        return count;
    },

    /**
     * Создает элемент кейса с нумерацией
     * @param {Object} violation - Объект нарушения
     * @param {Object} item - Данные элемента
     * @param {number} index - Индекс элемента
     * @param {number} caseNumber - Номер кейса
     * @returns {HTMLElement} Элемент кейса
     */
    createCaseElement(violation, item, index, caseNumber, isReadOnly = false) {
        const wrapper = document.createElement('div');
        wrapper.className = 'content-item-wrapper';
        // Подсветка пустого кейса (#9-Г, Wave 2): не блокирует ввод, только визуальный сигнал.
        wrapper.classList.toggle('content-item-wrapper--empty', !item.content?.trim());

        const label = document.createElement('div');
        label.className = 'content-item-label';
        label.innerHTML = `⋮⋮ Кейс ${caseNumber}`;

        const itemDiv = document.createElement('div');
        itemDiv.className = 'content-item';

        // Кейс — rich-поле (contenteditable), путь по item через content-item
        // поверхность; ввод пишется в item.content write-through контроллера.
        const field = this._createRichFieldEditor(
            this._makeContentItemSurface(violation, item),
            { placeholder: 'Описание кейса', isReadOnly },
        );
        if (!isReadOnly) {
            // Живая подсветка пустого кейса (#9-Г) — только визуальный класс, без
            // записи модели (её ведёт write-through контроллера через commit).
            field.addEventListener('input', () => {
                wrapper.classList.toggle('content-item-wrapper--empty', !field.textContent.trim());
            });
        }

        itemDiv.appendChild(field);
        wrapper.appendChild(label);
        wrapper.appendChild(itemDiv);

        return wrapper;
    },

    /**
     * Создает элемент изображения с нумерацией
     * @param {Object} violation - Объект нарушения
     * @param {Object} item - Данные элемента
     * @param {number} index - Индекс элемента
     * @param {number} imageNumber - Номер изображения
     * @returns {HTMLElement} Элемент изображения
     */
    createImageElement(violation, item, index, imageNumber, isReadOnly = false) {
        const wrapper = document.createElement('div');
        wrapper.className = 'content-item-wrapper';

        const label = document.createElement('div');
        label.className = 'content-item-label';
        label.innerHTML = `⋮⋮ Изображение ${imageNumber}`;

        const itemDiv = document.createElement('div');
        itemDiv.className = 'image-item';

        // Контейнер с фиксированной высотой для изображения
        const imgContainer = document.createElement('div');
        imgContainer.className = 'image-preview-container';

        // #27: onerror ДО src + текст-плейсхолдер при битой картинке (зеркалит превью).
        renderImageWithFallback(imgContainer, {
            src: item.url,
            alt: item.caption || item.filename,
            imgClassName: 'image-preview',
            placeholderText: `Изображение: ${item.filename}`,
            placeholderClassName: 'image-preview-placeholder',
            configureImg: (img) => {
                // Запрещаем перетаскивание самого изображения
                img.draggable = false;
                img.style.pointerEvents = 'none';
                img.style.userSelect = 'none';
            },
        });

        const filenameDiv = document.createElement('div');
        filenameDiv.className = 'image-filename';
        filenameDiv.textContent = item.filename;

        // Подпись — rich-поле (Task 6, contenteditable), путь по item.caption
        // через content-item поверхность (field='caption'); compact-модификатор
        // держит поле низким (однострочная подпись — не полноразмерная textarea).
        const captionField = this._createRichFieldEditor(
            this._makeContentItemSurface(violation, item, 'caption'),
            { placeholder: 'Подпись к изображению', isReadOnly },
        );
        captionField.classList.add('violation-textarea--compact');

        // Селект ширины картинки (Б-1.4): % полезной ширины листа, 0 — авто
        // (натуральный размер с потолком по ширине). Пишет item.width —
        // Proxy пометит unsaved, превью и DOCX применят значение.
        const widthControl = document.createElement('div');
        widthControl.className = 'image-width-control';

        const widthLabel = document.createElement('label');
        widthLabel.className = 'image-width-label';
        widthLabel.textContent = 'Ширина:';

        const widthSelect = document.createElement('select');
        widthSelect.className = 'image-width-select';
        for (const [value, text] of IMAGE_WIDTH_OPTIONS) {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = text;
            widthSelect.appendChild(option);
        }
        widthSelect.value = String(item.width || 0);
        widthLabel.htmlFor = widthSelect.id = `${item.id}-width`;
        widthSelect.disabled = isReadOnly;

        if (!isReadOnly) {
            widthSelect.addEventListener('change', () => {
                this.setContentItemField(violation, item, 'width', parseInt(widthSelect.value, 10) || 0);
            });
        }

        widthControl.appendChild(widthLabel);
        widthControl.appendChild(widthSelect);

        itemDiv.appendChild(imgContainer);
        itemDiv.appendChild(filenameDiv);
        itemDiv.appendChild(captionField);
        itemDiv.appendChild(widthControl);

        wrapper.appendChild(label);
        wrapper.appendChild(itemDiv);

        return wrapper;
    },

    /**
     * Создает элемент произвольного текста с нумерацией
     * @param {Object} violation - Объект нарушения
     * @param {Object} item - Данные элемента
     * @param {number} index - Индекс элемента
     * @param {number} textNumber - Номер текстового блока
     * @returns {HTMLElement} Элемент текста
     */
    createFreeTextElement(violation, item, index, textNumber, isReadOnly = false) {
        const wrapper = document.createElement('div');
        wrapper.className = 'content-item-wrapper';
        // Подсветка пустого текста (#9-Г, Wave 2): не блокирует ввод, только визуальный сигнал.
        wrapper.classList.toggle('content-item-wrapper--empty', !item.content?.trim());

        const label = document.createElement('div');
        label.className = 'content-item-label';
        label.innerHTML = `⋮⋮ Текст ${textNumber}`;

        const itemDiv = document.createElement('div');
        itemDiv.className = 'content-item';

        // Свободный текст — rich-поле (contenteditable), путь по item через
        // content-item поверхность; ввод пишется в item.content контроллером.
        const field = this._createRichFieldEditor(
            this._makeContentItemSurface(violation, item),
            { placeholder: 'Произвольный текст', isReadOnly },
        );
        if (!isReadOnly) {
            // Живая подсветка пустого текста (#9-Г) — только визуальный класс.
            field.addEventListener('input', () => {
                wrapper.classList.toggle('content-item-wrapper--empty', !field.textContent.trim());
            });
        }

        itemDiv.appendChild(field);
        wrapper.appendChild(label);
        wrapper.appendChild(itemDiv);

        return wrapper;
    }
});
