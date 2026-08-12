/**
 * Резолвер таблиц (table-store.js): единый адрес узловых и встроенных таблиц.
 *
 * Тестируются РЕАЛЬНЫЕ функции модуля; браузерные глобалы — из _browser-stub.mjs
 * (импорт ПЕРВЫМ, порядок load-bearing). Гарантии:
 *  - синтетический id собирается и разбирается без потерь;
 *  - встроенная таблица резолвится КАЖДЫЙ РАЗ от AppState.violations (ссылка не
 *    кэшируется — иначе запись обошла бы Proxy-трекинг несохранённого);
 *  - неузнаваемый адрес молча даёт undefined, а не бросает;
 *  - afterTableChanged маршрутизирует: узловая → ItemsRenderer + полное превью,
 *    встроенная → пересборка host-контейнера + патч превью НАРУШЕНИЯ.
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppState } from '../../static/js/constructor/state/state-core.js';
import { ItemsRenderer } from '../../static/js/constructor/items/items-renderer.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { tableManager } from '../../static/js/constructor/table/table-core.js';
import {
  makeEmbeddedTableId,
  isEmbeddedTableId,
  parseEmbeddedTableId,
  resolveTable,
  afterTableChanged,
  afterTableCellChanged,
} from '../../static/js/constructor/table/table-store.js';

const VID = 'violation_1';
const FIELD = 'codeMining';
const BID = 'table_1_abc';
const EMBEDDED_ID = makeEmbeddedTableId(VID, FIELD, BID);

/** Нарушение с одним табличным блоком в поле codeMining. */
function makeViolationWithTable(grid = [[{ content: 'A' }]]) {
  return {
    id: VID,
    nodeId: 'n1',
    [FIELD]: {
      enabled: true,
      blocks: [
        { id: 'text_0', type: 'text', content: 'до' },
        { id: BID, type: 'table', table: { grid, colWidths: [100] } },
      ],
    },
  };
}

beforeEach(() => {
  AppState.tables = { t1: { id: 't1', grid: [[{ content: 'узловая' }]], colWidths: [100] } };
  AppState.violations = { [VID]: makeViolationWithTable() };
});

// ──────────────────────────────────────────────────────────────────────────
// Синтетический id: сборка / признак / разбор.
// ──────────────────────────────────────────────────────────────────────────

test('makeEmbeddedTableId собирает адрес вида vt::<vid>::<field>::<block>', () => {
  assert.equal(makeEmbeddedTableId('v', 'f', 'b'), 'vt::v::f::b');
});

test('isEmbeddedTableId: только строки с префиксом vt:: (узловые id и мусор — false)', () => {
  assert.equal(isEmbeddedTableId(EMBEDDED_ID), true);
  assert.equal(isEmbeddedTableId('table_123'), false);
  assert.equal(isEmbeddedTableId('vt'), false);
  assert.equal(isEmbeddedTableId(''), false);
  assert.equal(isEmbeddedTableId(undefined), false);
  assert.equal(isEmbeddedTableId(null), false);
});

test('parseEmbeddedTableId разбирает адрес обратно в три части', () => {
  assert.deepEqual(parseEmbeddedTableId(EMBEDDED_ID), {
    violationId: VID,
    fieldKey: FIELD,
    blockId: BID,
  });
});

test('parseEmbeddedTableId: узловой id и повреждённый адрес → null', () => {
  assert.equal(parseEmbeddedTableId('table_123'), null);
  assert.equal(parseEmbeddedTableId('vt::v::f'), null, 'не хватает части');
  assert.equal(parseEmbeddedTableId('vt::v::f::b::лишнее'), null);
  assert.equal(parseEmbeddedTableId('vt::::f::b'), null, 'пустая часть');
});

// ──────────────────────────────────────────────────────────────────────────
// resolveTable: две ветки адресации.
// ──────────────────────────────────────────────────────────────────────────

test('resolveTable по обычному id отдаёт таблицу из AppState.tables', () => {
  assert.equal(resolveTable('t1'), AppState.tables.t1);
});

test('resolveTable по обычному id неизвестной таблицы — undefined', () => {
  assert.equal(resolveTable('нет-такой'), undefined);
});

test('resolveTable по встроенному id отдаёт table блока нарушения', () => {
  const expected = AppState.violations[VID][FIELD].blocks[1].table;
  assert.equal(resolveTable(EMBEDDED_ID), expected);
});

