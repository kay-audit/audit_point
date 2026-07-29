/**
 * F3 (follow-up T7): own-реконструкция капсул при DROP.
 *
 * Дефект T7: нативный drag выделения браузер сериализует БЕЗ метки data-aw-clip,
 * поэтому капсулы из нашего же текстблока при drop уходили ВНЕШНИМ путём
 * (_buildExternalPasteFragment): капсула-ссылка теряла URL (деградация в текст),
 * сноска резалась санитайзером, а НЕ гейтом политики. Copy/paste не затронуты
 * (метку ставит handleEditorCopy).
 *
 * Фикс: при drop (fromDrop=true) HTML с нашими капсульными маркерами
 * (data-link-url / data-footnote-text) маршрутизируется через own-путь —
 * ссылки выживают (URL валиден), сноски режутся ГЕЙТОМ по политике поверхности.
 * Детект УЗКИЙ: только drop + только при наличии капсул; paste не меняется.
 *
 * ОГРАНИЧЕНИЕ ХАРНЕССА: точная attribute-проверка _hasCapsuleMarkers (парс в
 * inert <template>) и полный конвейер DOMPurify (<img onerror>/скрипт рядом с
 * капсулой) требуют реального DOM — покрыты e2e (playwright, спек 16). Здесь:
 * маршрутизация, быстрый отказ префильтра, спуф-валидация URL и гейт сносок
 * через РЕАЛЬНЫЙ _reconstructPastedCapsules, контракт конфига own-санитизации.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import { SafeHTML } from '../../static/js/shared/sanitize.js';
// Тянет textblock-editor.js (side-effect) → paste/drop-методы на прототипе;
// и links-footnotes.js — window.validateLinkUrl (реальный гейт схемы URL).
import '../../static/js/constructor/textblock/textblock-editor.js';
import '../../static/js/constructor/textblock/textblock-links-footnotes.js';

const mgr = () => Object.create(TextBlockManager.prototype);

// ── _hasCapsuleMarkers: быстрый отказ префильтра (без DOM-парса) ───────────────

test('_hasCapsuleMarkers: без наших data-маркеров → false (быстрый отказ до парса)', () => {
  // Substring-префильтр отсекает обычный HTML без парсинга. Точная
  // attribute-проверка (inert <template>) требует реального DOM — покрыта e2e
  // в 16-capsule-integrity (детект + устойчивость к CF_HTML-обёртке + отсев
  // подстроки в тексте).
  const m = mgr();
  assert.equal(m._hasCapsuleMarkers('<p>обычный <b>текст</b></p>'), false);
  assert.equal(m._hasCapsuleMarkers('<a href="http://x">ссылка</a>'), false);
  assert.equal(m._hasCapsuleMarkers(''), false);
  assert.equal(m._hasCapsuleMarkers(null), false);
  assert.equal(m._hasCapsuleMarkers(undefined), false);
});

// ── Маршрутизация _buildPasteFragment с fromDrop ──────────────────────────────

/** Прогоняет _buildPasteFragment со стабами предикатов/строителей. */
function route({ own = false, word = false, capsules = false, fromDrop = false } = {}) {
  const m = mgr();
  const calls = [];
  m._isOwnClipboardHtml = () => own;
  m._isWordHtml = () => word;
  m._hasCapsuleMarkers = () => capsules;
  m._buildOwnPasteFragment = () => { calls.push('own'); return 'OWN'; };
  m._buildWordPasteFragment = () => { calls.push('word'); return 'WORD'; };
  m._buildExternalPasteFragment = () => { calls.push('external'); return 'EXT'; };
  const tel = [];
  const origTel = window.EditorTelemetry;
  window.EditorTelemetry = { track: (n) => tel.push(n) };
  let out;
  try {
    out = m._buildPasteFragment('<x>', undefined, fromDrop);
  } finally {
    window.EditorTelemetry = origTel;
  }
  return { out, calls, tel };
}

test('drop + капсульные маркеры (без метки) → own-путь (было: внешний)', () => {
  const r = route({ own: false, capsules: true, fromDrop: true });
  assert.equal(r.out, 'OWN');
  assert.deepEqual(r.calls, ['own']);
});

