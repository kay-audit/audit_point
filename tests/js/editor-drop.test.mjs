/**
 * T7 (находки #6/#14b): policy-driven drop в rich-поле нарушения —
 * EditorController.handleSurfaceDrop.
 *
 * Слушатель drop живёт на поле с СОЗДАНИЯ (_createRichFieldEditor), НЕ на mount:
 * focus диспатчится как default-action события drop (ПОСЛЕ drop-обработчиков),
 * поэтому mount-time слушатель опоздал бы на drop в НЕсфокусированное поле —
 * основной сценарий #6 (сноска создаётся только в текстблоке → поле нарушения
 * расфокусировано). Handler не зависит от фокуса/реестра: гейт сносок — из
 * ЗАХВАЧЕННОЙ поверхности (surface.kind), модель — явным surface.commit(), если
 * поле не смонтировано.
 *
 * Здесь — логика handleSurfaceDrop под node-стабом (без реального DOM/DOMPurify).
 * Полный конвейер санитизации (<img onerror>/скрипт режет DOMPurify) — в
 * _buildPasteFragment, покрыт paste-тестами/playwright; drop делегирует в ТУ ЖЕ
 * функцию. Wiring «создание поля → drop-слушатель» — violation-rich-fields.test.mjs.
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EditorController } from '../../static/js/constructor/textblock/editor-controller.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import '../../static/js/constructor/textblock/textblock-editor.js';

beforeEach(() => { EditorRegistry.clear(); EditorController._surface = null; });

/**
 * Прогоняет EditorController.handleSurfaceDrop на стабах, возвращает журнал.
 * _insertSanitizedHtml записывает html + footnotesBlocked — так проверяется, что
 * drop доводит контент до ТОЙ ЖЕ санитизации/гейта, что paste, с политикой из
 * ЗАХВАЧЕННОЙ поверхности.
 * @param {{kind?:string, html?:string, plain?:string, files?:any[],
 *   editing?:boolean, mounted?:boolean, caret?:boolean}} cfg
 */
function runSurfaceDrop(cfg = {}) {
  const {
    kind = 'violationField', html = '', plain = '', files = null,
    editing = false, mounted = false, caret = false,
  } = cfg;
  const calls = [];
  const el = {
    focus: () => calls.push('focus'),
    querySelector: (sel) => (sel === '.editing-mode' && editing ? {} : null),
    contains: () => true,
  };
  const surface = { kind, element: el, commit: () => calls.push('commit') };
  const e = {
    clientX: 3, clientY: 4,
    preventDefault: () => calls.push('prevent'),
    dataTransfer: { files: files || [], getData: (t) => (t === 'text/html' ? html : plain) },
  };
  const origInsert = textBlockManager._insertSanitizedHtml;
  const origCaret = textBlockManager._dropCaretRange;
  const origSel = globalThis.getSelection;
  const origExec = globalThis.document.execCommand;
  textBlockManager._insertSanitizedHtml = (element, h, p, fb) => calls.push(`insert:${h}:${fb}`);
  textBlockManager._dropCaretRange = () => (caret ? { startContainer: {} } : null);
  globalThis.getSelection = () => ({ removeAllRanges() { calls.push('sel:clear'); }, addRange() { calls.push('sel:set'); } });
  globalThis.document.execCommand = (cmd, _b, val) => { calls.push(`exec:${cmd}:${val == null ? '' : val}`); return true; };
  EditorController._surface = mounted ? surface : null;
  try {
    EditorController.handleSurfaceDrop(e, surface);
  } finally {
    textBlockManager._insertSanitizedHtml = origInsert;
    textBlockManager._dropCaretRange = origCaret;
    globalThis.getSelection = origSel;
    globalThis.document.execCommand = origExec;
    EditorController._surface = null;
  }
  return calls;
}

// ── Ответственность handleSurfaceDrop ─────────────────────────────────────────

