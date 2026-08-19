/**
 * Операции с ячейками таблиц.
 * Обрабатывает редактирование содержимого, выделение и объединение/разделение ячеек.
 *
 * Таблица адресуется строковым id из `cell.dataset.tableId` и разрешается через
 * `resolveTable` (table-store.js) — один и тот же код обслуживает узловые
 * таблицы (`AppState.tables`) и встроенные таблицы блоков нарушения. Перерисовку
 * редактора и превью после правки берёт на себя `afterTableChanged`.
 */
import { ChangelogTracker } from '../changelog-tracker.js';
import { AppState } from '../state/state-core.js';
import { AppConfig } from '../../shared/app-config.js';
import { Notifications } from '../../shared/notifications.js';
import { getStructureLimits } from '../violation/violation-image-validator.js';
import { applyInsertColumnWidth, applyRemoveColumnWidth } from './col-widths.js';
import { mergeRange, unmergeAt } from './table-merge-core.js';
import { validateGridRegion, gridToMerges, applyMergesToGrid } from './grid-merges.js';
import {
    resolveTable,
    isEmbeddedTableId,
    afterTableChanged,
    afterTableCellChanged,
} from './table-store.js';

/**
 * Единое сообщение отказа удаления строки с объединениями (M.22).
 * Семантика «сначала разделить, потом удалять»: тот же текст показывает
 * контекстное меню (context-menu-cells.js) и ядро deleteRow.
 */
export const MSG_ROW_HAS_MERGED_CELLS = 'Строка содержит объединенные ячейки. Сначала разъедините их.';

export class TableCellsOperations {
    constructor(tableManager) {
        this.tableManager = tableManager;
    }

