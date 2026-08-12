/**
 * Полная машинерия таблиц над ВСТРОЕННОЙ таблицей блока нарушения.
 *
 * Смысл теста: `TableCellsOperations` — тот же самый код, что обслуживает
 * узловые таблицы; отличается только адрес (`vt::…`), который разрешает
 * `resolveTable`. Значит все гейты (лимиты строк/колонок, отказ удалять
 * заголовок, запрет удалять строку с объединениями) обязаны работать и здесь,
 * а записи — попадать в `violation[field].blocks[].table`, а не в
 * `AppState.tables`.
 *
 * Браузерные глобалы — из _browser-stub.mjs (импорт ПЕРВЫМ, порядок
 * load-bearing). Уведомления — шпион на синглтоне, как в table-cells-limits.
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeCell, makeHeaderedGrid } from './_browser-stub.mjs';
import { AppState } from '../../static/js/constructor/state/state-core.js';
import { Notifications } from '../../static/js/shared/notifications.js';
import { TableCellsOperations } from '../../static/js/constructor/table/table-cells-operations.js';
import { makeEmbeddedTableId } from '../../static/js/constructor/table/table-store.js';

const VID = 'violation_1';
const FIELD = 'codeMining';
const BID = 'table_1_abc';
const TABLE_ID = makeEmbeddedTableId(VID, FIELD, BID);

// Шпион уведомлений: подменяем методы синглтона, копим сообщения.
const shown = { warning: [], error: [], success: [], info: [] };
Notifications.warning = (msg) => shown.warning.push(msg);
Notifications.error = (msg) => shown.error.push(msg);
Notifications.success = (msg) => shown.success.push(msg);
Notifications.info = (msg) => shown.info.push(msg);

/**
 * Готовит нарушение с табличным блоком rows×cols и выбранной ячейкой (row,col).
 * @returns {{ops: TableCellsOperations, table: Object}}
 */
function setup(rows, cols, selRow = 1, selCol = 0) {
  const tableManager = { selectedCells: [makeFakeCell(TABLE_ID, selRow, selCol)] };
  AppState.tables = {};
  AppState.violations = {
    [VID]: {
      id: VID,
      nodeId: 'n1',
      [FIELD]: {
        enabled: true,
        blocks: [{
          id: BID,
          type: 'table',
          table: { grid: makeHeaderedGrid(rows, cols), colWidths: new Array(cols).fill(100) },
        }],
      },
    },
  };
  AppState.selectedCells = tableManager.selectedCells;
  return {
    ops: new TableCellsOperations(tableManager),
    table: AppState.violations[VID][FIELD].blocks[0].table,
  };
}

beforeEach(() => {
  shown.warning.length = 0;
  shown.error.length = 0;
  shown.success.length = 0;
  shown.info.length = 0;
});

// ──────────────────────────────────────────────────────────────────────────
// Записи идут в модель нарушения, а не в AppState.tables.
// ──────────────────────────────────────────────────────────────────────────

test('insertRowBelow пишет строку в table блока нарушения (AppState.tables не трогается)', () => {
  const { ops, table } = setup(3, 3);

  ops.insertRowBelow();

  assert.equal(table.grid.length, 4);
  assert.equal(AppState.violations[VID][FIELD].blocks[0].table.grid.length, 4);
  assert.deepEqual(AppState.tables, {});
});

test('insertColumnRight расширяет сетку и веса колонок встроенной таблицы', () => {
  const { ops, table } = setup(3, 3);

  ops.insertColumnRight();

  assert.equal(table.grid[0].length, 4);
  assert.ok(table.grid.every(row => row.length === 4));
  assert.equal(table.colWidths.length, 4);
});

test('deleteColumn сужает сетку и веса колонок встроенной таблицы', () => {
  const { ops, table } = setup(3, 3);

  ops.deleteColumn();

  assert.equal(table.grid[0].length, 2);
  assert.equal(table.colWidths.length, 2);
});

// ──────────────────────────────────────────────────────────────────────────
// Лимиты (H8) — те же, что у узловых таблиц: 64 строки / 16 колонок.
// ──────────────────────────────────────────────────────────────────────────