test('drop файла (картинка из проводника) → preventDefault, БЕЗ вставки/фокуса/commit', () => {
  // #14b: файловый drop гасим, но не мешаем контейнеру доп-контента (событие
  // всплывает — stopPropagation не зовём); санитайзер HTML не запускаем.
  const calls = runSurfaceDrop({ files: [{}], html: '<p>x</p>', plain: 'x' });
  assert.deepEqual(calls, ['prevent']);
});

test('drop без dataTransfer → no-op без throw', () => {
  const surface = { kind: 'violationField', element: {}, commit() {} };
  assert.doesNotThrow(() => EditorController.handleSurfaceDrop({ preventDefault() {} }, surface));
});

test('drop только с text/plain (без HTML) → нативная вставка (не вмешиваемся)', () => {
  // Внутренний drag (reorder/дерево) и внешний plain не несут капсул/img/скрипта.
  const calls = runSurfaceDrop({ html: '', plain: 'просто текст' });
  assert.deepEqual(calls, []);
});

test('drop пустой (ни файлов, ни html, ни plain) → no-op', () => {
  assert.deepEqual(runSurfaceDrop({ html: '', plain: '' }), []);
});

test('drop HTML в НЕсмонтированное поле нарушения → prevent + focus + каретка + insert(footnotesBlocked=true) + commit', () => {
  const calls = runSurfaceDrop({ kind: 'violationField', html: '<p>текст</p>', plain: 'текст', caret: true });
  assert.deepEqual(calls, [
    'prevent', 'focus', 'sel:clear', 'sel:set', 'insert:<p>текст</p>:true', 'commit',
  ]);
});

test('drop HTML: гейт сносок берётся из ЗАХВАЧЕННОЙ поверхности (textblock → footnotesBlocked=false)', () => {
  // Политика — из surface.kind, НЕ из EditorRegistry (при drop в несфокус. поле
  // активной может быть другая/никакая). Ставим чужую активную — не должна влиять.
  EditorRegistry.setActive({ kind: 'violationField' });
  const calls = runSurfaceDrop({ kind: 'textblock', html: '<p>x</p>', caret: true });
  assert.ok(calls.includes('insert:<p>x</p>:false'),
    'footnotesBlocked должен читаться из surface.kind (textblock=false), не из активной поверхности');
});

test('drop HTML в СМОНТИРОВАННОЕ поле → явного commit НЕТ (коммитит input-хендлер, без двойного commit)', () => {
  const calls = runSurfaceDrop({ kind: 'violationField', html: '<p>x</p>', caret: true, mounted: true });
  assert.ok(calls.includes('insert:<p>x</p>:true'));
  assert.ok(!calls.includes('commit'),
    'смонтированную поверхность коммитит её input-хендлер — явный commit был бы двойным');
});

test('drop HTML во время inline-правки капсулы → только insertText(plain), без insert-фрагмента', () => {
  const calls = runSurfaceDrop({ kind: 'violationField', html: '<span data-footnote-text="t">X</span>', plain: 'ВСТАВКА', editing: true });
  assert.deepEqual(calls, ['prevent', 'focus', 'exec:insertText:ВСТАВКА', 'commit']);
});

// ── Мандат ревью: гейт+commit на НЕсмонтированном поле через РЕАЛЬНЫЙ гейт ──────
// Реальный own-путь _buildPasteFragment зовёт _reconstructPastedCapsules с
// переданным footnotesBlocked. В node без DOMPurify имитируем связку делегатом:
// _buildPasteFragment → РЕАЛЬНЫЙ гейт с fb из захваченной поверхности.

