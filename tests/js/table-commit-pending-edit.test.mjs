/**
 * commitPendingEdit (H5-A, недеструктивный коммит после M.26).
 *
 * До фикса воронка автосейва дёргала textarea.blur() → finishEditing →
 * cellEl.textContent = ... удалял textarea из DOM и ронял фокус посреди
 * набора текста пользователем (баг «сброс печати через ~3с»). Коммит теперь
 * пишет textarea.value.trim() напрямую в grid[row][col].content, не трогая
 * DOM/фокус/классы — textarea остаётся ребёнком ячейки, ввод не прерывается.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHeaderedGrid } from './_browser-stub.mjs';
import { AppState } from '../../static/js/constructor/state/state-core.js';
import { TableCellsOperations } from '../../static/js/constructor/table/table-cells-operations.js';

const realQuerySelectorAll = document.querySelectorAll;

afterEach(() => {
  document.querySelectorAll = realQuerySelectorAll;
});

/**
 * Фейковая `.editing`-ячейка: textarea внутри, blur() не должен вызываться
 * коммитом — если тест его дёрнет, это сигнал регрессии на старое поведение.
 */
function makeEditingCell(tableId, row, col, value) {
  let blurCalled = false;
  const textarea = {
    value,
    blur() { blurCalled = true; },
  };
  const cell = {
    dataset: { tableId, row: String(row), col: String(col) },
    classList: { contains: (c) => c === 'editing' },
    querySelector: (sel) => (sel === 'textarea' ? textarea : null),
  };
  return { cell, textarea, wasBlurCalled: () => blurCalled };
}

function setup(rows = 2, cols = 1) {
  AppState.tables = {
    t1: {
      id: 't1',
      nodeId: 'n1',
      grid: makeHeaderedGrid(rows, cols),
      colWidths: new Array(cols).fill(100),
      protected: false,
      deletable: true,
    },
  };
  return new TableCellsOperations({ selectedCells: [] });
}

test('commitPendingEdit пишет trimmed-значение в grid', () => {
  const ops = setup();
  const { cell } = makeEditingCell('t1', 1, 0, '  новое значение  ');
  document.querySelectorAll = () => [cell];

  const committed = ops.commitPendingEdit();

  assert.equal(committed, true);
  assert.equal(AppState.tables.t1.grid[1][0].content, 'новое значение');
});

test('commitPendingEdit не вызывает blur — textarea и .editing остаются на месте', () => {
  const ops = setup();
  const { cell, wasBlurCalled } = makeEditingCell('t1', 1, 0, 'текст');
  document.querySelectorAll = () => [cell];

  ops.commitPendingEdit();

  assert.equal(wasBlurCalled(), false, 'blur() не должен вызываться — рвёт фокус/ввод');
  assert.equal(cell.querySelector('textarea') !== null, true, 'textarea остаётся ребёнком ячейки');
  assert.equal(cell.classList.contains('editing'), true, 'класс .editing не снят');
});

test('commitPendingEdit: isSpanned-ячейка не перезаписывается', () => {
  const ops = setup();
  AppState.tables.t1.grid[1][0] = {
    content: 'исходное',
    isHeader: false,
    isSpanned: true,
    colSpan: 1,
    rowSpan: 1,
    originRow: 1,
    originCol: 0,
  };
  const { cell } = makeEditingCell('t1', 1, 0, 'попытка записи');
  document.querySelectorAll = () => [cell];

  ops.commitPendingEdit();

  assert.equal(AppState.tables.t1.grid[1][0].content, 'исходное');
});

test('commitPendingEdit: без .editing-ячеек возвращает false', () => {
  const ops = setup();
  document.querySelectorAll = () => [];

  assert.equal(ops.commitPendingEdit(), false);
});
