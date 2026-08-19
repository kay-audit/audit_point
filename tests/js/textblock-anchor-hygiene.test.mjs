/**
 * Task 12: гигиена невидимых якорей размера (CORE-5, TB-4) и палитра (TB-6).
 *  - CORE-5: повторная смена размера на каретке ПЕРЕИСПОЛЬЗУЕТ пустой якорь-span
 *    (U+200B + font-size), не вкладывает новый → мусорная вложенность не копится.
 *  - TB-4: zero-width-узлы (U+200B/U+FEFF) не примешивают размер в выделение
 *    (ложный «—»); осиротевший якорь чистится на save, якорь под кареткой живёт.
 *  - TB-6: normalizeFontSizes снапит к пересечению палитры и [min,max] из limits.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
// _isZeroWidthNode/_isCapsule/_cleanOrphanSizeAnchors живут в textblock-editor.js,
// на том же прототипе — импорт обязателен ДО вызова методов.
import '../../static/js/constructor/textblock/textblock-editor.js';
import {
  normalizeFontSizes,
} from '../../static/js/constructor/textblock/textblock-toolbar.js';

globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

const PALETTE = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** Стаб span-якоря: <span style="font-size:X">содержимое</span>. */
function makeSpan(fontSize, textContent, { capsule = false } = {}) {
  const el = {
    nodeType: 1,
    tagName: 'SPAN',
    style: { fontSize },
    classList: { contains: (c) => capsule && (c === 'text-link' || c === 'text-footnote') },
    textContent,
    removed: false,
    _caret: null,
    remove() { this.removed = true; },
    contains(n) { return n === this._caret; },
  };
  return el;
}

// ── CORE-5: переиспользование пустого якоря ──────────────────────────────────

test('CORE-5: _reusableSizeAnchor находит пустой якорь, в котором стоит каретка', () => {
  const zwsp = { nodeType: 3, textContent: '​', data: '​' };
  const editor = { contains: () => true };
  const anchor = makeSpan('18px', '​');
  anchor.parentElement = editor;
  zwsp.parentElement = anchor;

  const mgr = Object.create(TextBlockManager.prototype);
  mgr.activeEditor = editor;

  const found = mgr._reusableSizeAnchor({ startContainer: zwsp, startOffset: 1 });
  assert.equal(found, anchor);
});

test('CORE-5: span с реальным текстом — НЕ переиспользуемый якорь (размер там ставится обычным путём)', () => {
  const textNode = { nodeType: 3, textContent: 'привет', data: 'привет' };
  const editor = { contains: (el) => el !== editor };
  const span = makeSpan('18px', 'привет');
  span.parentElement = editor;
  textNode.parentElement = span;

  const mgr = Object.create(TextBlockManager.prototype);
  mgr.activeEditor = editor;

  const found = mgr._reusableSizeAnchor({ startContainer: textNode, startOffset: 3 });
  assert.equal(found, null);
});

test('CORE-5: applyFontSize на каретке в пустом якоре правит его font-size, НЕ вставляет новый span', () => {
  const zwsp = { nodeType: 3, textContent: '​', data: '​' };
  const editor = { contains: () => true, focus() {} };
  const anchor = makeSpan('18px', '​');
  anchor.firstChild = zwsp;
  anchor.parentElement = editor;
  zwsp.parentElement = anchor;

  const mgr = Object.create(TextBlockManager.prototype);
  mgr.activeEditor = editor;
  mgr.fontSizes = PALETTE;
  mgr.finalizeEdit = () => {};
  mgr.updateToolbarState = () => {};

  let insertedNew = false;
  const range = {
    startContainer: zwsp,
    startOffset: 1,
    insertNode: () => { insertedNew = true; },
  };
  globalThis.getSelection = () => ({
    isCollapsed: true, rangeCount: 1, getRangeAt: () => range,
    removeAllRanges() {}, addRange() {},
  });
  globalThis.document.createRange = () => ({ setStart() {}, collapse() {} });

  mgr.applyFontSize(24);

  assert.equal(anchor.style.fontSize, '24pt', 'font-size существующего якоря обновлён');
  assert.equal(insertedNew, false, 'новый span НЕ вставлен — вложенность не создаётся');
});

// ── TB-4: zero-width не примешивает размер в выделение ────────────────────────

