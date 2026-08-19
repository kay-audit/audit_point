/**
 * B-24/B-2: applyFontSize без execCommand/font[size=7].
 *  - С выделением: размер накладывается ПОУЗЛОВО (каждый текстовый узел — свой
 *    span), содержимое диапазона НЕ вырезается. Прежняя реализация звала
 *    range.extractContents() и заворачивала фрагмент в один span — на выделении
 *    через несколько <li> это оставляло в списке пустые пункты-огрызки, а сами
 *    пункты уезжали внутрь span (разметка, которую не понимают ни превью, ни
 *    DOCX). Живая проверка результата — playwright-спека 31.
 *  - На каретке (collapsed): материализует размер в content span'ом с ZWSP-якорем,
 *    а НЕ в editor.style (флагман data-loss B-2 — стиль контейнера в innerHTML
 *    не попадает и терялся при reload/preview/export).
 *  - Единица размера — ПУНКТЫ: выбранное пользователем число уходит в Word как
 *    есть (экранную читаемость даёт zoom поверхности, а не подмена кегля).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import '../../static/js/constructor/textblock/textblock-toolbar.js';

/** Минимальная заглушка span/элемента, читаемая applyFontSize. */
function makeSpanStub() {
  return {
    style: {},
    _children: [],
    firstChild: null,
    classList: { contains: () => false },
    appendChild(node) {
      this._children.push(node);
      if (!this.firstChild) this.firstChild = node;
      return node;
    },
    querySelectorAll: () => [],
    getAttribute: () => null,
    setAttribute() {},
    removeAttribute() {},
  };
}

function installDom(createdSpans) {
  globalThis.window = globalThis;
  globalThis.document = {
    createElement: () => {
      const s = makeSpanStub();
      createdSpans.push(s);
      return s;
    },
    createRange: () => ({
      selectNodeContents() {},
      setStart() {},
      setEnd() {},
      collapse() {},
    }),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  };
}

function makeEditor() {
  return {
    dataset: { textBlockId: 'tb1' },
    innerHTML: '<p>x</p>',
    style: {},
    focus() {},
    // finalizeEdit (единый сток) опрашивает капсулы и число сносок.
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function makeManager(editor) {
  const mgr = Object.create(TextBlockManager.prototype);
  mgr.activeEditor = editor;
  mgr.fontSizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
  mgr.saved = [];
  mgr.saveContent = (id, content) => mgr.saved.push({ id, content });
  // _toggleEmptyClass живёт в textblock-editor.js (тут не импортирован) — стаб.
  mgr._toggleEmptyClass = () => {};
  mgr.updateToolbarState = () => {};
  return mgr;
}

/** Текстовый узел с рабочим splitText — без авто-правки живых диапазонов. */
function makeText(t) {
  return {
    nodeType: 3,
    textContent: t,
    parentElement: null,
    splitText(offset) {
      const tail = makeText(this.textContent.slice(offset));
      this.textContent = this.textContent.slice(0, offset);
      return tail;
    },
  };
}

test('B-24: выделение НЕ вырезается — размер накладывается поузлово', () => {
  const editor = makeEditor();
  const mgr = makeManager(editor);
  const createdSpans = [];
  installDom(createdSpans);

  let extracted = false;
  const boundary = makeText('текст');
  const range = {
    startContainer: boundary,
    endContainer: boundary,
    startOffset: 0,
    endOffset: 5,
    extractContents() { extracted = true; return { _kind: 'fragment' }; },
    insertNode() {},
  };
  globalThis.getSelection = () => ({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges() {},
    addRange() {},
  });

  let appliedPt = null;
  mgr._applySizeToRange = (_range, pt) => { appliedPt = pt; return { first: null, last: null }; };

  mgr.applyFontSize(20);

  assert.equal(extracted, false, 'extractContents звать нельзя — он и плодил пустые <li>');
  assert.equal(appliedPt, 20, 'размер уходит в поузловое применение');
  assert.equal(editor.style.fontSize, undefined, 'editor.style НЕ трогаем при выделении');
  assert.equal(mgr.saved.length, 1);
});

test('_splitRangeEdges: частично выделенный узел режется по обоим краям', () => {
  const mgr = makeManager(makeEditor());
  installDom([]);

  const node = makeText('abcdef');
  const calls = { start: null, end: null };
  const range = {
    startContainer: node, startOffset: 2,
    endContainer: node, endOffset: 4,
    setStart(n, o) { this.startContainer = n; this.startOffset = o; calls.start = [n, o]; },
    setEnd(n, o) { this.endContainer = n; this.endOffset = o; calls.end = [n, o]; },
  };

  mgr._splitRangeEdges(range);

  assert.equal(node.textContent, 'ab', 'голова до выделения осталась в исходном узле');
  assert.equal(range.startContainer.textContent, 'cd', 'выделение выделено в свой узел');
  assert.equal(range.startOffset, 0);
  assert.equal(range.endContainer, range.startContainer, 'оба края — на одном узле');
  assert.equal(range.endOffset, 2, 'конец — на длине выделенного куска');
});

test('_splitRangeEdges: узел, выделенный целиком, не режется', () => {
  const mgr = makeManager(makeEditor());
  installDom([]);

  const node = makeText('abc');
  let touched = false;
  const range = {
    startContainer: node, startOffset: 0,
    endContainer: node, endOffset: 3,
    setStart() { touched = true; },
    setEnd() { touched = true; },
  };

  mgr._splitRangeEdges(range);

  assert.equal(node.textContent, 'abc');
  assert.equal(touched, false, 'резать нечего — границы совпадают с краями узла');
});

test('B-2: размер на каретке материализуется span+ZWSP в content, НЕ в editor.style', () => {
  const editor = makeEditor();
  const mgr = makeManager(editor);
  const createdSpans = [];
  installDom(createdSpans);

  let inserted = null;
  const range = { insertNode(node) { inserted = node; } };
  globalThis.getSelection = () => ({
    isCollapsed: true,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges() {},
    addRange() {},
  });

  mgr.applyFontSize(28);

  assert.ok(inserted, 'span с размером должен быть вставлен в каретку');
  assert.equal(inserted.style.fontSize, '28pt');
  // Флагман B-2: editor.style.fontSize НЕ выставляется.
  assert.equal(editor.style.fontSize, undefined);
  // ZWSP-якорь добавлен внутрь span (будущий ввод унаследует размер).
  assert.equal(inserted._children.length, 1);
  assert.equal(inserted._children[0].textContent, '​');
  assert.equal(mgr.saved.length, 1);
});

test('размер клампится по границам шрифта (выходит за max → не применяется буквально)', () => {
  const editor = makeEditor();
  const mgr = makeManager(editor);
  const createdSpans = [];
  installDom(createdSpans);

  let inserted = null;
  const range = { insertNode(node) { inserted = node; } };
  globalThis.getSelection = () => ({
    isCollapsed: true,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges() {},
    addRange() {},
  });

  mgr.applyFontSize(999);

  assert.ok(inserted);
  // 999 зажат к максимуму палитры/границ (≤ 72).
  assert.ok(parseInt(inserted.style.fontSize) <= 72);
});
