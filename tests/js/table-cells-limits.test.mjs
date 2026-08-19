/**
 * H8: фронт-лимит размера таблицы 64×16 в структурных вставках.
 *
 * Тестируются РЕАЛЬНЫЕ методы TableCellsOperations (не реплики): браузерные
 * глобалы стабятся в _browser-stub.mjs (импорт ПЕРВЫМ — порядок load-bearing).
 * Сервер режет превышение 422 (TableSchema: grid max_length=64, строки ≤16
 * колонок) — фронт обязан отказать ДО мутации grid с понятным предупреждением.
 * Источник лимитов — AppConfig.limits.table (единый, синхронен с бэком).
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeCell, makeHeaderedGrid } from './_browser-stub.mjs';
import { AppState } from '../../static/js/constructor/state/state-core.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { Notifications } from '../../static/js/shared/notifications.js';
import { TableCellsOperations } from '../../static/js/constructor/table/table-cells-operations.js';

// Шпион уведомлений: подменяем методы синглтона, копим сообщения.
const shown = { warning: [], error: [], success: [], info: [] };
Notifications.warning = (msg) => shown.warning.push(msg);
Notifications.error = (msg) => shown.error.push(msg);
Notifications.success = (msg) => shown.success.push(msg);
Notifications.info = (msg) => shown.info.push(msg);

/** Создаёт ops с таблицей rows×cols и выбранной ячейкой (row,col). */
function setup(rows, cols, selRow = 1, selCol = 0) {
  const tableManager = { selectedCells: [makeFakeCell('t1', selRow, selCol)] };
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
  AppState.selectedCells = tableManager.selectedCells;
  return { ops: new TableCellsOperations(tableManager), table: AppState.tables.t1 };
}

beforeEach(() => {
  shown.warning.length = 0;
  shown.error.length = 0;
  shown.success.length = 0;
  shown.info.length = 0;
});

// ──────────────────────────────────────────────────────────────────────────
// Источник лимитов: AppConfig.limits.table зеркалит act_content.py.
// ──────────────────────────────────────────────────────────────────────────

test('AppConfig.limits.table: maxRows=64, maxCols=16 (контракт с бэком act_content.py)', () => {
  assert.equal(AppConfig.limits.table.maxRows, 64);
  assert.equal(AppConfig.limits.table.maxCols, 16);
});

test('AppConfig.limits.textblock: fontSize 8-72, база 12 пт (контракт с ACTS__TEXTBLOCKS__)', () => {
  assert.equal(AppConfig.limits.textblock.fontSizeMin, 8);
  assert.equal(AppConfig.limits.textblock.fontSizeMax, 72);
  // Базовый размер текстблока В ПУНКТАХ — зеркало font_size_default: тело акта
  // 12pt, ровно столько же уйдёт в Word.
  assert.equal(AppConfig.limits.textblock.fontSizeDefault, 12);
});

// ──────────────────────────────────────────────────────────────────────────
// Лимит строк: 64 → отказ, 63 → вставка проходит.
// ──────────────────────────────────────────────────────────────────────────

test('insertRowBelow при 64 строках — отказ: grid не изменился, есть предупреждение', () => {
  const { ops, table } = setup(64, 3);
  const before = JSON.parse(JSON.stringify(table.grid));

  ops.insertRowBelow();

  assert.equal(table.grid.length, 64);
  assert.deepEqual(table.grid, before);
  assert.equal(shown.warning.length, 1);
  assert.ok(shown.warning[0].includes('64'), shown.warning[0]);
});

test('insertRowBelow при 63 строках — вставка проходит: 64 строки', () => {
  const { ops, table } = setup(63, 3);

  ops.insertRowBelow();

  assert.equal(table.grid.length, 64);
  assert.equal(shown.warning.length, 0);
});

test('insertRowAbove при 64 строках — отказ: grid не изменился, есть предупреждение', () => {
  const { ops, table } = setup(64, 3, 2);
  const before = JSON.parse(JSON.stringify(table.grid));

  ops.insertRowAbove();

  assert.equal(table.grid.length, 64);
  assert.deepEqual(table.grid, before);
  assert.equal(shown.warning.length, 1);
  assert.ok(shown.warning[0].includes('64'), shown.warning[0]);
});