test('insertRowBelow при 64 строках — отказ с предупреждением, сетка не изменилась', () => {
  const { ops, table } = setup(64, 3);
  const before = JSON.parse(JSON.stringify(table.grid));

  ops.insertRowBelow();

  assert.equal(table.grid.length, 64);
  assert.deepEqual(table.grid, before);
  assert.equal(shown.warning.length, 1);
  assert.ok(shown.warning[0].includes('64'), shown.warning[0]);
});

test('insertRowAbove при 64 строках — отказ с предупреждением', () => {
  const { ops, table } = setup(64, 3, 2);

  ops.insertRowAbove();

  assert.equal(table.grid.length, 64);
  assert.equal(shown.warning.length, 1);
  assert.ok(shown.warning[0].includes('64'), shown.warning[0]);
});

test('insertColumnRight при 16 колонках — отказ с предупреждением', () => {
  const { ops, table } = setup(3, 16);

  ops.insertColumnRight();

  assert.equal(table.grid[0].length, 16);
  assert.equal(shown.warning.length, 1);
  assert.ok(shown.warning[0].includes('16'), shown.warning[0]);
});

test('insertColumnLeft при 16 колонках — отказ с предупреждением', () => {
  const { ops, table } = setup(3, 16);

  ops.insertColumnLeft();

  assert.equal(table.grid[0].length, 16);
  assert.equal(shown.warning.length, 1);
  assert.ok(shown.warning[0].includes('16'), shown.warning[0]);
});

test('вставка проходит на границе лимита (63 строки / 15 колонок) без предупреждений', () => {
  const rows = setup(63, 3);
  rows.ops.insertRowBelow();
  assert.equal(rows.table.grid.length, 64);

  const cols = setup(3, 15);
  cols.ops.insertColumnRight();
  assert.equal(cols.table.grid[0].length, 16);

  assert.equal(shown.warning.length, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// Структурные гейты заголовка и объединений — тоже общие.
// ──────────────────────────────────────────────────────────────────────────

test('insertRowAbove по строке-заголовку — отказ с ошибкой', () => {
  const { ops, table } = setup(3, 3, 0, 0);

  ops.insertRowAbove();

  assert.equal(table.grid.length, 3);
  assert.ok(shown.error.some(m => m.includes('выше заголовка')), shown.error.join('|'));
});

test('deleteRow не удаляет строку заголовков', () => {
  const { ops, table } = setup(4, 3, 0, 0);

  ops.deleteRow();

  assert.equal(table.grid.length, 4);
});

test('deleteRow не удаляет строку с объединёнными ячейками (нужно сначала разъединить)', () => {
  const { ops, table } = setup(4, 3, 1, 0);
  table.grid[1][0].colSpan = 2;
  table.grid[1][1] = { isSpanned: true, spanOrigin: { row: 1, col: 0 } };

  ops.deleteRow();

  assert.equal(table.grid.length, 4);
  assert.ok(shown.error.some(m => m.includes('объединенные')), shown.error.join('|'));
});

// ──────────────────────────────────────────────────────────────────────────
// Объединение/разъединение — во встроенной таблице доступны полностью.
// ──────────────────────────────────────────────────────────────────────────

test('mergeCells объединяет ячейки встроенной таблицы, unmergeCells возвращает обратно', () => {
  const { ops, table } = setup(3, 3, 1, 0);
  ops.tableManager.selectedCells = [
    makeFakeCell(TABLE_ID, 1, 0),
    makeFakeCell(TABLE_ID, 1, 1),
  ];

  ops.mergeCells();

  assert.equal(table.grid[1][0].colSpan, 2);
  assert.equal(table.grid[1][1].isSpanned, true);
  assert.ok(shown.success.some(m => m.includes('объединены')), shown.success.join('|'));

  ops.tableManager.selectedCells = [makeFakeCell(TABLE_ID, 1, 0)];
  ops.unmergeCells();

  assert.equal(table.grid[1][0].colSpan, 1);
  assert.ok(!table.grid[1][1].isSpanned);
});
