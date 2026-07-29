/**
 * Тесты flush'а зависших правок перед сериализацией (Finding 2).
 *
 * Ячейки таблиц пишутся в state синхронно, но текстблоки коммитят правку через
 * debounce 500мс. Таймерный автосейв / экспорт / переключение акта могли читать
 * exportData() без последних символов. flushActiveEditor() коммитит активный
 * редактор; StorageManager._flushPendingEdits() — единая воронка, вызываемая
 * ДО exportData() во всех persistence-путях.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import { AppState } from '../../static/js/constructor/state/state-core.js';

beforeEach(() => {
  StorageManager._trackingDepth = 0;
  StorageManager._setState('saved');
  AppState.textBlocks = {};
  document.activeElement = null;
  // clearTimeout не объявлен в стабе — flushActiveEditor дёргает его на таймере.
  globalThis.clearTimeout = globalThis.clearTimeout || (() => {});
});

afterEach(() => {
  StorageManager.destroy();
  StorageManager._trackingDepth = 0;
  StorageManager._setState('saved');
  document.activeElement = null;
  delete window.currentActId;
  delete window.textBlockManager;
  delete window.tableManager;
});

/**
 * Фейковый contenteditable-редактор текстблока: ровно те поля, что читает
 * flushActiveEditor (classList.contains, saveTimeout, dataset.textBlockId,
 * innerHTML).
 */
function makeFakeEditor(textBlockId, innerHTML, saveTimeout) {
  return {
    classList: { contains: (c) => c === 'textblock-editor' },
    saveTimeout,
    dataset: { textBlockId },
    innerHTML,
  };
}

test('flushActiveEditor коммитит innerHTML активного редактора в state и снимает saveTimeout', () => {
  AppState.textBlocks['tb1'] = { id: 'tb1', content: 'старое значение' };
  const editor = makeFakeEditor('tb1', 'новое значение с последними буквами', 777);
  document.activeElement = editor;

  const committed = textBlockManager.flushActiveEditor();

  assert.equal(committed, true, 'pending-редактор закоммичен');
  assert.equal(editor.saveTimeout, null, 'saveTimeout снят');
  assert.equal(
    AppState.textBlocks['tb1'].content,
    'новое значение с последними буквами',
    'innerHTML перенесён в state'
  );
});

test('flushActiveEditor: нет фокуса на редакторе → no-op (false)', () => {
  document.activeElement = null;
  assert.equal(textBlockManager.flushActiveEditor(), false);

  // Фокус есть, но это не textblock-редактор.
  document.activeElement = {
    classList: { contains: () => false },
    saveTimeout: 1,
    dataset: {},
    innerHTML: 'x',
  };
  assert.equal(textBlockManager.flushActiveEditor(), false);
});

test('flushActiveEditor: редактор в фокусе, но debounce уже погашен (saveTimeout=null) → no-op', () => {
  AppState.textBlocks['tb1'] = { id: 'tb1', content: 'значение' };
  document.activeElement = makeFakeEditor('tb1', 'другое', null);
  assert.equal(textBlockManager.flushActiveEditor(), false);
  assert.equal(AppState.textBlocks['tb1'].content, 'значение', 'state не тронут');
});

test('saveState вызывает _flushPendingEdits ДО AppState.exportData', () => {
  const calls = [];
  const realFlush = StorageManager._flushPendingEdits;
  const realExport = AppState.exportData;
  StorageManager._flushPendingEdits = function () { calls.push('flush'); };
  AppState.exportData = function () { calls.push('export'); return {}; };

  window.currentActId = 42;
  // Снимок пишется только при несинхронизированных правках.
  StorageManager._setState('unsaved');

  try {
    StorageManager.saveState(true);
  } finally {
    StorageManager._flushPendingEdits = realFlush;
    AppState.exportData = realExport;
  }

  assert.deepEqual(
    calls,
    ['flush', 'export'],
    'flush обязан предшествовать чтению exportData()'
  );
});

test('_flushPendingEdits дёргает flushActiveEditor и commitPendingEdit (через window)', () => {
  const order = [];
  window.textBlockManager = { flushActiveEditor: () => { order.push('textblock'); return true; } };
  window.tableManager = { cellsOps: { commitPendingEdit: () => { order.push('cells'); return false; } } };

  StorageManager._flushPendingEdits();

  assert.deepEqual(order, ['textblock', 'cells']);
});

// V20: активная rich-поверхность (поле нарушения) коммитит правку в модель только
// через debounce-мост — воронка обязана сбросить её перед сериализацией через
// EditorRegistry.flushActive (flushActiveEditor ловит лишь .textblock-editor).
test('V20: _flushPendingEdits коммитит активную поверхность через EditorRegistry.flushActive', () => {
  const commits = [];
  window.EditorRegistry.setActive({ element: {}, commit: () => commits.push('surface') });
  try {
    StorageManager._flushPendingEdits();
    assert.deepEqual(commits, ['surface'], 'активная поверхность поля нарушения не сброшена перед сериализацией');
  } finally {
    window.EditorRegistry.clear();
  }
});

test('_flushPendingEdits не валится при отсутствии менеджеров', () => {
  delete window.textBlockManager;
  delete window.tableManager;
  // Не должно бросить.
  StorageManager._flushPendingEdits();
  assert.ok(true);
});
