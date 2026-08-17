/**
 * Многоуровневые списки в rich-редакторе (спека §4).
 *
 *  - собственный indent (_indentListItem вместо нативного execCommand):
 *    пункт целиком уезжает в подсписок ПРЕДЫДУЩЕГО пункта — существующий того
 *    же типа (нумерация продолжается) либо новый; первый пункт уровня не
 *    углубляется вовсе (пустой <li>-хост больше не выдумывается);
 *  - нормализация вложенности (страховка paste/undo/старого контента):
 *    НЕВАЛИДНОЕ `<ul><li>a</li><ul><li>b</li></ul></ul>` (список прямо внутри
 *    списка, минуя <li>) → валидное `<ul><li>a<ul>…</ul></li></ul>`; список-
 *    сирота без предыдущего <li> разворачивается на уровень вверх; соседние
 *    подсписки одного типа внутри <li> сливаются;
 *  - политика Tab/Shift+Tab: перехват ТОЛЬКО внутри <li>, вне списка нативный
 *    переход фокуса сохраняется (preventDefault не зовётся);
 *  - потолок глубины — настройка (ACTS__TEXTBLOCKS__MAX_LIST_LEVEL, дефолт 4),
 *    прижатая жёстким пределом формата (уровень 8 = 9 уровней w:abstractNum).
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
import '../../static/js/constructor/textblock/textblock-editor.js';
import { SAFE_HTML_PROFILES } from '../../static/js/shared/sanitize.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { ChangelogTracker } from '../../static/js/constructor/changelog-tracker.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import {
  getStructureLimits,
  resetImageLimitsForTests,
} from '../../static/js/constructor/violation/violation-image-validator.js';

installMiniDom();
// saveContent тянет побочные эффекты (патч превью + дебаунс-таймер changelog) —
// в node они не нужны и таймер держал бы процесс живым.
PreviewManager.updateBlock = () => {};
ChangelogTracker._recordDebounced = () => {};

const mgr = () => Object.create(TextBlockManager.prototype);

/** Действующий потолок глубины (фолбэк AppConfig — ответа /acts/limits в node нет). */
const CEILING = mgr()._listLevelCeiling();

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

test('нормализация: список-сирота (нет предыдущего <li>) разворачивается на уровень вверх', () => {
  // Раньше здесь создавался ПУСТОЙ <li>-хост. Его маркер рисовался отдельным
  // пунктом — при повторном indent такие хосты копились и выстраивались в одну
  // строку («a) i. 1. Текст»), а MD/TXT получали фантомную строку с маркером.
  assert.equal(
    normalizeDom('<ul><ul><li>b</li></ul></ul>'),
    '<ul><li>b</li></ul>',
  );
});

test('нормализация: сирота разворачивается, следующий список уезжает в появившийся <li>', () => {
  assert.equal(
    normalizeDom('<ul><ul><li>b</li></ul><ul><li>c</li></ul></ul>'),
    '<ul><li>b<ul><li>c</li></ul></li></ul>',
  );
});

