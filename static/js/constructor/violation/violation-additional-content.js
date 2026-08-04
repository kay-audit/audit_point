/**
 * Модуль управления дополнительным контентом
 * Кейсы, изображения, произвольный текст
 */

import { ContextMenuManager } from '../context-menu/context-menu-core.js';
import { PreviewManager } from '../preview/preview.js';
import { ViolationManager } from './violation-core.js';
import { ValidationCore } from '../validation/validation-core.js';
import { Notifications } from '../../shared/notifications.js';
import { AppConfig } from '../../shared/app-config.js';
import { AppState } from '../state/state-core.js';
import {
    estimateActImageBytes,
    estimateDataUrlBytes,
    getImageLimits,
    loadImageLimits,
    validateImageType,
    validateImageBytes,
} from './violation-image-validator.js';
import { CONTENT_TYPE_IMAGE, createContentItem } from './violation-content-item.js';
import { sniffImageMagic, RECOGNIZED_IMAGE_FORMATS } from './violation-file-reading.js';
import { downscaleImage, resolveActualFilename } from './violation-image-resize.js';
import { DialogManager } from '../../shared/dialog/dialog-confirm.js';

/** localStorage-ключ предвыбора режима качества (Q3 всё равно спрашивает каждый раз). */
const IMAGE_QUALITY_MODE_KEY = 'violation_image_quality_mode';

