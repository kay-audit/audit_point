/**
 * D2: «Очистить форматирование» снимает не только inline-формат (это делает
 * нативный execCommand('removeFormat')), но и БЛОЧНЫЙ — список разворачивается
 * в абзацы, выравнивание и отступы снимаются.
 *
 * ИНВАРИАНТ (спека §6): капсулы ссылок/сносок обязаны выжить — блочный проход
 * их не разбирает и не чистит их атрибуты. Контракт вокруг самой команды
 * (какая строка уходит браузеру, отсутствие removeFormat в FORMAT_CMDS) —
 * в textblock-remove-format.test.mjs, здесь только новый блочный слой.
 *
 * ОГРАНИЧЕНИЕ ХАРНЕССА: дерево — `_mini-dom.mjs` (jsdom в проекте нет),
 * нативная часть команды в node не исполняется; сквозной прогон — Playwright.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml, installMiniDom } from './_mini-dom.mjs';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import '../../static/js/constructor/textblock/textblock-editor.js';

installMiniDom();

const mgr = () => Object.create(TextBlockManager.prototype);

/** Прогоняет блочную очистку и возвращает получившийся HTML. */
function clean(html) {
  const editor = parseHtml(html);
  mgr()._removeBlockFormat(editor);
  return editor.innerHTML;
}

// ── списки ───────────────────────────────────────────────────────────────────

test('список разворачивается в абзацы: пункты разделены <br>', () => {
  assert.equal(clean('<ul><li>раз</li><li>два</li></ul>'), 'раз<br>два');
  assert.equal(clean('<ol><li>раз</li><li>два</li></ol>'), 'раз<br>два');
});

test('вложенный список разворачивается вместе с внешним, порядок строк сохранён', () => {
  assert.equal(
    clean('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>'),
    'a<br>b<br>c',
  );
});

test('список после текста отделяется переносом', () => {
  assert.equal(clean('<p>текст</p><ul><li>a</li></ul>'), '<p>текст</p><br>a');
});

test('inline-формат внутри пункта переживает разворот (его снимает нативная команда)', () => {
  assert.equal(clean('<ul><li><b>жир</b>ный</li></ul>'), '<b>жир</b>ный');
});

// ── выравнивание и отступы ───────────────────────────────────────────────────

test('text-align снимается, пустой style-атрибут исчезает', () => {
  assert.equal(clean('<p style="text-align: center">центр</p>'), '<p>центр</p>');
  assert.equal(clean('<div style="text-align: right">право</div>'), '<div>право</div>');
});

test('text-align снимается и с корня редактора (contenteditable сам его носит)', () => {
  const editor = parseHtml('текст');
  editor.style.textAlign = 'center';
  mgr()._removeBlockFormat(editor);
  assert.equal(editor.style.textAlign, '');
});

test('отступы (margin-left/padding-left/text-indent) снимаются, прочий style цел', () => {
  assert.equal(
    clean('<p style="margin-left: 40px; text-indent: 20px; color: red">x</p>'),
    '<p style="color: red">x</p>',
  );
  assert.equal(clean('<div style="padding-left: 40px">x</div>'), '<div>x</div>');
});

test('blockquote (артефакт indent вне списка) разворачивается', () => {
  assert.equal(
    clean('<blockquote style="margin: 0 0 0 40px">отступ</blockquote>'),
    'отступ',
  );
});

test('атрибут align снимается', () => {
  assert.equal(clean('<p align="center">x</p>'), '<p>x</p>');
});

test('font-size на span не трогаем — это работа нативного removeFormat', () => {
  assert.equal(
    clean('<ul><li><span style="font-size: 18px">крупно</span></li></ul>'),
    '<span style="font-size: 18px">крупно</span>',
  );
});

// ── инвариант капсул ─────────────────────────────────────────────────────────

test('ИНВАРИАНТ: капсулы ссылки и сноски внутри списка выживают целиком', () => {
  const out = clean(
    '<ul style="text-align: center">'
    + '<li><span class="text-link" data-link-id="L1" data-link-url="http://x">ссылка</span></li>'
    + '<li><span class="text-footnote" data-footnote-id="F1" data-footnote-text="тело сноски">сн</span></li>'
    + '</ul>',
  );
  assert.match(out, /class="text-link"/);
  assert.match(out, /data-link-url="http:\/\/x"/);
  assert.match(out, /data-link-id="L1"/);
  assert.match(out, /class="text-footnote"/);
  assert.match(out, /data-footnote-text="тело сноски"/);
  assert.match(out, /data-footnote-id="F1"/);
  assert.equal(out.indexOf('<li>'), -1, 'список должен быть развёрнут');
});

