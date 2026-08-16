/**
 * B-23/28/30: контракт кнопки «очистить форматирование» (removeFormat).
 *
 * Node-стаб не реализует document.execCommand (нет реальной DOM-мутации) —
 * поведение живого браузера (что именно снимается, что происходит с капсулой)
 * зафиксировано эмпирически и покрыто в Playwright:
 * tests/playwright/specs/20-textblock-remove-format.spec.ts. Здесь — контракт
 * НАШЕГО JS-слоя вокруг execCommand: какую команду/value он шлёт браузеру,
 * что removeFormat (в отличие от bold/italic/underline/strikeThrough) не
 * входит в FORMAT_CMDS и не получает range-расширение вокруг капсул, и что
 * результат native-команды доходит до saveContent, не задевая капсулы
 * (data-link-url / data-footnote-text / contenteditable).
 *
 * D2: поверх нативной команды наш слой снимает ещё и БЛОЧНЫЙ формат
 * (_removeBlockFormat: списки, выравнивание, отступы) — он и разбирает
 * innerHTML. Здесь редактор-фейк без DOM-API (нет querySelectorAll), поэтому
 * блочный проход штатно no-op, и тест ниже остаётся тестом ИМЕННО про
 * сохранность капсулы. Блочный слой — textblock-remove-format-block.test.mjs.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';

/**
 * @param {string} editorHtml Текущее innerHTML фейкового редактора.
 * @returns {{mgr: object, editor: object, calls: any[]}}
 */
function makeManager(editorHtml) {
  const mgr = Object.create(TextBlockManager.prototype);
  const calls = [];
  const editor = {
    dataset: { textBlockId: 'tb1' },
    focus() {},
    innerHTML: editorHtml,
  };
  mgr.activeEditor = editor;
  mgr.saveContent = (id, content) => calls.push({ id, content });
  mgr._expandRangeOutOfMarkers = () => calls.push('expand');
  return { mgr, editor, calls };
}

test('execCommand(removeFormat): команда и value передаются браузеру без модификаций', () => {
  const { mgr } = makeManager('<b>текст</b>');
  const execCalls = [];
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = (cmd, ui, value) => {
    execCalls.push({ cmd, ui, value });
    return true;
  };
  try {
    mgr.execCommand('removeFormat');
  } finally {
    globalThis.document.execCommand = origExec;
  }

  assert.deepEqual(execCalls, [{ cmd: 'removeFormat', ui: false, value: null }]);
});

test('removeFormat не в FORMAT_CMDS: в отличие от bold, не расширяет выделение вокруг капсул', () => {
  const { mgr, calls } = makeManager('текст');
  const origSel = globalThis.getSelection;
  globalThis.getSelection = () => ({
    rangeCount: 1,
    isCollapsed: false,
    getRangeAt: () => ({}),
    removeAllRanges() {},
    addRange() {},
  });
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = () => true;
  try {
    mgr.execCommand('removeFormat');
    mgr.execCommand('bold');
  } finally {
    globalThis.getSelection = origSel;
    globalThis.document.execCommand = origExec;
  }

  // _expandRangeOutOfMarkers обязан сработать РОВНО один раз — для bold.
  // Если однажды removeFormat допишут в FORMAT_CMDS, этот тест укажет на
  // изменение контракта (сейчас — НЕ входит, фиксируем фактическое поведение).
  assert.deepEqual(calls.filter((c) => c === 'expand'), ['expand']);
});

test('после removeFormat капсула уходит в saveContent как есть (блочный слой её не разбирает)', () => {
  // HTML ниже имитирует РЕЗУЛЬТАТ уже отработавшего нативного removeFormat
  // (эмпирика Chromium, см. Playwright-спек): жирность снята, capsule с
  // contenteditable=false и data-footnote-text цела. Проверяем, что поверх
  // неё наш код ничего не ломает — innerHTML доходит до saveContent побайтово
  // тем же, каким его оставил браузер (блочного формата тут нет, а капсулу
  // _removeBlockFormat не трогает по инварианту).
  const afterNativeRemoveFormat =
    'важный текст ' +
    '<span class="text-footnote" data-footnote-id="F1" data-footnote-text="тело сноски" contenteditable="false">сн</span> ' +
    'конец';
  const { mgr, editor, calls } = makeManager(afterNativeRemoveFormat);
  const origExec = globalThis.document.execCommand;
  globalThis.document.execCommand = () => true;
  try {
    mgr.execCommand('removeFormat');
  } finally {
    globalThis.document.execCommand = origExec;
  }

  assert.equal(calls.length, 1, 'saveContent должен быть вызван ровно один раз');
  assert.equal(calls[0].content, editor.innerHTML);
  assert.match(calls[0].content, /data-footnote-text="тело сноски"/);
  assert.match(calls[0].content, /contenteditable="false"/);
});
