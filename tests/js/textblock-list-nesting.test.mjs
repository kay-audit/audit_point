/**
 * Многоуровневые списки в rich-редакторе (спека §4).
 *
 *  - нормализация вложенности: Chromium после execCommand('indent') даёт
 *    НЕВАЛИДНОЕ `<ul><li>a</li><ul><li>b</li></ul></ul>` (список прямо внутри
 *    списка, минуя <li>) — приводим к валидному `<ul><li>a<ul>…</ul></li></ul>`;
 *  - политика Tab/Shift+Tab: перехват ТОЛЬКО внутри <li>, вне списка нативный
 *    переход фокуса сохраняется (preventDefault не зовётся);
 *  - потолок глубины — уровень 8 (9 уровней w:abstractNum в OOXML).
 *
 * ОГРАНИЧЕНИЕ ХАРНЕССА: jsdom/linkedom в проекте нет, `_browser-stub.mjs` даёт
 * узлы без дерева и без парсинга innerHTML → дерево строим на `_mini-dom.mjs`
 * (ровно то подмножество DOM, которым пользуется нормализатор). Живое поведение
 * Chromium (что именно порождает indent) — предмет Playwright-спеки.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml, installMiniDom } from './_mini-dom.mjs';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import { MAX_LIST_LEVEL } from '../../static/js/constructor/textblock/textblock-editor.js';
import { SAFE_HTML_PROFILES } from '../../static/js/shared/sanitize.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { ChangelogTracker } from '../../static/js/constructor/changelog-tracker.js';

installMiniDom();
// saveContent тянет побочные эффекты (патч превью + дебаунс-таймер changelog) —
// в node они не нужны и таймер держал бы процесс живым.
PreviewManager.updateBlock = () => {};
ChangelogTracker._recordDebounced = () => {};

const mgr = () => Object.create(TextBlockManager.prototype);

/** Нормализует HTML через живое дерево (как на пути indent/outdent). */
function normalizeDom(html) {
  const root = parseHtml(html);
  mgr()._normalizeListNesting(root);
  return root.innerHTML;
}

// ── нормализация вложенности ─────────────────────────────────────────────────

test('нормализация: chromium-вывод <ul><li>a</li><ul>… → список уезжает внутрь предыдущего <li>', () => {
  assert.equal(
    normalizeDom('<ul><li>a</li><ul><li>b</li></ul></ul>'),
    '<ul><li>a<ul><li>b</li></ul></li></ul>',
  );
});

test('нормализация: нет предыдущего <li> → создаётся пустой', () => {
  assert.equal(
    normalizeDom('<ul><ul><li>b</li></ul></ul>'),
    '<ul><li><ul><li>b</li></ul></li></ul>',
  );
});

test('нормализация: двойная вложенность чинится за один проход', () => {
  assert.equal(
    normalizeDom('<ul><li>a</li><ul><li>b</li><ul><li>c</li></ul></ul></ul>'),
    '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>',
  );
});

test('нормализация: смешанные типы (ol внутри ul) — тип списка не меняется', () => {
  assert.equal(
    normalizeDom('<ul><li>a</li><ol><li>1</li></ol></ul>'),
    '<ul><li>a<ol><li>1</li></ol></li></ul>',
  );
});

test('нормализация: валидная разметка не меняется, повторный вызов идемпотентен', () => {
  const valid = '<ul><li>a<ul><li>b</li></ul></li></ul>';
  assert.equal(normalizeDom(valid), valid);
  assert.equal(normalizeDom(normalizeDom('<ul><li>a</li><ul><li>b</li></ul></ul>')),
    '<ul><li>a<ul><li>b</li></ul></li></ul>');
});

test('нормализация: два соседних невалидных списка уходят в один и тот же <li>', () => {
  assert.equal(
    normalizeDom('<ul><li>a</li><ul><li>b</li></ul><ol><li>1</li></ol></ul>'),
    '<ul><li>a<ul><li>b</li></ul><ol><li>1</li></ol></li></ul>',
  );
});

