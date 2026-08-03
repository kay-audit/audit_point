/**
 * Координатор событий таблиц с матричной структурой данных.
 * Навешивает обработчики на ячейки/ручки (рендер выполняет ItemsRenderer),
 * управляет выделением и взаимодействием с ячейками.
 * Делегирует операции с ячейками в TableCellsOperations и изменение размеров в TableSizes.
 */
import { ContextMenuManager } from '../context-menu/context-menu-core.js';
import { AppState } from '../state/state-core.js';
import { applyCellInput, cancelCellInput } from './cell-write-through.js';
import { TableCellsOperations } from './table-cells-operations.js';
import { TableSizes } from './table-sizes.js';
import { Notifications } from '../../shared/notifications.js';
import { EscapeStack } from '../../shared/escape-stack.js';

export class TableManager {
    constructor() {
        // Список выбранных ячеек для групповых операций (объединение/разделение)
        this.selectedCells = [];
        // Модуль операций с ячейками (выделение, редактирование, объединение)
        this.cellsOps = new TableCellsOperations(this);
        // Модуль изменения размеров (ширина колонок, высота строк)
        this.sizes = new TableSizes(this);
        // Исходные значения активных сессий редактирования ячеек —
        // для отката состояния при отмене (Escape). Ключ — элемент textarea.
        this._cellEditOriginals = new WeakMap();

        // Инициализация глобальных обработчиков
        this.initGlobalHandlers();
    }

