/**
 * DOM-фабрики блоков поля нарушения (блочная модель).
 *
 * Три типа блоков — три фабрики с единой обёрткой `.content-item-wrapper`
 * (ручка перетаскивания + подпись типа + тело блока). Нумерации у блоков нет:
 * тип «Кейс N» умер вместе со старой моделью, слово «Кейс» пользователь при
 * необходимости пишет сам в текст-блоке.
 *
 * Все записи в модель — через поверхность блока (текст/подпись,
 * violation-field-surface.js) либо мутатор setBlockField (ширина картинки).
 */

import { ViolationManager } from './violation-core.js';
import { AppConfig } from '../../shared/app-config.js';
import { BLOCK_TYPES, BLOCK_TYPE_META } from './violation-block-types.js';
import { renderImageWithFallback } from './violation-image-render.js';
import { resolveBlockImageSrc } from './violation-image-api.js';
import { createTableElement } from '../table/table-render.js';
import { makeEmbeddedTableId } from '../table/table-store.js';
import { tableManager } from '../table/table-core.js';
import { toggleEmptyClass } from './violation-field-empty.js';

/**
 * Опции селекта ширины картинки (Б-1.4): [значение block.width, подпись].
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
     * Отрисовывает блоки ОДНОГО поля в порядке хранения. Диспетчер по
     * block.type; неизвестный тип пропускается молча (схема бэка его не
     * пропустит, а падать на рендере карточки нельзя).
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер блоков (.violation-blocks-items)
     * @param {boolean} [isReadOnly] - Режим просмотра
     */
    renderBlocks(violation, fieldKey, container, isReadOnly = AppConfig.readOnlyMode?.isReadOnly) {
        container.innerHTML = '';

        const blocks = violation?.[fieldKey]?.blocks || [];

        blocks.forEach((block, index) => {
            let blockElement;

            if (block.type === BLOCK_TYPES.TEXT) {
                blockElement = this.createTextBlockElement(violation, fieldKey, block, isReadOnly);
            } else if (block.type === BLOCK_TYPES.IMAGE) {
                blockElement = this.createImageBlockElement(violation, fieldKey, block, isReadOnly);
            } else if (block.type === BLOCK_TYPES.TABLE) {
                blockElement = this.createTableBlockWrapper(violation, fieldKey, block, isReadOnly);
            }

            if (!blockElement) return;

            // id блока в dataset — адрес для удаления через меню и для DnD.
            blockElement.dataset.blockId = block.id;
            blockElement.dataset.blockIndex = index;
            // draggable выключен по умолчанию: перетаскивание разрешает только
            // mousedown по шапке блока (armBlockDrag), иначе выделение текста и
            // работа в теле блока начинали бы drag.
            blockElement.draggable = false;

            if (!isReadOnly) {
                blockElement.addEventListener('mousedown', (e) => this.armBlockDrag(e, blockElement));
                blockElement.addEventListener('mouseup', () => this.disarmBlockDrag(blockElement));
                blockElement.addEventListener('dragstart', (e) => this.handleDragStart(e, violation, fieldKey, index, block));
                blockElement.addEventListener('dragenter', (e) => this.handleDragEnter(e));
                blockElement.addEventListener('dragleave', (e) => this.handleDragLeave(e));
                // dragover/drop — на КОНТЕЙНЕРЕ поля (setupBlockDragAndDrop):
                // над зазором между карточками обёртки нет, а drop туда должен
                // работать. dragend остаётся здесь — он приходит источнику drag.
                blockElement.addEventListener('dragend', (e) => this.handleDragEnd(e, violation, fieldKey, container));
            }

            container.appendChild(blockElement);
        });

        // Сбрасываем последний индекс и блок, по которому он посчитан:
        // прежние обёртки уже выброшены, гистерезису не за что держаться.
        this.lastDragOverIndex = null;
        this._lastDragOverElement = null;

        // Мультивыделение адресуется id блоков, а не DOM-ссылками: обёртки
        // выше созданы заново, подсветку восстанавливаем по id (и вычищаем id
        // блоков, которых в поле больше нет). `?.` — на случай вызова
        // renderBlocks в изоляции, до домешивания violation-blocks.js.
        this._syncBlockSelectionClasses?.(violation, fieldKey, container);
    },

    /**
     * Общая обёртка блока: ручка перетаскивания с подписью типа + тело.
     * @param {string} label - Подпись типа блока
     * @returns {{wrapper: HTMLElement, body: HTMLElement}}
     */
    _createBlockWrapper(label) {
        const wrapper = document.createElement('div');
        wrapper.className = 'content-item-wrapper';

        const handle = document.createElement('div');
        handle.className = 'content-item-label';
        handle.textContent = `⋮⋮ ${label}`;

        const body = document.createElement('div');
        body.className = 'content-item';

        wrapper.appendChild(handle);
        wrapper.appendChild(body);
        return { wrapper, body };
    },

    /**
     * Текст-блок: полноценная rich-поверхность (тот же тулбар, что у
     * текстблоков и остальных полей).
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {Object} block - Блок типа 'text'
     * @param {boolean} [isReadOnly] - Режим просмотра
     * @returns {HTMLElement} Обёртка блока
     */
    createTextBlockElement(violation, fieldKey, block, isReadOnly = false) {
        const { wrapper, body } = this._createBlockWrapper(BLOCK_TYPE_META[BLOCK_TYPES.TEXT].label);
        // Подсветка пустого блока (#9-Г): не блокирует ввод, только визуальный
        // сигнал. Единый предикат с live-тумблером ниже — toggleEmptyClass.
        toggleEmptyClass(wrapper, 'content-item-wrapper--empty', block.content);

        const field = this._createRichFieldEditor(
            this._makeBlockSurface(violation, fieldKey, block),
            { placeholder: 'Текст', isReadOnly },
        );

        if (!isReadOnly) {
            // Живая подсветка пустоты — только визуальный класс, без записи
            // модели (её ведёт write-through контроллера через commit).
            field.addEventListener('input', () => {
                toggleEmptyClass(wrapper, 'content-item-wrapper--empty', field);
            });
        }

        body.appendChild(field);
        return wrapper;
    },

    /**
     * Блок-картинка: превью с фолбэком, имя файла, rich-подпись и селект ширины.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {Object} block - Блок типа 'image'
     * @param {boolean} [isReadOnly] - Режим просмотра
     * @returns {HTMLElement} Обёртка блока
     */
    createImageBlockElement(violation, fieldKey, block, isReadOnly = false) {
        const { wrapper, body } = this._createBlockWrapper(BLOCK_TYPE_META[BLOCK_TYPES.IMAGE].label);
        body.className = 'image-item';

        // Контейнер с фиксированной высотой для изображения
        const imgContainer = document.createElement('div');
        imgContainer.className = 'image-preview-container';

        // #27: onerror ДО src + текст-плейсхолдер при битой картинке (зеркалит превью).
        // src — ссылка на байты в act_images; пустой image_id (черновик) или
        // висячий id дают тот же текстовый плейсхолдер, что и битый файл.
        renderImageWithFallback(imgContainer, {
            src: resolveBlockImageSrc(block),
            alt: block.caption || block.filename,
            imgClassName: 'image-preview',
            placeholderText: `Изображение: ${block.filename}`,
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
        filenameDiv.textContent = block.filename;

        // Подпись — rich-поле (attr 'caption'); compact-модификатор держит поле
        // низким (однострочная подпись — не полноразмерная textarea).
        const captionField = this._createRichFieldEditor(
            this._makeBlockSurface(violation, fieldKey, block, 'caption'),
            { placeholder: 'Подпись к изображению', isReadOnly },
        );
        captionField.classList.add('violation-textarea--compact');

        // Селект ширины картинки (Б-1.4): % полезной ширины листа, 0 — авто
        // (натуральный размер с потолком по ширине). Пишет block.width через
        // мутатор — превью и DOCX применят значение.
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
        widthSelect.value = String(block.width || 0);
        widthLabel.htmlFor = widthSelect.id = `${block.id}-width`;
        widthSelect.disabled = isReadOnly;

        if (!isReadOnly) {
            widthSelect.addEventListener('change', () => {
                this.setBlockField(violation, fieldKey, block.id, 'width',
                    parseInt(widthSelect.value, 10) || 0);
            });
        }

        widthControl.appendChild(widthLabel);
        widthControl.appendChild(widthSelect);

        body.appendChild(imgContainer);
        body.appendChild(filenameDiv);
        body.appendChild(captionField);
        body.appendChild(widthControl);

        return wrapper;
    },

    /**
     * Блок-таблица: ОБЫЧНАЯ таблица конструктора в общей обёртке блока.
     *
     * Разметка и машинерия — те же, что у узловых таблиц: `createTableElement`
     * даёт `.editable-table` (а значит и те же CSS), а
     * `attachEventListenersToContainer` — dblclick-редактирование, выделение,
     * контекст-меню и ручки ресайза. Адрес таблицы для этой машинерии —
     * синтетический id `vt::…` (table-store.js); host-контейнер помечен
     * `data-embedded-table-id`, по нему `afterTableChanged` находит, что
     * пересобрать после структурной правки.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {Object} block - Блок типа 'table'
     * @param {boolean} [isReadOnly] - Режим просмотра (здесь сознательно не
     *        читается: гейты режима живут в самой машинерии, см. ниже)
     * @returns {HTMLElement} Обёртка блока
     */
    createTableBlockWrapper(violation, fieldKey, block, isReadOnly = false) {
        const { wrapper, body } = this._createBlockWrapper(BLOCK_TYPE_META[BLOCK_TYPES.TABLE].label);
        body.className = 'content-item content-item--table';

        const tableId = makeEmbeddedTableId(violation.id, fieldKey, block.id);
        const host = document.createElement('div');
        host.className = 'violation-table-block-scroll';
        host.dataset.embeddedTableId = tableId;
        host.appendChild(createTableElement(block.table || {}, tableId));

        // Слушатели вешаем и в режиме просмотра — паритет с узловыми таблицами:
        // запись отсекают гейты startEditingCell и ContextMenuManager.show,
        // а выделение ячеек в просмотре разрешено.
        tableManager.attachEventListenersToContainer(host);

        body.appendChild(host);
        return wrapper;
    }
});