test('insertRowAbove при 63 строках — вставка проходит: 64 строки', () => {
  const { ops, table } = setup(63, 3, 2);

  ops.insertRowAbove();

  assert.equal(table.grid.length, 64);
  assert.equal(shown.warning.length, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// Лимит колонок: 16 → отказ, 15 → вставка проходит.
// ──────────────────────────────────────────────────────────────────────────

test('insertColumnRight при 16 колонках — отказ: grid не изменился, есть предупреждение', () => {
  const { ops, table } = setup(3, 16);
  const before = JSON.parse(JSON.stringify(table.grid));

  ops.insertColumnRight();

  assert.equal(table.grid[0].length, 16);
  assert.deepEqual(table.grid, before);
  assert.equal(shown.warning.length, 1);
  assert.ok(shown.warning[0].includes('16'), shown.warning[0]);
});

test('insertColumnRight при 15 колонках — вставка проходит: 16 колонок', () => {
  const { ops, table } = setup(3, 15);

  ops.insertColumnRight();

  assert.equal(table.grid[0].length, 16);
  assert.equal(shown.warning.length, 0);
});

test('insertColumnLeft при 16 колонках — отказ: grid не изменился, есть предупреждение', () => {
  const { ops, table } = setup(3, 16);
  const before = JSON.parse(JSON.stringify(table.grid));

  ops.insertColumnLeft();

  assert.equal(table.grid[0].length, 16);
  assert.deepEqual(table.grid, before);
  assert.equal(shown.warning.length, 1);
  assert.ok(shown.warning[0].includes('16'), shown.warning[0]);
});

test('insertColumnLeft при 15 колонках — вставка проходит: 16 колонок', () => {
  const { ops, table } = setup(3, 15);

  ops.insertColumnLeft();

  assert.equal(table.grid[0].length, 16);
  assert.equal(shown.warning.length, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// FINDING 9: пустой grid (grid:[]) — легальное персистентное/импортированное
// состояние. Раньше guard `if (!table || !table.grid) return;` пропускал
// truthy []-массив, а grid[0] в _checkGridColumnsConsistent/_checkColumnLimit
// и в deleteColumn/deleteRow был undefined → TypeError. Расширенный guard
// (`|| !table.grid.length`) делает тихий no-op: без throw, без мутации, без
// уведомления.
// ──────────────────────────────────────────────────────────────────────────

/** ops с таблицей пустого grid:[] и фейковой выбранной ячейкой. */
function setupEmptyGrid() {
  const tableManager = { selectedCells: [makeFakeCell('t1', 0, 0)] };
  AppState.tables = {
    t1: {
      id: 't1',
      nodeId: 'n1',
      grid: [],
      colWidths: [],
      protected: false,
      deletable: true,
    },
  };
  AppState.selectedCells = tableManager.selectedCells;
  return { ops: new TableCellsOperations(tableManager), table: AppState.tables.t1 };
}

for (const method of ['insertRowAbove', 'insertRowBelow', 'insertColumnLeft', 'insertColumnRight']) {
  test(`${method} на пустом grid:[] — нет throw, grid остаётся [], нет уведомления`, () => {
    const { ops, table } = setupEmptyGrid();

    assert.doesNotThrow(() => ops[method]());

    assert.deepEqual(table.grid, []);
    assert.equal(shown.warning.length, 0);
    assert.equal(shown.error.length, 0);
    assert.equal(shown.success.length, 0);
    assert.equal(shown.info.length, 0);
  });
}

test('deleteColumn на пустом grid:[] — нет throw, grid остаётся [], нет уведомления', () => {
  const { ops, table } = setupEmptyGrid();

  assert.doesNotThrow(() => ops.deleteColumn());

  assert.deepEqual(table.grid, []);
  assert.equal(shown.warning.length, 0);
  assert.equal(shown.error.length, 0);
  assert.equal(shown.success.length, 0);
  assert.equal(shown.info.length, 0);
});

test('deleteRow на пустом grid:[] — нет throw, grid остаётся [], нет уведомления', () => {
  const { ops, table } = setupEmptyGrid();

  assert.doesNotThrow(() => ops.deleteRow());

  assert.deepEqual(table.grid, []);
  assert.equal(shown.warning.length, 0);
  assert.equal(shown.error.length, 0);
  assert.equal(shown.success.length, 0);
  assert.equal(shown.info.length, 0);
});
