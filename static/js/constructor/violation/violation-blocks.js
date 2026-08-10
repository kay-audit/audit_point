/**
 * Секция ОДНОГО поля нарушения и её контейнер блоков (блочная модель).
 *
 * Все десять полей реестра (violation-fields.js) рендерятся ОДНИМ этим
 * компонентом — «Дополнительный контент» перестал быть особенным: конвейер
 * приёма картинок, зона вставки и контекстное меню параметризованы ключом поля.
 *
 * Записи в модель — только через мутаторы (violation-mutations.js):
 * setFieldEnabled / addBlock / removeBlock. Здесь остаются гейты, которые
 * мутатору не видны: лимит числа блоков ПО ПОЛЮ (#4) и лимиты картинок
 * (тип/magic/байты).
 *
 * Перенос блоков между полями — сознательный non-goal первой итерации
 * (спека §7): контейнер каждого поля работает только со своими блоками.
 */

import { ContextMenuManager } from '../context-menu/context-menu-core.js';
import { ViolationManager } from './violation-core.js';
import { ValidationCore } from '../validation/validation-core.js';
import { Notifications } from '../../shared/notifications.js';
import { AppConfig } from '../../shared/app-config.js';
import { AppState } from '../state/state-core.js';
import {
    estimateActImageBytes,
    estimateDataUrlBytes,
    getImageLimits,
    validateImageType,
    validateImageBytes,
} from './violation-image-validator.js';
import { BLOCK_TYPES, createTextBlock, createImageBlock, createTableBlock } from './violation-block-types.js';
import { sniffImageMagic, RECOGNIZED_IMAGE_FORMATS } from './violation-file-reading.js';
import { downscaleImage, resolveActualFilename } from './violation-image-resize.js';
import { DialogManager } from '../../shared/dialog/dialog-confirm.js';

/** localStorage-ключ предвыбора режима качества (Q3 всё равно спрашивает каждый раз). */
const IMAGE_QUALITY_MODE_KEY = 'violation_image_quality_mode';

/**
 * Блоки поля с гвардом от повреждённого контейнера (нормализатор дозаполняет
 * форму на загрузке, но программные пути могут прийти раньше него).
 * @param {Object} violation - Объект нарушения
 * @param {string} fieldKey - Ключ поля реестра
 * @returns {Object[]}
 */
function fieldBlocks(violation, fieldKey) {
    const blocks = violation?.[fieldKey]?.blocks;
    return Array.isArray(blocks) ? blocks : [];
}

