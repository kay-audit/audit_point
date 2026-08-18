/**
 * Главный класс приложения
 *
 * Координирует инициализацию всех модулей и управляет глобальным состоянием.
 * Делегирует специфичную логику соответствующим менеджерам.
 * Интегрирован с StorageManager для автосохранения.
 */
import { ContextMenuManager } from './context-menu/context-menu-core.js';
import { HelpManager } from './dialog/dialog-help.js';
import { FormatMenuManager } from './header/format-menu-manager.js';
import { ItemsRenderer } from './items/items-renderer.js';
import { LifecycleHelper } from './lifecycle-helper.js';
import { NavigationManager } from './navigation-manager.js';
import { PreviewManager } from './preview/preview.js';
import { RENDER_CLASSES } from './render-classes.js';
import { AppState } from './state/state-core.js';
import { StorageManager } from './storage-manager.js';
import { loadViewPosition, saveViewPosition } from './state/view-position-store.js';
import { AppConfig } from '../shared/app-config.js';
import { Notifications } from '../shared/notifications.js';

export class App {
    /**
     * Инициализация приложения при загрузке страницы
     */
    static init() {
        try {
            // С defer-загрузкой scripts state-core.js может успеть установить
            // Proxy ДО App.init: его bottom-code в ветке `readyState !== 'loading'`
            // ставит setTimeout(0), который выполняется до DOMContentLoaded-обработчика
            // app.js. Без явного disableTracking() мутации внутри _initializeState()
            // (AppState.initializeTree → generateNumbering → ...) трекаются Proxy
            // и поднимают _hasUnsavedChanges=true ДО StorageManager.init(), из-за чего
            // индикатор стартует в local-only/unsaved вместо saved.
            // markAsSyncedWithDB() в финале сбрасывает оба флага в "чистое" состояние.
            StorageManager.disableTracking();

            this._initializeState();
            this._initializeStorageManager();
            this._initializeManagers();
            this._setupEventHandlers();

            // Сохранение позиции просмотра при уходе со страницы. Восстановление
            // шага/скролла — в APIClient._applyActContent (после отрисовки
            // содержимого загруженного акта), не здесь.
            this._setupScrollPersistence();

            // Применяем режим только чтения если активен
            if (AppConfig.readOnlyMode?.isReadOnly) {
                this._applyReadOnlyMode();
            }

            // Сбрасываем флаги после init: дефолтное дерево/таблицы — это не
            // правки пользователя, а bootstrap-состояние. После loadActContent
            // данные перезапишутся и тоже не должны считаться "грязными".
            StorageManager.markAsSyncedWithDB();
            StorageManager.enableTracking();
        } catch (err) {
            console.error('Критическая ошибка инициализации приложения:', err);
            Notifications.error(`Ошибка инициализации приложения: ${err.message}`);
            // Даже при ошибке снимаем tracking-гард, иначе все последующие
            // правки пользователя перестанут трекаться.
            StorageManager.enableTracking();
        }
    }

    /**
     * Инициализация начального состояния приложения
     * @private
     */
    static _initializeState() {
        try {
            // По умолчанию создаём процессную проверку
            // При загрузке акта из БД структура будет перезаписана
            AppState.initializeTree(true);
            AppState.generateNumbering();
        } catch (err) {
            console.error('Ошибка инициализации состояния:', err);
            Notifications.error(`Ошибка инициализации состояния: ${err.message}`);
            throw err;
        }
    }

    /**
     * Инициализация менеджера хранилища
     * @private
     */
    static _initializeStorageManager() {
        try {
            StorageManager.init();
        } catch (err) {
            console.error('Ошибка инициализации StorageManager:', err);
            // Не критичная ошибка, продолжаем работу без автосохранения
        }
    }