test('нормализация: список верхнего уровня (родитель — не список) не трогается', () => {
  const html = '<p>текст</p><ul><li>a</li></ul><ol><li>1</li></ol>';
  assert.equal(normalizeDom(html), html);
});

test('нормализация: капсулы внутри пунктов переживают перенос списка', () => {
  const out = normalizeDom(
    '<ul><li>a<span class="text-link" data-link-id="L1" data-link-url="http://x">ссылка</span></li>'
    + '<ul><li><span class="text-footnote" data-footnote-id="F1" data-footnote-text="тело">сн</span></li></ul></ul>',
  );
  assert.match(out, /data-link-url="http:\/\/x"/);
  assert.match(out, /data-footnote-text="тело"/);
  assert.equal(out.indexOf('</li><ul>'), -1, 'невалидная вложенность не осталась');
});

// ── строковый путь (saveContent) ─────────────────────────────────────────────

test('_normalizeListNestingHtml: HTML без списков возвращается тем же значением', () => {
  const html = '<p>обычный <b>текст</b></p>';
  assert.equal(mgr()._normalizeListNestingHtml(html), html);
});

test('_normalizeListNestingHtml: не-строка проходит насквозь', () => {
  assert.equal(mgr()._normalizeListNestingHtml(null), null);
  assert.equal(mgr()._normalizeListNestingHtml(undefined), undefined);
});

test('_normalizeListNestingHtml: невалидная вложенность чинится в строке', () => {
  assert.equal(
    mgr()._normalizeListNestingHtml('<ul><li>a</li><ul><li>b</li></ul></ul>'),
    '<ul><li>a<ul><li>b</li></ul></li></ul>',
  );
});

test('saveContent: контент проходит через нормализацию перед записью в модель', () => {
  const m = mgr();
  const block = { content: '' };
  m.getTextBlock = () => block;
  m.saveContent('tb1', '<ul><li>a</li><ul><li>b</li></ul></ul>');
  assert.equal(block.content, '<ul><li>a<ul><li>b</li></ul></li></ul>');
});

// ── уровень вложенности ──────────────────────────────────────────────────────

test('_listLevel: пункт списка верхнего уровня — 0, вложенного — 1 и глубже', () => {
  const editor = parseHtml('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>');
  const m = mgr();
  const items = editor.querySelectorAll('li');
  assert.equal(m._listLevel(items[0], editor), 0);
  assert.equal(m._listLevel(items[1], editor), 1);
  assert.equal(m._listLevel(items[2], editor), 2);
});

test('_listItemAncestor: текстовый узел внутри <li> → сам <li>; вне списка → null', () => {
  const editor = parseHtml('<ul><li>a</li></ul><p>вне</p>');
  const m = mgr();
  const li = editor.querySelector('li');
  assert.equal(m._listItemAncestor(li.firstChild, editor), li);
  assert.equal(m._listItemAncestor(editor.querySelector('p').firstChild, editor), null);
  assert.equal(m._listItemAncestor(null, editor), null);
});

test('MAX_LIST_LEVEL = 8 (9 уровней w:abstractNum в OOXML)', () => {
  assert.equal(MAX_LIST_LEVEL, 8);
});

// ── политика Tab / Shift+Tab ─────────────────────────────────────────────────

/**
 * @param {string} html Разметка редактора.
 * @param {string} caretSelector Селектор элемента, в текст которого встаёт каретка.
 * @returns {{m: object, editor: object, cmds: string[], restore: () => void}}
 */
function withCaretIn(html, caretSelector) {
  const editor = parseHtml(html);
  const target = caretSelector === ':root' ? editor : editor.querySelector(caretSelector);
  const cmds = [];
  const m = mgr();
  m.activeEditor = editor;
  m.execCommand = (cmd) => cmds.push(cmd);
  const origSel = globalThis.getSelection;
  globalThis.getSelection = () => ({
    rangeCount: 1,
    isCollapsed: true,
    getRangeAt: () => ({ startContainer: target.firstChild || target, startOffset: 0 }),
  });
  return { m, editor, cmds, restore: () => { globalThis.getSelection = origSel; } };
}

