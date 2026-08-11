/**
 * Обработчик контекстного меню для ячеек таблицы.
 * Управляет операциями с ячейками: объединение, разъединение, вставка/удаление строк и колонок.
 */
import { ContextMenuManager } from './context-menu-core.js';
import { Notifications } from '../../shared/notifications.js';
import { resolveTable } from '../table/table-store.js';
import { MSG_ROW_HAS_MERGED_CELLS } from '../table/table-cells-operations.js';

export class CellContextMenu {
    constructor(menu) {
        this.menu = menu;
        this.initHandlers();
    }

    /**
     * Инициализация обработчиков событий для пунктов меню.
     */
    initHandlers() {
        this.menu.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();

                const action = item.dataset.action;
                this.handleAction(action);
                ContextMenuManager.hide();
            });

            // Обработчик mouseenter для показа подсказок и подсветки
            item.addEventListener('mouseenter', (e) => {
                const action = item.dataset.action;
                this.showHint(action, item);
            });

            item.addEventListener('mouseleave', (e) => {
                this.hideTooltip();
                this.clearHighlights();
            });
        });
    }

    /**
     * Показывает меню и обновляет доступность пунктов на основе защиты таблицы.
     * @param {number} x - Координата X
     * @param {number} y - Координата Y
     * @param {Object} params - Дополнительные параметры
     */
    show(x, y, params = {}) {
        if (!this.menu) return;

        this.updateMenuState();
        ContextMenuManager.positionMenu(this.menu, x, y);
    }

    /**
     * Обновляет состояние пунктов меню в зависимости от защиты таблицы.
     * protected блокирует только объединение ячеек и операции с колонками.
     */
    updateMenuState() {
        const selectedCount = tableManager.selectedCells.length;

        let isProtectedTable = false;
        let isHeaderRowSelected = false;

        if (selectedCount > 0) {
            const cell = tableManager.selectedCells[0];
            const tableId = cell.dataset.tableId;
            const table = resolveTable(tableId);

            isProtectedTable = table && table.protected === true;

            const rowIndex = parseInt(cell.dataset.row);
            if (table && table.grid && table.grid[rowIndex]) {
                isHeaderRowSelected = table.grid[rowIndex].some(c => c.isHeader === true);
            }
        }

        // Unmerge - блокируется для protected таблиц
        const unmergeItem = this.menu.querySelector('[data-action="unmerge-cell"]');
        if (unmergeItem) {
            if (selectedCount === 1 && !isProtectedTable) {
                // Объединение определяем по grid-модели (как ядро операций),
                // а не по DOM-свойствам td: DOM-узел в selectedCells может
                // быть detached/устаревшим относительно модели.
                const isMerged = this._isMergedInGrid(tableManager.selectedCells[0]);
                unmergeItem.classList.toggle('disabled', !isMerged);
            } else {
                unmergeItem.classList.add('disabled');
            }
        }

        // Merge - блокируется для protected таблиц
        const mergeItem = this.menu.querySelector('[data-action="merge-cells"]');
        if (mergeItem) {
            if (!isProtectedTable && selectedCount >= 2) {
                mergeItem.classList.remove('disabled');
            } else {
                mergeItem.classList.add('disabled');
            }
        }

        // ОПЕРАЦИИ СО СТРОКАМИ - ВСЕГДА ДОСТУПНЫ (кроме заголовков)
        const insertRowAboveItem = this.menu.querySelector('[data-action="insert-row-above"]');
        if (insertRowAboveItem) {
            // Блокируем только для заголовков, НЕ для protected
            insertRowAboveItem.classList.toggle('disabled', isHeaderRowSelected);
        }

        const insertRowBelowItem = this.menu.querySelector('[data-action="insert-row-below"]');
        if (insertRowBelowItem) {
            // Всегда доступно
            insertRowBelowItem.classList.remove('disabled');
        }

        const deleteRowItem = this.menu.querySelector('[data-action="delete-row"]');
        if (deleteRowItem) {
            // Блокируем только для заголовков, НЕ для protected
            deleteRowItem.classList.toggle('disabled', isHeaderRowSelected);
        }

        // ОПЕРАЦИИ С КОЛОНКАМИ - блокируются для protected таблиц
        const columnActions = ['insert-col-left', 'insert-col-right', 'delete-col'];
        columnActions.forEach(action => {
            const item = this.menu.querySelector(`[data-action="${action}"]`);
            if (item) {
                item.classList.toggle('disabled', isProtectedTable);
            }
        });
    }

    /**
     * Обработчик действий из контекстного меню.
     */
    handleAction(action) {
        const selectedCount = tableManager.selectedCells.length;

        if (selectedCount === 0) {
            Notifications.error('Выберите ячейку');
            return;
        }

        const cell = tableManager.selectedCells[0];
        const tableId = cell.dataset.tableId;
        const rowIndex = parseInt(cell.dataset.row);
        const colIndex = parseInt(cell.dataset.col);
        const table = resolveTable(tableId);

        const isProtectedTable = table && table.protected === true;

        // Список действий, запрещенных для protected таблиц
        // Операции со строками НЕ включены!
        const protectedForbiddenActions = [
            'merge-cells',
            'unmerge-cell',
            'insert-col-left',
            'insert-col-right',
            'delete-col'
        ];

        // Блокируем только запрещенные действия
        if (isProtectedTable && protectedForbiddenActions.includes(action)) {
            Notifications.error('Нельзя объединять ячейки и изменять колонки в этой таблице');
            return;
        }

        // Валидация действий
        switch (action) {
            case 'merge-cells':
                if (selectedCount < 2) {
                    Notifications.error('Выберите минимум 2 ячейки для объединения');
                    return;
                }
                if (!this._canMergeCells()) {
                    Notifications.error('Нельзя объединять ячейки заголовка с ячейками данных');
                    return;
                }
                break;

            case 'unmerge-cell':
                if (selectedCount !== 1) {
                    Notifications.error('Выберите одну ячейку для разъединения');
                    return;
                }
                // По grid-модели — единый предикат с updateMenuState и ядром.
                if (!this._isMergedInGrid(cell)) {
                    Notifications.info('Ячейка не объединена');
                    return;
                }
                break;

            case 'insert-row-above':
                if (selectedCount !== 1) {
                    Notifications.error('Выберите одну ячейку');
                    return;
                }
                const isHeaderRow = table.grid[rowIndex].some(c => c.isHeader === true);
                if (isHeaderRow) {
                    Notifications.error('Нельзя вставить строку выше заголовка таблицы');
                    return;
                }
                break;

            case 'insert-row-below':
            case 'insert-col-left':
            case 'insert-col-right':
                if (selectedCount !== 1) {
                    Notifications.error('Выберите одну ячейку');
                    return;
                }
                break;

            case 'delete-row':
                if (selectedCount !== 1) {
                    Notifications.error('Выберите одну ячейку');
                    return;
                }
                const isHeader = table.grid[rowIndex].some(c => c.isHeader === true);
                if (isHeader) {
                    Notifications.error('Нельзя удалить строку заголовков');
                    return;
                }
                const rowHasMerged = this._rowHasAnyMergedCellsStrict(table, rowIndex);
                if (rowHasMerged) {
                    Notifications.error(MSG_ROW_HAS_MERGED_CELLS);
                    return;
                }
                const headerRowCount = table.grid.filter(row => row.some(c => c.isHeader === true)).length;
                if (table.grid.length - headerRowCount <= 1) {
                    Notifications.error('Таблица должна содержать хотя бы одну строку данных');
                    return;
                }
                break;

            case 'delete-col':
                if (selectedCount !== 1) {
                    Notifications.error('Выберите одну ячейку');
                    return;
                }
                if (table.grid[0].length <= 1) {
                    Notifications.error('Таблица должна содержать хотя бы одну колонку');
                    return;
                }
                const colHasMerged = this._columnHasAnyMergedCellsStrict(table, colIndex);
                if (colHasMerged) {
                    Notifications.error('Колонка содержит объединенные ячейки. Сначала разъедините их.');
                    return;
                }
                break;
        }

        // Ширины колонок — единый источник истины table.colWidths; операции сами
        // зовут ItemsRenderer.updateTable, который пересобирает colgroup из весов.
        // Высоты строк — auto. Снапшот/восстановление DOM-размеров больше не нужны.
        switch (action) {
            case 'merge-cells':
                tableManager.mergeCells();
                break;
            case 'unmerge-cell':
                tableManager.unmergeCells();
                break;
            case 'insert-row-above':
                tableManager.cellsOps.insertRowAbove();
                Notifications.success('Строка добавлена');
                break;
            case 'insert-row-below':
                tableManager.cellsOps.insertRowBelow();
                Notifications.success('Строка добавлена');
                break;
            case 'insert-col-left':
                tableManager.cellsOps.insertColumnLeft();
                Notifications.success('Колонка добавлена');
                break;
            case 'insert-col-right':
                tableManager.cellsOps.insertColumnRight();
                Notifications.success('Колонка добавлена');
                break;
            case 'delete-row':
                tableManager.cellsOps.deleteRow();
                Notifications.success('Строка удалена');
                break;
            case 'delete-col':
                tableManager.cellsOps.deleteColumn();
                Notifications.success('Колонка удалена');
                break;
        }
    }

    /**
     * Показывает подсказку и подсветку операции (только информативные сообщения).
     * @param {string} action - Действие из контекстного меню
     * @param {HTMLElement} menuItem - Элемент пункта меню
     */
    showHint(action, menuItem) {
        const selectedCount = tableManager.selectedCells.length;
        if (selectedCount === 0) return;

        const cell = tableManager.selectedCells[0];
        const tableId = cell.dataset.tableId;
        const rowIndex = parseInt(cell.dataset.row);
        const colIndex = parseInt(cell.dataset.col);
        const table = resolveTable(tableId);

        let hint = '';
        let highlightType = null;

        switch (action) {
            case 'insert-row-above': {
                const actualRowIndex = this._findRowStartOfSpan(table, rowIndex);
                if (actualRowIndex !== rowIndex) {
                    hint = `Вставка будет выполнена выше объединенных ячеек (строка ${actualRowIndex + 1})`;
                }
                highlightType = 'insert-row-above';
                break;
            }

            case 'insert-row-below': {
                const actualRowIndex = this._findRowEndOfSpan(table, rowIndex);
                if (actualRowIndex !== rowIndex + 1) {
                    hint = `Вставка будет выполнена ниже объединенных ячеек (строка ${actualRowIndex + 1})`;
                }
                highlightType = 'insert-row-below';
                break;
            }

            case 'insert-col-left': {
                const actualColIndex = this._findColumnStartOfSpan(table, colIndex);
                if (actualColIndex !== colIndex) {
                    hint = `Вставка будет выполнена слева от объединенных ячеек (колонка ${actualColIndex + 1})`;
                }
                highlightType = 'insert-col-left';
                break;
            }

            case 'insert-col-right': {
                const actualColIndex = this._findColumnEndOfSpan(table, colIndex);
                if (actualColIndex !== colIndex + 1) {
                    hint = `Вставка будет выполнена справа от объединенных ячеек (колонка ${actualColIndex + 1})`;
                }
                highlightType = 'insert-col-right';
                break;
            }

            case 'delete-row':
                highlightType = 'delete-row';
                break;

            case 'delete-col':
                highlightType = 'delete-column';
                break;
        }

        if (hint) {
            this.showTooltip(hint, menuItem);
        }

        if (highlightType) {
            this.highlightOperation(table, rowIndex, colIndex, highlightType);
        }
    }

    /**
     * Показывает всплывающую подсказку рядом с пунктом меню.
     * @param {string} text - Текст подсказки
     * @param {HTMLElement} menuItem - Элемент пункта меню
     */
    showTooltip(text, menuItem) {
        this.hideTooltip();

        const tooltip = document.createElement('div');
        tooltip.className = 'context-menu-tooltip';
        tooltip.textContent = text;
        tooltip.id = 'contextMenuTooltip';

        document.body.appendChild(tooltip);

        const itemRect = menuItem.getBoundingClientRect();
        tooltip.style.left = `${itemRect.right + 10}px`;
        tooltip.style.top = `${itemRect.top}px`;

        requestAnimationFrame(() => {
            const tooltipRect = tooltip.getBoundingClientRect();
            const viewportWidth = window.innerWidth;

            if (tooltipRect.right > viewportWidth) {
                tooltip.style.left = `${itemRect.left - tooltipRect.width - 10}px`;
            }
        });
    }

    /**
     * Скрывает всплывающую подсказку.
     */
    hideTooltip() {
        const tooltip = document.getElementById('contextMenuTooltip');
        if (tooltip) {
            tooltip.remove();
        }
    }

    /**
     * Универсальная подсветка для всех операций с таблицей.
     * @param {Object} table - Объект таблицы (resolveTable)
     * @param {number} rowIndex - Индекс строки
     * @param {number} colIndex - Индекс колонки
     * @param {string} type - Тип операции
     */
    highlightOperation(table, rowIndex, colIndex, type) {
        this.clearHighlights();

        if (!tableManager.selectedCells.length) return;

        const cell = tableManager.selectedCells[0];
        const tableElement = cell.closest('table');
        if (!tableElement) return;

        switch (type) {
            case 'insert-row-above': {
                const actualRowIndex = this._findRowStartOfSpan(table, rowIndex);
                this._highlightRowBorder(tableElement, table, actualRowIndex, 'top');
                break;
            }

            case 'insert-row-below': {
                const actualRowIndex = this._findRowEndOfSpan(table, rowIndex);
                if (actualRowIndex > 0) {
                    this._highlightRowBorder(tableElement, table, actualRowIndex - 1, 'bottom');
                }
                break;
            }

            case 'insert-col-left': {
                const actualColIndex = this._findColumnStartOfSpan(table, colIndex);
                this._highlightColumnBorder(tableElement, table, actualColIndex, 'left');
                break;
            }

            case 'insert-col-right': {
                const actualColIndex = this._findColumnEndOfSpan(table, colIndex);
                if (actualColIndex > 0) {
                    this._highlightColumnBorder(tableElement, table, actualColIndex - 1, 'right');
                }
                break;
            }

            case 'delete-row': {
                this._highlightRowBorder(tableElement, table, rowIndex, 'top');
                this._highlightRowBorder(tableElement, table, rowIndex, 'bottom');
                const rows = tableElement.querySelectorAll('tr');
                rows[rowIndex]?.querySelectorAll('td, th').forEach(c =>
                    c.classList.add('highlight-warning')
                );
                break;
            }

            case 'delete-column': {
                this._highlightColumnBorder(tableElement, table, colIndex, 'left');
                this._highlightColumnBorder(tableElement, table, colIndex, 'right');
                const rows = tableElement.querySelectorAll('tr');
                rows.forEach(row => {
                    row.querySelectorAll('td, th').forEach(c => {
                        if (parseInt(c.dataset.col) === colIndex) {
                            c.classList.add('highlight-warning');
                        }
                    });
                });
                break;
            }
        }
    }

    /**
     * Подсвечивает горизонтальную границу строки (верхнюю или нижнюю).
     * Учитывает colspan ячеек для непрерывной линии.
     * @param {HTMLElement} tableElement - DOM-элемент таблицы
     * @param {Object} table - Объект таблицы (resolveTable)
     * @param {number} rowIndex - Индекс строки
     * @param {string} side - Сторона ('top' или 'bottom')
     */
    _highlightRowBorder(tableElement, table, rowIndex, side) {
        const rows = tableElement.querySelectorAll('tr');
        const row = rows[rowIndex];
        if (!row) return;

        const numCols = table.grid[0].length;
        const borderClass = side === 'top' ? 'highlight-border-top' : 'highlight-border-bottom';

        // Создаем карту покрытия колонок для этой строки
        const colCoverage = new Array(numCols).fill(null);

        // Заполняем карту: какая DOM-ячейка покрывает какую логическую колонку
        const domCells = row.querySelectorAll('td, th');
        domCells.forEach(domCell => {
            const startCol = parseInt(domCell.dataset.col);
            const colspan = domCell.colSpan || 1;

            for (let c = startCol; c < startCol + colspan && c < numCols; c++) {
                colCoverage[c] = domCell;
            }
        });

        // Подсвечиваем все уникальные DOM-ячейки
        const highlightedCells = new Set();
        colCoverage.forEach(domCell => {
            if (domCell && !highlightedCells.has(domCell)) {
                domCell.classList.add(borderClass);
                highlightedCells.add(domCell);
            }
        });
    }

    /**
     * Подсвечивает вертикальную границу колонки (левую или правую).
     * Учитывает rowspan ячеек для непрерывной линии.
     * @param {HTMLElement} tableElement - DOM-элемент таблицы
     * @param {Object} table - Объект таблицы (resolveTable)
     * @param {number} colIndex - Индекс колонки
     * @param {string} side - Сторона ('left' или 'right')
     */
    _highlightColumnBorder(tableElement, table, colIndex, side) {
        const rows = tableElement.querySelectorAll('tr');
        const borderClass = side === 'left' ? 'highlight-border-left' : 'highlight-border-right';

        // Для каждой строки находим DOM-ячейку, которая покрывает нужную колонку
        rows.forEach((row, rowIndex) => {
            if (rowIndex >= table.grid.length) return;

            const cells = row.querySelectorAll('td, th');

            // Ищем ячейку, которая покрывает целевую колонку
            cells.forEach(domCell => {
                const startCol = parseInt(domCell.dataset.col);
                const colspan = domCell.colSpan || 1;
                const endCol = startCol + colspan - 1;

                // Проверяем, покрывает ли эта ячейка целевую колонку
                if (startCol <= colIndex && colIndex <= endCol) {
                    domCell.classList.add(borderClass);
                }
            });
        });
    }

    /**
     * Убирает всю подсветку с таблицы.
     */
    clearHighlights() {
        const classes = [
            'highlight-error',
            'highlight-insert',
            'highlight-warning',
            'highlight-border-top',
            'highlight-border-bottom',
            'highlight-border-left',
            'highlight-border-right'
        ];

        document.querySelectorAll(classes.map(c => '.' + c).join(',')).forEach(el => {
            classes.forEach(className => el.classList.remove(className));
        });
    }

    /**
     * Находит начальную строку для вставки с учетом объединенных ячеек.
     * @param {Object} table - Объект таблицы
     * @param {number} rowIndex - Индекс текущей строки
     * @returns {number} Индекс начальной строки
     */
    _findRowStartOfSpan(table, rowIndex) {
        for (let r = 0; r < rowIndex; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned && cellData.rowSpan > 1) {
                    const cellEndRow = r + cellData.rowSpan;
                    if (cellEndRow > rowIndex) {
                        return r;
                    }
                }
            }
        }
        return rowIndex;
    }

    /**
     * Находит конечную строку для вставки с учетом объединенных ячеек.
     * @param {Object} table - Объект таблицы
     * @param {number} rowIndex - Индекс текущей строки
     * @returns {number} Индекс для вставки
     */
    _findRowEndOfSpan(table, rowIndex) {
        let insertRowIndex = rowIndex + 1;
        for (let c = 0; c < table.grid[rowIndex].length; c++) {
            const cellData = table.grid[rowIndex][c];
            if (!cellData.isSpanned && cellData.rowSpan > 1) {
                const cellEndRow = rowIndex + cellData.rowSpan;
                insertRowIndex = Math.max(insertRowIndex, cellEndRow);
            }
        }
        for (let r = 0; r < rowIndex; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned && cellData.rowSpan > 1) {
                    const cellEndRow = r + cellData.rowSpan;
                    if (cellEndRow > rowIndex) {
                        insertRowIndex = Math.max(insertRowIndex, cellEndRow);
                    }
                }
            }
        }
        return insertRowIndex;
    }

    /**
     * Находит начальную колонку для вставки с учетом объединенных ячеек.
     * @param {Object} table - Объект таблицы
     * @param {number} colIndex - Индекс текущей колонки
     * @returns {number} Индекс начальной колонки
     */
    _findColumnStartOfSpan(table, colIndex) {
        for (let r = 0; r < table.grid.length; r++) {
            for (let c = 0; c < colIndex; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned && cellData.colSpan > 1) {
                    const cellEndCol = c + cellData.colSpan;
                    if (cellEndCol > colIndex) {
                        return c;
                    }
                }
            }
        }
        return colIndex;
    }

    /**
     * Находит конечную колонку для вставки с учетом объединенных ячеек.
     * @param {Object} table - Объект таблицы
     * @param {number} colIndex - Индекс текущей колонки
     * @returns {number} Индекс для вставки
     */
    _findColumnEndOfSpan(table, colIndex) {
        let insertColIndex = colIndex + 1;
        for (let r = 0; r < table.grid.length; r++) {
            const cellData = table.grid[r][colIndex];
            if (cellData && !cellData.isSpanned && cellData.colSpan > 1) {
                const cellEndCol = colIndex + cellData.colSpan;
                insertColIndex = Math.max(insertColIndex, cellEndCol);
            }
        }
        for (let r = 0; r < table.grid.length; r++) {
            for (let c = 0; c < colIndex; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned && cellData.colSpan > 1) {
                    const cellEndCol = c + cellData.colSpan;
                    if (cellEndCol > colIndex) {
                        insertColIndex = Math.max(insertColIndex, cellEndCol);
                    }
                }
            }
        }
        return insertColIndex;
    }

    /**
     * Проверяет по grid-модели, является ли выбранная DOM-ячейка ведущей
     * ячейкой объединения. Ядро операций (TableCellsOperations) работает
     * только по grid — меню обязано использовать тот же источник истины,
     * иначе detached/устаревший DOM даёт рассинхрон доступности unmerge.
     * @param {HTMLElement} cell - DOM-элемент выбранной ячейки
     * @returns {boolean} true если в grid у ячейки colSpan>1 или rowSpan>1
     */
    _isMergedInGrid(cell) {
        const table = resolveTable(cell.dataset.tableId);
        const cellData = table?.grid?.[parseInt(cell.dataset.row)]?.[parseInt(cell.dataset.col)];
        if (!cellData || cellData.isSpanned) return false;
        return (cellData.colSpan || 1) > 1 || (cellData.rowSpan || 1) > 1;
    }

    /**
     * Проверяет наличие объединенных ячеек в строке (строгая проверка).
     * @param {Object} table - Объект таблицы
     * @param {number} rowIndex - Индекс строки
     * @returns {boolean} true если есть объединенные ячейки
     */
    _rowHasAnyMergedCellsStrict(table, rowIndex) {
        for (let c = 0; c < table.grid[rowIndex].length; c++) {
            const cellData = table.grid[rowIndex][c];
            if (cellData.isSpanned) return true;
            if ((cellData.rowSpan || 1) > 1 || (cellData.colSpan || 1) > 1) return true;
        }

        for (let r = 0; r < rowIndex; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned && cellData.rowSpan > 1) {
                    const cellEndRow = r + cellData.rowSpan;
                    if (cellEndRow > rowIndex) return true;
                }
            }
        }

        return false;
    }

    /**
     * Проверяет наличие объединенных ячеек в колонке (строгая проверка).
     * @param {Object} table - Объект таблицы
     * @param {number} colIndex - Индекс колонки
     * @returns {boolean} true если есть объединенные ячейки
     */
    _columnHasAnyMergedCellsStrict(table, colIndex) {
        for (let r = 0; r < table.grid.length; r++) {
            const cellData = table.grid[r][colIndex];
            if (cellData.isSpanned) return true;
            if ((cellData.rowSpan || 1) > 1 || (cellData.colSpan || 1) > 1) return true;
        }

        for (let r = 0; r < table.grid.length; r++) {
            for (let c = 0; c < colIndex; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned && cellData.colSpan > 1) {
                    const cellEndCol = c + cellData.colSpan;
                    if (cellEndCol > colIndex) return true;
                }
            }
        }

        return false;
    }

    /**
     * Проверяет возможность объединения выбранных ячеек.
     * Запрещает объединение ячеек заголовка с ячейками данных.
     * @returns {boolean} true если ячейки можно объединить
     */
    _canMergeCells() {
        const selectedCount = tableManager.selectedCells.length;
        if (selectedCount < 2) return false;

        const coords = tableManager.selectedCells.map(cell => ({
            row: parseInt(cell.dataset.row),
            col: parseInt(cell.dataset.col),
            tableId: cell.dataset.tableId
        }));

        const tableId = coords[0].tableId;
        if (!coords.every(c => c.tableId === tableId)) return false;

        const table = resolveTable(tableId);
        if (!table) return false;

        const minRow = Math.min(...coords.map(c => c.row));
        const maxRow = Math.max(...coords.map(c => c.row));
        const minCol = Math.min(...coords.map(c => c.col));
        const maxCol = Math.max(...coords.map(c => c.col));

        let hasHeader = false;
        let hasData = false;

        for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned) {
                    if (cellData.isHeader) {
                        hasHeader = true;
                    } else {
                        hasData = true;
                    }
                }
            }
        }

        return !(hasHeader && hasData);
    }

}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.CellContextMenu = CellContextMenu;
