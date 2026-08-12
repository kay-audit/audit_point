/**
 * Write-through ввода в ячейку таблицы (M.26).
 *
 * Значение из textarea редактируемой ячейки пишется в
 * table.grid[row][col].content на каждый input, а не только на blur/Enter.
 * Состояние — единственный источник истины: чтения DOM перед сохранением
 * больше нет. Таблица приходит уже разрешённой (resolveTable) — модуль не знает
 * ни про AppState, ни про то, узловая она или встроенная в блок нарушения.
 *
 * Отмена редактирования (Escape) откатывает состояние к значению на момент
 * первого ввода сессии. Ключ сессии — элемент textarea (в проде хранилище
 * исходников — WeakMap, в тестах подойдёт обычный Map).
 */

/**
 * Возвращает редактируемую (не поглощённую объединением) ячейку грида
 * по координатам или null, если координаты невалидны.
 * @param {Object} table - Объект таблицы (уже разрешённый resolveTable)
 * @param {number} row - Индекс строки
 * @param {number} col - Индекс колонки
 * @returns {Object|null}
 */
function getEditableCell(table, row, col) {
    const cell = table?.grid?.[row]?.[col];
    return cell && !cell.isSpanned ? cell : null;
}

/**
 * Пишет значение ввода в ячейку состояния. При первом вводе сессии запоминает
 * исходное значение ячейки для возможного отката по Escape.
 * @param {Object} table - Объект таблицы (уже разрешённый resolveTable)
 * @param {number} row - Индекс строки
 * @param {number} col - Индекс колонки
 * @param {string} value - Текущее значение textarea
 * @param {WeakMap|Map} originals - Хранилище исходных значений сессий
 * @param {Object} sessionKey - Ключ сессии редактирования (элемент textarea)
 * @returns {boolean} true, если запись в состояние выполнена
 */
export function applyCellInput(table, row, col, value, originals, sessionKey) {
    const cell = getEditableCell(table, row, col);
    if (!cell) return false;
    if (!originals.has(sessionKey)) {
        originals.set(sessionKey, cell.content);
    }
    cell.content = value;
    return true;
}

/**
 * Откатывает отменённое редактирование (Escape): восстанавливает исходное
 * значение сессии в состоянии и забывает сессию.
 * @param {Object} table - Объект таблицы (уже разрешённый resolveTable)
 * @param {number} row - Индекс строки
 * @param {number} col - Индекс колонки
 * @param {WeakMap|Map} originals - Хранилище исходных значений сессий
 * @param {Object} sessionKey - Ключ сессии редактирования (элемент textarea)
 * @returns {boolean} true, если откат выполнен
 */
export function cancelCellInput(table, row, col, originals, sessionKey) {
    if (!originals.has(sessionKey)) return false;
    const original = originals.get(sessionKey);
    originals.delete(sessionKey);
    const cell = getEditableCell(table, row, col);
    if (!cell) return false;
    cell.content = original;
    return true;
}
