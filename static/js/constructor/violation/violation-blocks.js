/**
 * Секция ОДНОГО поля нарушения и её контейнер блоков (блочная модель).
 *
 * Все десять полей реестра (violation-fields.js) рендерятся ОДНИМ этим
 * компонентом — «Дополнительный контент» перестал быть особенным: конвейер
 * приёма картинок, зона вставки и контекстное меню параметризованы ключом поля.
 *
 * Записи в модель — только через мутаторы (violation-mutations.js):
 * setFieldEnabled / addBlock / removeBlock / removeBlocks. Здесь остаются
 * гейты, которые мутатору не видны: лимит числа блоков ПО ПОЛЮ (#4) и лимиты
 * картинок (тип/magic/байты).
 *
 * Здесь же — проводка мультивыделения блоков (состояние —
 * violation-block-selection.js): document-слушатели клика и Delete,
 * восстановление подсветки после перерисовки, групповое удаление.
 *
 * Перенос блоков между полями — сознательный non-goal первой итерации
 * (спека §7): контейнер каждого поля работает только со своими блоками.
 */

import { ContextMenuManager } from '../context-menu/context-menu-core.js';
import { ViolationManager } from './violation-core.js';
import { ValidationCore } from '../validation/validation-core.js';
import { Notifications } from '../../shared/notifications.js';
import { AppConfig } from '../../shared/app-config.js';
import {
    getImageLimits,
    validateImageType,
    validateImageBytes,
} from './violation-image-validator.js';
import { BLOCK_TYPES, BLOCK_TYPE_META, createImageBlock } from './violation-block-types.js';
import { sniffImageMagic, RECOGNIZED_IMAGE_FORMATS } from './violation-file-reading.js';
import { downscaleImage, resolveActualFilename } from './violation-image-resize.js';
import { getImageActContext, uploadActImage } from './violation-image-api.js';
import { DialogManager } from '../../shared/dialog/dialog-confirm.js';
import { EscapeStack } from '../../shared/escape-stack.js';
import { isEditableTarget } from '../../shared/editable-target.js';
import { pluralizeBlocks } from './violation-block-selection.js';

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

/**
 * id блоков поля в порядке хранения — адресация мультивыделения (диапазоны,
 * групповые операции) идёт только по ним.
 * @param {Object} violation - Объект нарушения
 * @param {string} fieldKey - Ключ поля реестра
 * @returns {string[]}
 */