test('resolveTable НЕ кэширует: после подмены блока отдаёт новую таблицу', () => {
  const first = resolveTable(EMBEDDED_ID);
  const fresh = { grid: [[{ content: 'новая' }]], colWidths: [100] };
  AppState.violations[VID][FIELD].blocks[1].table = fresh;

  const second = resolveTable(EMBEDDED_ID);
  assert.notEqual(second, first);
  assert.equal(second, fresh);
});

test('resolveTable отбивает промахи адреса молча (undefined, без throw)', () => {
  assert.equal(resolveTable(makeEmbeddedTableId('нет-нарушения', FIELD, BID)), undefined);
  assert.equal(resolveTable(makeEmbeddedTableId(VID, 'нет-поля', BID)), undefined);
  assert.equal(resolveTable(makeEmbeddedTableId(VID, FIELD, 'нет-блока')), undefined);
  assert.equal(resolveTable('vt::повреждён'), undefined);
});

test('resolveTable не падает на пустом состоянии', () => {
  AppState.tables = undefined;
  AppState.violations = undefined;
  assert.doesNotThrow(() => resolveTable('t1'));
  assert.doesNotThrow(() => resolveTable(EMBEDDED_ID));
});

// ──────────────────────────────────────────────────────────────────────────
// afterTableChanged / afterTableCellChanged: маршрутизация перерисовки.
// ──────────────────────────────────────────────────────────────────────────

/** Подменяет рендер-точки на шпионов и возвращает журнал вызовов + restore. */
function spyRenderers() {
  const calls = { updateTable: [], previewUpdate: 0, updateBlock: [], attach: [] };
  const orig = {
    updateTable: ItemsRenderer.updateTable,
    update: PreviewManager.update,
    updateBlock: PreviewManager.updateBlock,
    attach: tableManager.attachEventListenersToContainer,
    querySelector: document.querySelector,
  };

  ItemsRenderer.updateTable = (id) => calls.updateTable.push(id);
  PreviewManager.update = () => { calls.previewUpdate += 1; };
  PreviewManager.updateBlock = (kind, id) => calls.updateBlock.push(`${kind}:${id}`);
  tableManager.attachEventListenersToContainer = (el) => calls.attach.push(el);

  return {
    calls,
    restore() {
      ItemsRenderer.updateTable = orig.updateTable;
      PreviewManager.update = orig.update;
      PreviewManager.updateBlock = orig.updateBlock;
      tableManager.attachEventListenersToContainer = orig.attach;
      document.querySelector = orig.querySelector;
    },
  };
}

test('afterTableChanged для узловой таблицы: ItemsRenderer.updateTable + полное превью', () => {
  const spy = spyRenderers();
  try {
    afterTableChanged('t1');
    assert.deepEqual(spy.calls.updateTable, ['t1']);
    assert.equal(spy.calls.previewUpdate, 1);
    assert.deepEqual(spy.calls.updateBlock, []);
  } finally {
    spy.restore();
  }
});

test('afterTableChanged для встроенной: узловой рендер НЕ трогается, превью — патч нарушения', () => {
  const spy = spyRenderers();
  try {
    afterTableChanged(EMBEDDED_ID);
    assert.deepEqual(spy.calls.updateTable, [], 'таблицы-узла у встроенной нет');
    assert.equal(spy.calls.previewUpdate, 0, 'полный ре-рендер превью не нужен');
    assert.deepEqual(spy.calls.updateBlock, [`violation:${VID}`]);
  } finally {
    spy.restore();
  }
});

test('afterTableChanged для встроенной пересобирает найденный host и вешает слушатели', () => {
  const spy = spyRenderers();
  const appended = [];
  const host = {
    innerHTML: 'старое',
    appendChild: (el) => appended.push(el),
    querySelectorAll: () => [],
  };
  document.querySelector = (sel) => (sel.includes(EMBEDDED_ID) ? host : null);

  try {
    afterTableChanged(EMBEDDED_ID);

    assert.equal(host.innerHTML, '', 'прежнее содержимое host очищено');
    assert.equal(appended.length, 1, 'таблица пересобрана и вставлена в host');
    assert.deepEqual(spy.calls.attach, [host], 'слушатели навешаны на host');
  } finally {
    spy.restore();
  }
});

test('afterTableCellChanged: узловая → патч блока таблицы, встроенная → патч нарушения', () => {
  const spy = spyRenderers();
  try {
    afterTableCellChanged('t1');
    afterTableCellChanged(EMBEDDED_ID);

    assert.deepEqual(spy.calls.updateBlock, ['table:t1', `violation:${VID}`]);
    assert.deepEqual(spy.calls.updateTable, [], 'контентная правка DOM не пересобирает');
    assert.equal(spy.calls.previewUpdate, 0);
  } finally {
    spy.restore();
  }
});