    /**
     * Инициализация глобальных обработчиков событий.
     * Обрабатывает клики вне таблицы и нажатие Escape для снятия выделения.
     */
    initGlobalHandlers() {
        // Обработчик кликов вне таблицы
        document.addEventListener('click', (e) => {
            // Проверяем, что клик НЕ по ячейке таблицы и НЕ по контекстному меню
            const isTableCell = e.target.closest('td, th');
            const isContextMenu = e.target.closest('.context-menu, #cellContextMenu');
            const isResizeHandle = e.target.classList.contains('resize-handle');

            if (!isTableCell && !isContextMenu && !isResizeHandle) {
                // Клик вне таблицы - снимаем выделение
                this.clearSelection();
            }
        });

        // Обработчик нажатия Escape.
        // Legacy-listener: написан до централизации ESC в EscapeStack, живёт в
        // bubbling. Пока в стеке есть слой (диалог, панель поиска, активная зона
        // нарушений), ESC принадлежит ему; сюда событие доходит только сквозным
        // отказом всех слоёв (PASS) — снимать по нему выделение нельзя, иначе
        // Escape, адресованный редактору, незаметно стирает выделение ячеек.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !EscapeStack.isActive()) {
                // Снимаем выделение с ячеек
                this.clearSelection();
                // Скрываем контекстное меню
                if (typeof ContextMenuManager !== 'undefined') {
                    ContextMenuManager.hide();
                }
            }
        });
    }

    /**
     * Привязка обработчиков событий к ячейкам и ручкам изменения размеров.
     * Обрабатывает клики, двойные клики, контекстное меню и начало resize-операций.
     */
    attachEventListeners() {
        const container = document.getElementById('itemsContainer');
        if (!container) return;
        this.attachEventListenersToContainer(container);
    }

    /**
     * Привязка cell/handle-обработчиков ТОЛЬКО к ячейкам внутри указанного контейнера.
     * Используется per-node API в ItemsRenderer (updateTable/updateItem), чтобы НЕ навешивать
     * слушатели повторно на все таблицы в #itemsContainer (это привело бы к мульти-срабатыванию).
     * Контейнер должен содержать только что созданные cell-элементы без существующих листенеров.
     * @param {HTMLElement} container - DOM-элемент, в котором искать td/th/resize-handle
     */
    attachEventListenersToContainer(container) {
        if (!container) return;

        // Обработка событий на ячейках
        container.querySelectorAll('td, th').forEach(cell => {
            // Одинарный клик - выделение ячейки (с Ctrl - множественное)
            cell.addEventListener('click', (e) => {
                if (e.target.classList.contains('resize-handle')) {
                    return;
                }

                // Добавляем stopPropagation для предотвращения всплытия к document
                e.stopPropagation();

                if (!e.ctrlKey) {
                    this.cellsOps.clearSelection();
                }

                this.cellsOps.selectCell(cell);
            });

            // Двойной клик для редактирования ячейки
            cell.addEventListener('dblclick', (e) => {
                const tableId = cell.dataset.tableId;
                const table = AppState.tables[tableId];

                // ПРОВЕРКА: блокируем редактирование заголовков защищенных таблиц
                const isProtectedTable = table && table.protected === true;
                const isHeaderCell = cell.tagName.toLowerCase() === 'th';

                if (isProtectedTable && isHeaderCell) {
                    Notifications.info('Заголовки защищенной таблицы нельзя редактировать');
                    return;
                }

                this.cellsOps.startEditingCell(cell);
            });

            // Правая кнопка мыши - контекстное меню
            cell.addEventListener('contextmenu', (e) => {
                if (e.target.classList.contains('resize-handle')) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();

                // Если нет выделенных ячеек или текущая ячейка не входит в выделение - выбираем её
                if (this.selectedCells.length === 0 || !this.selectedCells.includes(cell)) {
                    this.cellsOps.clearSelection();
                    this.cellsOps.selectCell(cell);
                }

                ContextMenuManager.show(e.clientX, e.clientY, null, 'cell');
            });

            // Write-through ввода: каждое изменение в textarea редактируемой
            // ячейки сразу пишется в состояние (Proxy пометит акт несохранённым).
            // Коммит по blur/Enter (finishEditing) поверх запишет то же значение с trim.
            cell.addEventListener('input', (e) => {
                const textarea = e.target;
                if (!textarea || textarea.tagName !== 'TEXTAREA') return;
                applyCellInput(
                    AppState.tables,
                    cell.dataset.tableId,
                    parseInt(cell.dataset.row, 10),
                    parseInt(cell.dataset.col, 10),
                    textarea.value,
                    this._cellEditOriginals,
                    textarea
                );
            });

            // Отмена редактирования (Escape): откатываем состояние к значению
            // на момент начала ввода. Capture-фаза — штатный keydown-обработчик
            // textarea гасит Escape (stopPropagation) после отката DOM, поэтому
            // ловим событие раньше него.
            cell.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return;
                const textarea = e.target;
                if (!textarea || textarea.tagName !== 'TEXTAREA') return;
                cancelCellInput(
                    AppState.tables,
                    cell.dataset.tableId,
                    parseInt(cell.dataset.row, 10),
                    parseInt(cell.dataset.col, 10),
                    this._cellEditOriginals,
                    textarea
                );
            }, true);
        });

        // Обработка ручек изменения ширины колонок
        container.querySelectorAll('.resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Делегируем к модулю sizes
                this.sizes.startColumnResize(e);
            });
        });
    }

    // Делегирующие методы для операций с ячейками
    /**
     * Снимает выделение со всех ячеек.
     * Делегирует выполнение в TableCellsOperations.
     */
    clearSelection() {
        this.cellsOps.clearSelection();
    }

    /**
     * Объединяет выбранные ячейки в одну с colspan/rowspan.
     * Делегирует выполнение в TableCellsOperations.
     */
    mergeCells() {
        this.cellsOps.mergeCells();
    }

    /**
     * Разделяет объединенную ячейку на отдельные ячейки.
     * Делегирует выполнение в TableCellsOperations.
     */
    unmergeCells() {
        this.cellsOps.unmergeCells();
    }

    // Делегирующие методы для изменения размеров
    /**
     * Начинает интерактивное изменение ширины колонки.
     * Делегирует выполнение в TableSizes.
     * @param {MouseEvent} e - событие mousedown на ручке изменения размера
     */
    startColumnResize(e) {
        this.sizes.startColumnResize(e);
    }
}

// Глобальный экземпляр для управления всеми таблицами в приложении
export const tableManager = new TableManager();

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.TableManager = TableManager;
window.tableManager = tableManager;