    /**
     * Инициализация всех менеджеров приложения
     * @private
     */
    static _initializeManagers() {
        const managers = [
            {name: 'Tree', fn: () => treeManager.render()},
            {name: 'Preview', fn: () => requestAnimationFrame(() => PreviewManager.update())},
            {name: 'ContextMenu', fn: () => ContextMenuManager.init()},
            {name: 'Help', fn: () => HelpManager.init()}
        ];

        for (const manager of managers) {
            try {
                manager.fn();
            } catch (err) {
                console.error(`Ошибка инициализации ${manager.name}:`, err);
                Notifications.error(`Ошибка инициализации ${manager.name}: ${err.message}`);
            }
        }
    }

    /**
     * Настройка глобальных обработчиков событий
     * @private
     */
    static _setupEventHandlers() {
        const handlers = [
            {name: 'Navigation', fn: () => NavigationManager.setup()},
            {name: 'FormatMenu', fn: () => FormatMenuManager.setup()},
            {name: 'SaveIndicator', fn: () => this._setupSaveIndicator()},
            {name: 'Hotkeys', fn: () => this._setupGlobalKeyboardShortcuts()}
        ];

        for (const handler of handlers) {
            try {
                handler.fn();
            } catch (err) {
                console.error(`Ошибка настройки ${handler.name}:`, err);
                Notifications.error(`Ошибка настройки ${handler.name}: ${err.message}`);
            }
        }
    }

    /**
     * Настройка индикатора сохранности
     * @private
     */
    static _setupSaveIndicator() {
        const saveIndicatorBtn = document.getElementById('saveIndicatorBtn');

        if (saveIndicatorBtn) {
            // Удаляем старые обработчики если были
            const newBtn = saveIndicatorBtn.cloneNode(true);
            saveIndicatorBtn.parentNode.replaceChild(newBtn, saveIndicatorBtn);

            // Добавляем новый обработчик
            newBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                console.log('Save indicator clicked, disabled:', newBtn.disabled);

                if (!newBtn.disabled) {
                    // Клик по индикатору = сохранить в БД + сгенерировать и
                    // скачать выбранные в настройках форматы (Ctrl+Shift+S).
                    NavigationManager.saveAndExport();
                }
            });

