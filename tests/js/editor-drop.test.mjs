/**
 * T7 (находки #6/#14b): policy-driven drop в rich-поле нарушения.
 *
 * Нативный drop выделения со сноской/картинкой в поле нарушения обходил
 * тройной enforcement (тулбар/хоткей/паста) и санитизацию — сноска доводилась
 * observer'ом до атома, сырой <img> из файла попадал в модель. Фикс —
 * handleEditorDrop: тот же санитайзер/гейт капсул, что у paste (_buildPasteFragment
 * → _reconstructPastedCapsules), но данные из dataTransfer и каретка в точку сброса.
 *
 * Здесь — чистая логика маршрутизации/гейтов, тестируемая без реального DOM/
 * DOMPurify (в node его нет). Полный конвейер санитизации (DOMPurify вырезает
 * <img onerror>/скрипт) — в _buildPasteFragment, покрыт e2e (playwright) и
 * paste-тестами; drop делегирует В ТУ ЖЕ функцию (тест «маршрутизация»), поэтому
 * наследует её сан-гарантии. Гейт сносок (_reconstructPastedCapsules) — Group B.
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import '../../static/js/constructor/textblock/textblock-editor.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';

beforeEach(() => EditorRegistry.clear());

/**
 * Прогоняет handleEditorDrop на стабах и возвращает журнал ключевых вызовов
 * (зеркало runPaste из textblock-clipboard.test.mjs). _buildPasteFragment
 * записывает переданный html — так проверяется, что drop доводит контент до ТОЙ
 * ЖЕ санитизации/гейта, что paste.
 * @param {{editing?:boolean, html?:string, plain?:string, files?:any[],
 *   fragChildren?:any[], caret?:boolean, clientX?:number, clientY?:number}} cfg
 */
function runDrop(cfg = {}) {
  const {
    editing = false, html = '', plain = '', files = null,
    fragChildren = [], caret = false, clientX = 0, clientY = 0,
  } = cfg;
  const calls = [];
  const mgr = Object.create(TextBlockManager.prototype);
  mgr._buildPasteFragment = (h) => { calls.push(`build:${h}`); return { childNodes: fragChildren }; };
  mgr._expandRangeOutOfMarkers = () => calls.push('expand');
  mgr.applyFormattingToNewNodes = () => calls.push('applyFmt');
  mgr.finalizeEdit = () => calls.push('finalize');
  mgr.attachLinkFootnoteHandlers = () => calls.push('attach');
  const editor = {
    querySelector: (sel) => (sel === '.editing-mode' && editing ? {} : null),
    contains: () => true,
    dataset: { textBlockId: 'tb1' },
  };
  const e = {
    clientX, clientY,
    preventDefault() { calls.push('prevent'); },
    dataTransfer: {
      files: files || [],
      getData: (t) => (t === 'text/html' ? html : plain),
    },
  };
  const origExec = globalThis.document.execCommand;
  const origSel = globalThis.getSelection;
  const hadCaret = 'caretRangeFromPoint' in globalThis.document;
  const origCaret = globalThis.document.caretRangeFromPoint;
  globalThis.document.execCommand = (cmd, _b, val) => {
    calls.push(`exec:${cmd}:${val == null ? '' : val}`);
    return true;
  };
  globalThis.getSelection = () => ({
    rangeCount: 1,
    getRangeAt: () => ({}),
    removeAllRanges() { calls.push('sel:clear'); },
    addRange() { calls.push('sel:set'); },
  });
  if (caret) {
    globalThis.document.caretRangeFromPoint = (x, y) => {
      calls.push(`caret:${x},${y}`);
      return { startContainer: {} };
    };
  } else if (hadCaret) {
    delete globalThis.document.caretRangeFromPoint;
  }
  try {
    mgr.handleEditorDrop(e, editor, { id: 'tb1' });
  } finally {
    globalThis.document.execCommand = origExec;
    globalThis.getSelection = origSel;
    if (hadCaret) globalThis.document.caretRangeFromPoint = origCaret;
    else delete globalThis.document.caretRangeFromPoint;
  }
  return calls;
}

// ── Group A: ответственность самого handleEditorDrop ─────────────────────────

test('drop файла (картинка из проводника) → preventDefault, БЕЗ вставки (сырой <img> не попадёт в модель)', () => {
  // #14b: файловый drop гасим, но не мешаем контейнеру доп-контента (событие
  // всплывает — stopPropagation не зовём); санитайзер HTML не запускаем.
  const calls = runDrop({ files: [{}], html: '<p>x</p>', plain: 'x' });
  assert.deepEqual(calls, ['prevent'], 'при файлах — только preventDefault, без build/insert');
});

test('drop без dataTransfer → no-op без throw', () => {
  const mgr = Object.create(TextBlockManager.prototype);
  assert.doesNotThrow(() => mgr.handleEditorDrop({ preventDefault() {} }, { querySelector: () => null }, null));
});

test('drop только с text/plain (без HTML) → нативная вставка (не вмешиваемся, plain безопасен)', () => {
  // Внутренний drag (reorder/дерево) и внешний plain-текст не несут капсул/img/
  // скрипта — нативная вставка безопасна, preventDefault не зовём.
  const calls = runDrop({ html: '', plain: 'просто текст' });
  assert.deepEqual(calls, [], 'plain-only drop не перехватываем');
});

test('drop пустой (ни файлов, ни html, ни plain) → no-op', () => {
  const calls = runDrop({ html: '', plain: '' });
  assert.deepEqual(calls, []);
});