// Расширение ViolationManager
Object.assign(ViolationManager.prototype, {
    /**
     * Создаёт секцию ОДНОГО поля нарушения: заголовок (чекбокс либо просто
     * метка у mandatory-полей), тулбар добавления блоков и контейнер блоков
     * с зоной вставки, контекстным меню и приёмом файлов.
     *
     * @param {Object} violation - Объект нарушения
     * @param {Object} descriptor - Дескриптор поля реестра ({key,label,mandatory,...})
     * @param {boolean} [isReadOnly] - Режим просмотра
     * @returns {HTMLElement} Секция поля
     */
    createBlocksField(violation, descriptor, isReadOnly = false) {
        const fieldKey = descriptor.key;

        // Страховка от отсутствующего контейнера поля (повреждённые данные до
        // normalizeViolations): подставляем дефолт, валидные данные не трогаем.
        if (!violation[fieldKey] || typeof violation[fieldKey] !== 'object') {
            violation[fieldKey] = { enabled: !!descriptor.mandatory, blocks: [] };
        }
        if (!Array.isArray(violation[fieldKey].blocks)) {
            violation[fieldKey].blocks = [];
        }

        const fieldContainer = document.createElement('div');
        fieldContainer.className = 'violation-field-section';
        fieldContainer.dataset.fieldKey = fieldKey;

        const contentContainer = document.createElement('div');
        contentContainer.className = 'violation-field-content violation-blocks-wrapper';
        // Focusable — перехват Ctrl+V по фокусу (violation-paste.js).
        contentContainer.setAttribute('tabindex', '0');

        // Заголовок поля: у mandatory-полей (Нарушено/Установлено) чекбокса нет
        // — их нельзя выключить, метка выводится как есть.
        const headerContainer = document.createElement('div');
        headerContainer.className = 'violation-field-toggle';

        if (descriptor.mandatory) {
            const label = document.createElement('span');
            label.className = 'violation-field-label';
            label.textContent = descriptor.label;
            headerContainer.appendChild(label);
            headerContainer.classList.add('violation-field-toggle--mandatory');
        } else {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `${violation.id}-${fieldKey}`;
            checkbox.checked = !!violation[fieldKey].enabled;
            checkbox.disabled = isReadOnly;

            // В режиме просмотра чекбокс заблокирован, мутирующий слушатель не
            // вешаем; уже включённые поля остаются раскрытыми для чтения.
            if (!isReadOnly) {
                checkbox.addEventListener('change', () => {
                    this.setFieldEnabled(violation, fieldKey, checkbox.checked);
                    contentContainer.style.display = checkbox.checked ? 'block' : 'none';

                    // Выключили поле — активная зона вставки этого поля недействительна.
                    if (!checkbox.checked && this.currentActiveContainer === contentContainer) {
                        this._resetActiveZone();
                    }
                });
            }

            const checkboxLabel = document.createElement('label');
            checkboxLabel.htmlFor = checkbox.id;
            checkboxLabel.textContent = descriptor.label;
            checkboxLabel.className = 'violation-field-label';

            headerContainer.appendChild(checkbox);
            headerContainer.appendChild(checkboxLabel);
        }

        fieldContainer.appendChild(headerContainer);
        contentContainer.style.display = violation[fieldKey].enabled ? 'block' : 'none';

        const itemsContainer = document.createElement('div');
        itemsContainer.className = 'violation-blocks-items';
        itemsContainer.dataset.violationId = violation.id;
        itemsContainer.dataset.fieldKey = fieldKey;

        // Тулбар добавления блоков (в режиме просмотра не рендерится).
        if (!isReadOnly) {
            contentContainer.appendChild(
                this._createBlocksToolbar(violation, fieldKey, contentContainer));
        }

        // Вход мыши в зону поля: активация регистрирует сброс по ESC в EscapeStack.
        contentContainer.addEventListener('mouseenter', () => {
            if (violation[fieldKey].enabled) {
                this._setActiveZone(contentContainer);
            }
        });

        contentContainer.addEventListener('mouseleave', () => {
            if (this.currentActiveContainer === contentContainer) {
                this._resetActiveZone();
                this.removeInsertIndicators(itemsContainer);
            }
        });

        // Движение мыши — позиция вставки для paste/меню.
        contentContainer.addEventListener('mousemove', (e) => {
            if (violation[fieldKey].enabled && this.currentActiveContainer === contentContainer) {
                const position = this.calculateCursorPosition(e, itemsContainer);
                this.cursorInsertPosition = position;

                // В пустом контейнере при простом наведении индикатор не
                // показываем (не прячем подсказку «ПКМ...»); при файловом drag
                // его рисует dragover в violation-file-upload.js — mousemove
                // во время drag не приходит.
                if (itemsContainer.querySelector('.content-item-wrapper')) {
                    this.updateInsertIndicator(itemsContainer, position);
                }
            }
        });

        // В режиме просмотра — только чтение: без приёма файлов и без меню.
        if (!isReadOnly) {
            this.setupFileDragAndDrop(itemsContainer, violation, fieldKey, contentContainer);

            itemsContainer.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const insertPosition = this.calculateCursorPosition(e, itemsContainer);
                const clickedWrapper = e.target.closest('.content-item-wrapper');

                ContextMenuManager.show(e.clientX, e.clientY, null, 'violation', {
                    violation,
                    fieldKey,
                    contentContainer,
                    blockId: clickedWrapper ? clickedWrapper.dataset.blockId : null,
                    insertPosition,
                });
            });
        }

        contentContainer.appendChild(itemsContainer);
        this.renderBlocks(violation, fieldKey, itemsContainer, isReadOnly);

        fieldContainer.appendChild(contentContainer);
        return fieldContainer;
    },

    /**
     * Тулбар добавления блоков поля: «+ Текст | + Таблица | + Картинка».
     * Вставка идёт в КОНЕЦ поля (позиционная вставка — через ПКМ-меню).
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} contentContainer - Контейнер содержимого поля
     * @returns {HTMLElement} Тулбар
     */
    _createBlocksToolbar(violation, fieldKey, contentContainer) {
        const toolbar = document.createElement('div');
        toolbar.className = 'violation-blocks-toolbar';

        const buttons = [
            ['+ Текст', () => this.addBlockAtPosition(
                violation, fieldKey, BLOCK_TYPES.TEXT, contentContainer,
                fieldBlocks(violation, fieldKey).length)],
            ['+ Таблица', () => this.addBlockAtPosition(
                violation, fieldKey, BLOCK_TYPES.TABLE, contentContainer,
                fieldBlocks(violation, fieldKey).length)],
            ['+ Картинка', () => this.triggerImageUploadAtPosition(
                violation, fieldKey, contentContainer,
                fieldBlocks(violation, fieldKey).length)],
        ];

        for (const [label, handler] of buttons) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'violation-blocks-add-btn';
            btn.textContent = label;
            btn.addEventListener('click', handler);
            toolbar.appendChild(btn);
        }

        return toolbar;
    },

    /**
     * Вычисляет позицию курсора для вставки блоков.
     * @param {Event} event - Событие мыши
     * @param {HTMLElement} container - Контейнер блоков
     * @returns {number} Индекс позиции для вставки
     */
    calculateCursorPosition(event, container) {
        const wrappers = Array.from(container.querySelectorAll('.content-item-wrapper'));

        if (wrappers.length === 0) {
            return 0;
        }

        const clickY = event.clientY;

        for (let i = 0; i < wrappers.length; i++) {
            const wrapperRect = wrappers[i].getBoundingClientRect();
            const wrapperTop = wrapperRect.top;
            const wrapperBottom = wrapperRect.bottom;
            const wrapperHeight = wrapperRect.height;

            // Делим элемент на три зоны: верхняя треть, средняя треть, нижняя треть
            const topThird = wrapperTop + wrapperHeight / 3;
            const bottomThird = wrapperTop + (wrapperHeight * 2) / 3;

            if (clickY < topThird) {
                // Курсор в верхней трети элемента - вставляем перед ним
                return i;
            } else if (clickY >= topThird && clickY < bottomThird) {
                // Курсор в средней трети - вставляем перед элементом
                return i;
            } else if (clickY >= bottomThird && clickY <= wrapperBottom) {
                // Курсор в нижней трети - вставляем после элемента
                return i + 1;
            }
        }

        // Если курсор ниже всех элементов - вставляем в конец
        return wrappers.length;
    },

    /**
     * Визуализирует индикатор места вставки
     * @param {HTMLElement} container - Контейнер блоков
     * @param {number} position - Позиция для вставки
     */
    updateInsertIndicator(container, position) {
        // Удаляем предыдущие индикаторы
        this.removeInsertIndicators(container);

        const wrappers = Array.from(container.querySelectorAll('.content-item-wrapper'));

        // Создаем индикатор
        const indicator = document.createElement('div');
        indicator.className = 'insert-indicator';

        if (wrappers.length === 0 || position >= wrappers.length) {
            // Пустой контейнер или вставка в конец
            container.appendChild(indicator);
        } else {
            // Вставка в начало или между элементами
            container.insertBefore(indicator, wrappers[position]);
        }
    },

    /**
     * Удаляет все индикаторы позиции вставки из контейнера
     * @param {HTMLElement} container - Контейнер блоков
     */
    removeInsertIndicators(container) {
        const indicators = container.querySelectorAll('.insert-indicator');
        indicators.forEach(ind => ind.remove());
    },

    /**
     * Добавляет ОДИН пустой блок заданного типа в позицию (тулбар / ПКМ-меню /
     * текстовая паста). Обёртка над _insertBlocksBulk — единой точкой гейта
     * лимита и read-only-guard'а для всех путей вставки.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {string} type - Тип блока (BLOCK_TYPES.*)
     * @param {HTMLElement} container - Контейнер содержимого поля
     * @param {number} insertIndex - Позиция для вставки
     * @param {Object} [extraData] - Данные блока (content для текста)
     * @returns {boolean} true при успешной вставке
     */
    addBlockAtPosition(violation, fieldKey, type, container, insertIndex, extraData = {}) {
        let block;
        if (type === BLOCK_TYPES.TEXT) {
            block = createTextBlock(extraData.content || '');
        } else if (type === BLOCK_TYPES.TABLE) {
            block = createTableBlock();
        } else if (type === BLOCK_TYPES.IMAGE) {
            block = createImageBlock(extraData);
        } else {
            return false;
        }
        return this._insertBlocksBulk(violation, fieldKey, container, insertIndex, [block]) > 0;
    },

    /**
     * Вставляет пачку готовых блоков РАЗОМ: одна перерисовка контейнера на всю
     * пачку. Единая точка гейтов для ВСЕХ путей приёма (тулбар / меню /
     * текст-паста / картинки paste/drop/upload):
     *
     * - read-only (#1): requireWrite-guard закрывает и программные пути;
     * - лимит числа блоков (#4) — ПО ПОЛЮ: вставляется ровно столько, сколько
     *   влезает до maxItemsPerViolation; переполнение показывает ОДИН warning
     *   на всю пачку, счётчик не завышается.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер содержимого поля
     * @param {number} insertIndex - Позиция для вставки первого блока
     * @param {Object[]} blocks - Готовые блоки (violation-block-types.js) в порядке вставки
     * @returns {number} Сколько блоков реально вставлено (0 при отказе/лимите)
     */
    _insertBlocksBulk(violation, fieldKey, container, insertIndex, blocks) {
        // Guard закрывает и программные пути добавления в режиме просмотра (#1).
        const guard = ValidationCore.requireWrite('cannotAddContent');
        if (guard) return 0;

        if (!blocks || blocks.length === 0) return 0;

        // Единый гейт лимита числа блоков для ЛЮБОГО типа (#4), считается ПО
        // ПОЛЮ: вставляем ровно столько, сколько влезает; переполнение — один
        // warning. Раньше лимит был на «дополнительный контент» целиком.
        const maxItems = getImageLimits().maxItemsPerViolation;
        const available = Math.max(0, maxItems - fieldBlocks(violation, fieldKey).length);
        const toInsert = available >= blocks.length ? blocks : blocks.slice(0, available);

        if (toInsert.length < blocks.length) {
            // №14: текст — из единой точки формирования (app-config.js), не хардкод.
            Notifications.warning(AppConfig.content.errors.contentItemsLimitReached(maxItems));
        }

        if (toInsert.length === 0) return 0;

        // Порядок блоков задаётся позицией в массиве; вставка через мутатор —
        // единственный путь записи в модель (превью планирует он же).
        let inserted = 0;
        for (const block of toInsert) {
            if (!this.addBlock(violation, fieldKey, block, insertIndex + inserted)) break;
            inserted += 1;
        }
        if (inserted === 0) return 0;

        const itemsContainer = container.querySelector('.violation-blocks-items');

        // Сохраняем текущее состояние активности зоны.
        const wasActive = this.currentActiveContainer === container;

        if (itemsContainer) {
            this.renderBlocks(violation, fieldKey, itemsContainer);
        }

        // Восстанавливаем активность после перерисовки.
        if (wasActive) {
            this.currentActiveContainer = container;
        }

        return inserted;
    },

    /**
     * Удаляет ОДИН блок поля (меню «Удалить») и перерисовывает контейнер.
     * Read-only-guard и превью — внутри мутатора removeBlock.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {string} blockId - id удаляемого блока
     * @param {HTMLElement} container - Контейнер содержимого поля
     * @returns {boolean} true — удалено; false — read-only либо блок не найден
     */
    removeBlockFromField(violation, fieldKey, blockId, container) {
        // Блок мог держать смонтированное rich-поле (текст/подпись): снимаем
        // контроллер ДО удаления из модели, иначе unmount закоммитил бы ввод в
        // уже удалённый блок (мутатор его не найдёт) поверх detached-хоста.
        this._teardownActiveRichField(violation.id);

        if (!this.removeBlock(violation, fieldKey, blockId)) return false;

        const itemsContainer = container?.querySelector('.violation-blocks-items');
        if (itemsContainer) {
            this.renderBlocks(violation, fieldKey, itemsContainer);
        }
        return true;
    },

    /**
     * Валидирует ТИП пачки файлов ДО чтения (H6/#26).
     *
     * Общая точка для всех трёх способов приёма (выбор файлов, drag&drop,
     * Ctrl+V). Здесь — только тип (MIME), число блоков поля и абсурдный сырой
     * потолок; magic-байты (#26) и РАЗМЕРНЫЙ гейт (#2) — в асинхронном
     * конвейере insertImageFilesInOrder: размер считается ПОСЛЕ ресайза по
     * ужатым байтам, иначе крупное фото отклонилось бы раньше, чем успело
     * ужаться. Отказ каждого файла — Notifications.warning с причиной.
     *
     * @param {File[]} files - Файлы-кандидаты
     * @param {Object} violation - Нарушение, в которое добавляются картинки
     * @param {string} fieldKey - Ключ поля реестра
     * @returns {File[]} Прошедшие тип-валидацию файлы
     */
    filterAcceptedImageFiles(files, violation, fieldKey) {
        const lim = getImageLimits();
        let runningCount = fieldBlocks(violation, fieldKey).length;
        const accepted = [];

        for (const file of files) {
            const result = validateImageType(file, { itemsCount: runningCount, limits: lim });
            if (!result.ok) {
                Notifications.warning(result.reason);
                continue;
            }
            accepted.push(file);
            runningCount += 1;
        }

        return accepted;
    },

    /**
     * Читает, пережимает и вставляет пачку картинок (порядок выбора — violation-4).
     *
     * Конвейер на каждый файл (порядок пачки сохранён через Promise.all):
     *  1. magic-байты (#26) — тип по содержимому ДО ресайза; мусор пропускаем;
     *  2. ресайз (#25) — downscaleImage по выбранному режиму (JPEG-сжатие;
     *     GIF/прозрачные PNG/original — оригинал);
     *  3. размерный гейт (#2) — per-file + накопительный суммарный лимит акта
     *     по УЖАТЫМ байтам dataUrl; over-budget пропускаем с warning'ом.
     * Затем bulk-вставка: одна перерисовка. Лимит числа (#4) и read-only (#1)
     * — внутри _insertBlocksBulk.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер содержимого поля
     * @param {number} insertIndex - Позиция для вставки первой картинки
     * @param {File[]} files - Прошедшие тип-валидацию файлы в порядке выбора
     * @param {string} [mode='high'] - Режим качества ('high'|'medium'|'original')
     */
    async insertImageFilesInOrder(violation, fieldKey, container, insertIndex, files, mode = 'high') {
        const lim = getImageLimits();

        // #26 + ресайз параллельно, порядок пачки сохраняется (violation-4).
        const processed = await Promise.all(files.map(async (file) => {
            try {
                const okMagic = await sniffImageMagic(file, lim.allowedMimeTypes);
                if (!okMagic) return { ok: false, file, reason: 'magic' };
                const url = await downscaleImage(file, { mode });
                return { ok: true, file, url };
            } catch (error) {
                return { ok: false, file, reason: 'read', error };
            }
        }));

        // #2 размерный гейт ПОСЛЕ ресайза — по ужатым байтам, накопительно.
        let runningBytes = estimateActImageBytes(AppState.violations);
        const blocks = [];
        for (const result of processed) {
            if (!result.ok) {
                if (result.reason === 'magic') {
                    // Список форматов — из RECOGNIZED_IMAGE_FORMATS (то, что sniffer реально
                    // умеет подтвердить), а не хардкод: если настройка разрешит формат вне
                    // этого набора, сообщение честно назовёт проверяемые форматы, а не соврёт.
                    Notifications.warning(
                        `Файл «${result.file.name}» не удалось распознать как изображение поддерживаемого формата `
                        + `(${RECOGNIZED_IMAGE_FORMATS.join('/')}) и он не добавлен.`,
                    );
                } else {
                    console.error('Ошибка при чтении файла:', result.file.name, result.error);
                    Notifications.error(`Ошибка при чтении ${result.file.name}`);
                }
                continue;
            }

            const bytes = estimateDataUrlBytes(result.url);
            const sizeCheck = validateImageBytes(bytes, {
                existingTotalBytes: runningBytes,
                name: result.file.name,
                limits: lim,
            });
            if (!sizeCheck.ok) {
                Notifications.warning(sizeCheck.reason);
                continue;
            }

            runningBytes += bytes;
            blocks.push(createImageBlock({
                url: result.url,
                // #12: имя должно отражать факт (downscaleImage мог молча
                // перекодировать непрозрачный PNG в JPEG).
                filename: resolveActualFilename(result.file, result.url),
            }));
        }

        // Bulk-вставка: одна перерисовка. Лимит (#4) и read-only (#1) — внутри
        // _insertBlocksBulk. addedCount отражает реально вставленное: при
        // обрезке по лимиту тост не соврёт.
        const addedCount = this._insertBlocksBulk(violation, fieldKey, container, insertIndex, blocks);

        if (addedCount > 0) {
            const message = addedCount === 1
                ? 'Изображение добавлено'
                : `Добавлено изображений: ${addedCount}`;
            Notifications.success(message);
        }
    },

    /**
     * Показывает диалог качества (Q3) один раз на пачку и вставляет картинки
     * выбранным режимом. Единая точка для всех трёх путей приёма (выбор /
     * drag&drop / Ctrl+V). Отмена диалога (Escape/клик вне) → ничего не вставляем.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер содержимого поля
     * @param {number} insertIndex - Позиция для вставки первой картинки
     * @param {File[]} files - Прошедшие тип-валидацию файлы в порядке выбора
     */
    async promptQualityThenInsertImages(violation, fieldKey, container, insertIndex, files) {
        const mode = await this.promptImageQualityMode();
        if (mode === null) return; // пользователь отменил вставку
        await this.insertImageFilesInOrder(violation, fieldKey, container, insertIndex, files, mode);
    },

    /**
     * Диалог выбора режима сжатия (Q3): три кнопки «Сжатие» (по умолч.) /
     * «Среднее» / «Исходное». Последний выбор запоминается в localStorage как
     * ПРЕДВЫБОР (подсвеченная кнопка), но диалог показывается на КАЖДУЮ вставку.
     *
     * @returns {Promise<'high'|'medium'|'original'|null>} Режим или null при отмене
     */
    async promptImageQualityMode() {
        let preselect = 'high';
        try {
            const saved = localStorage.getItem(IMAGE_QUALITY_MODE_KEY);
            if (saved === 'high' || saved === 'medium' || saved === 'original') preselect = saved;
        } catch (_) { /* приватный режим — дефолт «Сжатие» */ }

        const OPTIONS = [
            { mode: 'high', label: 'Сжатие' },
            { mode: 'medium', label: 'Среднее' },
            { mode: 'original', label: 'Исходное' },
        ];

        const result = await DialogManager.show({
            title: 'Качество изображений',
            message: 'Выберите режим для вставляемых картинок. Сжатие уменьшает вес акта; '
                + 'GIF и прозрачные PNG не пережимаются.',
            icon: '🖼️',
            type: 'info',
            hideConfirm: true,
            hideCancel: true,
            onMount: ({ overlay, close }) => {
                const dialog = overlay.querySelector('.custom-dialog');
                if (!dialog) return;
                const row = document.createElement('div');
                row.className = 'dialog-buttons';
                for (const opt of OPTIONS) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = `btn ${opt.mode === preselect ? 'btn-primary' : 'btn-secondary'}`;
                    btn.textContent = opt.label;
                    btn.addEventListener('click', () => {
                        try { localStorage.setItem(IMAGE_QUALITY_MODE_KEY, opt.mode); } catch (_) { /* noop */ }
                        close(opt.mode);
                    });
                    row.appendChild(btn);
                }
                dialog.appendChild(row);
            },
        });

        return (result === 'high' || result === 'medium' || result === 'original') ? result : null;
    },

    /**
     * Инициирует выбор файлов изображений для поля с указанием позиции
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер содержимого поля
     * @param {number} insertIndex - Позиция для вставки
     */
    triggerImageUploadAtPosition(violation, fieldKey, container, insertIndex) {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.multiple = true;
        fileInput.style.display = 'none';

        fileInput.addEventListener('change', (e) => {
            if (!e.target.files || e.target.files.length === 0) return;

            // Тип-валидация ДО чтения (H6/#26); отказники отсеяны с warning'ом.
            const files = this.filterAcceptedImageFiles(Array.from(e.target.files), violation, fieldKey);
            if (files.length === 0) return;

            // Диалог качества (Q3) → ресайз → вставка в порядке выбора (violation-4).
            this.promptQualityThenInsertImages(violation, fieldKey, container, insertIndex, files);
        });

        document.body.appendChild(fileInput);
        fileInput.click();
        document.body.removeChild(fileInput);
    }
});