            console.log('Save indicator setup complete');
        } else {
            console.error('saveIndicatorBtn not found');
        }
    }

    /**
     * Настройка глобальных горячих клавиш
     * @private
     */
    static _setupGlobalKeyboardShortcuts() {
        document.addEventListener('keydown', async (e) => {
            if ((e.ctrlKey || e.metaKey) && e.code === AppConfig.hotkeys.save.key) {
                e.preventDefault();
                e.stopImmediatePropagation();

                // H5-A: коммитим pending-редактирование ячейки до сохранения.
                // Без этого Ctrl+S во время editing'а ячейки уходил бы с старым content,
                // потому что textarea.value попадает в AppState только на blur/Enter.
                if (typeof tableManager !== 'undefined' && tableManager.cellsOps?.commitPendingEdit) {
                    tableManager.cellsOps.commitPendingEdit();
                }
                // Аналогично для активного textblock-редактора (его blur синхронит innerHTML
                // в textBlock.content через handleEditorBlur).
                const activeEl = document.activeElement;
                if (activeEl && activeEl.classList?.contains(RENDER_CLASSES.TEXTBLOCK_EDITOR)) {
                    activeEl.blur();
                }

                if (e.shiftKey) {
                    // Ctrl+Shift+S — сохранение в БД + генерация + скачивание.
                    // Эквивалент клика по кнопке-индикатору в шапке.
                    await NavigationManager.saveAndExport();
                } else {
                    // Ctrl+S — только сохранение акта в БД (без генерации и скачивания)
                    await NavigationManager.saveToDatabase();
                }
            }
        });
    }

    /**
     * Переключение между шагами приложения
     * @param {number} stepNum - Номер шага (1 или 2)
     * @param {Object} [options]
     * @param {boolean} [options.persist=true] - Сохранять ли шаг в localStorage.
     *   false — при восстановлении позиции из APIClient._applyActContent, где
     *   window.currentActId ещё не гарантированно обновлён на загружаемый акт
     *   (см. view-position-store.js).
     */
    static goToStep(stepNum, { persist = true } = {}) {
        // Обновляем текущий шаг
        AppState.currentStep = stepNum;
        if (persist && window.currentActId) {
            this._saveViewPosition(window.currentActId, { step: stepNum });
        }

        this._updateStepVisibility(stepNum);
        this._handleStepTransition(stepNum);

        HelpManager.updateTooltip();
    }

    /**
     * Обновление видимости шагов в UI
     * @private
     * @param {number} stepNum - Номер активного шага
     */
    static _updateStepVisibility(stepNum) {
        // Обновляем индикаторы в заголовке
        document.querySelectorAll('.step').forEach(step => {
            step.classList.toggle('active', parseInt(step.dataset.step) === stepNum);
        });

        // Скрываем все контенты шагов
        document.querySelectorAll('.step-content').forEach(content => {
            content.classList.add('hidden');
        });

        // Показываем текущий шаг
        const currentContent = document.getElementById(`step${stepNum}`);
        currentContent?.classList.remove('hidden');
    }

    /**
     * Обработка специфичной логики при переходе на шаг
     * @private
     * @param {number} stepNum - Номер шага
     */
    static _handleStepTransition(stepNum) {
        if (stepNum === 2) {
            textBlockManager.initGlobalToolbar();
            ItemsRenderer.renderAll();

            // Применяем режим только чтения к новым элементам
            if (AppConfig.readOnlyMode?.isReadOnly) {
                this._applyReadOnlyToContent();
            }
        } else {
            textBlockManager.hideToolbar();
            requestAnimationFrame(() => PreviewManager.update());
        }
    }

    /**
     * Настраивает сохранение позиции просмотра (скролл панелей + якорь) при
     * уходе со страницы. Восстановление — в APIClient._applyActContent, не здесь:
     * на момент App.init содержимое акта ещё не загружено.
     * @private
     */
    static _setupScrollPersistence() {
        const persist = () => this.persistViewPositionForAct(window.currentActId);

        // beforeunload — закрытие вкладки/обычная навигация; pagehide — доп. страховка
        // для сценариев, где beforeunload не срабатывает (bfcache, мобильный Safari).
        if (typeof LifecycleHelper !== 'undefined') {
            LifecycleHelper.registerBeforeUnload('app:scroll', persist);
        } else {
            window.addEventListener('beforeunload', persist);
        }
        window.addEventListener('pagehide', persist);
    }

    /**
     * Снимает текущий скролл панелей и якорный узел превью.
     * @private
     * @returns {{scroll: {treeColumn: number, previewColumn: number, step2: number}, anchorNodeId: string|null}}
     */
    static _captureScrollAndAnchor() {
        const treeColumn = document.getElementById('treeColumn');
        const previewColumn = document.getElementById('previewColumn');
        const step2 = document.getElementById('step2');

        return {
            scroll: {
                treeColumn: treeColumn ? treeColumn.scrollTop : 0,
                previewColumn: previewColumn ? previewColumn.scrollTop : 0,
                step2: step2 ? step2.scrollTop : 0,
            },
            anchorNodeId: step2 ? this._findTopVisibleAnchorNodeId(step2) : null,
        };
    }

    /**
     * Находит id верхнего видимого пункта в контейнере шага 2 — якорь для
     * восстановления скролла независимо от последующих изменений контента.
     * @private
     * @param {HTMLElement} step2 - Контейнер шага 2
     * @returns {string|null}
     */
    static _findTopVisibleAnchorNodeId(step2) {
        const items = step2.querySelectorAll('.item-block[data-node-id]');
        const containerTop = step2.getBoundingClientRect().top;
        for (const el of items) {
            if (el.getBoundingClientRect().bottom > containerTop) {
                return el.dataset.nodeId || null;
            }
        }
        return null;
    }

    /**
     * Сливает частичное обновление позиции просмотра с уже сохранённой
     * (по указанному actId явно — не полагается на window.currentActId).
     * @private
     * @param {number|string} actId - ID акта
     * @param {Object} partial - Частичное обновление ({step} и/или {scroll, anchorNodeId})
     */
    static _saveViewPosition(actId, partial) {
        if (!actId) return;
        const current = loadViewPosition(localStorage, actId) || {
            step: 1,
            scroll: { treeColumn: 0, previewColumn: 0, step2: 0 },
            anchorNodeId: null,
        };
        saveViewPosition(localStorage, actId, {
            step: partial.step !== undefined ? partial.step : current.step,
            scroll: partial.scroll !== undefined ? partial.scroll : current.scroll,
            anchorNodeId: partial.anchorNodeId !== undefined ? partial.anchorNodeId : current.anchorNodeId,
        });
    }

    /**
     * Сохраняет полный снимок текущей позиции просмотра (шаг + скролл + якорь)
     * под явно переданным actId. Используется в точках, где window.currentActId
     * не гарантированно совпадает с сохраняемым актом (переключение акта —
     * вызывается ДО перезаписи window.currentActId на новый акт).
     * @param {number|string} actId - ID акта, для которого сохраняется позиция
     */
    static persistViewPositionForAct(actId) {
        if (!actId) return;
        const { scroll, anchorNodeId } = this._captureScrollAndAnchor();
        this._saveViewPosition(actId, { step: AppState.currentStep, scroll, anchorNodeId });
    }

    /**
     * Применяет режим только чтения к интерфейсу
     * @private
     */
    static _applyReadOnlyMode() {
        console.log('Применяется режим только чтения');

        // Добавляем класс к body для глобальных стилей
        document.body.classList.add('read-only-mode');

        // Кнопка-индикатор в read-only остаётся активной: сохранять в БД нельзя,
        // но скачивание выбранных форматов доступно (NavigationManager.saveAndExport).
        const saveIndicatorBtn = document.getElementById('saveIndicatorBtn');
        if (saveIndicatorBtn) {
            saveIndicatorBtn.disabled = false;
            saveIndicatorBtn.title = 'Только чтение — сохранить нельзя, доступно скачивание файлов';
            saveIndicatorBtn.classList.remove('disabled');
        }

        // Скрываем тулбар форматирования в режиме просмотра
        const toolbar = document.querySelector('.formatting-toolbar');
        if (toolbar) {
            toolbar.classList.add('read-only-hidden');
        }
    }

    /**
     * Применяет режим только чтения к контенту (таблицы, текстблоки, нарушения)
     * @private
     */
    static _applyReadOnlyToContent() {
        // TREE-2: текстблоки переводятся в read-only в createEditor при рендере
        // (textblock-editor.js — реальный, работающий гард), поэтому отдельного
        // фолбэк-прохода по ним здесь нет: прежний селектор '.textblock-content'
        // не соответствовал ни одному элементу (реальный класс — '.textblock-editor',
        // и он уже создаётся с contentEditable='false' в RO-режиме).

        // Делаем ячейки таблиц нередактируемыми
        document.querySelectorAll('.table-cell[contenteditable="true"]').forEach(el => {
            el.contentEditable = 'false';
            el.classList.add('read-only');
        });

        // Делаем поля нарушений нередактируемыми
        document.querySelectorAll('.violation-field[contenteditable="true"]').forEach(el => {
            el.contentEditable = 'false';
            el.classList.add('read-only');
        });

        // Делаем input и textarea нередактируемыми
        document.querySelectorAll('.violation-editor input, .violation-editor textarea').forEach(el => {
            el.readOnly = true;
            el.classList.add('read-only');
        });
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
// App.init() запускается из entries/constructor.js, НЕ здесь:
// shared/api.js импортирует этот файл косвенно из portal-entry, и
// module-level DOMContentLoaded-подписка стреляла на portal-страницах,
// падая на AppState.generateNumbering (state-tree.js в portal не входит).
window.App = App;