test('drop HTML → preventDefault + каретка в точку сброса + _buildPasteFragment(html) + insertHTML/finalize/attach', () => {
  const calls = runDrop({
    html: '<p>текст</p>', plain: 'текст', fragChildren: [{}], caret: true, clientX: 5, clientY: 7,
  });
  assert.ok(calls.includes('prevent'), 'нативная вставка не погашена');
  assert.ok(calls.includes('caret:5,7'), 'каретка не выставлена в точку сброса');
  assert.ok(calls.includes('build:<p>текст</p>'),
    'HTML не доведён до _buildPasteFragment — санитизация/гейт сносок paste не переиспользованы');
  assert.ok(calls.some((c) => c.startsWith('exec:insertHTML')), 'вставка не через insertHTML');
  assert.ok(!calls.some((c) => c.startsWith('exec:insertText')), 'HTML не должен уходить в insertText');
  assert.ok(calls.includes('finalize') && calls.includes('attach'));
});

test('drop HTML без caretRangeFromPoint → деградирует в текущее выделение (build+insertHTML всё равно)', () => {
  const calls = runDrop({ html: '<p>x</p>', plain: 'x', fragChildren: [{}], caret: false });
  assert.ok(!calls.some((c) => c.startsWith('caret:')), 'без API каретки не двигаем');
  assert.ok(calls.includes('build:<p>x</p>'));
  assert.ok(calls.some((c) => c.startsWith('exec:insertHTML')));
});

test('drop HTML во время inline-правки капсулы → только insertText(plain), без build (зеркало paste CARET-1)', () => {
  const calls = runDrop({
    editing: true, html: '<span data-footnote-text="t">X</span>', plain: 'ВСТАВКА', caret: true,
  });
  assert.deepEqual(calls, ['prevent', 'exec:insertText:ВСТАВКА']);
});

test('drop HTML с пустым санитизированным фрагментом → деградирует в plain (гейт пустоты paste)', () => {
  // <img onerror> санитизируется в ноль (в реальном _buildPasteFragment); здесь
  // fragChildren=[] имитирует пустой фрагмент — как в paste, падаем в plain.
  const calls = runDrop({ html: '<img onerror=alert(1)>', plain: 'запасной', fragChildren: [], caret: true });
  assert.ok(calls.includes('build:<img onerror=alert(1)>'));
  assert.ok(calls.includes('exec:insertText:запасной'));
  assert.ok(!calls.some((c) => c.startsWith('exec:insertHTML')));
});

// ── Group B: гейт сносок переиспользован через drop (_reconstructPastedCapsules) ──
// Реальный own-путь _buildPasteFragment зовёт _reconstructPastedCapsules (тот
// читает политику АКТИВНОЙ поверхности из EditorRegistry). В node без DOMPurify
// повторяем эту связку делегатом: _buildPasteFragment → РЕАЛЬНЫЙ гейт. Так
// проверяем поведение «drop сноски» напрямую (зеркало гейта из
// editor-surface-wiring.test.mjs, но доведённое через handleEditorDrop).

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

/** Прогоняет drop HTML со сноской через РЕАЛЬНЫЙ гейт при активной поверхности kind. */
function dropFootnoteUnderKind(kind) {
  const mgr = Object.create(TextBlockManager.prototype);
  const footnoteCalls = [];
  mgr.createFootnoteMarker = (t, b) => { footnoteCalls.push([t, b]); return { tag: 'footnote' }; };
  mgr._expandRangeOutOfMarkers = () => {};
  mgr.applyFormattingToNewNodes = () => {};
  mgr.finalizeEdit = () => {};
  mgr.attachLinkFootnoteHandlers = () => {};
  const children = [];
  const footnote = fakeFootnoteEl(fakeParent(children));
  children.push(footnote);
  // Имитация own-ветки _buildPasteFragment: зовём РЕАЛЬНЫЙ гейт, возвращаем
  // непустой фрагмент (чтобы drop дошёл до вставки).
  mgr._buildPasteFragment = () => {
    mgr._reconstructPastedCapsules({ querySelectorAll: () => [footnote] });
    return { childNodes: [{}] };
  };
  const editor = { querySelector: () => null, contains: () => true, dataset: { textBlockId: 'tb1' } };
  const e = {
    clientX: 0, clientY: 0, preventDefault() {},
    dataTransfer: { files: [], getData: (t) => (t === 'text/html' ? '<span data-footnote-text="тело">1</span>' : '') },
  };
  const origExec = globalThis.document.execCommand;
  const origSel = globalThis.getSelection;
  globalThis.document.execCommand = () => true;
  globalThis.getSelection = () => ({ rangeCount: 1, getRangeAt: () => ({}), removeAllRanges() {}, addRange() {} });
  EditorRegistry.setActive({ kind });
  try {
    mgr.handleEditorDrop(e, editor, null);
  } finally {
    globalThis.document.execCommand = origExec;
    globalThis.getSelection = origSel;
  }
  return { footnoteCalls, children };
}

test('drop HTML со сноской в violation-поле → сноска вырезана (гейт footnotes:false), маркер не реконструирован', () => {
  const { footnoteCalls, children } = dropFootnoteUnderKind('violationField');
  assert.deepEqual(footnoteCalls, [], 'createFootnoteMarker не должен звать — сноска под запретом политики');
  assert.deepEqual(children, [], 'капсула-сноска удалена из фрагмента до вставки');
});

test('drop того же HTML в textblock → сноска сохранена (гейт footnotes:true, поведение не меняется)', () => {
  const { footnoteCalls, children } = dropFootnoteUnderKind('textblock');
  assert.deepEqual(footnoteCalls, [['1', 'тело']], 'сноска реконструируется — политика textblock разрешает');
  assert.deepEqual(children, [{ tag: 'footnote' }]);
});