    /**
     * Начинает редактирование содержимого ячейки.
     * Создает textarea для ввода текста с поддержкой Shift+Enter для многострочного ввода.
     * @param {HTMLElement} cellEl - DOM-элемент ячейки
     */
    startEditingCell(cellEl) {
        // Блокируем редактирование в режиме только чтения
        if (AppConfig.readOnlyMode?.isReadOnly) {
            Notifications.warning(AppConfig.readOnlyMode.messages.cannotEdit);
            return;
        }

        const originalContent = cellEl.textContent;
        cellEl.classList.add('editing');

        const textarea = document.createElement('textarea');
        textarea.value = originalContent;
        textarea.style.width = '100%';
        textarea.style.height = '100%';
        textarea.style.minHeight = '28px';
        textarea.style.border = 'none';
        textarea.style.outline = 'none';
        textarea.style.resize = 'none';
        textarea.style.padding = '4px';
        textarea.style.fontFamily = 'inherit';
        textarea.style.fontSize = 'inherit';

        cellEl.textContent = '';
        cellEl.appendChild(textarea);
        textarea.focus();

        let finished = false;
        const finishEditing = (cancel = false) => {
            // Guard от повторного входа: установка cellEl.textContent ниже
            // удаляет textarea из DOM и может повторно эмитнуть blur (→ второй
            // finishEditing с уже пустым/изменённым значением). Завершаем ровно раз.
            if (finished) return;
            finished = true;

            if (cancel) {
                cellEl.textContent = originalContent;
            } else {
                const newValue = textarea.value.trim();
                cellEl.textContent = newValue;

                const tableId = cellEl.dataset.tableId;
                const row = parseInt(cellEl.dataset.row);
                const col = parseInt(cellEl.dataset.col);
                const table = resolveTable(tableId);

                if (table && table.grid && table.grid[row] && table.grid[row][col]) {
                    if (!table.grid[row][col].isSpanned) {
                        table.grid[row][col].content = newValue;
                    }
                }

                // Встроенные таблицы нарушений в журнал правок не пишем: правки
                // нарушения фиксирует блочный аудит-дифф при сохранении
                // (violation-audit.js), а запись о таблице vt::… была бы
                // фантомной — такой таблицы в акте нет.
                if (typeof ChangelogTracker !== 'undefined' && !isEmbeddedTableId(tableId)) {
                    ChangelogTracker._recordDebounced('modify_table', tableId, '', {field: 'cell'}, 5000);
                }

                // Контентная правка одной ячейки → точечный патч блока превью.
                afterTableCellChanged(tableId);
            }

            cellEl.classList.remove('editing');
        };

        const blurHandler = () => {
            finishEditing(false);
        };

        const keydownHandler = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                textarea.removeEventListener('blur', blurHandler);
                textarea.removeEventListener('keydown', keydownHandler);
                finishEditing(false);
            } else if (e.key === 'Enter' && e.shiftKey) {
                e.stopPropagation();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                textarea.removeEventListener('blur', blurHandler);
                textarea.removeEventListener('keydown', keydownHandler);
                finishEditing(true);
            }
        };

        textarea.addEventListener('blur', blurHandler);
        textarea.addEventListener('keydown', keydownHandler);
    }

    /**
     * H5-A: коммитит pending-редактирование ячейки, если оно есть. Используется
     * периодическим автосейвом и перед сохранением (Ctrl+S), чтобы значение из
     * textarea успело попасть в grid[r][c].content состояния до saveState.
     *
     * До M.26 значение ячейки попадало в state только на blur/Enter, поэтому
     * коммит делал textarea.blur() — это синхронно триггерило finishEditing.
     * После M.26 (write-through, cell-write-through.js::applyCellInput пишет в
     * grid[r][c].content на каждый input) содержимое и так уже актуально, но
     * blur всё ещё вызывался из автосейва каждые ~3с и попутно гасил
     * редактирование: finishEditing делает cellEl.textContent = ..., что удаляет
     * textarea из DOM и роняет фокус посреди набора текста пользователем.
     *
     * Коммит теперь недеструктивен: читает textarea.value.trim() и пишет
     * напрямую в grid[row][col].content (тот же гвард !isSpanned, что в
     * finishEditing), не трогая DOM/фокус/классы — textarea остаётся в ячейке,
     * ввод не прерывается.
     *
     * ChangelogTracker здесь намеренно НЕ вызывается — это не окончание правки,
     * а промежуточная синхронизация; реальное завершение (blur/Enter/Escape)
     * по-прежнему проходит через finishEditing. Превью, наоборот, патчится: его
     * освежал ровно тот blur, что убран выше, и без патча предпросмотр отставал
     * бы от ячейки до конца редактирования. Патч трогает только DOM превью —
     * ни textarea, ни фокус он не задевает.
     *
     * @returns {boolean} true если был хотя бы один pending edit
     */
    commitPendingEdit() {
        let committed = false;
        const touchedTables = new Set();
        const editingCells = document.querySelectorAll('#itemsContainer td.editing, #itemsContainer th.editing');
        editingCells.forEach(cell => {
            const textarea = cell.querySelector('textarea');
            if (!textarea) return;
            committed = true;

            const tableId = cell.dataset.tableId;
            const row = parseInt(cell.dataset.row);
            const col = parseInt(cell.dataset.col);
            const table = resolveTable(tableId);

            if (table && table.grid && table.grid[row] && table.grid[row][col]) {
                if (!table.grid[row][col].isSpanned) {
                    table.grid[row][col].content = textarea.value.trim();
                    touchedTables.add(tableId);
                }
            }
        });
        touchedTables.forEach(tableId => afterTableCellChanged(tableId));
        return committed;
    }

    /**
     * H8: проверяет лимит строк таблицы перед вставкой строки.
     * Зеркалит серверную схему (TableSchema.grid max_length) — без фронт-гейта
     * превышение уехало бы на бэк и вернулось 422 при сохранении.
     * @private
     * @param {Object} table - Объект таблицы
     * @returns {boolean} true если вставка разрешена; false — показан warning
     */
    _checkRowLimit(table) {
        const maxRows = getStructureLimits().maxRows;
        if (table.grid.length >= maxRows) {
            Notifications.warning(`Достигнут максимум строк таблицы (${maxRows}). Добавить новую строку нельзя.`);
            return false;
        }
        return true;
    }

    /**
     * H8: проверяет лимит колонок таблицы перед вставкой колонки.
     * Зеркалит серверную схему (validate_grid_dimensions) — без фронт-гейта
     * превышение уехало бы на бэк и вернулось 422 при сохранении.
     * @private
     * @param {Object} table - Объект таблицы
     * @returns {boolean} true если вставка разрешена; false — показан warning
     */
    _checkColumnLimit(table) {
        const maxCols = getStructureLimits().maxCols;
        if (table.grid[0].length >= maxCols) {
            Notifications.warning(`Достигнут максимум колонок таблицы (${maxCols}). Добавить новую колонку нельзя.`);
            return false;
        }
        return true;
    }

    /**
     * tables-7: проверяет, что сетка прямоугольная (все строки одной ширины),
     * прежде чем строить новый ряд по ширине grid[0]. На рваной сетке вставка
     * молча создала бы ряд с несовместимым числом колонок (бэк ответит 422
     * при сохранении) — отказываем с понятной ошибкой ДО мутации grid.
     * @private
     * @param {Object} table - Объект таблицы
     * @returns {boolean} true если вставка разрешена; false — показана ошибка
     */
    _checkGridColumnsConsistent(table) {
        const numCols = table.grid[0].length;
        if (table.grid.every(row => row.length === numCols)) return true;
        Notifications.error('Структура таблицы повреждена: строки содержат разное число колонок. Вставка строки отменена.');
        return false;
    }

    /**
     * Вставляет новую строку выше выбранной ячейки.
     * Учитывает объединенные ячейки и запрещает вставку выше заголовка.
     */
    insertRowAbove() {
        if (this.tableManager.selectedCells.length === 0) return;

        const cell = this.tableManager.selectedCells[0];
        const tableId = cell.dataset.tableId;
        let rowIndex = parseInt(cell.dataset.row);
        const table = resolveTable(tableId);

        // Пустой grid (grid:[]) — легальное персистентное/импортированное состояние;
        // grid[0] в _checkGridColumnsConsistent был бы undefined → TypeError. No-op.
        if (!table || !table.grid || !table.grid.length) return;

        // Лимит размера таблицы (H8)
        if (!this._checkRowLimit(table)) return;

        // Валидация числа колонок нового ряда (tables-7)
        if (!this._checkGridColumnsConsistent(table)) return;

        // КРИТИЧЕСКАЯ ПРОВЕРКА: запрещаем вставку выше заголовка
        const isHeaderRow = table.grid[rowIndex].some(c => c.isHeader === true);
        if (isHeaderRow) {
            Notifications.error('Нельзя добавить строку выше заголовка таблицы');
            return;
        }

        // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: если текущая строка часть объединения с заголовком
        rowIndex = this._findRowStartOfSpan(table, rowIndex);
        const targetRowIsHeader = table.grid[rowIndex].some(c => c.isHeader === true);
        if (targetRowIsHeader) {
            Notifications.error('Нельзя добавить строку выше заголовка таблицы');
            return;
        }

        // Новая строка с пустыми ячейками
        const newRow = [];
        const numCols = table.grid[0].length;

        for (let c = 0; c < numCols; c++) {
            newRow.push({
                content: '',
                isHeader: false,
                colSpan: 1,
                rowSpan: 1,
                originRow: rowIndex,
                originCol: c
            });
        }

        // Вставляем новую строку в grid
        table.grid.splice(rowIndex, 0, newRow);

        // Обновляем originRow для всех ячеек ниже
        for (let r = rowIndex + 1; r < table.grid.length; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                if (table.grid[r][c].originRow !== undefined) {
                    table.grid[r][c].originRow = r;
                }
            }
        }

        // Обновляем rowSpan для ячеек с объединением
        for (let r = 0; r < rowIndex; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned) {
                    const cellEndRow = r + (cellData.rowSpan || 1);
                    if (cellEndRow > rowIndex) {
                        cellData.rowSpan = (cellData.rowSpan || 1) + 1;
                    }
                }
            }
        }

        // Сдвигаем spanOrigin поглощённых ячеек, чьё объединение начинается на
        // вставленной строке или ниже — чтобы spanOrigin продолжал указывать на
        // сдвинувшуюся ведущую ячейку (иначе spanOrigin устаревает).
        this._shiftSpanOriginsForRowInsert(table, rowIndex);

        // Нормализуем поглощённые флаги из геометрии origin-спанов: вставка внутрь
        // объединения в соседней строке могла оставить НЕ-spanned синглтон внутри
        // покрытия (валидаторы его не ловят → молча битый экспорт). Перестроение из
        // range-list поглощает такой синглтон в объемлющее объединение.
        table.grid = applyMergesToGrid(table.grid, gridToMerges(table.grid));

        this.clearSelection();
        afterTableChanged(tableId);
    }

    /**
     * Вставляет новую строку ниже выбранной ячейки.
     * Учитывает объединенные ячейки для корректной вставки.
     */
    insertRowBelow() {
        if (this.tableManager.selectedCells.length === 0) return;

        const cell = this.tableManager.selectedCells[0];
        const tableId = cell.dataset.tableId;
        let rowIndex = parseInt(cell.dataset.row);
        const table = resolveTable(tableId);

        // Пустой grid (grid:[]) — легальное персистентное/импортированное состояние;
        // grid[0] в _checkGridColumnsConsistent был бы undefined → TypeError. No-op.
        if (!table || !table.grid || !table.grid.length) return;

        // Лимит размера таблицы (H8)
        if (!this._checkRowLimit(table)) return;

        // Валидация числа колонок нового ряда (tables-7)
        if (!this._checkGridColumnsConsistent(table)) return;

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

        const newRow = [];
        const numCols = table.grid[0].length;

        for (let c = 0; c < numCols; c++) {
            newRow.push({
                content: '',
                isHeader: false,
                colSpan: 1,
                rowSpan: 1,
                originRow: insertRowIndex,
                originCol: c
            });
        }

        table.grid.splice(insertRowIndex, 0, newRow);

        for (let r = insertRowIndex + 1; r < table.grid.length; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                if (table.grid[r][c].originRow !== undefined) {
                    table.grid[r][c].originRow = r;
                }
            }
        }

        for (let r = 0; r < insertRowIndex; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned) {
                    const cellEndRow = r + (cellData.rowSpan || 1);
                    if (cellEndRow > insertRowIndex) {
                        cellData.rowSpan = (cellData.rowSpan || 1) + 1;
                    }
                }
            }
        }

        // Сдвигаем spanOrigin поглощённых ячеек объединений на/ниже insertRowIndex.
        this._shiftSpanOriginsForRowInsert(table, insertRowIndex);

        // Нормализуем поглощённые флаги из геометрии origin-спанов: вставка внутрь
        // объединения в соседней строке могла оставить НЕ-spanned синглтон внутри
        // покрытия (валидаторы его не ловят → молча битый экспорт). Перестроение из
        // range-list поглощает такой синглтон в объемлющее объединение.
        table.grid = applyMergesToGrid(table.grid, gridToMerges(table.grid));

        this.clearSelection();
        afterTableChanged(tableId);
    }

    /**
     * Вставляет новую колонку слева от выбранной ячейки.
     * Учитывает объединенные ячейки и сохраняет флаг заголовка для новых ячеек.
     */
    insertColumnLeft() {
        if (this.tableManager.selectedCells.length === 0) return;

        const cell = this.tableManager.selectedCells[0];
        const tableId = cell.dataset.tableId;
        let colIndex = parseInt(cell.dataset.col);
        const table = resolveTable(tableId);

        // Пустой grid (grid:[]) — легальное персистентное/импортированное состояние;
        // grid[0] в _checkColumnLimit был бы undefined → TypeError. No-op.
        if (!table || !table.grid || !table.grid.length) return;

        // Проверка protected
        if (table.protected === true) {
            Notifications.error('Структуру этой таблицы нельзя изменять');
            return;
        }

        // Лимит размера таблицы (H8)
        if (!this._checkColumnLimit(table)) return;

        colIndex = this._findColumnStartOfSpan(table, colIndex);

        let headerRowIndex = -1;
        for (let r = 0; r < table.grid.length; r++) {
            if (table.grid[r].some(c => c.isHeader === true)) {
                headerRowIndex = r;
                break;
            }
        }

        for (let r = 0; r < table.grid.length; r++) {
            const isHeaderRow = r === headerRowIndex;
            table.grid[r].splice(colIndex, 0, {
                content: '',
                isHeader: isHeaderRow,
                colSpan: 1,
                rowSpan: 1,
                originRow: r,
                originCol: colIndex
            });
        }

        for (let r = 0; r < table.grid.length; r++) {
            for (let c = colIndex + 1; c < table.grid[r].length; c++) {
                if (table.grid[r][c].originCol !== undefined) {
                    table.grid[r][c].originCol = c;
                }
            }
        }

        for (let r = 0; r < table.grid.length; r++) {
            for (let c = 0; c < colIndex; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned) {
                    const cellEndCol = c + (cellData.colSpan || 1);
                    if (cellEndCol > colIndex) {
                        cellData.colSpan = (cellData.colSpan || 1) + 1;
                    }
                }
            }
        }

        // Сдвигаем spanOrigin поглощённых ячеек объединений на/правее colIndex.
        this._shiftSpanOriginsForColInsert(table, colIndex);

        // Нормализуем поглощённые флаги из геометрии origin-спанов: вставка внутрь
        // объединения в соседней строке могла оставить НЕ-spanned синглтон внутри
        // покрытия (валидаторы его не ловят → молча битый экспорт). Перестроение из
        // range-list поглощает такой синглтон в объемлющее объединение.
        table.grid = applyMergesToGrid(table.grid, gridToMerges(table.grid));

        applyInsertColumnWidth(table, colIndex);
        this.clearSelection();
        afterTableChanged(tableId);
    }

    /**
     * Вставляет новую колонку справа от выбранной ячейки.
     * Учитывает объединенные ячейки и сохраняет флаг заголовка для новых ячеек.
     */
    insertColumnRight() {
        if (this.tableManager.selectedCells.length === 0) return;

        const cell = this.tableManager.selectedCells[0];
        const tableId = cell.dataset.tableId;
        let colIndex = parseInt(cell.dataset.col);
        const table = resolveTable(tableId);

        // Пустой grid (grid:[]) — легальное персистентное/импортированное состояние;
        // grid[0] в _checkColumnLimit был бы undefined → TypeError. No-op.
        if (!table || !table.grid || !table.grid.length) return;

        // Проверка protected
        if (table.protected === true) {
            Notifications.error('Структуру этой таблицы нельзя изменять');
            return;
        }

        // Лимит размера таблицы (H8)
        if (!this._checkColumnLimit(table)) return;

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

        let headerRowIndex = -1;
        for (let r = 0; r < table.grid.length; r++) {
            if (table.grid[r].some(c => c.isHeader === true)) {
                headerRowIndex = r;
                break;
            }
        }

        for (let r = 0; r < table.grid.length; r++) {
            const isHeaderRow = r === headerRowIndex;
            table.grid[r].splice(insertColIndex, 0, {
                content: '',
                isHeader: isHeaderRow,
                colSpan: 1,
                rowSpan: 1,
                originRow: r,
                originCol: insertColIndex
            });
        }

        for (let r = 0; r < table.grid.length; r++) {
            for (let c = insertColIndex + 1; c < table.grid[r].length; c++) {
                if (table.grid[r][c].originCol !== undefined) {
                    table.grid[r][c].originCol = c;
                }
            }
        }

        for (let r = 0; r < table.grid.length; r++) {
            for (let c = 0; c < insertColIndex; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned) {
                    const cellEndCol = c + (cellData.colSpan || 1);
                    if (cellEndCol > insertColIndex) {
                        cellData.colSpan = (cellData.colSpan || 1) + 1;
                    }
                }
            }
        }

        // Сдвигаем spanOrigin поглощённых ячеек объединений на/правее insertColIndex.
        this._shiftSpanOriginsForColInsert(table, insertColIndex);

        // Нормализуем поглощённые флаги из геометрии origin-спанов: вставка внутрь
        // объединения в соседней строке могла оставить НЕ-spanned синглтон внутри
        // покрытия (валидаторы его не ловят → молча битый экспорт). Перестроение из
        // range-list поглощает такой синглтон в объемлющее объединение.
        table.grid = applyMergesToGrid(table.grid, gridToMerges(table.grid));

        applyInsertColumnWidth(table, insertColIndex);
        this.clearSelection();
        afterTableChanged(tableId);
    }

    /**
     * Удаляет выбранную строку из таблицы.
     * Строку, участвующую в объединении (origin внутри строки или
     * spanned-в-неё), НЕ удаляет — возвращает отказ с тем же сообщением,
     * что контекстное меню (семантика «сначала разделить, потом удалять», M.22).
     */
    deleteRow() {
        if (this.tableManager.selectedCells.length === 0) return;

        const cell = this.tableManager.selectedCells[0];
        const tableId = cell.dataset.tableId;
        const rowIndex = parseInt(cell.dataset.row);
        const table = resolveTable(tableId);

        // Пустой grid (grid:[]) — легальное персистентное/импортированное состояние;
        // grid[rowIndex].some(...) ниже был бы чтением undefined → TypeError. No-op.
        if (!table || !table.grid || !table.grid.length) return;

        // Проверка: запрещаем удаление строки заголовков
        const isHeaderRow = table.grid[rowIndex].some(c => c.isHeader === true);
        if (isHeaderRow) {
            return;
        }

        // Проверяем, что в таблице остается хотя бы одна строка данных
        const headerRowCount = table.grid.filter(row => row.some(c => c.isHeader === true)).length;
        if (table.grid.length - headerRowCount <= 1) {
            return;
        }

        // M.22: строку, участвующую в объединении, не удаляем — семантика
        // «сначала разделить, потом удалять» (то же сообщение, что в меню).
        if (this._rowHasAnyMergedCellsStrict(table, rowIndex)) {
            Notifications.error(MSG_ROW_HAS_MERGED_CELLS);
            return;
        }

        // Уменьшаем rowSpan для ячеек, которые охватывают удаляемую строку
        for (let r = 0; r < rowIndex; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned) {
                    const cellEndRow = r + (cellData.rowSpan || 1);
                    if (cellEndRow > rowIndex) {
                        cellData.rowSpan = Math.max(1, (cellData.rowSpan || 1) - 1);
                    }
                }
            }
        }

        // Удаляем строку
        table.grid.splice(rowIndex, 1);

        // Обновляем originRow для всех ячеек ниже
        for (let r = rowIndex; r < table.grid.length; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                if (table.grid[r][c].originRow !== undefined) {
                    table.grid[r][c].originRow = r;
                }
            }
        }

        // Сдвигаем spanOrigin поглощённых ячеек объединений ниже удалённой строки
        // (объединения, покрывавшие rowIndex, отклонены проверкой
        // _rowHasAnyMergedCellsStrict выше).
        this._shiftSpanOriginsForRowDelete(table, rowIndex);

        this.clearSelection();
        afterTableChanged(tableId);
    }

    /**
     * Удаляет выбранную колонку из таблицы.
     * Проверяет минимальное количество колонок и наличие объединенных ячеек.
     */
    deleteColumn() {
        if (this.tableManager.selectedCells.length === 0) return;

        const cell = this.tableManager.selectedCells[0];
        const tableId = cell.dataset.tableId;
        const colIndex = parseInt(cell.dataset.col);
        const table = resolveTable(tableId);

        // Пустой grid (grid:[]) — легальное персистентное/импортированное состояние;
        // grid[0].length ниже был бы чтением undefined → TypeError. No-op.
        if (!table || !table.grid || !table.grid.length) return;

        // Проверка protected
        if (table.protected === true) {
            Notifications.error('Структуру этой таблицы нельзя изменять');
            return;
        }

        // Проверяем минимальное количество колонок
        if (table.grid[0].length <= 1) {
            return;
        }

        // Проверяем наличие объединенных ячеек в колонке
        const hasMergedCells = this._columnHasAnyMergedCells(table, colIndex);
        if (hasMergedCells) {
            return;
        }

        // Уменьшаем colSpan для ячеек, которые охватывают удаляемую колонку
        for (let r = 0; r < table.grid.length; r++) {
            for (let c = 0; c < colIndex; c++) {
                const cellData = table.grid[r][c];
                if (!cellData.isSpanned) {
                    const cellEndCol = c + (cellData.colSpan || 1);
                    if (cellEndCol > colIndex) {
                        cellData.colSpan = Math.max(1, (cellData.colSpan || 1) - 1);
                    }
                }
            }
        }

        // Удаляем колонку из всех строк
        for (let r = 0; r < table.grid.length; r++) {
            table.grid[r].splice(colIndex, 1);
        }

        // Обновляем originCol для всех ячеек справа
        for (let r = 0; r < table.grid.length; r++) {
            for (let c = colIndex; c < table.grid[r].length; c++) {
                if (table.grid[r][c].originCol !== undefined) {
                    table.grid[r][c].originCol = c;
                }
            }
        }

        // Сдвигаем spanOrigin поглощённых ячеек объединений правее удалённой колонки
        // (колонки с объединениями отсекаются проверкой _columnHasAnyMergedCells выше).
        this._shiftSpanOriginsForColDelete(table, colIndex);

        applyRemoveColumnWidth(table, colIndex);
        this.clearSelection();
        afterTableChanged(tableId);
    }

    /**
     * Сдвигает spanOrigin поглощённых ячеек при ВСТАВКЕ колонки на insertIndex.
     * Полный обход грида; гейт — только {isSpanned, spanOrigin}: user-merge ячейки
     * несут лишь эти два поля (без originCol), поэтому гейтить на originCol нельзя.
     * Если ведущая ячейка объединения находилась на/правее insertIndex, она
     * сдвинулась на +1 колонку — обновляем spanOrigin.col синхронно.
     * @private
     * @param {Object} table - Объект таблицы (grid уже изменён вставкой)
     * @param {number} insertIndex - Индекс вставленной колонки
     */
    _shiftSpanOriginsForColInsert(table, insertIndex) {
        for (let r = 0; r < table.grid.length; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                const cellData = table.grid[r][c];
                if (cellData.isSpanned && cellData.spanOrigin) {
                    if (cellData.spanOrigin.col >= insertIndex) {
                        cellData.spanOrigin.col += 1;
                    }
                }
            }
        }
    }

    /**
     * Сдвигает spanOrigin поглощённых ячеек при УДАЛЕНИИ колонки colIndex.
     * Полный обход грида; гейт — только {isSpanned, spanOrigin}. Если ведущая
     * ячейка объединения была правее colIndex, она сдвинулась на -1 колонку.
     * @private
     * @param {Object} table - Объект таблицы (grid уже изменён удалением)
     * @param {number} colIndex - Индекс удалённой колонки
     */
    _shiftSpanOriginsForColDelete(table, colIndex) {
        for (let r = 0; r < table.grid.length; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                const cellData = table.grid[r][c];
                if (cellData.isSpanned && cellData.spanOrigin) {
                    if (cellData.spanOrigin.col > colIndex) {
                        cellData.spanOrigin.col -= 1;
                    }
                }
            }
        }
    }

    /**
     * Сдвигает spanOrigin поглощённых ячеек при ВСТАВКЕ строки на insertIndex.
     * Полный обход грида; гейт — только {isSpanned, spanOrigin}. Если ведущая
     * ячейка объединения находилась на/ниже insertIndex, она сдвинулась на +1 строку.
     * @private
     * @param {Object} table - Объект таблицы (grid уже изменён вставкой)
     * @param {number} insertIndex - Индекс вставленной строки
     */
    _shiftSpanOriginsForRowInsert(table, insertIndex) {
        for (let r = 0; r < table.grid.length; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                const cellData = table.grid[r][c];
                if (cellData.isSpanned && cellData.spanOrigin) {
                    if (cellData.spanOrigin.row >= insertIndex) {
                        cellData.spanOrigin.row += 1;
                    }
                }
            }
        }
    }

    /**
     * Сдвигает spanOrigin поглощённых ячеек при УДАЛЕНИИ строки rowIndex.
     * Полный обход грида; гейт — только {isSpanned, spanOrigin}. Если ведущая
     * ячейка объединения была ниже rowIndex, она сдвинулась на -1 строку.
     * @private
     * @param {Object} table - Объект таблицы (grid уже изменён удалением)
     * @param {number} rowIndex - Индекс удалённой строки
     */
    _shiftSpanOriginsForRowDelete(table, rowIndex) {
        for (let r = 0; r < table.grid.length; r++) {
            for (let c = 0; c < table.grid[r].length; c++) {
                const cellData = table.grid[r][c];
                if (cellData.isSpanned && cellData.spanOrigin) {
                    if (cellData.spanOrigin.row > rowIndex) {
                        cellData.spanOrigin.row -= 1;
                    }
                }
            }
        }
    }

    /**
     * Находит начальную строку для вставки с учетом объединенных ячеек
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
     * Находит начальную колонку для вставки с учетом объединенных ячеек
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
     * Проверяет наличие объединенных ячеек в строке
     * @param {Object} table - Объект таблицы
     * @param {number} rowIndex - Индекс строки
     * @returns {boolean} true если есть объединенные ячейки
     */
    _rowHasAnyMergedCells(table, rowIndex) {
        for (let c = 0; c < table.grid[rowIndex].length; c++) {
            const cellData = table.grid[rowIndex][c];
            if (cellData.isSpanned) continue;
            if ((cellData.rowSpan || 1) > 1 || (cellData.colSpan || 1) > 1) {
                return true;
            }
        }
        return false;
    }

    /**
     * Проверяет участие строки в любом объединении (строгая проверка, M.22):
     * поглощённая ячейка в строке, ведущая со span>1 в строке либо вертикальное
     * объединение из строк выше, доходящее до неё. Зеркало
     * CellContextMenu._rowHasAnyMergedCellsStrict — ядро и меню отказывают
     * по одному и тому же предикату.
     * @param {Object} table - Объект таблицы
     * @param {number} rowIndex - Индекс строки
     * @returns {boolean} true если строка участвует в объединении
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
     * Проверяет наличие объединенных ячеек в колонке
     * @param {Object} table - Объект таблицы
     * @param {number} colIndex - Индекс колонки
     * @returns {boolean} true если есть объединенные ячейки
     */
    _columnHasAnyMergedCells(table, colIndex) {
        for (let r = 0; r < table.grid.length; r++) {
            const cellData = table.grid[r][colIndex];
            if (cellData.isSpanned) continue;
            if ((cellData.rowSpan || 1) > 1 || (cellData.colSpan || 1) > 1) {
                return true;
            }
        }
        return false;
    }

    /**
     * Проверяет возможность объединения ячеек разных типов
     * @param {Object} table - Объект таблицы
     * @param {number} minRow - Минимальный индекс строки
     * @param {number} maxRow - Максимальный индекс строки
     * @param {number} minCol - Минимальный индекс колонки
     * @param {number} maxCol - Максимальный индекс колонки
     * @returns {boolean} true если можно объединять
     */
    _canMergeCellsAcrossTypes(table, minRow, maxRow, minCol, maxCol) {
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

    /**
     * Выделяет ячейку; повторный вызов по уже выбранной — снимает выделение (toggle).
     * Дублей в selectedCells не бывает: раньше безусловный push при повторном
     * Ctrl+клике клал ту же ячейку дважды и ломал счётчик mergeCells (M.14).
     * @param {HTMLElement} cell - DOM-элемент ячейки
     */
    selectCell(cell) {
        const idx = this.tableManager.selectedCells.indexOf(cell);
        if (idx !== -1) {
            // Повторный клик по выбранной ячейке — снимаем выделение и подсветку.
            cell.classList.remove('selected');
            this.tableManager.selectedCells.splice(idx, 1);
        } else {
            cell.classList.add('selected');
            this.tableManager.selectedCells.push(cell);
        }
        AppState.selectedCells = this.tableManager.selectedCells;
    }

    /**
     * Снимает выделение со всех ячеек
     */
    clearSelection() {
        this.tableManager.selectedCells.forEach(cell => cell.classList.remove('selected'));
        this.tableManager.selectedCells = [];
        AppState.selectedCells = [];
    }

    /**
     * Объединяет выбранные ячейки в одну.
     * Проверяет прямоугольность выделения и совместимость типов ячеек.
     */
    mergeCells() {
        if (this.tableManager.selectedCells.length < 2) return;

        const coords = this.tableManager.selectedCells.map(cell => ({
            row: parseInt(cell.dataset.row),
            col: parseInt(cell.dataset.col),
            tableId: cell.dataset.tableId,
            cell: cell
        }));

        const tableId = coords[0].tableId;
        if (!coords.every(c => c.tableId === tableId)) {
            Notifications.error('Можно объединять только ячейки из одной таблицы');
            return;
        }

        const table = resolveTable(tableId);
        if (!table) return;

        // Проверка protected
        if (table.protected === true) {
            Notifications.error('Структуру этой таблицы нельзя изменять');
            return;
        }

        for (let coord of coords) {
            const cellData = table.grid[coord.row][coord.col];
            if (cellData.isSpanned) {
                Notifications.error('Нельзя объединять уже объединенные ячейки. Сначала разделите их.');
                return;
            }
            if (cellData.colSpan > 1 || cellData.rowSpan > 1) {
                Notifications.error('Нельзя объединять ячейки, если среди них есть уже объединенные.');
                return;
            }
        }

        const minRow = Math.min(...coords.map(c => c.row));
        const maxRow = Math.max(...coords.map(c => c.row));
        const minCol = Math.min(...coords.map(c => c.col));
        const maxCol = Math.max(...coords.map(c => c.col));

        const rowspan = maxRow - minRow + 1;
        const colspan = maxCol - minCol + 1;

        const expectedCellsCount = rowspan * colspan;
        if (this.tableManager.selectedCells.length !== expectedCellsCount) {
            Notifications.error('Можно объединять только полную прямоугольную область ячеек');
            return;
        }

        const selectedSet = new Set(coords.map(c => `${c.row}-${c.col}`));
        for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
                if (!selectedSet.has(`${r}-${c}`)) {
                    Notifications.error('Можно объединять только полную прямоугольную область ячеек');
                    return;
                }
            }
        }

        if (!this._canMergeCellsAcrossTypes(table, minRow, maxRow, minCol, maxCol)) {
            Notifications.error('Нельзя объединять ячейки заголовка с ячейками данных');
            return;
        }

        // Грид-математика — в чистом ядре поверх range-list; хранимый формат
        // (ведущая colSpan/rowSpan; поглощённые {isSpanned, spanOrigin}) не меняется.
        const nextGrid = mergeRange(table.grid, minRow, minCol, maxRow, maxCol);

        // Клиентская защита целостности (T6b.6): не коммитим повреждённую сетку.
        // Региональная проверка — окрестность нового объединения, чтобы устаревший
        // spanOrigin-мусор в других частях таблицы не давал ложного отказа.
        const integrity = validateGridRegion(nextGrid, minRow, minCol, maxRow, maxCol);
        if (!integrity.valid) {
            Notifications.error(
                `Объединение отменено: нарушена целостность таблицы — ${integrity.errors[0]}`
            );
            return;
        }
        table.grid = nextGrid;

        this.clearSelection();
        afterTableChanged(tableId);
        Notifications.success('Ячейки объединены');
    }

    /**
     * Разделение объединенной ячейки на отдельные ячейки.
     * Восстанавливает grid-структуру, создавая пустые ячейки на месте spanned.
     * Сохраняет флаг isHeader для ячеек заголовка.
     */
    unmergeCells() {
        if (this.tableManager.selectedCells.length !== 1) return;

        const cell = this.tableManager.selectedCells[0];
        const tableId = cell.dataset.tableId;
        const row = parseInt(cell.dataset.row);
        const col = parseInt(cell.dataset.col);

        const table = resolveTable(tableId);
        if (!table) return;

        // Проверка protected
        if (table.protected === true) {
            Notifications.error('Структуру этой таблицы нельзя изменять');
            return;
        }

        const cellData = table.grid[row][col];

        // Проверка наличия объединения
        if ((cellData.colSpan || 1) <= 1 && (cellData.rowSpan || 1) <= 1) {
            return;
        }

        // Размер разъединяемого прямоугольника — для региональной проверки.
        const rs = cellData.rowSpan || 1;
        const cs = cellData.colSpan || 1;

        // Грид-математика — в чистом ядре поверх range-list; здесь только запись
        // новой сетки в table.grid (симметрично mergeCells).
        const nextGrid = unmergeAt(table.grid, row, col);

        // Клиентская защита целостности (T6b.6): не коммитим повреждённую сетку.
        // Региональная проверка — окрестность разъединённого прямоугольника.
        const integrity = validateGridRegion(nextGrid, row, col, row + rs - 1, col + cs - 1);
        if (!integrity.valid) {
            Notifications.error(
                `Разъединение отменено: нарушена целостность таблицы — ${integrity.errors[0]}`
            );
            return;
        }
        table.grid = nextGrid;

        this.clearSelection();
        afterTableChanged(tableId);
        Notifications.success('Ячейка разъединена');
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.TableCellsOperations = TableCellsOperations;
