/**
 * serializeGrid: отсечение рантайм-полей ячейки в ОБОИХ путях сериализации.
 *
 * Почему это блокирующий инвариант: `mergeRange` вешает на ведущую ячейку
 * рантайм-снимок `mergeSnapshot` (нужен откату при разъединении), а серверная
 * `TableCellSchema` объявлена с `extra="forbid"`. Пока встроенные таблицы
 * нарушений сериализовались ПО ССЫЛКЕ, первое же объединение ячеек в блоке
 * нарушения отбило бы сохранение ВСЕГО акта 422. Теперь оба пути
 * (`_serializeTables` и `_serializeViolations`) идут через один serializeGrid.
 *
 * Пин допустимого набора ключей ячейки — ниже: расхождение с бэком ловится
 * здесь, а не на проде.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppState } from '../../static/js/constructor/state/state-core.js';
import { serializeGrid } from '../../static/js/constructor/table/table-serialize.js';
import { mergeRange } from '../../static/js/constructor/table/table-merge-core.js';
import { makeGrid } from './_setup.mjs';

/** Ключи ячейки, разрешённые схемой TableCellSchema (extra="forbid"). */
const CELL_KEYS = [
  'content', 'isHeader', 'colSpan', 'rowSpan',
  'isSpanned', 'spanOrigin', 'originRow', 'originCol',
];

/** Сетка 2×2 после объединения верхней строки — на ведущей висит mergeSnapshot. */
function makeMergedGrid() {
  const grid = mergeRange(makeGrid(2, 2), 0, 0, 0, 1);
  assert.ok(grid[0][0].mergeSnapshot, 'предусловие: mergeRange повесил снимок');
  return grid;
}

// ──────────────────────────────────────────────────────────────────────────
// Чистая функция.
// ──────────────────────────────────────────────────────────────────────────

test('serializeGrid отдаёт ровно ключи хранимого формата и отбрасывает рантайм-поля', () => {
  const out = serializeGrid(makeMergedGrid());

  for (const row of out) {
    for (const cell of row) {
      assert.deepEqual(Object.keys(cell).sort(), [...CELL_KEYS].sort());
    }
  }
});

test('serializeGrid сохраняет значения объединения (colSpan/isSpanned/spanOrigin)', () => {
  const out = serializeGrid(makeMergedGrid());

  assert.equal(out[0][0].colSpan, 2);
  assert.equal(out[0][1].isSpanned, true);
  assert.deepEqual(out[0][1].spanOrigin, { row: 0, col: 0 });
});

test('serializeGrid не мутирует исходник и не падает на мусоре', () => {
  const grid = makeMergedGrid();
  serializeGrid(grid);
  assert.ok(grid[0][0].mergeSnapshot, 'исходная сетка осталась с рантайм-снимком');

  assert.deepEqual(serializeGrid(undefined), []);
  assert.deepEqual(serializeGrid([]), []);
  assert.deepEqual(serializeGrid([null]), [[]]);
});

// ──────────────────────────────────────────────────────────────────────────
// Путь 1: узловые таблицы.
// ──────────────────────────────────────────────────────────────────────────

test('_serializeTables: после объединения ячеек payload узловой таблицы без mergeSnapshot', () => {
  AppState.tables = {
    t1: { id: 't1', nodeId: 'n1', grid: makeMergedGrid(), colWidths: [100, 100] },
  };

  const payload = AppState._serializeTables();

  assert.equal(JSON.stringify(payload).includes('mergeSnapshot'), false);
  assert.deepEqual(Object.keys(payload.t1.grid[0][0]).sort(), [...CELL_KEYS].sort());
});

// ──────────────────────────────────────────────────────────────────────────
// Путь 2: встроенные таблицы блоков нарушения (тот самый блокирующий баг).
// ──────────────────────────────────────────────────────────────────────────

/** Нарушение с одним табличным блоком, сетка — уже объединённая. */
function setupViolationWithMergedTable() {
  AppState.violations = {
    v1: {
      id: 'v1',
      nodeId: 'n1',
      fieldOrder: null,
      codeMining: {
        enabled: true,
        blocks: [
          { id: 'text_0', type: 'text', content: '<p>текст</p>' },
          { id: 'tbl_0', type: 'table', table: { grid: makeMergedGrid(), colWidths: [100, 100] } },
        ],
      },
    },
  };
}

test('_serializeViolations: после объединения ячеек в блоке нарушения payload без mergeSnapshot', () => {
  setupViolationWithMergedTable();

  const payload = AppState._serializeViolations();

  assert.equal(JSON.stringify(payload).includes('mergeSnapshot'), false);

  const tableBlock = payload.v1.codeMining.blocks[1];
  assert.equal(tableBlock.type, 'table');
  assert.deepEqual(Object.keys(tableBlock.table.grid[0][0]).sort(), [...CELL_KEYS].sort());
  assert.deepEqual(tableBlock.table.colWidths, [100, 100]);
});

test('_serializeViolations: блок таблицы копируется, исходная модель сохраняет снимок отката', () => {
  setupViolationWithMergedTable();
  const source = AppState.violations.v1.codeMining.blocks[1].table;

  const payload = AppState._serializeViolations();

  assert.notEqual(payload.v1.codeMining.blocks[1].table, source, 'в payload — копия, не ссылка');
  assert.ok(source.grid[0][0].mergeSnapshot, 'рантайм-снимок в модели уцелел (нужен unmerge)');
});

test('_serializeViolations: блоки других типов проходят как есть', () => {
  setupViolationWithMergedTable();
  const textBlock = AppState.violations.v1.codeMining.blocks[0];

  const payload = AppState._serializeViolations();

  assert.equal(payload.v1.codeMining.blocks[0], textBlock);
});

test('_serializeViolations: табличный блок без сетки не роняет сериализацию', () => {
  AppState.violations = {
    v1: {
      id: 'v1',
      nodeId: 'n1',
      fieldOrder: null,
      codeMining: { enabled: true, blocks: [{ id: 'tbl_0', type: 'table' }] },
    },
  };

  const payload = AppState._serializeViolations();

  assert.deepEqual(payload.v1.codeMining.blocks[0].table, { grid: [], colWidths: [] });
});
