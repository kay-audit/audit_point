/**
 * Стабы браузерных глобалов для импорта РЕАЛЬНЫХ модулей конструктора в node:test.
 *
 * Граф импорта table-cells-operations.js тянет DOM-зависимые модули
 * (ItemsRenderer, PreviewManager, Notifications, state-core), у которых на
 * module-level только `window.X = X` и `new NotificationManager()` →
 * document.querySelector/createElement/appendChild. Достаточно минимальных
 * заглушек window/document; Proxy-трекинг AppState НЕ активируется
 * (_initStateTracking вызывается только из entries/constructor.js).
 *
 * ВАЖНО: этот модуль должен идти ПЕРВЫМ в списке import'ов тест-файла —
 * ESM исполняет модули в порядке объявления, и глобалы появятся до
 * исполнения module-level кода модулей приложения.
 *
 * Здесь НЕТ импортов модулей приложения (иначе hoisting исполнил бы их
 * раньше установки глобалов).
 */

function makeStubElement(tag) {
  return {
    // Тег заглушка помнит: часть рендеров выбирает его по данным (уровень
    // заголовка пункта в PreviewManager._renderHeading), и проверить это
    // иначе нечем.
    tagName: String(tag || '').toUpperCase(),
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    remove() {},
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    textContent: '',
    innerHTML: '',
  };
}

globalThis.window = globalThis;
globalThis.document = {
  createElement: (tag) => makeStubElement(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  body: makeStubElement(),
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
// PreviewManager.update планирует рендер через RAF; в тестах рендер не нужен.
globalThis.requestAnimationFrame = () => 0;

/**
 * Фейковая DOM-ячейка для tableManager.selectedCells: ровно те поля, которые
 * читает TableCellsOperations (dataset.tableId/row/col) и красит выделение
 * (classList add/remove/contains 'selected').
 *
 * @param {string} tableId ID таблицы.
 * @param {number} row Индекс строки.
 * @param {number} col Индекс колонки.
 * @returns {Object} Объект-ячейка с dataset и трекающим classList.
 */
export function makeFakeCell(tableId, row, col) {
  const classes = new Set();
  return {
    dataset: { tableId, row: String(row), col: String(col) },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

/**
 * Сетка rows×cols: первая строка — заголовок, остальные — данные.
 *
 * @param {number} rows Всего строк (включая заголовок).
 * @param {number} cols Число колонок.
 * @returns {Object[][]} Двумерный массив ячеек в хранимом формате.
 */
export function makeHeaderedGrid(rows, cols) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({
        content: r === 0 ? `H${c}` : `${r}:${c}`,
        isHeader: r === 0,
        colSpan: 1,
        rowSpan: 1,
        originRow: r,
        originCol: c,
      });
    }
    grid.push(row);
  }
  return grid;
}
