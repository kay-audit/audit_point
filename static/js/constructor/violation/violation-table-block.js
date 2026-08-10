/**
 * Блок-таблица поля нарушения: встроенный редактор обычной таблицы.
 *
 * Тонкий редактор НА ТЕХ ЖЕ операциях, что таблицы конструктора (решение
 * задокументировано в журнале блочной модели): полная машинерия table/
 * адресует таблицы через AppState.tables[tableId] и узлы дерева — встроенная
 * таблица живёт в violation.<field>.blocks[].table и в AppState.tables не
 * попадает. Переиспользуются ЧИСТЫЕ хелперы: colgroup.js (рендер ширин),
 * col-widths.js (веса колонок: insert/remove/percents/px→веса),
 * grid-merges.js (обход видимых ячеек — сетка с colSpan/rowSpan из
 * скопированных таблиц рендерится честно).
 *
 * Возможности v1: dblclick-редактирование ячейки (textarea, write-through
 * per-keystroke через мутатор setTableCell; Enter/blur — конец, Escape —
 * откат), добавление/удаление строк и столбцов, resize колонок мышью
 * (как у таблиц конструктора: живой px-drag → фиксация целыми весами
 * colWidths). Объединение ячеек в v1 не редактируется (существующие
 * span'ы скопированной таблицы отображаются корректно). Подвиды
 * metrics/risk, пины и каскады к встроенным таблицам не применяются.
 *
 * Все записи в модель — через мутаторы (setTableCell / setBlockField
 * с attr 'table'): requireWrite-guard + превью (violation-mutations.js).
 */
import { buildColgroup } from '../table/colgroup.js';
import {
    applyInsertColumnWidth,
    applyRemoveColumnWidth,
    pixelWidthsToWeights,
} from '../table/col-widths.js';
import { iterateVisibleCells } from '../table/grid-merges.js';

/** Дефолтная сетка новой встроенной таблицы: шапка + одна строка данных. */
const DEFAULT_ROWS = 2;
const DEFAULT_COLS = 2;

/**
 * Пустая ячейка сетки (хранимый формат TableCellSchema, только нужные ключи —
 * бэк-схема дозаполняет дефолтами при валидации).
 * @param {boolean} [isHeader]
 * @returns {Object}
 */
function makeCell(isHeader = false) {
    return isHeader ? { content: '', isHeader: true } : { content: '' };
}

/**
 * Дозаполняет пустую сетку дефолтной (2×2, первая строка — шапка).
 * Мутирует table на месте; непустую сетку не трогает.
 * @param {Object} table - Сетка блока ({grid, colWidths})
 * @returns {boolean} true — сетка была инициализирована
 */
export function ensureDefaultGrid(table) {
    if (Array.isArray(table.grid) && table.grid.length > 0) return false;
    table.grid = [];
    for (let r = 0; r < DEFAULT_ROWS; r++) {
        const row = [];
        for (let c = 0; c < DEFAULT_COLS; c++) {
            row.push(makeCell(r === 0));
        }
        table.grid.push(row);
    }
    table.colWidths = new Array(DEFAULT_COLS).fill(100);
    return true;
}

/**
 * Структурные операции над сеткой (чистые мутации table на месте; лимиты
 * строк/колонок сверяются вызывающим кодом с /limits — здесь только нижняя
 * граница «не меньше 1×1»). Возвращают true при реальном изменении.
 */
export const tableStructureOps = {
    addRow(table) {
        const cols = table.grid[0]?.length || 0;
        if (!cols) return false;
        table.grid.push(Array.from({ length: cols }, () => makeCell(false)));
        return true;
    },
    removeRow(table) {
        // Шапку (первую строку) последней не удаляем — минимум 1 строка.
        if (table.grid.length <= 1) return false;
        table.grid.pop();
        return true;
    },
    addColumn(table) {
        if (!table.grid.length) return false;
        const index = table.grid[0].length;
        table.grid.forEach((row, r) => row.push(makeCell(r === 0 && !!row[0]?.isHeader)));
        applyInsertColumnWidth(table, index);
        return true;
    },
    removeColumn(table) {
        const cols = table.grid[0]?.length || 0;
        if (cols <= 1) return false;
        const index = cols - 1;
        table.grid.forEach(row => row.splice(index, 1));
        applyRemoveColumnWidth(table, index);
        return true;
    },
};

/**
 * Создаёт DOM встроенного редактора блока-таблицы.
 *
 * @param {Object} params
 * @param {Object} params.violation - Объект нарушения (модель)
 * @param {string} params.fieldKey - Ключ поля реестра
 * @param {Object} params.block - Блок типа 'table' ({id, type, table})
 * @param {Object} params.manager - ViolationManager (мутаторы setTableCell/setBlockField)
 * @param {boolean} [params.isReadOnly]
 * @returns {HTMLElement} Корневой элемент блока-таблицы
 */