// Расширение ViolationManager
Object.assign(ViolationManager.prototype, {
    /**
     * Создает расширяемую секцию дополнительного контента
     * @param {Object} violation - Объект нарушения
     * @returns {HTMLElement} Контейнер с подсущностями
     */
    createAdditionalContentField(violation, isReadOnly = false) {
        const fieldContainer = document.createElement('div');
        fieldContainer.className = 'violation-optional-field violation-additional-content';

        // Регистрируем violation в хранилище для быстрого доступа
        this.activeViolations.set(violation.id, violation);

        // Лимиты картинок подтягиваются один раз заранее (fire-and-forget):
        // к моменту приёма первого файла валидатор уже знает серверные значения.
        loadImageLimits();

        // Чекбокс для включения секции
        const checkboxContainer = document.createElement('div');
        checkboxContainer.className = 'violation-field-toggle';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `${violation.id}-additionalContent`;
        checkbox.checked = violation.additionalContent.enabled;
        checkbox.disabled = isReadOnly;

        // В режиме просмотра чекбокс заблокирован, мутирующий слушатель не вешаем.
        if (!isReadOnly) {
            checkbox.addEventListener('change', () => {
                this.setViolationField(violation, 'additionalContent.enabled', checkbox.checked);
                contentContainer.style.display = checkbox.checked ? 'block' : 'none';

                // Если выключаем - сбрасываем активный контейнер
                if (!checkbox.checked && this.currentActiveContainer === contentContainer) {
                    this._resetActiveZone();
                }
            });
        }

        const checkboxLabel = document.createElement('label');
        checkboxLabel.htmlFor = checkbox.id;
        checkboxLabel.textContent = 'Дополнительный контент';
        checkboxLabel.className = 'violation-field-label';

        checkboxContainer.appendChild(checkbox);
        checkboxContainer.appendChild(checkboxLabel);
        fieldContainer.appendChild(checkboxContainer);

        // Контейнер содержимого
        const contentContainer = document.createElement('div');
        contentContainer.className = 'violation-field-content additional-content-wrapper';
        contentContainer.style.display = violation.additionalContent.enabled ? 'block' : 'none';

        // Делаем контейнер focusable для перехвата Ctrl+V
        contentContainer.setAttribute('tabindex', '0');

        // Контейнер для элементов
        const itemsContainer = document.createElement('div');
        itemsContainer.className = 'additional-content-items';
        itemsContainer.dataset.violationId = violation.id;

        // Отслеживаем вход мыши в contentContainer.
        // Активация зоны регистрирует сброс по ESC в EscapeStack (violation-5).
        contentContainer.addEventListener('mouseenter', () => {
            if (violation.additionalContent.enabled) {
                this._setActiveZone(contentContainer);
            }
        });

        // Отслеживаем выход мыши из contentContainer
        contentContainer.addEventListener('mouseleave', () => {
            if (this.currentActiveContainer === contentContainer) {
                this._resetActiveZone();
                // Удаляем индикатор при выходе мыши
                this.removeInsertIndicators(itemsContainer);
            }
        });

        // Отслеживаем движение мыши для определения позиции курсора
        contentContainer.addEventListener('mousemove', (e) => {
            if (violation.additionalContent.enabled && this.currentActiveContainer === contentContainer) {
                // Вычисляем позицию курсора относительно элементов
                const position = this.calculateCursorPosition(e, itemsContainer);
                this.cursorInsertPosition = position;

                // Визуализируем позицию вставки. В пустом контейнере при
                // простом наведении индикатор не показываем (не прячем
                // подсказку «ПКМ...»); при файловом drag его рисует dragover
                // в violation-file-upload.js — mousemove во время drag не приходит.
                if (itemsContainer.querySelector('.content-item-wrapper')) {
                    this.updateInsertIndicator(itemsContainer, position);
                }
            }
        });

        // В режиме просмотра — только чтение: без приёма файлов и без меню
        // добавления/удаления элементов.
        if (!isReadOnly) {
            // Настраиваем Drag and Drop для файлов
            this.setupFileDragAndDrop(itemsContainer, violation, contentContainer);

            // Обработчик контекстного меню - используем новый ContextMenuManager
            itemsContainer.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // Вычисляем позицию для вставки на основе клика
                const insertPosition = this.calculateCursorPosition(e, itemsContainer);

                // Проверяем, клик по элементу или по пустой области
                const clickedWrapper = e.target.closest('.content-item-wrapper');

                const options = {
                    violation,
                    contentContainer,
                    itemId: clickedWrapper ? clickedWrapper.dataset.itemId : null,
                    insertPosition
                };

                // Используем новый единый ContextMenuManager
                ContextMenuManager.show(e.clientX, e.clientY, null, 'violation', options);
            });
        }

        contentContainer.appendChild(itemsContainer);

        // Рендерим существующие элементы
        this.renderContentItems(violation, itemsContainer, isReadOnly);

        fieldContainer.appendChild(contentContainer);
        return fieldContainer;
    },

    /**
     * Вычисляет позицию курсора для вставки элементов
     * @param {Event} event - Событие мыши
     * @param {HTMLElement} container - Контейнер с элементами
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
     * @param {HTMLElement} container - Контейнер с элементами
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
     * @param {HTMLElement} container - Контейнер с элементами
     */
    removeInsertIndicators(container) {
        const indicators = container.querySelectorAll('.insert-indicator');
        indicators.forEach(ind => ind.remove());
    },

    /**
     * Добавляет ОДИН элемент контента в указанную позицию (меню / текст-паста).
     * Обёртка над _insertContentItemsBulk — единой точкой гейта лимита (#4)
     * и read-only-guard'а (#1) для всех путей вставки.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} type - Тип элемента ('case', 'image', 'freeText')
     * @param {HTMLElement} container - Контейнер содержимого
     * @param {number} insertIndex - Позиция для вставки
     * @param {Object} extraData - Дополнительные данные элемента
     * @returns {boolean} true при успешной вставке, false при отказе
     *          (режим просмотра или достигнут лимит элементов, #4)
     */
    addContentItemAtPosition(violation, type, container, insertIndex, extraData = {}) {
        // Фабрика создаёт только релевантные типу поля (violation-3):
        // кейс/текст — content; картинка — url/caption/filename/width.
        const newItem = createContentItem(type, extraData);
        return this._insertContentItemsBulk(violation, container, insertIndex, [newItem]) > 0;
    },

    /**
     * Вставляет пачку готовых элементов контента РАЗОМ: один splice, один
     * renderContentItems, один updateBlock (#29). Единая точка гейтов для ВСЕХ
     * путей приёма (меню / текст-паста / картинки paste/drop/upload):
     *
     * - read-only (#1): requireWrite-guard закрывает и программные пути;
     * - лимит числа элементов (#4): вставляется ровно столько, сколько влезает
     *   до maxItemsPerViolation; переполнение показывает ОДИН warning на всю
     *   пачку, счётчик не завышается.
     *
     * @param {Object} violation - Объект нарушения
     * @param {HTMLElement} container - Контейнер содержимого
     * @param {number} insertIndex - Позиция для вставки первого элемента
     * @param {Object[]} items - Готовые элементы (createContentItem) в порядке вставки
     * @returns {number} Сколько элементов реально вставлено (0 при отказе/лимите)
     */
    _insertContentItemsBulk(violation, container, insertIndex, items) {
        // Guard закрывает и программные пути добавления в режиме просмотра (#1).
        const guard = ValidationCore.requireWrite('cannotAddContent');
        if (guard) return 0;

        if (!items || items.length === 0) return 0;

        // Единый гейт лимита числа элементов для ЛЮБОГО типа контента (#4):
        // раньше лимит проверялся только для картинок, кейсы/текст добавлялись
        // без счёта, и бэкенд резал >50 элементов сразу на весь акт (422).
        // Вставляем ровно столько, сколько влезает; переполнение — один warning.
        const maxItems = getImageLimits().maxItemsPerViolation;
        const available = Math.max(0, maxItems - violation.additionalContent.items.length);
        const toInsert = available >= items.length ? items : items.slice(0, available);

        if (toInsert.length < items.length) {
            // №14: текст — из единой точки формирования (app-config.js), не хардкод.
            Notifications.warning(AppConfig.content.errors.contentItemsLimitReached(maxItems));
        }

        if (toInsert.length === 0) return 0;

        // Splice РАЗОМ на insertIndex — порядок элементов пачки сохраняется.
        // Порядок задаётся позицией в массиве, отдельного поля order нет (#24).
        violation.additionalContent.items.splice(insertIndex, 0, ...toInsert);

        const itemsContainer = container.querySelector('.additional-content-items');

        // Сохраняем текущее состояние активности зоны.
        const wasActive = this.currentActiveContainer === container;

        this.renderContentItems(violation, itemsContainer);

        // Восстанавливаем активность после перерисовки.
        if (wasActive) {
            this.currentActiveContainer = container;
        }

        PreviewManager.updateBlock('violation', violation.id);
        return toInsert.length;
    },

    /**
     * Удаляет ОДИН элемент дополнительного контента (меню «Удалить», #11).
     * Раньше сплайс в context-menu-violation.js шёл БЕЗ read-only-guard'а:
     * безопасно было только потому, что пункт меню не рендерится в режиме
     * просмотра. Теперь гейт есть здесь — defense-in-depth для программных
     * путей, как у остальных мутаций нарушения.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} itemId - id удаляемого элемента (additionalContent.items[].id)
     * @param {HTMLElement} container - Контейнер содержимого (contentContainer)
     * @returns {boolean} true — удалено; false — заблокировано read-only
     *          либо элемент с таким id не найден
     */
    removeContentItem(violation, itemId, container) {
        const guard = ValidationCore.requireWrite('cannotEdit');
        if (guard) return false;

        const itemIndex = violation.additionalContent.items.findIndex(
            item => item.id === itemId
        );
        if (itemIndex === -1) return false;

        violation.additionalContent.items.splice(itemIndex, 1);

        const itemsContainer = container.querySelector('.additional-content-items');
        if (itemsContainer) {
            this.renderContentItems(violation, itemsContainer);
        }

        PreviewManager.updateBlock('violation', violation.id);
        return true;
    },

    /**
     * Валидирует ТИП пачки файлов ДО чтения (H6/#26).
     *
     * Общая точка для всех трёх способов приёма (выбор файлов, drag&drop,
     * Ctrl+V). Здесь — только тип (MIME), число элементов и абсурдный сырой
     * потолок; magic-байты (#26) и РАЗМЕРНЫЙ гейт (#2) перенесены в
     * асинхронный конвейер insertImageFilesInOrder — размер считается ПОСЛЕ
     * ресайза по ужатым байтам, иначе крупное фото отклонилось бы раньше, чем
     * успело ужаться. Отказ каждого файла — Notifications.warning с причиной.
     *
     * @param {File[]} files - Файлы-кандидаты
     * @param {Object} violation - Нарушение, в которое добавляются картинки
     * @returns {File[]} Прошедшие тип-валидацию файлы
     */
    filterAcceptedImageFiles(files, violation) {
        const lim = getImageLimits();
        let runningCount = (violation.additionalContent?.items || []).length;
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
     * Затем bulk-вставка (#29): один splice/render/updateBlock. Лимит числа
     * (#4) и read-only (#1) — внутри _insertContentItemsBulk.
     *
     * @param {Object} violation - Объект нарушения
     * @param {HTMLElement} container - Контейнер содержимого
     * @param {number} insertIndex - Позиция для вставки первой картинки
     * @param {File[]} files - Прошедшие тип-валидацию файлы в порядке выбора
     * @param {string} [mode='high'] - Режим качества ('high'|'medium'|'original')
     */
    async insertImageFilesInOrder(violation, container, insertIndex, files, mode = 'high') {
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
        const items = [];
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
            items.push(createContentItem(CONTENT_TYPE_IMAGE, {
                url: result.url,
                // #12: имя должно отражать факт (downscaleImage мог молча
                // перекодировать непрозрачный PNG в JPEG).
                filename: resolveActualFilename(result.file, result.url),
            }));
        }

        // Bulk-вставка (#29): один splice, один render, один updateBlock. Лимит
        // (#4) и read-only (#1) — внутри _insertContentItemsBulk. addedCount
        // отражает реально вставленное: при обрезке по лимиту тост не соврёт.
        const addedCount = this._insertContentItemsBulk(violation, container, insertIndex, items);

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
     * @param {HTMLElement} container - Контейнер содержимого
     * @param {number} insertIndex - Позиция для вставки первой картинки
     * @param {File[]} files - Прошедшие тип-валидацию файлы в порядке выбора
     */
    async promptQualityThenInsertImages(violation, container, insertIndex, files) {
        const mode = await this.promptImageQualityMode();
        if (mode === null) return; // пользователь отменил вставку
        await this.insertImageFilesInOrder(violation, container, insertIndex, files, mode);
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
     * Инициирует выбор файлов изображений с указанием позиции
     * @param {Object} violation - Объект нарушения
     * @param {HTMLElement} container - Контейнер содержимого
     * @param {number} insertIndex - Позиция для вставки
     */
    triggerImageUploadAtPosition(violation, container, insertIndex) {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.multiple = true;
        fileInput.style.display = 'none';

        fileInput.addEventListener('change', (e) => {
            if (!e.target.files || e.target.files.length === 0) return;

            // Тип-валидация ДО чтения (H6/#26); отказники отсеяны с warning'ом.
            const files = this.filterAcceptedImageFiles(Array.from(e.target.files), violation);
            if (files.length === 0) return;

            // Диалог качества (Q3) → ресайз → вставка в порядке выбора (violation-4).
            this.promptQualityThenInsertImages(violation, container, insertIndex, files);
        });

        document.body.appendChild(fileInput);
        fileInput.click();
        document.body.removeChild(fileInput);
    }
});