test('ИНВАРИАНТ: у капсулы не чистится style (её внутренняя геометрия — не блочный формат)', () => {
  const out = clean(
    '<p style="text-align: center">'
    + '<span class="text-link" data-link-url="http://x" style="text-indent: 5px">L</span></p>',
  );
  assert.match(out, /<span class="text-link" data-link-url="http:\/\/x" style="text-indent: 5px">/);
  assert.equal(out.indexOf('text-align'), -1);
});

// ── скоуп по выделению ───────────────────────────────────────────────────────

/**
 * Диапазон-скоуп для _removeBlockFormat. Настоящего Range в node нет (мини-DOM
 * его не эмулирует), но методу нужны ровно три вещи: collapsed, startContainer
 * и intersectsNode — их и подменяем. Границы корня (_rangeCoversContents)
 * считать нечем (нет document.createRange) → корень остаётся нетронутым, что
 * для частичного выделения и требуется.
 * @param {object[]} nodes Узлы, которые диапазон «пересекает».
 * @returns {object}
 */
function fakeRange(nodes) {
  return { collapsed: false, intersectsNode: (el) => nodes.includes(el) };
}

test('СКОУП: частичное выделение вне списка — список НЕ разворачивается', () => {
  // Регрессия: проход по всему блоку сносил все списки из-за одного выделенного
  // жирного слова — и тут же персистил это через saveContent.
  const editor = parseHtml('<p><b>жирное</b> слово</p><ul><li>раз</li><li>два</li></ul>');
  const bold = editor.querySelector('b');
  mgr()._removeBlockFormat(editor, fakeRange([editor.querySelector('p'), bold]));
  assert.equal(editor.innerHTML, '<p><b>жирное</b> слово</p><ul><li>раз</li><li>два</li></ul>');
});

test('СКОУП: выделение внутри одного списка — соседний список цел', () => {
  const editor = parseHtml('<ul><li>раз</li></ul><ol><li>один</li></ol>');
  const target = editor.querySelector('ul');
  mgr()._removeBlockFormat(editor, fakeRange([target, ...target.querySelectorAll('*')]));
  assert.equal(editor.innerHTML, 'раз<ol><li>один</li></ol>');
});

test('СКОУП: выравнивание снимается только с пересечённых элементов', () => {
  const editor = parseHtml(
    '<p style="text-align: center">в выделении</p><div style="text-align: right">вне</div>',
  );
  mgr()._removeBlockFormat(editor, fakeRange([editor.querySelector('p')]));
  assert.equal(editor.innerHTML, '<p>в выделении</p><div style="text-align: right">вне</div>');
});

test('СКОУП: схлопнутая каретка — только её блочные предки, соседний список цел', () => {
  const editor = parseHtml(
    '<ul style="text-align: center"><li>раз</li></ul><ul><li>сосед</li></ul>',
  );
  const caret = editor.querySelector('li').firstChild;
  mgr()._removeBlockFormat(editor, { collapsed: true, startContainer: caret });
  assert.equal(editor.innerHTML, 'раз<ul><li>сосед</li></ul>');
});

test('СКОУП: корень редактора при частичном выделении НЕ чистится', () => {
  const editor = parseHtml('<p>текст</p>');
  editor.style.textAlign = 'center';
  mgr()._removeBlockFormat(editor, fakeRange([editor.querySelector('p')]));
  assert.equal(editor.style.textAlign, 'center', 'text-align корня — не в скоупе выделения');
});

// ── устойчивость и идемпотентность ───────────────────────────────────────────

test('повторный прогон ничего не меняет (идемпотентность)', () => {
  const once = clean('<ul><li>a<ul><li>b</li></ul></li></ul>');
  assert.equal(clean(once), once);
});

test('редактор без DOM-API (старый фейк из тестов) не роняет очистку', () => {
  assert.doesNotThrow(() => mgr()._removeBlockFormat({ innerHTML: '<b>x</b>' }));
  assert.doesNotThrow(() => mgr()._removeBlockFormat(null));
});

test('execCommand(removeFormat): блочная очистка отрабатывает ДО saveContent', () => {
  const editor = parseHtml('<ul><li>раз</li><li>два</li></ul>');
  editor.dataset.textBlockId = 'tb1';
  const m = mgr();
  m.activeEditor = editor;
  const saved = [];
  m.saveContent = (id, html) => saved.push(html);
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = () => true;
  try {
    m.execCommand('removeFormat');
  } finally { globalThis.document.execCommand = origExec; }

  assert.deepEqual(saved, ['раз<br>два']);
  assert.equal(editor.innerHTML, 'раз<br>два');
});
