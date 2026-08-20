/**
 * Единое правило оформления подписи таблицы (WP2).
 *
 * Пресетная таблица разделов 1–4 — обычным начертанием с подчёркиванием;
 * раздел 5 и любая пользовательская таблица — без эффектов. Правило —
 * чистая функция tableTitleUnderlined в table-title.js; зеркало на бэке —
 * app/domains/acts/formatters/table_title.py, страж синхронизации —
 * tests/domains/acts/formatters/test_table_title_rule.py.
 *
 * Здесь же — проверка, что оба фронтовых рендера (редактор и превью) кладут
 * на подпись класс-модификатор, а не инлайновый text-decoration: оформление
 * живёт в CSS, JS решает только «подчёркивать или нет».
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNDERLINED_TITLE_SECTIONS,
  tableTitleUnderlined,
} from '../../static/js/constructor/table/table-title.js';
import { ItemsRenderer } from '../../static/js/constructor/items/items-renderer.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { AppState } from '../../static/js/constructor/state/state-core.js';

const preset = (extra = {}) => ({ id: 't1', type: 'table', label: 'Таблица', protected: true, ...extra });

test('пресетная таблица разделов 1–4 — подчёркивается', () => {
  for (const section of ['1', '2', '3', '4']) {
    assert.equal(tableTitleUnderlined(preset(), section), true, `раздел ${section}`);
  }
});

test('раздел 5 — подчёркивания нет ни у какой таблицы', () => {
  assert.equal(tableTitleUnderlined(preset(), '5'), false);
  assert.equal(tableTitleUnderlined(preset({ protected: false }), '5'), false);
  assert.equal(tableTitleUnderlined(preset({ kind: 'operationalRisk' }), '5'), false);
});

test('пользовательская таблица — без эффектов в любом разделе', () => {
  assert.equal(tableTitleUnderlined(preset({ protected: false }), '2'), false);
  assert.equal(tableTitleUnderlined({ id: 't', type: 'table' }, '2'), false);
});

test('спецтаблица (kind ≠ regular) пресетной не считается', () => {
  assert.equal(tableTitleUnderlined(preset({ kind: 'metrics' }), '2'), false);
});

test('не-таблица и неизвестный раздел — правило не срабатывает', () => {
  assert.equal(tableTitleUnderlined({ id: '2', type: 'item', protected: true }, '2'), false);
  assert.equal(tableTitleUnderlined(preset(), null), false);
  assert.equal(tableTitleUnderlined(null, '2'), false);
});

test('список подчёркиваемых разделов — 1–4', () => {
  assert.deepEqual([...UNDERLINED_TITLE_SECTIONS], ['1', '2', '3', '4']);
});

// --- рендер редактора: класс вместо инлайнового оформления -------------------

/** Дерево из одного раздела с таблицей внутри. */
function withTree(sectionId, node, fn) {
  const prev = AppState.treeData;
  AppState.treeData = {
    id: 'root', label: 'Акт',
    children: [{ id: sectionId, label: `Раздел ${sectionId}`, children: [node] }],
  };
  try {
    return fn();
  } finally {
    AppState.treeData = prev;
  }
}

test('редактор: подпись пресетной таблицы раздела 2 получает класс-модификатор', () => {
  const node = preset();
  const el = withTree('2', node, () =>
    ItemsRenderer._createTableTitle({ id: 'tbl1', protected: true }, node));

  assert.ok(el.className.includes('table-title'), 'базовый класс подписи потерян');
  assert.ok(el.className.includes('table-title--underline'), 'нет модификатора подчёркивания');
  assert.equal(el.style.textDecoration, undefined, 'оформление осталось инлайном');
  assert.equal(el.style.fontWeight, undefined, 'начертание осталось инлайном');
});

test('редактор: подпись таблицы раздела 5 — без модификатора', () => {
  const node = preset();
  const el = withTree('5', node, () =>
    ItemsRenderer._createTableTitle({ id: 'tbl1', protected: true }, node));

  assert.ok(el.className.includes('table-title'));
  assert.ok(!el.className.includes('table-title--underline'));
});

// --- рендер превью: тот же класс-модификатор --------------------------------

/** Контейнер, собирающий appendChild в массив. */
function collector() {
  const children = [];
  return { children, appendChild(el) { children.push(el); } };
}

test('превью: подпись пресетной таблицы раздела 3 получает модификатор', () => {
  const container = collector();
  PreviewManager._renderTableNode(
    preset({ customLabel: 'Таблица 1' }), container, 1, '3',
  );
  const title = container.children[0];
  assert.ok(title.className.includes('preview-table-title'));
  assert.ok(title.className.includes('preview-table-title--underline'));
});

test('превью: подпись таблицы раздела 5 — без модификатора', () => {
  const container = collector();
  PreviewManager._renderTableNode(
    preset({ customLabel: 'Таблица 1' }), container, 1, '5',
  );
  const title = container.children[0];
  assert.ok(title.className.includes('preview-table-title'));
  assert.ok(!title.className.includes('preview-table-title--underline'));
});