function fieldBlockIds(violation, fieldKey) {
    return fieldBlocks(violation, fieldKey).map(block => block.id);
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
            }
        });

        // Слежения за мышью здесь нет: индикатор места вставки показывается
        // ТОЛЬКО при активном перетаскивании (внутреннем — violation-drag-drop.js,
        // файловом — violation-file-upload.js), а ПКМ-меню считает позицию в
        // момент клика (calculateCursorPosition ниже).

        // В режиме просмотра — только чтение: без приёма файлов и без меню.
        if (!isReadOnly) {
            this.setupFileDragAndDrop(itemsContainer, violation, fieldKey, contentContainer);
            this.setupBlockDragAndDrop(itemsContainer, violation, fieldKey);

            itemsContainer.addEventListener('contextmenu', (e) => {
                // Внутри редактируемого текста (contenteditable-хост rich-поля,
                // textarea/input) отдаём браузеру НАТИВНОЕ меню: только оно умеет
                // предлагать исправления орфографии (spellcheck) — паритет с
                // текстблоками акта, которые ПКМ не перехватывают. Капсулы
                // ссылок/сносок (ce=false) сюда не попадают: isContentEditable
                // у них false, их меню вешает textblock-links-footnotes.js со
                // stopPropagation. Меню добавления блоков остаётся на хроме
                // поля: обёртка блока, ручка ⋮⋮, зазоры и пустая зона.
                if (e.target.isContentEditable || e.target.closest('textarea, input')) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();

                const insertPosition = this.calculateCursorPosition(e, itemsContainer);
                const clickedWrapper = e.target.closest('.content-item-wrapper');
                const clickedBlockId = clickedWrapper ? clickedWrapper.dataset.blockId : null;

                // ПКМ мимо выделения (по другому блоку, по зазору, по пустому
                // месту) сбрасывает его — прецедент таблиц (table-core.js):
                // меню обязано говорить о том, на что показывает курсор.
                if (!clickedBlockId
                    || !this.blockSelection.isSelected(violation.id, fieldKey, clickedBlockId)) {
                    this.clearBlockSelection();
                }

                // Список выделенного снимаем ЗДЕСЬ и передаём меню замыканием:
                // клик по пункту меню сначала пройдёт через document-слушатель
                // выделения и обнулит живое состояние.
                const selectedIds = this.blockSelection.idsInOrder(
                    violation.id, fieldKey, fieldBlockIds(violation, fieldKey));

                ContextMenuManager.show(e.clientX, e.clientY, null, 'violation', {
                    violation,
                    fieldKey,
                    contentContainer,
                    blockId: clickedBlockId,
                    selectedIds,
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
     * Подписи и порядок кнопок — из реестра типов блоков (BLOCK_TYPE_META).
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

        for (const meta of Object.values(BLOCK_TYPE_META)) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'violation-blocks-add-btn';
            btn.textContent = `+ ${meta.shortLabel}`;
            btn.addEventListener('click', () => {
                // Картинка идёт своим конвейером (выбор файлов → качество →
                // ресайз), остальные типы создаются пустым блоком.
                const insertIndex = fieldBlocks(violation, fieldKey).length;
                if (meta.type === BLOCK_TYPES.IMAGE) {
                    this.triggerImageUploadAtPosition(
                        violation, fieldKey, contentContainer, insertIndex);
                } else {
                    this.addBlockAtPosition(
                        violation, fieldKey, meta.type, contentContainer, insertIndex);
                }
            });
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
     * Показывает индикатор места вставки — ОВЕРЛЕЕМ, без единого узла в потоке.
     *
     * Раньше полоска была настоящим flex-ребёнком контейнера, и её появление
     * раздвигало карточки. Теперь это псевдоэлемент обёртки: позиция
     * `position` — граница, помечаем ближайшую к ней обёртку классом
     * `drop-before` (вставка перед ней) либо последнюю — `drop-after`
     * (вставка в конец). Раскладка блоков при этом не меняется.
     *
     * В пустом контейнере рисовать не на чем: там место вставки единственное,
     * а состояние приёма показывает подсветка зоны (`drag-over-file`).
     *
     * @param {HTMLElement} container - Контейнер блоков
     * @param {number} position - Позиция для вставки
     */
    updateInsertIndicator(container, position) {
        this.removeInsertIndicators(container);

        const wrappers = Array.from(container.querySelectorAll('.content-item-wrapper'));
        if (wrappers.length === 0) return;

        if (position >= wrappers.length) {
            wrappers[wrappers.length - 1].classList.add('drop-after');
        } else {
            wrappers[Math.max(0, position)].classList.add('drop-before');
        }
    },

    /**
     * Снимает индикатор позиции вставки со всех обёрток контейнера.
     * @param {HTMLElement} container - Контейнер блоков
     */
    removeInsertIndicators(container) {
        container.querySelectorAll('.content-item-wrapper').forEach((wrapper) => {
            wrapper.classList.remove('drop-before');
            wrapper.classList.remove('drop-after');
        });
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
        // Фабрика — из реестра типов (единая сигнатура create(extraData));
        // неизвестный тип отказ, как и раньше.
        const meta = BLOCK_TYPE_META[type];
        if (!meta) return false;
        const block = meta.create(extraData);
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

        // Симметрично removeBlockFromField: перерисовка уничтожает узлы поля, а
        // смонтированное rich-поле осталось бы жить на уничтоженном хосте и
        // закоммитило бы устаревший HTML. Снимаем контроллер ДО перерисовки —
        // и только на пути, который реально перерисовывает (отказ по лимиту
        // сюда не доходит и не должен ронять активный редактор).
        this._teardownActiveRichField(violation.id);

        // Любая вставка контента снимает выделение: пачка новых блоков сдвигает
        // список, и подсвеченные «до вставки» блоки перестают быть тем, что
        // пользователь набрал глазами. Ctrl+V, ПКМ-меню и тулбар приходят сюда.
        this.clearBlockSelection();

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

    // ── Мультивыделение блоков поля (violation-block-selection.js) ────────────

    /**
     * Вешает document-слушатели мультивыделения: ЛКМ по шапке блока выделяет,
     * ЛКМ где угодно ещё — снимает выделение, Delete — удаляет выделенное.
     *
     * Слушатели глобальные (а не на контейнере поля) по двум причинам: снятие
     * выделения обязано ловить клики ВНЕ поля (тулбар, другое нарушение, пустое
     * место страницы), а перерисовка поля не должна их терять — контейнеры
     * пересоздаются, document живёт всегда. Ставятся один раз из initialize().
     *
     * Фаза перехвата — как у setupPasteHandler: клик по пункту контекстного
     * меню или кнопке тулбара может быть погашен stopPropagation'ом, а снять
     * выделение мы обязаны в любом случае.
     */
    setupBlockSelectionHandlers() {
        document.addEventListener('click', (e) => this._handleBlockSelectionClick(e), true);
        document.addEventListener('keydown', (e) => this._handleBlockSelectionKeydown(e));
    },

    /**
     * ЛКМ: по шапке блока — выделение (Ctrl — toggle, Shift — диапазон),
     * в любом другом месте — сброс.
     * @param {MouseEvent} e - Событие click
     */
    _handleBlockSelectionClick(e) {
        // Только основная кнопка: у ПКМ свой путь (contextmenu ниже) и своя
        // политика — выделение под курсором он сохраняет.
        if (e.button) return;

        const label = e.target?.closest?.('.content-item-label');
        const wrapper = label?.closest?.('.content-item-wrapper');
        const itemsContainer = wrapper?.closest?.('.violation-blocks-items');
        if (!itemsContainer) {
            this.clearBlockSelection();
            return;
        }

        // В режиме просмотра выделять нечего: групповые операции (перенос,
        // удаление) закрыты гейтами мутаторов, подсветка обещала бы их зря.
        if (AppConfig.readOnlyMode?.isReadOnly) {
            this.clearBlockSelection();
            return;
        }

        const violationId = itemsContainer.dataset?.violationId;
        const fieldKey = itemsContainer.dataset?.fieldKey;
        const blockId = wrapper.dataset?.blockId;
        const violation = violationId ? this.activeViolations.get(violationId) : null;
        if (!violation || !fieldKey || !blockId) {
            this.clearBlockSelection();
            return;
        }

        this.blockSelection.applyClick(
            violationId, fieldKey, blockId, e, fieldBlockIds(violation, fieldKey));
        this._syncSelectionEscapeLayer();
        this._syncBlockSelectionClasses(violation, fieldKey, itemsContainer);
    },

    /**
     * Delete по выделению — групповое удаление (диалог подтверждения при ≥2
     * блоках живёт в removeSelectedBlocks). В редактируемом контексте клавиша
     * принадлежит редактору: предикат общий с Ctrl+V и Escape зоны
     * (shared/editable-target.js).
     * @param {KeyboardEvent} e - Событие keydown
     */
    _handleBlockSelectionKeydown(e) {
        if (e.key !== 'Delete') return;
        if (this.blockSelection.isEmpty()) return;
        if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;

        const violation = this.activeViolations.get(this.blockSelection.violationId);
        if (!violation) return;

        e.preventDefault?.();
        this.removeSelectedBlocks(violation, this.blockSelection.fieldKey, null);
    },

    /**
     * Сбрасывает выделение и его подсветку. Идемпотентен.
     */
    clearBlockSelection() {
        this.blockSelection.clear();
        this._syncSelectionEscapeLayer();
        this._clearBlockSelectionClasses();
    },

    /**
     * Держит слой ESC в стеке ровно пока выделение непусто.
     *
     * Постоянный слой здесь не годится: он встал бы в стек один раз при старте
     * — то есть НИЖЕ слоя активной зоны нарушений (тот кладётся на каждый
     * mouseenter), и ESC до выделения не доходил бы вовсе. Сентинел PASS при
     * пустом выделении оставлен страховкой на случай, если состояние очистили
     * в обход clearBlockSelection.
     */
    _syncSelectionEscapeLayer() {
        if (this.blockSelection.isEmpty()) {
            if (this._escapeSelectionUnsub) {
                const unsub = this._escapeSelectionUnsub;
                this._escapeSelectionUnsub = null;
                unsub();
            }
            return;
        }

        if (this._escapeSelectionUnsub) return;
        this._escapeSelectionUnsub = EscapeStack.push(() => {
            if (this.blockSelection.isEmpty()) return EscapeStack.PASS;
            this.clearBlockSelection();
        });
    },

    /**
     * Снимает класс выделения со ВСЕХ обёрток документа.
     */
    _clearBlockSelectionClasses() {
        document.querySelectorAll?.('.content-item-wrapper.block-selected')
            ?.forEach?.(wrapper => wrapper.classList.remove('block-selected'));
    },

    /**
     * Восстанавливает подсветку выделения по id — вызывается ПОСЛЕ каждой
     * перерисовки поля (renderBlocks всегда пересоздаёт обёртки, DOM-ссылки на
     * них протухают) и после каждого клика.
     *
     * Заодно вычищает id блоков, которых в поле больше нет: удаление, откат
     * версии и загрузка другого акта оставили бы выделение из мёртвых id, и
     * групповое удаление молча промахнулось бы.
     *
     * Подсветка снимается со всего документа, а не только с `container`:
     * выделение живёт ровно в одном поле, и клик, переносящий его в соседнее,
     * иначе оставил бы подсвеченными обёртки прежнего.
     *
     * @param {Object} violation - Объект нарушения (владелец перерисованного поля)
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер блоков поля (.violation-blocks-items)
     */
    _syncBlockSelectionClasses(violation, fieldKey, container) {
        const selection = this.blockSelection;
        if (violation && fieldKey) {
            selection.prune(violation.id, fieldKey, fieldBlockIds(violation, fieldKey));
            this._syncSelectionEscapeLayer();
        }

        this._clearBlockSelectionClasses();
        if (selection.isEmpty()) return;

        // Контейнер поля-владельца: перерисовываемое поле годится только если
        // выделение принадлежит ему; иначе ищем владельца в документе (при
        // первичной сборке карточки его там ещё нет — но его обёртки тогда и не
        // трогались, подсветка на них уцелела).
        const owner = (container && selection.isScope(violation?.id, fieldKey))
            ? container
            : this._findBlocksItemsContainer(selection.violationId, selection.fieldKey);

        owner?.querySelectorAll?.('.content-item-wrapper')?.forEach?.((wrapper) => {
            if (selection.ids.has(wrapper.dataset?.blockId)) {
                wrapper.classList.add('block-selected');
            }
        });
    },

    /**
     * Контейнер блоков поля в документе (адрес поля лежит в его dataset).
     * @param {string|null} violationId - ID нарушения
     * @param {string|null} fieldKey - Ключ поля реестра
     * @returns {HTMLElement|null}
     */
    _findBlocksItemsContainer(violationId, fieldKey) {
        if (!violationId || !fieldKey) return null;
        return document.querySelector?.(
            `.violation-blocks-items[data-violation-id="${violationId}"]`
            + `[data-field-key="${fieldKey}"]`) || null;
    },

    /**
     * Групповое удаление выделенных блоков: ОДИН гейт read-only (в мутаторе),
     * один teardown rich-поля, одна перерисовка — зеркало _insertBlocksBulk.
     *
     * Подтверждение обязательно при ≥2 блоках: отмены удаления в конструкторе
     * нет, а Delete по выделению легко нажать мимо. Один блок удаляется без
     * вопроса — это ровно прежний одиночный путь меню.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement|null} contentContainer - Контейнер содержимого поля
     *        (null — найти контейнер блоков в документе по адресу поля)
     * @param {string[]|null} [blockIds] - Явный список id: контекстное меню
     *        снимает его в момент показа, потому что клик по пункту меню
     *        успевает сбросить живое выделение раньше обработчика пункта
     * @returns {Promise<boolean>} true — блоки удалены
     */
    async removeSelectedBlocks(violation, fieldKey, contentContainer, blockIds = null) {
        const ids = blockIds
            || this.blockSelection.idsInOrder(
                violation.id, fieldKey, fieldBlockIds(violation, fieldKey));
        if (ids.length === 0) return false;

        if (ids.length >= 2) {
            const confirmed = await DialogManager.show({
                title: 'Удаление блоков',
                message: `Удалить ${ids.length} ${pluralizeBlocks(ids.length)}? `
                    + 'Отменить удаление будет нельзя.',
                icon: '🗑️',
                type: 'warning',
                confirmText: 'Удалить',
            });
            if (!confirmed) return false;
        }

        // Симметрично removeBlockFromField: контроллер снимаем ДО удаления из
        // модели, иначе unmount закоммитил бы ввод в уже удалённый блок.
        this._teardownActiveRichField(violation.id);

        if (!this.removeBlocks(violation, fieldKey, ids)) return false;

        this.clearBlockSelection();

        const itemsContainer = contentContainer?.querySelector?.('.violation-blocks-items')
            || this._findBlocksItemsContainer(violation.id, fieldKey);
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
     * Сжимает, ЗАГРУЖАЕТ НА СЕРВЕР и вставляет пачку картинок (порядок выбора —
     * violation-4).
     *
     * Конвейер на каждый файл:
     *  1. magic-байты (#26) — тип по содержимому ДО сжатия; мусор пропускаем;
     *  2. сжатие (#25) — downscaleImage по выбранному режиму ('high'/'medium'
     *     → WebP; 'original' → перекодирование в СВОЙ формат, результат
     *     принимается только если легче оригинала; GIF едет как есть);
     *  3. размерный гейт (#2) — per-file, по реальным байтам отправки;
     *  4. загрузка POST /acts/{id}/images → image_id; блок хранит только его.
     * Затем bulk-вставка: одна перерисовка. Лимит числа (#4) и read-only (#1)
     * — внутри _insertBlocksBulk.
     *
     * Файлы обрабатываются ПОСЛЕДОВАТЕЛЬНО: у ПРОМ-учётки жёсткий потолок
     * соединений с БД, и пачка из десяти параллельных POST'ов упёрлась бы в
     * пул на ровном месте. Порядок пачки при этом сохраняется естественно.
     *
     * @param {Object} violation - Объект нарушения
     * @param {string} fieldKey - Ключ поля реестра
     * @param {HTMLElement} container - Контейнер содержимого поля
     * @param {number} insertIndex - Позиция для вставки первой картинки
     * @param {File[]} files - Прошедшие тип-валидацию файлы в порядке выбора
     * @param {string} [mode='high'] - Режим качества ('high'|'medium'|'original')
     */
    async insertImageFilesInOrder(violation, fieldKey, container, insertIndex, files, mode = 'high') {
        // Режим просмотра (#1) — ДО сети: грузить байты, которые всё равно не
        // попадут в акт, незачем (остались бы мусором в act_images). Сообщение
        // — то же, что у общего гейта _insertBlocksBulk.
        if (ValidationCore.requireWrite('cannotAddContent')) return;

        const lim = getImageLimits();
        const actId = getImageActContext();
        if (!actId) {
            Notifications.error('Не удалось определить акт — изображения не загружены');
            return;
        }

        // Загрузка сетевая и занимает секунды: держим ОДИН sticky-тост на всю
        // пачку, чтобы пользователь не смотрел в неподвижный экран.
        const progressId = Notifications.show(
            files.length === 1
                ? 'Загрузка изображения…'
                : `Загрузка изображений: ${files.length}…`,
            'info',
            0,
        );

        const blocks = [];
        const failures = [];
        try {
            for (const file of files) {
                const failed = (reason) => failures.push({ name: file.name || '', reason });
                try {
                    const okMagic = await sniffImageMagic(file, lim.allowedMimeTypes);
                    if (!okMagic) {
                        // Список форматов — из RECOGNIZED_IMAGE_FORMATS (то, что sniffer реально
                        // умеет подтвердить), а не хардкод: если настройка разрешит формат вне
                        // этого набора, сообщение честно назовёт проверяемые форматы, а не соврёт.
                        failed('Не удалось распознать как изображение поддерживаемого формата '
                            + `(${RECOGNIZED_IMAGE_FORMATS.join('/')}).`);
                        continue;
                    }

                    const prepared = await downscaleImage(file, { mode });
                    const sizeCheck = validateImageBytes(prepared.size, { limits: lim });
                    if (!sizeCheck.ok) {
                        failed(sizeCheck.reason);
                        continue;
                    }

                    // #12: имя должно отражать факт (downscaleImage мог молча
                    // перекодировать картинку в WebP).
                    const filename = resolveActualFilename(file, prepared);
                    const uploaded = await uploadActImage(actId, prepared, filename);
                    blocks.push(createImageBlock({ image_id: uploaded.image_id, filename }));
                } catch (error) {
                    // Отказ сервера (нет лока, превышен бюджет акта, нет прав)
                    // приходит человеческим текстом в envelope — показываем его,
                    // своей формулировки поверх не сочиняем.
                    console.error('Не удалось загрузить изображение:', file.name, error);
                    failed(error?.message || 'Не удалось загрузить изображение.');
                }
            }
        } finally {
            Notifications.hide(progressId);
        }

        this._reportImageFailures(failures);

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
     * Сообщает об отказах пачки: по ОДНОМУ тосту на причину, а не на файл.
     * Пять картинок, отклонённых одним и тем же «акт заблокирован», дают одно
     * уведомление со списком имён (длинный список усекается).
     *
     * Причина — законченная фраза с заглавной буквы (текст сервера либо наш
     * гейт), имя файла подставляется здесь: иначе одинаковые по сути отказы не
     * склеились бы в один тост.
     *
     * @param {{name: string, reason: string}[]} failures - Отказы в порядке файлов
     * @private
     */
    _reportImageFailures(failures) {
        if (!failures.length) return;

        const MAX_LISTED = 3;
        const byReason = new Map();
        for (const failure of failures) {
            if (!byReason.has(failure.reason)) byReason.set(failure.reason, []);
            byReason.get(failure.reason).push(failure.name);
        }

        for (const [reason, names] of byReason) {
            if (names.length === 1) {
                Notifications.warning(`Файл «${names[0]}» не добавлен. ${reason}`);
                continue;
            }
            const listed = names.slice(0, MAX_LISTED).map(name => `«${name}»`).join(', ');
            const rest = names.length - MAX_LISTED;
            Notifications.warning(
                `${reason} Не добавлены файлы (${names.length}): `
                + `${listed}${rest > 0 ? ` и ещё ${rest}` : ''}.`,
            );
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
            message: 'Выберите режим для вставляемых картинок. Сжатие уменьшает вес акта '
                + 'без потери чёткости текста на скриншотах; GIF не пережимается (сохраняем анимацию).',
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