/** @returns {{key: string, shiftKey: boolean, prevented: boolean}} */
function tabEvent(shiftKey = false) {
  return {
    key: 'Tab',
    shiftKey,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
}

test('Tab внутри <li>: перехват + indent', () => {
  const { m, editor, cmds, restore } = withCaretIn('<ul><li>a</li></ul>', 'li');
  const e = tabEvent();
  try {
    assert.equal(m._handleListTab(e, editor), true);
  } finally { restore(); }
  assert.equal(e.prevented, true);
  assert.deepEqual(cmds, ['indent']);
});

test('Shift+Tab внутри вложенного <li>: перехват + outdent', () => {
  const editor = parseHtml('<ul><li>a<ul><li>b</li></ul></li></ul>');
  const nested = editor.querySelectorAll('li')[1];
  const m = mgr();
  const cmds = [];
  m.execCommand = (cmd) => cmds.push(cmd);
  const origSel = globalThis.getSelection;
  globalThis.getSelection = () => ({
    rangeCount: 1,
    isCollapsed: true,
    getRangeAt: () => ({ startContainer: nested.firstChild, startOffset: 0 }),
  });
  const e = tabEvent(true);
  try {
    assert.equal(m._handleListTab(e, editor), true);
  } finally { globalThis.getSelection = origSel; }
  assert.equal(e.prevented, true);
  assert.deepEqual(cmds, ['outdent']);
});

test('Tab ВНЕ списка: не перехватывается, preventDefault НЕ зовётся (нативный переход фокуса)', () => {
  const { m, editor, cmds, restore } = withCaretIn('<p>обычный текст</p>', 'p');
  const e = tabEvent();
  try {
    assert.equal(m._handleListTab(e, editor), false);
  } finally { restore(); }
  assert.equal(e.prevented, false, 'вне списка Tab обязан остаться нативным');
  assert.deepEqual(cmds, []);
});

test('Tab на потолке глубины (уровень 8): клавиша проглатывается, indent НЕ зовётся', () => {
  // 9 вложенных списков → самый глубокий <li> имеет уровень 8.
  let html = '<li>дно</li>';
  for (let i = 0; i < MAX_LIST_LEVEL + 1; i++) html = `<ul><li>u${i}${html}</li></ul>`;
  const editor = parseHtml(html);
  const deepest = editor.querySelectorAll('li').slice(-1)[0];
  const m = mgr();
  const cmds = [];
  m.execCommand = (cmd) => cmds.push(cmd);
  const origSel = globalThis.getSelection;
  globalThis.getSelection = () => ({
    rangeCount: 1,
    isCollapsed: true,
    getRangeAt: () => ({ startContainer: deepest.firstChild, startOffset: 0 }),
  });
  const e = tabEvent();
  try {
    assert.equal(m._listLevel(deepest, editor), MAX_LIST_LEVEL);
    assert.equal(m._handleListTab(e, editor), true, 'клавиша всё равно проглатывается');
  } finally { globalThis.getSelection = origSel; }
  assert.equal(e.prevented, true);
  assert.deepEqual(cmds, [], 'глубже потолка не уходим');
});

test('Tab на уровне 7 (под потолком): indent ещё разрешён', () => {
  let html = '<li>дно</li>';
  for (let i = 0; i < MAX_LIST_LEVEL; i++) html = `<ul><li>u${i}${html}</li></ul>`;
  const editor = parseHtml(html);
  const deepest = editor.querySelectorAll('li').slice(-1)[0];
  const m = mgr();
  const cmds = [];
  m.execCommand = (cmd) => cmds.push(cmd);
  const origSel = globalThis.getSelection;
  globalThis.getSelection = () => ({
    rangeCount: 1,
    isCollapsed: true,
    getRangeAt: () => ({ startContainer: deepest.firstChild, startOffset: 0 }),
  });
  try {
    assert.equal(m._listLevel(deepest, editor), MAX_LIST_LEVEL - 1);
    m._handleListTab(tabEvent(), editor);
  } finally { globalThis.getSelection = origSel; }
  assert.deepEqual(cmds, ['indent']);
});

test('handleEditorKeydown: Tab внутри <li> уходит в _handleListTab', () => {
  const editor = parseHtml('<ul><li>a</li></ul>');
  const m = mgr();
  const seen = [];
  m._handleListTab = (e) => { seen.push(e.key + (e.shiftKey ? '+shift' : '')); return true; };
  m.handleEditorKeydown(tabEvent(), editor, null);
  m.handleEditorKeydown(tabEvent(true), editor, null);
  assert.deepEqual(seen, ['Tab', 'Tab+shift']);
});

test('handleEditorKeydown: Tab с Ctrl/Alt не считается списочным (переключение поверхностей)', () => {
  const editor = parseHtml('<ul><li>a</li></ul>');
  const m = mgr();
  let called = 0;
  m._handleListTab = () => { called++; return true; };
  m.handleEditorKeydown({ ...tabEvent(), ctrlKey: true, preventDefault() {} }, editor, null);
  m.handleEditorKeydown({ ...tabEvent(), altKey: true, preventDefault() {} }, editor, null);
  assert.equal(called, 0);
});

// ── execCommand: гейт и нормализация на пути indent/outdent ──────────────────

/**
 * Ставит каретку в узел (стаб window.getSelection).
 * @param {object} node Узел, в котором стоит каретка.
 * @returns {() => void} Восстановление прежнего getSelection.
 */
function stubCaret(node) {
  const origSel = globalThis.getSelection;
  globalThis.getSelection = () => ({
    rangeCount: 1,
    isCollapsed: true,
    getRangeAt: () => ({ startContainer: node, startOffset: 0 }),
  });
  return () => { globalThis.getSelection = origSel; };
}

test('execCommand(indent): живой DOM нормализуется ДО saveContent', () => {
  const editor = parseHtml('<ul><li>пункт</li></ul>');
  const m = mgr();
  m.activeEditor = editor;
  editor.dataset.textBlockId = 'tb1';
  const saved = [];
  m.saveContent = (id, html) => saved.push(html);
  const restoreCaret = stubCaret(editor.querySelector('li').firstChild);
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = () => {
    // Имитируем результат нативной команды Chromium.
    editor.innerHTML = '<ul><li>a</li><ul><li>b</li></ul></ul>';
    return true;
  };
  try {
    m.execCommand('indent');
  } finally { globalThis.document.execCommand = origExec; restoreCaret(); }

  assert.equal(editor.innerHTML, '<ul><li>a<ul><li>b</li></ul></li></ul>');
  assert.deepEqual(saved, ['<ul><li>a<ul><li>b</li></ul></li></ul>']);
});

test('ГЕЙТ: execCommand(indent) вне <li> — нативная команда браузеру НЕ уходит, <blockquote> не появляется', () => {
  const editor = parseHtml('<p>обычный абзац</p>');
  const m = mgr();
  m.activeEditor = editor;
  editor.dataset.textBlockId = 'tb1';
  const saved = [];
  m.saveContent = (id, html) => saved.push(html);
  const restoreCaret = stubCaret(editor.querySelector('p').firstChild);
  const execCalls = [];
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = (cmd) => {
    execCalls.push(cmd);
    // Так ведёт себя Chromium: indent вне списка заворачивает абзац в
    // blockquote, которого НЕТ в allowlist санитайзера 'acts' → отступ молча
    // исчез бы на перезагрузке. Сюда мы попасть не должны.
    editor.innerHTML = '<blockquote style="margin: 0 0 0 40px"><p>обычный абзац</p></blockquote>';
    return true;
  };
  let result;
  try {
    result = m.execCommand('indent');
  } finally { globalThis.document.execCommand = origExec; restoreCaret(); }

  assert.deepEqual(execCalls, [], 'indent вне списка не должен уходить браузеру');
  assert.equal(result, false);
  assert.equal(editor.innerHTML, '<p>обычный абзац</p>');
  assert.equal(editor.innerHTML.indexOf('blockquote'), -1);
  assert.deepEqual(saved, [], 'no-op не пишет в модель');
});

test('ГЕЙТ: execCommand(outdent) вне <li> — тоже тихий no-op', () => {
  const editor = parseHtml('<p>обычный абзац</p>');
  const m = mgr();
  m.activeEditor = editor;
  editor.dataset.textBlockId = 'tb1';
  const saved = [];
  m.saveContent = (id, html) => saved.push(html);
  const restoreCaret = stubCaret(editor.querySelector('p').firstChild);
  const execCalls = [];
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = (cmd) => { execCalls.push(cmd); return true; };
  let result;
  try {
    result = m.execCommand('outdent');
  } finally { globalThis.document.execCommand = origExec; restoreCaret(); }

  assert.deepEqual(execCalls, []);
  assert.equal(result, false);
  assert.deepEqual(saved, []);
});

test('ГЕЙТ: внутри <li> команда уровня проходит к браузеру', () => {
  const editor = parseHtml('<ul><li>пункт</li></ul>');
  const m = mgr();
  m.activeEditor = editor;
  editor.dataset.textBlockId = 'tb1';
  m.saveContent = () => {};
  const restoreCaret = stubCaret(editor.querySelector('li').firstChild);
  const execCalls = [];
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = (cmd) => { execCalls.push(cmd); return true; };
  try {
    m.execCommand('indent');
    m.execCommand('outdent');
  } finally { globalThis.document.execCommand = origExec; restoreCaret(); }

  assert.deepEqual(execCalls, ['indent', 'outdent']);
});

test('ГЕЙТ: списочные команды создания списка (insertUnorderedList) НЕ гейтятся', () => {
  // Создание списка стартует ИМЕННО вне <li> — гейт уровня их не касается.
  const editor = parseHtml('<p>обычный абзац</p>');
  const m = mgr();
  m.activeEditor = editor;
  editor.dataset.textBlockId = 'tb1';
  m.saveContent = () => {};
  const restoreCaret = stubCaret(editor.querySelector('p').firstChild);
  const execCalls = [];
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = (cmd) => { execCalls.push(cmd); return true; };
  try {
    m.execCommand('insertUnorderedList');
    m.execCommand('insertOrderedList');
  } finally { globalThis.document.execCommand = origExec; restoreCaret(); }

  assert.deepEqual(execCalls, ['insertUnorderedList', 'insertOrderedList']);
});

test('execCommand(bold): нормализация списков не запускается (не структурная команда)', () => {
  const editor = parseHtml('<ul><li>a</li><ul><li>b</li></ul></ul>');
  const m = mgr();
  m.activeEditor = editor;
  editor.dataset.textBlockId = 'tb1';
  m.saveContent = () => {};
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = () => true;
  try {
    m.execCommand('bold');
  } finally { globalThis.document.execCommand = origExec; }
  assert.equal(editor.innerHTML, '<ul><li>a</li><ul><li>b</li></ul></ul>',
    'bold не обязан чинить чужую разметку — чинит сток saveContent');
});

// ── санитайзер ───────────────────────────────────────────────────────────────

test('санитайзер: ul/ol/li в allowlist профиля acts (вложенность резать нечему)', () => {
  const tags = SAFE_HTML_PROFILES.acts.ALLOWED_TAGS;
  for (const tag of ['ul', 'ol', 'li']) {
    assert.ok(tags.includes(tag), `${tag} должен быть разрешён профилем acts`);
  }
  // DOMPurify в node нет (window.DOMPurify не грузится) → сквозной прогон
  // SafeHTML.sanitize живёт в Playwright. Здесь фиксируем то, от чего он
  // зависит: конфиг профиля не содержит ключей, режущих содержимое тегов.
  assert.equal(SAFE_HTML_PROFILES.acts.FORBID_CONTENTS, undefined);
  assert.equal(SAFE_HTML_PROFILES.acts.KEEP_CONTENT, undefined);
});