test('paste + те же маркеры (без метки) → НЕ own (внешний) — поведение paste не меняется', () => {
  // Детект капсул-без-метки — ТОЛЬКО для drop. На paste свой буфер всегда несёт
  // data-aw-clip; внешний HTML с data-link-url остаётся внешним, как прежде.
  const r = route({ own: false, capsules: true, fromDrop: false });
  assert.equal(r.out, 'EXT');
  assert.deepEqual(r.calls, ['external']);
});

test('drop БЕЗ капсул → внешний путь (drop без капсул не меняется)', () => {
  const r = route({ own: false, capsules: false, fromDrop: true });
  assert.equal(r.out, 'EXT');
  assert.deepEqual(r.calls, ['external']);
});

test('метка data-aw-clip выигрывает всегда (own-путь), fromDrop не важен', () => {
  assert.deepEqual(route({ own: true, fromDrop: false }).calls, ['own']);
  assert.deepEqual(route({ own: true, fromDrop: true, capsules: false }).calls, ['own']);
});

test('drop + капсулы выигрывают у Word-ветки (own раньше word)', () => {
  const r = route({ own: false, word: true, capsules: true, fromDrop: true });
  assert.equal(r.out, 'OWN');
  assert.deepEqual(r.calls, ['own']);
  assert.deepEqual(r.tel, [], 'телеметрия word_paste не должна сработать');
});

test('paste + Word-сигнатуры + маркеры → Word (капсульный детект drop-only не активен)', () => {
  const r = route({ own: false, word: true, capsules: true, fromDrop: false });
  assert.equal(r.out, 'WORD');
  assert.deepEqual(r.calls, ['word']);
  assert.deepEqual(r.tel, ['word_paste']);
});

// ── Спуф-валидация URL + гейт сносок через РЕАЛЬНЫЙ _reconstructPastedCapsules ─
// Внешний источник может подделать data-link-url в дропнутом HTML. Own-путь НЕ
// доверяет разметке: URL валидируется validateLinkUrl (реальный), капсула
// пересобирается заново фабрикой. Спуф даёт лишь обычную ссылку/текст, не XSS.