test('TB-4: выделение с zero-width якорем не даёт ложный смешанный размер («—»)', () => {
  globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  // getComputedStyle всегда отдаёт px — размеры выделения читаются в пунктах
  // (×0.75), поэтому фикстура задаёт именно вычисленные пиксели.
  const realSpan = { _fs: '16px' };              // = 12pt
  const anchorSpan = { _fs: '96px' };            // осиротевший якорь размера, = 72pt
  const realText = { nodeType: 3, textContent: 'Раз', data: 'Раз', parentElement: realSpan };
  const zwspText = { nodeType: 3, textContent: '​', data: '​', parentElement: anchorSpan };
  const root = { nodeType: 1, _textNodes: [realText, zwspText] };

  const editor = { contains: () => true };
  const range = { commonAncestorContainer: root, intersectsNode: () => true };
  const selection = { getRangeAt: () => range };

  globalThis.document.createTreeWalker = (r, _what, filter) => {
    const all = r._textNodes || [];
    let i = 0;
    return {
      nextNode() {
        while (i < all.length) {
          const n = all[i++];
          if (filter.acceptNode(n) === globalThis.NodeFilter.FILTER_ACCEPT) return n;
        }
        return null;
      },
    };
  };
  globalThis.getComputedStyle = (el) => ({ fontSize: el._fs });

  const mgr = Object.create(TextBlockManager.prototype);
  mgr.activeEditor = editor;

  const sizes = mgr._getSelectedFontSizes(selection);
  assert.equal(sizes.size, 1, 'zero-width якорь НЕ примешал свой размер');
  assert.ok(sizes.has(12));
  assert.ok(!sizes.has(72), 'размер осиротевшего якоря (72pt) не учтён');
});

// ── TB-4: чистка осиротевших якорей на save, якорь под кареткой живёт ─────────

test('TB-4: осиротевший якорь чистится на save, якорь под кареткой живёт (B-2)', () => {
  const caretZwsp = { nodeType: 3, textContent: '​', data: '​' };

  const orphan = makeSpan('18px', '​');           // zero-width, БЕЗ каретки → удалить
  const caretAnchor = makeSpan('24px', '​');      // zero-width, каретка внутри → сохранить
  caretAnchor._caret = caretZwsp;
  const realSpan = makeSpan('14px', 'текст');          // реальный текст → не якорь → сохранить
  const capsule = makeSpan('30px', '​', { capsule: true }); // капсула → не трогать

  const editor = { querySelectorAll: () => [orphan, caretAnchor, realSpan, capsule] };
  globalThis.getSelection = () => ({
    rangeCount: 1, getRangeAt: () => ({ startContainer: caretZwsp }),
  });

  const mgr = Object.create(TextBlockManager.prototype);
  mgr._cleanOrphanSizeAnchors(editor);

  assert.equal(orphan.removed, true, 'осиротевший якорь удалён');
  assert.equal(caretAnchor.removed, false, 'якорь под кареткой сохранён (регрессия B-2 запрещена)');
  assert.equal(realSpan.removed, false, 'span с реальным текстом не тронут');
  assert.equal(capsule.removed, false, 'капсула не тронута');
});

test('blur (ignoreCaret): якорь ПОД кареткой тоже чистится — каретка покидает редактор', () => {
  const caretZwsp = { nodeType: 3, textContent: '​', data: '​' };
  const caretAnchor = makeSpan('24px', '​'); // zero-width, каретка внутри
  caretAnchor._caret = caretZwsp;
  const editor = { querySelectorAll: () => [caretAnchor] };
  // На blur Selection ещё может указывать внутрь якоря — ignoreCaret его игнорирует.
  globalThis.getSelection = () => ({
    rangeCount: 1, getRangeAt: () => ({ startContainer: caretZwsp }),
  });

  const mgr = Object.create(TextBlockManager.prototype);
  mgr._cleanOrphanSizeAnchors(editor, { ignoreCaret: true });

  assert.equal(caretAnchor.removed, true, 'на blur осиротевший якорь под кареткой снят (не утечёт в content)');
});

test('TB-4: без активной каретки (null selection) все осиротевшие якоря чистятся', () => {
  const orphan1 = makeSpan('18px', '​');
  const orphan2 = makeSpan('72px', '​​');
  const editor = { querySelectorAll: () => [orphan1, orphan2] };
  globalThis.getSelection = () => ({ rangeCount: 0, getRangeAt: () => null });

  const mgr = Object.create(TextBlockManager.prototype);
  mgr._cleanOrphanSizeAnchors(editor);

  assert.equal(orphan1.removed, true);
  assert.equal(orphan2.removed, true);
});

// ── B-2/removeFormat: якорь без span-обёртки (голый текстовый узел) ──────────

