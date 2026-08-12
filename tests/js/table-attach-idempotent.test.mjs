/**
 * Идемпотентность attachEventListenersToContainer.
 *
 * Встроенная таблица блока нарушения получает слушателей при СОЗДАНИИ
 * (violation-rendering.js), потому что перерисовка поля блоками идёт мимо
 * ItemsRenderer. Затем те же ячейки попадают в сплошной обход #itemsContainer
 * при полном рендере (ItemsRenderer.renderAll → attachEventListeners) или в
 * пересборку поддерева (updateItem). Без стража на элемент легли бы ДВА
 * набора слушателей: клик выделял бы и тут же снимал выделение (selectCell —
 * toggle), dblclick создавал бы две textarea.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableManager } from '../../static/js/constructor/table/table-core.js';

/** Фейковая ячейка, считающая навешенные слушатели по типам событий. */
function makeCountingCell() {
  const counts = {};
  return {
    counts,
    dataset: { tableId: 't1', row: '0', col: '0' },
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(type) { counts[type] = (counts[type] || 0) + 1; },
  };
}

/** Контейнер, отдающий заданные ячейки и ручки. */
function makeContainer(cells, handles = []) {
  return {
    querySelectorAll: (sel) => (sel === '.resize-handle' ? handles : cells),
  };
}

test('повторный обход того же контейнера не добавляет второй набор слушателей', () => {
  const cell = makeCountingCell();
  const container = makeContainer([cell]);

  tableManager.attachEventListenersToContainer(container);
  const afterFirst = { ...cell.counts };

  tableManager.attachEventListenersToContainer(container);

  assert.deepEqual(cell.counts, afterFirst, 'счётчики слушателей не выросли');
  assert.equal(cell.counts.click, 1);
  assert.equal(cell.counts.dblclick, 1);
  assert.equal(cell.counts.contextmenu, 1);
});

test('ячейка, обслуженная в своём контейнере, пропускается при сплошном обходе родителя', () => {
  const embeddedCell = makeCountingCell();

  // 1) Блок нарушения вешает слушателей на свой host при создании.
  tableManager.attachEventListenersToContainer(makeContainer([embeddedCell]));
  // 2) Полный рендер обходит весь #itemsContainer и видит ту же ячейку.
  const nodeCell = makeCountingCell();
  tableManager.attachEventListenersToContainer(makeContainer([embeddedCell, nodeCell]));

  assert.equal(embeddedCell.counts.click, 1, 'встроенная ячейка обслужена ровно раз');
  assert.equal(nodeCell.counts.click, 1, 'новая ячейка обслужена в том же проходе');
});

test('ручка ресайза тоже обслуживается ровно один раз', () => {
  const handle = { addEventListener(type) { this[type] = (this[type] || 0) + 1; } };
  const container = makeContainer([], [handle]);

  tableManager.attachEventListenersToContainer(container);
  tableManager.attachEventListenersToContainer(container);

  assert.equal(handle.mousedown, 1);
});

test('новые элементы после пересборки таблицы получают слушателей', () => {
  const before = makeCountingCell();
  tableManager.attachEventListenersToContainer(makeContainer([before]));

  // afterTableChanged пересобирает host: старые ячейки выброшены, ячейки новые.
  const after = makeCountingCell();
  tableManager.attachEventListenersToContainer(makeContainer([after]));

  assert.equal(after.counts.click, 1);
});
