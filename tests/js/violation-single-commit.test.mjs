/**
 * V26: ровно ОДИН commit на паузу набора в rich-поле нарушения.
 *
 * Раньше на паузу набора коммит задваивался: write-through в EditorController._onInput
 * коммитил модель сразу на КАЖДЫЙ ввод, а debounce-мост (handleEditorInput →
 * finalizeEdit → active.commit()) — ещё раз через 500мс. Write-through для
 * capsule-поверхностей убран (V26): единственный путь коммита ввода — debounce-мост.
 * Свежесть модели на случай сохранения ВНУТРИ окна дебаунса держит
 * EditorRegistry.flushActive в persistence-воронке (V20).
 *
 * Тест гоняет РЕАЛЬНЫЕ handleEditorInput + finalizeEdit (мост персистентности);
 * DOM-тяжёлые capsule/тулбар-методы застаблены no-op'ами (недоступны в node-стабе),
 * а setTimeout перехвачен — дебаунс-колбэк исполняется синхронно.
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EditorController } from '../../static/js/constructor/textblock/editor-controller.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import '../../static/js/constructor/textblock/textblock-editor.js';
import '../../static/js/constructor/textblock/textblock-formatting.js';
import { AppState } from '../../static/js/constructor/state/state-core.js';

beforeEach(() => {
  EditorController._surface = null;
  EditorRegistry.clear();
  AppState.textBlocks = {}; // getTextBlock(undefined) → null (поле нарушения — не текстблок)
});

/**
 * Элемент-хост поля нарушения: минимум, который читают handleEditorInput /
 * finalizeEdit / _toggleEmptyClass / _cleanOrphanSizeAnchors /
 * applyFormattingToNewNodes, плюс addEventListener/_fire для перехвата
 * input-обработчика контроллера.
 */
function makeFieldElement() {
  const listeners = {};
  return {
    dataset: {},                 // нет textBlockId → бридж коммитит поверхность
    innerHTML: 'привет',
    textContent: 'привет',
    firstChild: null,
    __lastFootnoteCount: 0,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, handler) { listeners[type] = handler; },
    removeEventListener(type, handler) { if (listeners[type] === handler) delete listeners[type]; },
    _fire(type, evt) { if (listeners[type]) listeners[type](evt); },
  };
}

test('V26: один ввод + пауза (дебаунс) → ровно ОДИН commit поверхности', () => {
  // DOM-тяжёлые методы, вызываемые mount'ом capsule-поверхности, — no-op'ы.
  const orig = {
    install: textBlockManager.installCapsuleObserver,
    attach: textBlockManager.attachToolbarTo,
    detach: textBlockManager.detachToolbar,
    lf: textBlockManager.attachLinkFootnoteHandlers,
    sel: textBlockManager.handleSelectionChange,
  };
  textBlockManager.installCapsuleObserver = () => {};
  textBlockManager.attachToolbarTo = () => {};
  textBlockManager.detachToolbar = () => {};
  textBlockManager.attachLinkFootnoteHandlers = () => {};
  textBlockManager.handleSelectionChange = () => {};

  // Перехват дебаунс-таймера: сохраняем колбэк, исполняем синхронно.
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  let debounceCb = null;
  globalThis.setTimeout = (cb) => { debounceCb = cb; return 1; };
  globalThis.clearTimeout = () => {};

  let commits = 0;
  const el = makeFieldElement();
  const surface = {
    kind: 'violationField', rich: true, id: 'viol:v1:violated',
    element: el, commit: () => { commits += 1; },
  };

  try {
    EditorController.mount(surface);

    // Пользователь напечатал символ → input.
    el._fire('input');
    assert.equal(commits, 0, 'write-through убран — на сам ввод модель не коммитится');
    assert.equal(typeof debounceCb, 'function', 'debounce-таймер запланирован handleEditorInput');

    // Пауза набора: дебаунс срабатывает → finalizeEdit → мост коммитит поверхность.
    debounceCb();
    assert.equal(commits, 1, 'на паузу набора модель коммитится РОВНО один раз (только debounce-мост)');
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    textBlockManager.installCapsuleObserver = orig.install;
    textBlockManager.attachToolbarTo = orig.attach;
    textBlockManager.detachToolbar = orig.detach;
    textBlockManager.attachLinkFootnoteHandlers = orig.lf;
    textBlockManager.handleSelectionChange = orig.sel;
    EditorController._surface = null;
    EditorRegistry.clear();
  }
});
