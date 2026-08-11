/**
 * Сериализация сетки таблицы в хранимый формат.
 *
 * Живёт в `table/`, а не в state-core, потому что перечисление полей ячейки —
 * это описание ХРАНИМОГО ФОРМАТА таблицы (зеркало `TableCellSchema`,
 * `extra="forbid"`), а не деталь состояния конструктора. Потребителей два —
 * узловые таблицы и встроенные таблицы блоков нарушения (обе ветки в
 * `AppState._serialize*`), и оба обязаны отдавать один и тот же набор ключей.
 *
 * Перечисление ЯВНОЕ и это load-bearing: операции с таблицей вешают на ячейку
 * рантайм-поля, которых в схеме нет (`mergeSnapshot` — снимок содержимого для
 * отката объединения, table-merge-core.js). Отдай ячейку «как есть» — и первое
 * же объединение вернёт 422 на СОХРАНЕНИЕ ВСЕГО АКТА.
 */

/**
 * Сериализует сетку: каждая ячейка — только поля хранимого формата
 * (TableCellSchema), рантайм-поля отбрасываются.
 * @param {Object[][]} grid - Матрица ячеек
 * @returns {Object[][]} Новая матрица с новыми объектами ячеек
 */
export function serializeGrid(grid) {
    if (!Array.isArray(grid)) return [];
    return grid.map(row => (Array.isArray(row) ? row : []).map(cell => ({
        content: cell.content || '',
        isHeader: cell.isHeader || false,
        colSpan: cell.colSpan || 1,
        rowSpan: cell.rowSpan || 1,
        isSpanned: cell.isSpanned || false,
        spanOrigin: cell.spanOrigin || null,
        originRow: cell.originRow,
        originCol: cell.originCol
    })));
}
