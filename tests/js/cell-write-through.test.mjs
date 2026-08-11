/**
 * Тесты write-through ввода в ячейку таблицы (M.26).
 *
 * Гарантии:
 *  - ввод пишется в grid[r][c].content по координатам из dataset;
 *  - исходное значение сессии запоминается при ПЕРВОМ вводе и не затирается;
 *  - отмена (Escape) откатывает состояние к исходному и забывает сессию;
 *  - невалидные координаты и поглощённые (isSpanned) ячейки не трогаются;
 *  - запись идёт через переданный объект таблицы — Proxy-обёртка состояния
 *    (markAsUnsaved) ловит её set-trap'ом (эмулируется счётчиком записей).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCellInput, cancelCellInput } from '../../static/js/constructor/table/cell-write-through.js';
import { makeTable, makeCell, makeGrid } from './_setup.mjs';

/** Создаёт таблицу 2×3 (content по умолчанию ''), уже «разрешённую» резолвером. */
function makeTables() {
  return { t1: makeTable() };
}

test('applyCellInput пишет значение в ячейку по координатам', () => {
  const tables = makeTables();
  const session = {};
  const originals = new Map();

  const written = applyCellInput(tables.t1, 1, 2, 'abc', originals, session);

  assert.equal(written, true);
  assert.equal(tables.t1.grid[1][2].content, 'abc');
});

test('applyCellInput запоминает исходник при первом вводе и не затирает его дальше', () => {
  const tables = makeTables();
  tables.t1.grid[0][0].content = 'исходное';
  const session = {};
  const originals = new Map();

  applyCellInput(tables.t1, 0, 0, 'и', originals, session);
  applyCellInput(tables.t1, 0, 0, 'ис', originals, session);
  applyCellInput(tables.t1, 0, 0, 'исп', originals, session);

  assert.equal(tables.t1.grid[0][0].content, 'исп');
  assert.equal(originals.get(session), 'исходное');
});

test('cancelCellInput откатывает состояние к исходному и забывает сессию', () => {
  const tables = makeTables();
  tables.t1.grid[0][1].content = 'было';
  const session = {};
  const originals = new Map();

  applyCellInput(tables.t1, 0, 1, 'стало', originals, session);
  const cancelled = cancelCellInput(tables.t1, 0, 1, originals, session);

  assert.equal(cancelled, true);
  assert.equal(tables.t1.grid[0][1].content, 'было');
  assert.equal(originals.has(session), false);
});

test('cancelCellInput без активной сессии — no-op', () => {
  const tables = makeTables();
  tables.t1.grid[0][0].content = 'нетронуто';
  const originals = new Map();

  const cancelled = cancelCellInput(tables.t1, 0, 0, originals, {});

  assert.equal(cancelled, false);
  assert.equal(tables.t1.grid[0][0].content, 'нетронуто');
});

test('applyCellInput не пишет в поглощённую (isSpanned) ячейку', () => {
  const tables = makeTables();
  tables.t1.grid[1][1] = makeCell({ isSpanned: true, content: '' });
  const originals = new Map();

  const written = applyCellInput(tables.t1, 1, 1, 'x', originals, {});

  assert.equal(written, false);
  assert.equal(tables.t1.grid[1][1].content, '');
  assert.equal(originals.size, 0);
});

test('applyCellInput молча отбивает невалидные координаты и неразрешённую таблицу', () => {
  const tables = makeTables();
  const originals = new Map();

  assert.equal(applyCellInput(undefined, 0, 0, 'x', originals, {}), false);
  assert.equal(applyCellInput(tables.t1, 99, 0, 'x', originals, {}), false);
  assert.equal(applyCellInput(tables.t1, 0, 99, 'x', originals, {}), false);
  assert.equal(applyCellInput(tables.t1, NaN, NaN, 'x', originals, {}), false);
  assert.equal(originals.size, 0);
});

test('повторная сессия после отката стартует с актуального исходника', () => {
  const tables = makeTables();
  tables.t1.grid[0][0].content = 'v1';
  const originals = new Map();

  // Сессия 1: ввод + коммит (finishEditing пишет поверх — эмулируем прямой записью)
  const s1 = {};
  applyCellInput(tables.t1, 0, 0, 'v2', originals, s1);
  // Сессия 2 (новая textarea): исходником должен стать v2, а не v1
  const s2 = {};
  applyCellInput(tables.t1, 0, 0, 'v3', originals, s2);
  cancelCellInput(tables.t1, 0, 0, originals, s2);

  assert.equal(tables.t1.grid[0][0].content, 'v2');
});

test('запись проходит через set-trap Proxy-обёртки (эмуляция markAsUnsaved)', () => {
  let dirtyWrites = 0;
  const wrapCell = (cell) => new Proxy(cell, {
    set(target, prop, value) {
      dirtyWrites += 1;
      target[prop] = value;
      return true;
    },
  });
  const grid = makeGrid(1, 1).map(row => row.map(wrapCell));
  const tables = { t1: makeTable({ grid }) };
  const originals = new Map();

  applyCellInput(tables.t1, 0, 0, 'ввод', originals, {});

  assert.equal(tables.t1.grid[0][0].content, 'ввод');
  assert.equal(dirtyWrites, 1);
});