/** Фейковая капсула сноски: поля, что читает _reconstructPastedCapsules. */
function fakeFootnoteEl(parent) {
  const attrs = { 'data-footnote-text': 'тело' };
  return {
    parentNode: parent,
    textContent: '1',
    classList: { contains: (c) => c === 'text-footnote' },
    hasAttribute: (k) => k in attrs,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
}
function fakeParent(children) {
  return {
    replaceChild(node, old) { const i = children.indexOf(old); if (i !== -1) children[i] = node; },
    removeChild(old) { const i = children.indexOf(old); if (i !== -1) children.splice(i, 1); },
  };
}

/** Прогоняет handleSurfaceDrop с РЕАЛЬНЫМ гейтом через делегат _buildPasteFragment. */
function dropFootnoteIntoUnmounted(kind) {
  const committed = [];
  const el = { focus() {}, querySelector: () => null, contains: () => true, innerHTML: '<sanitized>' };
  const surface = { kind, element: el, commit: () => committed.push(el.innerHTML) };
  const footnoteCalls = [];
  const children = [];
  const footnote = fakeFootnoteEl(fakeParent(children));
  children.push(footnote);
  const prevented = [];
  const e = {
    clientX: 0, clientY: 0, preventDefault: () => prevented.push(1),
    dataTransfer: { files: [], getData: (t) => (t === 'text/html' ? '<span data-footnote-text="тело">1</span>' : '') },
  };
  const orig = {
    build: textBlockManager._buildPasteFragment,
    caret: textBlockManager._dropCaretRange,
    expand: textBlockManager._expandRangeOutOfMarkers,
    fmt: textBlockManager.applyFormattingToNewNodes,
    fin: textBlockManager.finalizeEdit,
    attach: textBlockManager.attachLinkFootnoteHandlers,
    createFn: textBlockManager.createFootnoteMarker,
  };
  textBlockManager.createFootnoteMarker = (t, b) => { footnoteCalls.push([t, b]); return { tag: 'footnote' }; };
  textBlockManager._buildPasteFragment = (html, fb) => {
    textBlockManager._reconstructPastedCapsules({ querySelectorAll: () => [footnote] }, fb);
    return { childNodes: [{}] };
  };
  textBlockManager._dropCaretRange = () => null;
  textBlockManager._expandRangeOutOfMarkers = () => {};
  textBlockManager.applyFormattingToNewNodes = () => {};
  textBlockManager.finalizeEdit = () => {};
  textBlockManager.attachLinkFootnoteHandlers = () => {};
  const origSel = globalThis.getSelection;
  const origExec = globalThis.document.execCommand;
  globalThis.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({}), removeAllRanges() {}, addRange() {} });
  globalThis.document.execCommand = () => true;
  EditorController._surface = null; // НЕ смонтировано
  try {
    EditorController.handleSurfaceDrop(e, surface);
  } finally {
    textBlockManager._buildPasteFragment = orig.build;
    textBlockManager._dropCaretRange = orig.caret;
    textBlockManager._expandRangeOutOfMarkers = orig.expand;
    textBlockManager.applyFormattingToNewNodes = orig.fmt;
    textBlockManager.finalizeEdit = orig.fin;
    textBlockManager.attachLinkFootnoteHandlers = orig.attach;
    textBlockManager.createFootnoteMarker = orig.createFn;
    globalThis.getSelection = origSel;
    globalThis.document.execCommand = origExec;
    EditorController._surface = null;
  }
  return { prevented, footnoteCalls, children, committed };
}

test('handleSurfaceDrop: НЕсмонтированное поле нарушения, drop HTML со сноской → default погашен, сноска вырезана, МОДЕЛЬ обновлена', () => {
  const { prevented, footnoteCalls, children, committed } = dropFootnoteIntoUnmounted('violationField');
  assert.deepEqual(prevented, [1], 'нативный default drop не погашен — капсула ушла бы в DOM мимо гейта');
  assert.deepEqual(footnoteCalls, [], 'сноска реконструирована (гейт не сработал под footnotes:false)');
  assert.deepEqual(children, [], 'капсула-сноска не удалена из фрагмента до вставки');
  assert.equal(committed.length, 1, 'модель не обновлена (commit не вызван для несмонтированного поля)');
});

test('handleSurfaceDrop: тот же drop в textblock-поверхность → сноска сохранена (footnotesBlocked=false)', () => {
  const { footnoteCalls, children } = dropFootnoteIntoUnmounted('textblock');
  assert.deepEqual(footnoteCalls, [['1', 'тело']], 'сноска реконструируется — политика textblock разрешает');
  assert.deepEqual(children, [{ tag: 'footnote' }]);
});
