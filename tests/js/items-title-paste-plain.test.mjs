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
    contains: () => true,
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

/** Событие сброса: dataTransfer с обоими представлениями перетаскиваемого. */
function makeDropEvent(el, { html = '', plain = '', files = [] }, calls) {
  return {
    currentTarget: el,
    clientX: 10,
    clientY: 10,
    preventDefault() { calls.push('prevent'); },
    stopPropagation() { calls.push('stop'); },
    dataTransfer: { files, getData: (t) => (t === 'text/html' ? html : plain) },
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

test('перетаскивание форматированного текста в подпись чистится до текста', () => {
  const el = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Подпись'));

  const handlers = el.listenersOf('drop');
  assert.equal(handlers.length, 1, 'drop-слушатель не навешан на редактируемую подпись');

  const calls = [];
  const e = makeDropEvent(el, {
    html: '<ul><li style="font-family:Calibri">Первый</li><li>Второй</li></ul>',
    plain: 'Первый\r\nВторой',
  }, calls);
  withEditing(() => withExecCommand(calls, () => handlers[0](e)));

  assert.deepEqual(calls, ['prevent', 'stop', 'exec:insertText:Первый Второй']);
});

test('перетаскивание многострочного plain схлопывается в одну строку', () => {
  const el = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Подпись'));
  const handler = el.listenersOf('drop')[0];

  const calls = [];
  const e = makeDropEvent(el, { plain: 'Первая\nВторая\tТретья' }, calls);
  withEditing(() => withExecCommand(calls, () => handler(e)));

  assert.deepEqual(calls, ['prevent', 'stop', 'exec:insertText:Первая Вторая Третья']);
});

test('перетаскивание узла дерева на подпись не перехватывается', () => {
  const el = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Подпись'));
  const handler = el.listenersOf('drop')[0];

  // TreeDragDrop кладёт в text/plain id узла — сброс должно обработать дерево.
  const calls = [];
  const e = makeDropEvent(el, { plain: 'node-42' }, calls);
  withEditing(() => withExecCommand(calls, () => handler(e)));

  assert.deepEqual(calls, [], 'однострочный plain без разметки — не наше дело');
});

test('перенос текста внутри самой подписи не перехватывается (иначе дубль)', () => {
  const el = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Подпись'));
  const handler = el.listenersOf('drop')[0];

  el.listenersOf('dragstart')[0]({ currentTarget: el });

  const calls = [];
  const e = makeDropEvent(el, { html: '<span>Подпись</span>', plain: 'Подпись' }, calls);
  withEditing(() => withExecCommand(calls, () => handler(e)));

  assert.deepEqual(calls, [], 'свой же фрагмент вырезает браузер — вмешательство даёт дубль');

  // dragend снимает метку — следующий внешний сброс снова чистится.
  el.listenersOf('dragend')[0]({ currentTarget: el });
  const calls2 = [];
  const e2 = makeDropEvent(el, { html: '<b>Извне</b>', plain: 'Извне' }, calls2);
  withEditing(() => withExecCommand(calls2, () => handler(e2)));
  assert.deepEqual(calls2, ['prevent', 'stop', 'exec:insertText:Извне']);
});

test('перетаскивание файла в подпись гасится без вставки', () => {
  const el = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Подпись'));
  const handler = el.listenersOf('drop')[0];

  const calls = [];
  const e = makeDropEvent(el, { files: [{ name: 'акт.docx' }] }, calls);
  withEditing(() => withExecCommand(calls, () => handler(e)));

  assert.deepEqual(calls, ['prevent', 'stop'], 'файл не должен ни вставляться, ни улетать наружу');
});

test('drop-слушатели снимаются вместе с contentEditable', () => {
  const el = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(el, 'Подпись'));
  ItemsTitleEditing._cleanupEditing(el);
  for (const type of ['drop', 'dragstart', 'dragend']) {
    assert.equal(el.listenersOf(type).length, 0, `${type} остался висеть после _cleanupEditing`);
  }

  const treeLabel = makeLabel();
  withEditing(() => ItemsTitleEditing._initializeEditing(treeLabel, 'Подпись'));
  ItemsTitleEditing._cleanupTreeNodeEditing(
    treeLabel,
    { classList: { remove() {} } },
    { editingElement: treeLabel },
  );
  for (const type of ['drop', 'dragstart', 'dragend']) {
    assert.equal(treeLabel.listenersOf(type).length, 0,
      `${type} остался висеть после _cleanupTreeNodeEditing`);
  }
});