test('removeFormat-unwrap: голый текстовый узел из U+200B (без span) чистится, узел под кареткой жив (B-2)', () => {
  // Имитирует результат removeFormat: якорь-span развёрнут браузером в голый
  // текстовый узел с тем же U+200B — селектор span[style] его больше не
  // находит, чистка должна ловить и такой случай (на том же проходе).
  const orphanText = { nodeType: 3, data: '​', nextSibling: null, parentNode: null };
  const guardText = { nodeType: 3, data: '﻿', nextSibling: null, parentNode: null };
  const caretText = { nodeType: 3, data: '​', nextSibling: null, parentNode: null };
  orphanText.nextSibling = guardText;
  guardText.nextSibling = caretText;

  const removed = [];
  const block = {
    nodeType: 1,
    firstChild: orphanText,
    nextSibling: null,
    removeChild(n) {
      removed.push(n);
      if (n === orphanText) this.firstChild = guardText;
    },
  };
  [orphanText, guardText, caretText].forEach((n) => { n.parentNode = block; });

  const editor = { querySelectorAll: () => [], firstChild: block };
  globalThis.getSelection = () => ({
    rangeCount: 1, getRangeAt: () => ({ startContainer: caretText }),
  });

  const mgr = Object.create(TextBlockManager.prototype);
  mgr._cleanOrphanSizeAnchors(editor);

  assert.equal(removed.length, 1, 'удалён ровно один узел');
  assert.equal(removed[0], orphanText, 'удалён именно осиротевший U+200B-узел');
  assert.equal(guardText.data, '﻿', 'U+FEFF не тронут — его чистит _cleanCapGuards отдельно');
});

// ── TB-6: normalizeFontSizes уважает [min,max] ────────────────────────────────

/**
 * Мини-стаб <template>: парсит font-size:<N>pt из innerHTML в «элементы» с
 * читаемым/записываемым style.fontSize и реэмитит их в innerHTML — ровно то,
 * что читает normalizeFontSizes (браузерного парсера в node:test нет).
 */
function installTemplateDom() {
  const orig = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    if (tag !== 'template') return orig ? orig(tag) : {};
    let els = [];
    let html = '';
    return {
      set innerHTML(v) {
        html = v;
        els = [];
        const re = /font-size:\s*([\d.]+)pt/gi;
        let m;
        while ((m = re.exec(v)) !== null) els.push({ style: { fontSize: `${m[1]}pt` } });
      },
      get innerHTML() {
        let i = 0;
        return html.replace(/font-size:\s*[\d.]+pt/gi, () => `font-size: ${els[i++].style.fontSize}`);
      },
      content: { querySelectorAll: () => els },
    };
  };
}

test('TB-6: normalizeFontSizes снапит к пересечению палитры и [min,max]', () => {
  installTemplateDom();
  const textBlocks = {
    a: { content: '<span style="font-size: 72pt">x</span>' }, // 72 вне [10,24] → 24
    b: { content: '<span style="font-size: 4pt">y</span>' },  // 4  вне [10,24] → 10
    c: { content: '<span style="font-size: 18pt">z</span>' }, // 18 в диапазоне → без изменений
  };
  const res = normalizeFontSizes(textBlocks, PALETTE, { fontSizeMin: 10, fontSizeMax: 24 });

  assert.equal(res.changed, true);
  assert.ok(textBlocks.a.content.includes('font-size: 24pt'), textBlocks.a.content);
  assert.ok(textBlocks.b.content.includes('font-size: 10pt'), textBlocks.b.content);
  assert.ok(textBlocks.c.content.includes('font-size: 18pt'), textBlocks.c.content);
});

test('TB-6: значение в границах не меняется (в т.ч. дефолтные границы через getStructureLimits)', () => {
  installTemplateDom();
  // Границы не переданы → берутся из getStructureLimits() (дефолт 8..72 в node).
  const textBlocks = { a: { content: '<span style="font-size: 13pt">x</span>' } };
  const res = normalizeFontSizes(textBlocks, PALETTE);
  assert.equal(res.changed, true);
  // 13 → ближайший в полной палитре = 12 (обе дист 1, reduce берёт первый меньший).
  assert.ok(textBlocks.a.content.includes('font-size: 12pt'), textBlocks.a.content);
});

test('TB-6: пустое пересечение (границы уже палитры) → фолбэк + финальный кламп', () => {
  installTemplateDom();
  // Палитра [30,40], границы [10,24] — пересечение пусто; снап по палитре, затем
  // кламп к 24 (обе за верхней границей).
  const textBlocks = { a: { content: '<span style="font-size: 35pt">x</span>' } };
  const res = normalizeFontSizes(textBlocks, [30, 40], { fontSizeMin: 10, fontSizeMax: 24 });
  assert.equal(res.changed, true);
  assert.ok(textBlocks.a.content.includes('font-size: 24pt'), textBlocks.a.content);
});