/** Фейк-капсула ссылки: поля, что читает _reconstructPastedCapsules. */
function fakeLinkEl(parent, url, text = 'ссылка') {
  const attrs = { 'data-link-url': url };
  return {
    parentNode: parent,
    textContent: text,
    classList: { contains: (c) => c === 'text-link' },
    hasAttribute: (k) => k in attrs,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
}
/** Фейк-капсула сноски. */
function fakeFootnoteEl(parent, body = 'тело', text = '1') {
  const attrs = { 'data-footnote-text': body };
  return {
    parentNode: parent,
    textContent: text,
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

/** Прогоняет РЕАЛЬНЫЙ _reconstructPastedCapsules над одной фейк-капсулой. */
function reconstructOne(el, children, footnotesBlocked) {
  const m = mgr();
  const created = [];
  m.createLinkMarker = (text, url) => { created.push(['link', text, url]); return { tag: 'link' }; };
  m.createFootnoteMarker = (text, body) => { created.push(['footnote', text, body]); return { tag: 'footnote' }; };
  m._reconstructPastedCapsules({ querySelectorAll: () => [el] }, footnotesBlocked);
  return { created, children };
}

test('спуф: капсула-ссылка с валидным URL → createLinkMarker с нормализованным URL', () => {
  const children = [];
  const el = fakeLinkEl(fakeParent(children), 'http://example.com');
  children.push(el);
  const { created, children: after } = reconstructOne(el, children, true);
  assert.deepEqual(created, [['link', 'ссылка', 'http://example.com']]);
  assert.deepEqual(after, [{ tag: 'link' }], 'капсула заменена свежим маркером');
});

test('спуф: капсула-ссылка с data-link-url="javascript:alert(1)" → НЕ восстановлена (деградация в текст)', () => {
  const children = [];
  const el = fakeLinkEl(fakeParent(children), 'javascript:alert(1)');
  children.push(el);
  const { created, children: after } = reconstructOne(el, children, true);
  assert.deepEqual(created, [], 'createLinkMarker НЕ должен зваться на опасной схеме');
  assert.equal(after.length, 1);
  assert.equal(after[0].nodeType, 3, 'капсула развёрнута в текстовый узел');
  assert.equal(after[0].textContent, 'ссылка');
});

test('спуф: капсула-ссылка с пустым data-link-url → деградация в текст', () => {
  const children = [];
  const el = fakeLinkEl(fakeParent(children), '   ');
  children.push(el);
  const { created, children: after } = reconstructOne(el, children, true);
  assert.deepEqual(created, []);
  assert.equal(after[0].nodeType, 3);
});

test('гейт сносок: footnotesBlocked=true → сноска вырезана ГЕЙТОМ (без текста-фолбэка)', () => {
  const children = [];
  const el = fakeFootnoteEl(fakeParent(children));
  children.push(el);
  const { created, children: after } = reconstructOne(el, children, true);
  assert.deepEqual(created, [], 'createFootnoteMarker НЕ зван — вырезано гейтом');
  assert.deepEqual(after, [], 'капсула удалена целиком, без текстового узла');
});

test('гейт сносок: footnotesBlocked=false → сноска пересобрана фабрикой', () => {
  const children = [];
  const el = fakeFootnoteEl(fakeParent(children));
  children.push(el);
  const { created, children: after } = reconstructOne(el, children, false);
  assert.deepEqual(created, [['footnote', '1', 'тело']]);
  assert.deepEqual(after, [{ tag: 'footnote' }]);
});

// ── Контракт own-санитизации: img/script режутся, onerror запрещён ────────────
// Требование брифа: own-путь для не-капсульного контента НЕ слабее внешнего.
// _buildOwnPasteFragment прогоняет ВЕСЬ html через SafeHTML.sanitize; ALLOWED_TAGS
// не содержит img/script, а слитый DEFAULT_CONFIG форбидит on*-обработчики.
// Полный DOMPurify — e2e (playwright); здесь фиксируем конфиг + tag-фильтрацию.

test('own-путь: конфиг санитизации исключает img/script, форбидит onerror, но держит капсульные теги', () => {
  const captured = [];
  const origDP = globalThis.window.DOMPurify;
  const origFrag = globalThis.document.createDocumentFragment;
  // Фейк DOMPurify: журналирует конфиг и режет теги вне ALLOWED_TAGS (сохраняя
  // текст) — этого достаточно, чтобы отличить allowlist без img от пропуска img.
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
  globalThis.document.createDocumentFragment = () => ({ appendChild() {} });
  try {
    const m = mgr();
    m._buildOwnPasteFragment(
      '<span class="text-link" data-link-url="http://a.ru">A</span>'
      + '<img src=x onerror="alert(1)"><script>alert(2)</script>',
      true,
    );
  } finally {
    globalThis.window.DOMPurify = origDP;
    globalThis.document.createDocumentFragment = origFrag;
  }
  assert.equal(captured.length, 1, 'own-путь прогнал html через SafeHTML.sanitize ровно раз');
  const { cfg, out } = captured[0];
  assert.ok(!cfg.ALLOWED_TAGS.includes('img'), 'img вне ALLOWED_TAGS own-пути');
  assert.ok(!cfg.ALLOWED_TAGS.includes('script'), 'script вне ALLOWED_TAGS own-пути');
  assert.ok(cfg.ALLOWED_TAGS.includes('span') && cfg.ALLOWED_TAGS.includes('a'),
    'носители капсул span/a остаются в allowlist');
  assert.ok(Array.isArray(cfg.FORBID_ATTR) && cfg.FORBID_ATTR.includes('onerror'),
    'on*-обработчики форбидятся слитым DEFAULT_CONFIG');
  assert.ok(!/<img/i.test(out), 'img (с onerror) вырезан санитайзером');
  assert.ok(!/<script/i.test(out), 'script вырезан санитайзером');
  assert.ok(/data-link-url/.test(out), 'капсула-ссылка рядом с img уцелела для реконструкции');
});

// ── SafeHTML доступен (страж импорта: own-путь зовёт именно его) ──────────────

test('SafeHTML.sanitize импортирован (own-путь опирается на него)', () => {
  assert.equal(typeof SafeHTML.sanitize, 'function');
});
