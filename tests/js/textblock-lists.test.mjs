/**
 * Task 4.1: маркированные и нумерованные списки в общем rich-редакторе.
 *
 * Кнопки тулбара (insertUnorderedList/insertOrderedList) эмитят ul/ol/li — этот
 * формат обязан переживать КЛИЕНТСКУЮ санитизацию вставки, иначе copy/paste
 * своего же списка отдавал бы голые li (браузер рисует их без маркеров).
 * Проверяем все три paste-конфига (свой буфер / Word / внешний HTML) и профиль
 * 'acts', которым редактор рендерит content из модели.
 *
 * ОГРАНИЧЕНИЕ ХАРНЕССА (как в textblock-word-paste.test.mjs): в node нет
 * window.DOMPurify и живого DOM — конфиг снимаем фейковым санитайзером,
 * фильтрующим теги по ALLOWED_TAGS; полный конвейер покрыт e2e (playwright).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAFE_HTML_PROFILES } from '../../static/js/shared/sanitize.js';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
// Тянет textblock-editor.js (side-effect) → paste-методы на прототипе.
import '../../static/js/constructor/textblock/textblock-links-footnotes.js';

const mgr = () => Object.create(TextBlockManager.prototype);
const LIST_TAGS = ['ul', 'ol', 'li'];

/**
 * Прогоняет paste-билдер под фейковым DOMPurify и возвращает журнал
 * {cfg, out} его вызовов. Стабы document.createElement/createDocumentFragment —
 * минимум, который читают билдеры после санитизации (childNodes/firstChild/
 * lastChild), чтобы обход не падал на браузерном стабе.
 * @param {(m: TextBlockManager) => void} run
 * @returns {Array<{cfg: Object, out: string}>}
 */
function captureSanitize(run) {
  const captured = [];
  const origDP = globalThis.window.DOMPurify;
  const origCreate = globalThis.document.createElement;
  const origFrag = globalThis.document.createDocumentFragment;
  globalThis.window.DOMPurify = {
    sanitize: (html, cfg) => {
      const out = String(html).replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag) => (
        cfg && Array.isArray(cfg.ALLOWED_TAGS) && cfg.ALLOWED_TAGS.includes(tag.toLowerCase())
          ? match : ''
      ));
      captured.push({ cfg, out });
      return out;
    },
  };
  globalThis.document.createElement = () => ({
    innerHTML: '',
    childNodes: [],
    firstChild: null,
    querySelectorAll: () => [],
    appendChild() {},
    removeChild() {},
  });
  globalThis.document.createDocumentFragment = () => ({
    lastChild: null,
    appendChild() {},
    removeChild() {},
  });
  try {
    run(mgr());
  } finally {
    globalThis.window.DOMPurify = origDP;
    globalThis.document.createElement = origCreate;
    globalThis.document.createDocumentFragment = origFrag;
  }
  return captured;
}

test("профиль 'acts' держит ul/ol/li (рендер content из модели в редактор)", () => {
  const tags = SAFE_HTML_PROFILES.acts.ALLOWED_TAGS;
  LIST_TAGS.forEach(t => assert.ok(tags.includes(t), `${t} вне профиля 'acts'`));
});

test('own-путь: ul/ol/li в ALLOWED_TAGS, разметка списка переживает санитизацию', () => {
  const captured = captureSanitize((m) => {
    m._buildOwnPasteFragment('<ul><li>раз</li><li>два</li></ul>', true);
  });
  assert.equal(captured.length, 1, 'own-путь прогнал html через SafeHTML.sanitize ровно раз');
  const { cfg, out } = captured[0];
  LIST_TAGS.forEach(t => assert.ok(cfg.ALLOWED_TAGS.includes(t), `${t} вне ALLOWED_TAGS own-пути`));
  assert.equal(out, '<ul><li>раз</li><li>два</li></ul>', 'список схлопнулся при round-trip');
});

test('Word-путь: ul/ol/li в _wordAllowedTags (пересечение с живым профилем acts)', () => {
  const tags = mgr()._wordAllowedTags();
  LIST_TAGS.forEach(t => assert.ok(tags.includes(t), `${t} вне ALLOWED_TAGS Word-пути`));
});

test('внешний путь: ul/ol/li в ALLOWED_TAGS', () => {
  const captured = captureSanitize((m) => {
    m._buildExternalPasteFragment('<ul><li>раз</li></ul>');
  });
  assert.equal(captured.length, 1);
  const { cfg } = captured[0];
  LIST_TAGS.forEach(t => assert.ok(cfg.ALLOWED_TAGS.includes(t), `${t} вне ALLOWED_TAGS внешнего пути`));
});