export function createTableBlockElement({ violation, fieldKey, block, manager, isReadOnly = false }) {
    const root = document.createElement('div');
    root.className = 'violation-table-block';
    root.dataset.blockId = block.id;

    if (!isReadOnly && ensureDefaultGrid(block.table)) {
        // Инициализация дефолтной сетки — дискретная запись в модель.
        manager.setBlockField(violation, fieldKey, block.id, 'table', block.table);
    }

    const rerender = () => {
        root.innerHTML = '';
        root.appendChild(_buildTable());
        if (!isReadOnly) root.appendChild(_buildToolbar());
    };

    /** Фиксирует структурную правку: запись в модель + перерисовка. */
    const commitStructure = (mutate) => {
        if (!mutate(block.table)) return;
        if (!manager.setBlockField(violation, fieldKey, block.id, 'table', block.table)) return;
        rerender();
    };

    function _buildTable() {
        const wrap = document.createElement('div');
        wrap.className = 'violation-table-block-scroll';
        const tableEl = document.createElement('table');
        tableEl.className = 'violation-embedded-table';
        tableEl.style.tableLayout = 'fixed';

        const grid = block.table.grid || [];
        const numCols = grid[0]?.length || 0;
        tableEl.appendChild(buildColgroup(block.table.colWidths, numCols));

        // Обход видимых ячеек — общий с превью/рендером таблиц (grid-merges):
        // сетка со span'ами из скопированной таблицы отображается честно.
        const rowEls = grid.map(() => document.createElement('tr'));
        iterateVisibleCells(grid, (cell, row, col) => {
            const cellEl = document.createElement(cell.isHeader ? 'th' : 'td');
            cellEl.textContent = cell.content || '';
            cellEl.dataset.row = String(row);
            cellEl.dataset.col = String(col);
            if (cell.colSpan > 1) cellEl.colSpan = cell.colSpan;
            if (cell.rowSpan > 1) cellEl.rowSpan = cell.rowSpan;
            if (!isReadOnly) {
                cellEl.addEventListener('dblclick', () => _startEditing(cellEl, row, col));
                _attachResizeHandle(cellEl, col);
            }
            rowEls[row].appendChild(cellEl);
        });
        rowEls.forEach(tr => {
            if (tr.childNodes.length) tableEl.appendChild(tr);
        });

        wrap.appendChild(tableEl);
        return wrap;
    }

    /** dblclick-редактирование: textarea во всю ячейку, write-through на input. */
    function _startEditing(cellEl, row, col) {
        if (cellEl.querySelector('textarea')) return;
        const original = block.table.grid[row][col].content || '';
        const textarea = document.createElement('textarea');
        textarea.className = 'violation-embedded-table-cell-input';
        textarea.value = original;
        cellEl.textContent = '';
        cellEl.appendChild(textarea);
        textarea.focus();
        textarea.select();

        const finish = (commit) => {
            const value = commit ? textarea.value.trim() : original;
            manager.setTableCell(violation, fieldKey, block.id, row, col, value);
            cellEl.textContent = value;
        };

        textarea.addEventListener('input', () => {
            manager.setTableCell(violation, fieldKey, block.id, row, col, textarea.value);
        });
        textarea.addEventListener('blur', () => finish(true));
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                textarea.blur();
            } else if (e.key === 'Escape') {
                e.stopPropagation();
                // Откат к значению на момент начала ввода.
                textarea.value = original;
                finish(false);
            }
        });
    }

    /** Ручка resize на правой границе ячейки (как у таблиц конструктора). */
    function _attachResizeHandle(cellEl, col) {
        const numCols = block.table.grid[0]?.length || 0;
        if (col >= numCols - 1) return; // у последней колонки правой ручки нет
        const handle = document.createElement('div');
        handle.className = 'resize-handle violation-table-resize-handle';
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            _startColumnResize(e, col);
        });
        cellEl.style.position = 'relative';
        cellEl.appendChild(handle);
    }

    /**
     * Живой px-drag границы: меняем ширины пары соседних колонок, на mouseup
     * фиксируем ВСЕ фактические px как целые веса colWidths
     * (pixelWidthsToWeights — тот же приём, что у TableSizes).
     */
    function _startColumnResize(e, col) {
        const tableEl = root.querySelector('table');
        const colEls = Array.from(tableEl.querySelectorAll('col'));
        if (colEls.length < 2) return;
        const startX = e.clientX;
        const startPx = colEls.map(c => c.getBoundingClientRect().width);
        const MIN_PX = 24;

        const onMove = (ev) => {
            const delta = ev.clientX - startX;
            const left = Math.max(MIN_PX, startPx[col] + delta);
            const right = Math.max(MIN_PX, startPx[col + 1] - delta);
            colEls[col].style.width = `${left}px`;
            colEls[col + 1].style.width = `${right}px`;
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const finalPx = colEls.map(c => c.getBoundingClientRect().width);
            commitStructure((table) => {
                table.colWidths = pixelWidthsToWeights(finalPx);
                return true;
            });
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    function _buildToolbar() {
        const bar = document.createElement('div');
        bar.className = 'violation-table-block-toolbar';
        const buttons = [
            ['+ Строка', () => tableStructureOps.addRow],
            ['− Строка', () => tableStructureOps.removeRow],
            ['+ Столбец', () => tableStructureOps.addColumn],
            ['− Столбец', () => tableStructureOps.removeColumn],
        ];
        for (const [label, opFactory] of buttons) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'violation-table-block-btn';
            btn.textContent = label;
            btn.addEventListener('click', () => commitStructure(opFactory()));
            bar.appendChild(btn);
        }
        return bar;
    }

    rerender();
    return root;
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
    window.createTableBlockElement = createTableBlockElement;
}
