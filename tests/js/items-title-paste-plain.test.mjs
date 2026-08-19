/**
 * Вставка в редактируемую подпись (шаг 1 «Составление структуры акта» — подписи
 * узлов дерева, а также заголовки пунктов/таблиц на шаге 2) должна быть ЧИСТЫМ
 * ТЕКСТОМ: Ctrl+V из Word/браузера не должен приносить в подпись ни разметки,
 * ни переводов строк.
 *
 * Реального DOM в node:test нет (см. _browser-stub.mjs), поэтому проверяется
 * контракт обработчика: preventDefault + insertText ровно с text/plain,
 * схлопнутым в одну строку, и снятие слушателя вместе с contentEditable.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ItemsTitleEditing } from '../../static/js/constructor/items/items-title-editing.js';

/** Фейковая подпись: журналирует навешивание/снятие слушателей и dispatch. */
function makeLabel() {
  const listeners = [];
  return {
    style: {},
    textContent: '',
    contentEditable: 'false',
    classList: { add() {}, remove() {}, contains: () => false },
    focus() {},
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    listenersOf(type) { return listeners.filter((l) => l.type === type).map((l) => l.fn); },
  };
}

/** Событие вставки с обоими представлениями буфера. */
function makePasteEvent(html, plain, calls) {
  return {
    preventDefault() { calls.push('prevent'); },
    clipboardData: { getData: (t) => (t === 'text/html' ? html : plain) },
  };
}

/** Запускает редактирование на фейковой подписи, подменяя Selection/Range. */
function withEditing(fn) {
  const origSel = globalThis.getSelection;
  const origCreateRange = globalThis.document.createRange;
  globalThis.document.createRange = () => ({ selectNodeContents() {} });
  globalThis.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  try {
    return fn();
  } finally {
    globalThis.getSelection = origSel;
    globalThis.document.createRange = origCreateRange;
  }
}

/** Перехватывает execCommand на время вызова. */
function withExecCommand(calls, fn) {
  const orig = globalThis.document.execCommand;
  globalThis.document.execCommand = (cmd, _b, val) => {
    calls.push(`exec:${cmd}:${val == null ? '' : val}`);
    return true;
  };
  try {
    return fn();
  } finally {
    globalThis.document.execCommand = orig;
  }
}

test('вставка в подпись: форматирование отброшено, вставлен только text/plain', () => {
  const el = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Исходная подпись'));

  const handlers = el.listenersOf('paste');
  assert.equal(handlers.length, 1, 'paste-слушатель не навешан на редактируемую подпись');

  const calls = [];
  const e = makePasteEvent(
    '<b style="color:red">Жирный</b> <span style="font-family:Arial">текст</span>',
    'Жирный текст',
    calls,
  );
  withExecCommand(calls, () => handlers[0](e));

  assert.deepEqual(calls, ['prevent', 'exec:insertText:Жирный текст']);
});

test('многострочный буфер схлопывается в одну строку', () => {
  const el = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Подпись'));
  const handler = el.listenersOf('paste')[0];

  const calls = [];
  const e = makePasteEvent('<p>Первая</p><p>Вторая</p>', 'Первая\r\n\tВторая\nТретья', calls);
  withExecCommand(calls, () => handler(e));

  assert.deepEqual(calls, ['prevent', 'exec:insertText:Первая Вторая Третья']);
});

test('пустой буфер: вставка гасится, но текст подписи не трогаем', () => {
  const el = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Подпись'));
  const handler = el.listenersOf('paste')[0];

  const calls = [];
  withExecCommand(calls, () => handler(makePasteEvent('<img src="x">', '', calls)));

  assert.deepEqual(calls, ['prevent']);
});

test('повторный вход в редактирование не плодит дублей слушателя', () => {
  const el = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Подпись'));
  const first = el.listenersOf('paste')[0];
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Подпись'));

  const handlers = el.listenersOf('paste');
  assert.ok(handlers.length >= 1, 'paste-слушатель не навешан');
  assert.ok(handlers.every((fn) => fn === first),
    'слушатель навешивается разными функциями — браузер накопит дубли');
});

test('слушатель снимается вместе с contentEditable (пункт/таблица и узел дерева)', () => {
  const el = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Подпись'));
  assert.equal(el.listenersOf('paste').length, 1, 'paste-слушатель не навешан');
  ItemsTitleEditing._cleanupEditing(el);
  assert.equal(el.listenersOf('paste').length, 0, 'paste остался висеть после _cleanupEditing');

  const treeLabel = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(treeLabel, 'Подпись'));
  assert.equal(treeLabel.listenersOf('paste').length, 1, 'paste-слушатель не навешан');
  ItemsTitleEditing._cleanupTreeNodeEditing(
    treeLabel,
    { classList: { remove() {} } },
    { editingElement: treeLabel },
  );
  assert.equal(treeLabel.listenersOf('paste').length, 0,
    'paste остался висеть после _cleanupTreeNodeEditing');
});