test('нормализация: пустых <li> не остаётся ни на одном уровне', () => {
  const out = normalizeDom('<ol><ol><li>x</li><ol><li>y</li></ol></ol></ol>');
  assert.equal(out.indexOf('<li><'), -1, 'пустой <li>-хост не создаётся');
  assert.equal(out, '<ol><li>x<ol><li>y</li></ol></li></ol>');
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

test('нормализация: два соседних невалидных списка РАЗНОГО типа уходят в один <li>, но не сливаются', () => {
  // ul рядом с ol — два разных подсписка пункта, слияние сменило бы тип
  // маркеров половине пунктов.
  assert.equal(
    normalizeDom('<ul><li>a</li><ul><li>b</li></ul><ol><li>1</li></ol></ul>'),
    '<ul><li>a<ul><li>b</li></ul><ol><li>1</li></ol></li></ul>',
  );
});

test('нормализация: соседние подсписки ОДНОГО типа внутри <li> сливаются в первый', () => {
  // Иначе второй <ol> нумеруется с начала («a) … a)») и в превью, и в DOCX.
  assert.equal(
    normalizeDom('<ol><li>a</li><ol><li>1</li></ol><ol><li>2</li></ol></ol>'),
    '<ol><li>a<ol><li>1</li><li>2</li></ol></li></ol>',
  );
});

test('нормализация: два ol-сиблинга в уже валидной разметке тоже сливаются (paste/undo)', () => {
  assert.equal(
    normalizeDom('<ol><li>a<ol><li>1</li></ol><ol><li>2</li></ol></li></ol>'),
    '<ol><li>a<ol><li>1</li><li>2</li></ol></li></ol>',
  );
});

test('нормализация: три подсписка ul-ol-ul внутри <li> сливаются только по соседству и типу', () => {
  assert.equal(
    normalizeDom('<ul><li>a<ul><li>b</li></ul><ol><li>1</li></ol><ul><li>c</li></ul></li></ul>'),
    '<ul><li>a<ul><li>b</li></ul><ol><li>1</li></ol><ul><li>c</li></ul></li></ul>',
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

test('_listLevelCeiling: дефолт 4 — фолбэк AppConfig, зеркало ACTS__TEXTBLOCKS__MAX_LIST_LEVEL', () => {
  assert.equal(AppConfig.limits.textblock.maxListLevel, 4);
  assert.equal(getStructureLimits().maxListLevel, 4);
  assert.equal(mgr()._listLevelCeiling(), 4);
});

test('_listLevelCeiling: настройка читается в момент проверки и прижимается пределом формата', () => {
  const limits = getStructureLimits(); // живой объект (сюда пишет /acts/limits)
  try {
    limits.maxListLevel = 2;
    assert.equal(mgr()._listLevelCeiling(), 2, 'значение настройки берётся вызовом, не с импорта');
    // Жёсткий предел — 9 уровней w:abstractNum в OOXML (DOCX клампит на ilvl 8).
    limits.maxListLevel = 99;
    assert.equal(mgr()._listLevelCeiling(), 8);
    limits.maxListLevel = 0;
    assert.equal(mgr()._listLevelCeiling(), 8, 'мусорное значение → жёсткий предел');
  } finally {
    resetImageLimitsForTests();
  }
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

/**
 * HTML из `depth+1` вложенных списков в ВАЛИДНОЙ форме: последний <li> («дно»)
 * имеет уровень depth. На самом глубоком уровне два пункта — у «дна» есть
 * предыдущий сиблинг, поэтому indent на нём упирается ровно в потолок глубины,
 * а не в правило «первый пункт уровня не углубляется».
 * @param {number} depth
 * @returns {string}
 */
function nestedListsHtml(depth) {
  let html = '<li>верх</li><li>дно</li>';
  for (let i = depth; i >= 1; i--) html = `<li>u${i}<ul>${html}</ul></li>`;
  return `<ul>${html}</ul>`;
}

test('Tab на потолке глубины: клавиша проглатывается, потолок держит гейт execCommand', () => {
  // Раньше потолок сравнивался ЗДЕСЬ (число знала только Tab-ветка), из-за чего
  // пункт меню «уровень глубже» углублял мимо него. Теперь _handleListTab
  // отвечает только за перехват клавиши и безусловно делегирует в execCommand,
  // где стоит единственное сравнение с _listLevelCeiling (тесты гейта ниже).
  const editor = parseHtml(nestedListsHtml(CEILING));
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
    assert.equal(m._listLevel(deepest, editor), CEILING);
    assert.equal(m._handleListTab(e, editor), true, 'клавиша всё равно проглатывается');
  } finally { globalThis.getSelection = origSel; }
  assert.equal(e.prevented, true, 'на дне списка Tab не должен уводить фокус');
  assert.deepEqual(cmds, ['indent']);
});

test('Tab на уровень под потолком: indent ещё разрешён', () => {
  const editor = parseHtml(nestedListsHtml(CEILING - 1));
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
    assert.equal(m._listLevel(deepest, editor), CEILING - 1);
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

/**
 * Прогоняет execCommand на дереве из html с кареткой в узле, выбранном
 * caretPick, и НЕ пускает нативную команду мимо счётчика вызовов.
 * @param {string} html Разметка редактора.
 * @param {(editor: object) => object} caretPick Узел каретки по дереву.
 * @param {string} command Команда.
 * @returns {{result: boolean, html: string, saved: string[], execCalls: string[]}}
 */
function runExecCommand(html, caretPick, command) {
  const editor = parseHtml(html);
  const m = mgr();
  m.activeEditor = editor;
  editor.dataset.textBlockId = 'tb1';
  const saved = [];
  m.saveContent = (id, content) => saved.push(content);
  const restoreCaret = stubCaret(caretPick(editor));
  const execCalls = [];
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = (cmd) => { execCalls.push(cmd); return true; };
  let result;
  try {
    result = m.execCommand(command);
  } finally { globalThis.document.execCommand = origExec; restoreCaret(); }
  return { result, html: editor.innerHTML, saved, execCalls };
}

test('execCommand(indent): пункт уезжает в подсписок предыдущего, нативная команда НЕ идёт', () => {
  // Углубление делает _indentListItem: нативный indent порождал список-сироту,
  // из которого валидную форму без пустого <li>-хоста уже не собрать.
  const r = runExecCommand(
    '<ul><li>a</li><li>b</li></ul>',
    (ed) => ed.querySelectorAll('li')[1].firstChild,
    'indent',
  );
  assert.deepEqual(r.execCalls, [], 'indent исполняется своим кодом, не браузером');
  assert.equal(r.result, true);
  assert.equal(r.html, '<ul><li>a<ul><li>b</li></ul></li></ul>');
  assert.deepEqual(r.saved, ['<ul><li>a<ul><li>b</li></ul></li></ul>'], 'сток модели тот же');
});

test('БАГ-1: indent первого пункта уровня — no-op, пустой <li>-хост не создаётся', () => {
  const r = runExecCommand(
    '<ul><li>пункт</li></ul>',
    (ed) => ed.querySelector('li').firstChild,
    'indent',
  );
  assert.deepEqual(r.execCalls, []);
  assert.equal(r.result, false);
  assert.equal(r.html, '<ul><li>пункт</li></ul>', 'разметка не изменилась вовсе');
  assert.deepEqual(r.saved, [], 'no-op не пишет в модель');
});

test('БАГ-1: повторный indent того же пункта не копит уровни и пустые пункты', () => {
  const editor = parseHtml('<ul><li>a</li><li>b</li></ul>');
  const m = mgr();
  m.activeEditor = editor;
  editor.dataset.textBlockId = 'tb1';
  m.saveContent = () => {};
  const caretNode = editor.querySelectorAll('li')[1].firstChild;
  const restoreCaret = stubCaret(caretNode);
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = () => true;
  try {
    assert.equal(m.execCommand('indent'), true);
    // Второй раз: пункт b — теперь единственный в своём подсписке, углублять
    // нечего. Раньше здесь появлялся пустой хост, и маркеры хостов копились
    // в строку «a) i. 1. Текст».
    assert.equal(m.execCommand('indent'), false);
    assert.equal(m.execCommand('indent'), false);
  } finally { globalThis.document.execCommand = origExec; restoreCaret(); }

  assert.equal(editor.innerHTML, '<ul><li>a<ul><li>b</li></ul></li></ul>');
  assert.equal(
    editor.querySelectorAll('li').every((li) => li.textContent.trim() !== ''),
    true,
    'пунктов без собственного содержимого нет',
  );
});

test('БАГ-2: indent соседнего пункта продолжает СУЩЕСТВУЮЩИЙ подсписок того же типа', () => {
  // Раньше в <li> появлялся второй ol-сиблинг, и его нумерация стартовала
  // заново («a)» вместо «b)») — и в превью, и в DOCX.
  const r = runExecCommand(
    '<ol><li>a<ol><li>a1</li></ol></li><li>b</li></ol>',
    (ed) => ed.querySelectorAll('li')[2].firstChild,
    'indent',
  );
  assert.equal(r.result, true);
  assert.equal(r.html, '<ol><li>a<ol><li>a1</li><li>b</li></ol></li></ol>');
  assert.equal(r.html.match(/<ol>/g).length, 2, 'второго подсписка не появилось');
});

test('indent: подсписок ДРУГОГО типа не переиспользуется — создаётся свой', () => {
  const r = runExecCommand(
    '<ol><li>a<ul><li>x</li></ul></li><li>b</li></ol>',
    (ed) => ed.querySelectorAll('li')[2].firstChild,
    'indent',
  );
  assert.equal(r.result, true);
  assert.equal(r.html, '<ol><li>a<ul><li>x</li></ul><ol><li>b</li></ol></li></ol>');
});

test('execCommand(outdent): живой DOM нормализуется ДО saveContent', () => {
  // outdent остался нативным — за ним по-прежнему нужна нормализация
  // (Chromium кладёт список прямо внутрь списка, минуя <li>).
  const editor = parseHtml('<ul><li>a<ul><li>b</li></ul></li></ul>');
  const m = mgr();
  m.activeEditor = editor;
  editor.dataset.textBlockId = 'tb1';
  const saved = [];
  m.saveContent = (id, html) => saved.push(html);
  const restoreCaret = stubCaret(editor.querySelectorAll('li')[1].firstChild);
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = () => {
    // Имитируем результат нативной команды Chromium.
    editor.innerHTML = '<ul><li>a</li><ul><li>b</li></ul></ul>';
    return true;
  };
  try {
    m.execCommand('outdent');
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

test('ГЕЙТ: внутри <li> outdent проходит к браузеру (indent исполняется своим кодом)', () => {
  const r = runExecCommand(
    '<ul><li>пункт</li></ul>',
    (ed) => ed.querySelector('li').firstChild,
    'outdent',
  );
  assert.deepEqual(r.execCalls, ['outdent']);
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

test('ГЕЙТ: indent на потолке глубины — разметка не меняется, в модель не пишется', () => {
  // Пункт меню «уровень глубже» приходит сюда же, что и Tab, — потолок обязан
  // держаться на общем гейте. У «дна» есть предыдущий сиблинг, т.е. углубление
  // было бы возможно: остановил его именно потолок.
  const before = nestedListsHtml(CEILING);
  const r = runExecCommand(
    before,
    (ed) => ed.querySelectorAll('li').slice(-1)[0].firstChild,
    'indent',
  );
  assert.deepEqual(r.execCalls, []);
  assert.equal(r.result, false);
  assert.equal(r.html, before);
  assert.deepEqual(r.saved, []);
});

test('ГЕЙТ: outdent на потолке разрешён (наверх из потолка выходить можно)', () => {
  const editor = parseHtml(nestedListsHtml(CEILING));
  const deepest = editor.querySelectorAll('li').slice(-1)[0];
  const m = mgr();
  m.activeEditor = editor;
  editor.dataset.textBlockId = 'tb1';
  m.saveContent = () => {};
  const restoreCaret = stubCaret(deepest.firstChild);
  const execCalls = [];
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = (cmd) => { execCalls.push(cmd); return true; };
  try {
    m.execCommand('outdent');
  } finally { globalThis.document.execCommand = origExec; restoreCaret(); }

  assert.deepEqual(execCalls, ['outdent']);
});

test('ГЕЙТ: indent на уровень под потолком — исполняется, глубина растёт ровно до потолка', () => {
  const editor = parseHtml(nestedListsHtml(CEILING - 1));
  const deepest = editor.querySelectorAll('li').slice(-1)[0];
  const m = mgr();
  m.activeEditor = editor;
  editor.dataset.textBlockId = 'tb1';
  const saved = [];
  m.saveContent = (id, html) => saved.push(html);
  const restoreCaret = stubCaret(deepest.firstChild);
  const execCalls = [];
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = (cmd) => { execCalls.push(cmd); return true; };
  let result;
  try {
    result = m.execCommand('indent');
  } finally { globalThis.document.execCommand = origExec; restoreCaret(); }

  assert.deepEqual(execCalls, [], 'нативная команда не нужна — indent свой');
  assert.equal(result, true);
  assert.equal(m._listLevel(deepest, editor), CEILING);
  assert.equal(saved.length, 1);
});

// ── range, заякоренный на ЭЛЕМЕНТЕ (Ctrl+A) ──────────────────────────────────

test('_caretListItem: range на самом редакторе (Ctrl+A) резолвится в первый <li> списка', () => {
  const editor = parseHtml('<ul><li>a</li><li>b</li></ul>');
  const m = mgr();
  const first = editor.querySelector('li');
  // Chrome при Ctrl+A якорит range на элементе редактора с offset 0 — сырой
  // _listItemAncestor от такого узла в цикл не входит и отдаёт null.
  assert.equal(m._listItemAncestor(editor, editor), null);
  assert.equal(m._caretListItem({ startContainer: editor, startOffset: 0 }, editor), first);
});

test('_caretListItem: range на самом <ul> резолвится в его первый <li>', () => {
  const editor = parseHtml('<ul><li>a</li><li>b</li></ul>');
  const m = mgr();
  const list = editor.querySelector('ul');
  const items = editor.querySelectorAll('li');
  assert.equal(m._caretListItem({ startContainer: list, startOffset: 0 }, editor), items[0]);
  assert.equal(m._caretListItem({ startContainer: list, startOffset: 1 }, editor), items[1]);
});

test('_caretListItem: вне списка → null (нативный Tab обязан остаться нативным)', () => {
  const editor = parseHtml('<p>обычный текст</p>');
  const m = mgr();
  assert.equal(m._caretListItem({ startContainer: editor, startOffset: 0 }, editor), null);
  assert.equal(
    m._caretListItem({ startContainer: editor.querySelector('p').firstChild, startOffset: 0 }, editor),
    null,
  );
  assert.equal(m._caretListItem(null, editor), null);
});

test('ГЕЙТ: indent при range на редакторе (Ctrl+A над списком) — гейт не режет, работает по НАЧАЛУ диапазона', () => {
  // Гейт резолвит range, заякоренный на самом редакторе, в ПЕРВЫЙ <li> списка
  // (_caretListItem) — и дальше действует общее правило: первый пункт уровня не
  // углубляется, разметка остаётся прежней. Раньше сюда уходила нативная
  // команда, и Chromium давал список-сироту на весь список.
  const first = runExecCommand(
    '<ul><li>a</li><li>b</li></ul>',
    (ed) => ed, // startContainer — сам редактор
    'indent',
  );
  assert.deepEqual(first.execCalls, [], 'нативная команда не уходит');
  assert.equal(first.result, false);
  assert.equal(first.html, '<ul><li>a</li><li>b</li></ul>');

  // А когда началу диапазона есть куда углубляться — команда исполняется.
  const second = runExecCommand(
    '<ul><li>a</li><li>b</li><li>c</li></ul>',
    (ed) => ed.querySelector('ul'), // range на самом <ul>, offset 0 → первый <li>
    'outdent',
  );
  assert.deepEqual(second.execCalls, ['outdent'], 'outdent по такому range гейт пропускает');
});

test('_handleListTab: Tab при range на редакторе (Ctrl+A над списком) перехватывается', () => {
  const editor = parseHtml('<ul><li>a</li></ul>');
  const m = mgr();
  const cmds = [];
  m.execCommand = (cmd) => cmds.push(cmd);
  const origSel = globalThis.getSelection;
  globalThis.getSelection = () => ({
    rangeCount: 1,
    isCollapsed: false,
    getRangeAt: () => ({ startContainer: editor, startOffset: 0 }),
  });
  const e = tabEvent();
  try {
    assert.equal(m._handleListTab(e, editor), true);
  } finally { globalThis.getSelection = origSel; }
  assert.equal(e.prevented, true, 'Tab не должен уводить фокус из выделенного списка');
  assert.deepEqual(cmds, ['indent']);
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
