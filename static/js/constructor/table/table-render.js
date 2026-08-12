/**
 * Рендер DOM таблицы конструктора (`<table class="editable-table">`).
 *
 * Вынесен из ItemsRenderer, потому что строит таблицу ИЗ САМОЙ ТАБЛИЦЫ, а не
 * из узла дерева: читаются только `{grid, colWidths, protected}`, а id таблицы
 * приходит отдельным параметром. Благодаря этому один и тот же рендер даёт и
 * узловые таблицы (`AppState.tables[id]`), и встроенные таблицы блоков
 * нарушения — с одинаковой разметкой, а значит одинаковыми CSS и машинерией
 * событий (`tableManager.attachEventListenersToContainer`).
 *
 * Обработчики здесь НЕ навешиваются: вызывающая сторона монтирует результат в
 * контейнер и передаёт его в attachEventListenersToContainer.
 */
import { buildColgroup } from './colgroup.js';
import { iterateVisibleCells } from './grid-merges.js';

/**
 * Создаёт DOM-элемент таблицы со всеми строками и ячейками.
 * Применяет стили для защищённых таблиц.
 * @param {Object} table - Данные таблицы ({grid, colWidths, protected})
 * @param {string} tableId - ID таблицы (уходит в dataset ячеек — адрес операций)
 * @returns {HTMLElement} Элемент <table>
 */
export function createTableElement(table, tableId) {
    const tableEl = document.createElement('table');
    tableEl.className = 'editable-table';

    if (table.protected) {
        tableEl.classList.add('protected-table');
    }

    // Проверяем наличие grid
    if (!table.grid || table.grid.length === 0) {
        // Создаем пустую таблицу-заглушку
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.textContent = '[Пустая таблица]';
        td.style.padding = '10px';
        td.style.color = '#999';
        td.style.fontStyle = 'italic';
        tr.appendChild(td);
        tableEl.appendChild(tr);
        return tableEl;
    }

    const numCols = table.grid[0]?.length || 0;

    // colgroup задаёт ширину колонок из colWidths (единый источник истины) —
    // веса → проценты, при table-layout:fixed Word-подобная раскладка.
    tableEl.style.tableLayout = 'fixed';
    tableEl.appendChild(buildColgroup(table.colWidths, numCols));

    table.grid.forEach((rowData, rowIndex) => {
        tableEl.appendChild(_createTableRow(rowData, rowIndex, tableId, numCols));
    });

    return tableEl;
}

/**
 * Создает строку таблицы со всеми ячейками.
 * Пропускает поглощенные ячейки (isSpanned).
 * @param {Array} rowData - Данные строки (массив ячеек)
 * @param {number} rowIndex - Индекс строки
 * @param {string} tableId - ID таблицы
 * @param {number} numCols - Общее количество колонок
 * @returns {HTMLElement} Элемент <tr>
 * @private
 */
function _createTableRow(rowData, rowIndex, tableId, numCols) {
    const tr = document.createElement('tr');

    // Единый обход видимых (не поглощённых) ячеек — общий helper для всех
    // рендереров. Обходим строку как одно-строчную сетку.
    iterateVisibleCells([rowData], (cellData, _r, colIndex) => {
        tr.appendChild(_createTableCell(cellData, rowIndex, colIndex, tableId, numCols));
    });

    return tr;
}

/**
 * Создает ячейку таблицы с обработчиками изменения размера.
 * Добавляет хендлы для изменения ширины колонок.
 * @param {Object} cellData - Данные ячейки
 * @param {number} rowIndex - Индекс строки
 * @param {number} colIndex - Индекс колонки
 * @param {string} tableId - ID таблицы
 * @param {number} numCols - Общее количество колонок
 * @returns {HTMLElement} Элемент <td> или <th>
 * @private
 */
function _createTableCell(cellData, rowIndex, colIndex, tableId, numCols) {
    const cellEl = document.createElement(cellData.isHeader ? 'th' : 'td');
    cellEl.textContent = cellData.content || '';

    // Применяем объединение ячеек
    if (cellData.colSpan > 1) cellEl.colSpan = cellData.colSpan;
    if (cellData.rowSpan > 1) cellEl.rowSpan = cellData.rowSpan;

    // Сохраняем координаты ячейки
    Object.assign(cellEl.dataset, {
        row: rowIndex,
        col: colIndex,
        tableId
    });

    // Добавляем хендл изменения ширины колонки (не для последней колонки)
    const colspan = cellData.colSpan || 1;
    const cellEndCol = colIndex + colspan - 1;
    const isLastColumn = cellEndCol >= numCols - 1;

    if (cellData.isHeader && !isLastColumn) {
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'resize-handle';
        cellEl.appendChild(resizeHandle);
    }

    // Высота строк — auto (как в Word); ручки изменения высоты убраны.

    return cellEl;
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
    window.createTableElement = createTableElement;
}
