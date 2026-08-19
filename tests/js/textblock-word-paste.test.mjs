/**
 * Task A: сохранение форматирования при вставке из Microsoft Word.
 *
 * Word-ветка paste переносит РОВНО набор тулбара — bold/italic/underline/
 * strikethrough + font-size + ссылки-капсулы; цвет/фон/выравнивание/списки
 * отбрасываются. Здесь — чистая логика, тестируемая без реального DOM/DOMPurify:
 * детект Word-сигнатур, regex-пред-очистка, конвертация pt→px+кламп, CSS-
 * allowlist (симметрия тулбару), маршрутизация и разворот невалидных ссылок.
 *
 * ОГРАНИЧЕНИЕ ХАРНЕССА: в node window.DOMPurify отсутствует → полный конвейер
 * _buildWordPasteFragment (санитизация + расплющивание блоков) и капсулизация в
 * реальном DOM покрыты e2e (playwright). Паритет CSS проверяем через реальную
 * чистую filterCssDeclarations — ту же функцию, что зовёт хук DOMPurify.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAFE_HTML_PROFILES, filterCssDeclarations,
} from '../../static/js/shared/sanitize.js';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
// Тянет textblock-editor.js (side-effect) → методы Word-пути на прототипе.
import '../../static/js/constructor/textblock/textblock-links-footnotes.js';

const mgr = () => Object.create(TextBlockManager.prototype);

// ── _isWordHtml ──────────────────────────────────────────────────────────────

test('_isWordHtml: true на Word-сигнатурах (class=Mso/mso-/Generator/o:p/namespace/conditional)', () => {
  const m = mgr();
  assert.equal(m._isWordHtml('<p class=MsoNormal>текст</p>'), true, 'class=Mso');
  assert.equal(m._isWordHtml('<p class="MsoListParagraph">x</p>'), true, 'class="Mso"');
  assert.equal(m._isWordHtml('<span style="mso-fareast-language:RU">x</span>'), true, 'mso- CSS');
  assert.equal(
    m._isWordHtml('<meta name=Generator content="Microsoft Word 15">'), true, 'Generator');
  assert.equal(m._isWordHtml('<p>x<o:p></o:p></p>'), true, '<o:p>');
  assert.equal(m._isWordHtml('<html xmlns:o="urn:schemas-microsoft-com:office:office">'), true, 'xmlns:o');
  assert.equal(m._isWordHtml('a<!--[if gte mso 9]><xml></xml><![endif]-->b'), true, 'conditional mso');
});

test('_isWordHtml: false на обычном HTML и на своём буфере (data-aw-clip)', () => {
  const m = mgr();
  assert.equal(m._isWordHtml('<p>обычный <b>текст</b> со <a href="http://x">ссылкой</a></p>'), false);
  assert.equal(m._isWordHtml('<div data-aw-clip="1"><span class="text-link" data-link-url="http://x">y</span></div>'), false);
  assert.equal(m._isWordHtml(''), false);
  assert.equal(m._isWordHtml(null), false);
  assert.equal(m._isWordHtml(undefined), false);
});

// ── _wordPreClean ────────────────────────────────────────────────────────────

test('_wordPreClean: срезает условные комментарии, <o:p>, <xml>; <w:*> разворачивает (текст сохраняется)', () => {
  const m = mgr();
  const raw = 'A<!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]-->'
    + 'B<p>C<o:p></o:p></p>D<w:sdt>E</w:sdt>F';
  const out = m._wordPreClean(raw);
  // <w:sdt>E</w:sdt> разворачивается → видимый текст E сохранён (не теряется)
  assert.equal(out, 'AB<p>C</p>DEF');
  assert.ok(!/mso/i.test(out), 'mso-разметка осталась');
  assert.ok(!/<o:p/i.test(out), '<o:p> остался');
  assert.ok(!/<w:/i.test(out), '<w:*> остался');
  assert.ok(!/<xml/i.test(out), '<xml> остался');
});

test('_wordPreClean: standalone <xml>…</xml> удаляется, обычный формат не трогается', () => {
  const m = mgr();
  assert.equal(m._wordPreClean('X<xml>junk</xml>Y'), 'XY');
  assert.equal(m._wordPreClean('<b>жир</b> и <i>курсив</i>'), '<b>жир</b> и <i>курсив</i>');
});

// ── _wordFontSizeToPt (чистая математика px→pt + кламп) ───────────────────────

test('_wordFontSizeToPt: pt как есть, px→pt round(v*0.75), прочее → null, кламп [8,72]', () => {
  const m = mgr();
  // Word пишет размеры В ПУНКТАХ — для типичной вставки это тождество.
  assert.equal(m._wordFontSizeToPt('11pt', 8, 72), 11);
  assert.equal(m._wordFontSizeToPt('11.0pt', 8, 72), 11); // Word пишет с .0
  assert.equal(m._wordFontSizeToPt('500pt', 8, 72), 72);  // клампится к max
  assert.equal(m._wordFontSizeToPt('4pt', 8, 72), 8);     // клампится к min
  assert.equal(m._wordFontSizeToPt('16px', 8, 72), 12);   // веб-источник: 16px = 12pt
  assert.equal(m._wordFontSizeToPt('14px', 8, 72), 11);   // round(10.5)
  assert.equal(m._wordFontSizeToPt('8px', 8, 72), 8);     // round(6) → клампится к min
  assert.equal(m._wordFontSizeToPt('200px', 8, 72), 72);  // px тоже клампится
  assert.equal(m._wordFontSizeToPt('2em', 8, 72), null);
  assert.equal(m._wordFontSizeToPt('120%', 8, 72), null);
  assert.equal(m._wordFontSizeToPt('1rem', 8, 72), null);
  assert.equal(m._wordFontSizeToPt('12', 8, 72), null);   // без единицы → drop
  assert.equal(m._wordFontSizeToPt('large', 8, 72), null);
  assert.equal(m._wordFontSizeToPt('1cm', 8, 72), null);  // неизвестная единица → drop
});

// ── _normalizeWordFontSizes (обход поддерева + переписывание/сброс) ───────────

/** Фейк-root: querySelectorAll('*') отдаёт элементы с изменяемым style.fontSize. */
function fakeRoot(sizes) {
  const els = sizes.map((s) => ({ style: { fontSize: s } }));
  return { querySelectorAll: () => els, _els: els };
}

test('_normalizeWordFontSizes: переписывает pt/px в pt, дропает прочее, диапазон [8,72]', () => {
  const m = mgr();
  const root = fakeRoot(['11pt', '8pt', '500pt', '16px', '2em', '120%', '']);
  m._normalizeWordFontSizes(root);
  const got = root._els.map((e) => e.style.fontSize);
  assert.deepEqual(got, ['11pt', '8pt', '72pt', '12pt', '', '', '']);
});

test('_normalizeWordFontSizes: root без querySelectorAll → no-op без исключения', () => {
  const m = mgr();
  assert.doesNotThrow(() => m._normalizeWordFontSizes(null));
  assert.doesNotThrow(() => m._normalizeWordFontSizes({}));
});

// ── _wordCssAllowlist + паритет (тулбар минус color/bg/alignment) ─────────────

test('_wordCssAllowlist: acts-набор минус color/background-color/text-align', () => {
  const m = mgr();
  const allow = m._wordCssAllowlist();
  assert.deepEqual(
    allow,
    ['font-size', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line'],
  );
  for (const bad of ['color', 'background-color', 'text-align']) {
    assert.ok(!allow.includes(bad), `${bad} не должен просочиться`);
  }
  // Дериват из активного профиля 'acts' (синхронность с бэком).
  const base = SAFE_HTML_PROFILES.acts.__cssAllowlist;
  assert.ok(allow.every((p) => base.includes(p)));
});

test('паритет: span из Word-фикстуры — px font-size + decoration/weight/style; НЕ color/bg/align', () => {
  const m = mgr();
  const allow = m._wordCssAllowlist();
  // Реальная чистая функция, которую зовёт хук DOMPurify afterSanitizeAttributes.
  const kept = filterCssDeclarations('span', [
    ['color', 'red'],
    ['background-color', 'yellow'],
    ['text-align', 'center'],
    ['font-size', '20px'],
    ['font-weight', 'bold'],
    ['font-style', 'italic'],
    ['text-decoration', 'underline'],
    ['text-decoration-line', 'line-through'],
  ], allow);
  assert.deepEqual(kept, [
    'font-size:20px;',
    'font-weight:bold;',
    'font-style:italic;',
    'text-decoration:underline;',
    'text-decoration-line:line-through;',
  ]);
  const joined = kept.join('');
  assert.ok(!/color/.test(joined), 'color/background-color просочились');
  assert.ok(!/text-align/.test(joined), 'text-align просочился');
});

// ── _reconstructWordLinks (<a>→капсула / разворот невалидной) ──────────────────

/** Фейк-anchor с parentNode, журналирующим replace/insertBefore/remove. */
function fakeAnchor(href, text, children = []) {
  const kids = [...children];
  const parent = { ops: [] };
  const a = {
    getAttribute: (k) => (k === 'href' ? href : null),
    textContent: text,
    get firstChild() { return kids.length ? kids[0] : null; },
    parentNode: parent,
  };
  parent.replaceChild = (nw) => parent.ops.push(['replace', nw]);
  parent.insertBefore = (n) => { kids.shift(); parent.ops.push(['insertBefore', n]); };
  parent.removeChild = () => parent.ops.push(['remove']);
  return { a, parent };
}

test('_reconstructWordLinks: валидная ссылка → капсула; невалидная → разворот в детей', () => {
  const m = mgr();
  m.createLinkMarker = (text, url) => ({ __capsule: true, text, url });
  const good = fakeAnchor('http://example.com', '  ссылка  ');
  const badChildA = { __child: 'A' };
  const badChildB = { __child: 'B' };
  const bad = fakeAnchor('javascript:alert(1)', 'зло', [badChildA, badChildB]);
  const root = { querySelectorAll: () => [good.a, bad.a] };

  const orig = window.validateLinkUrl;
  window.validateLinkUrl = (u) => (/^https?:/i.test(u) ? { ok: true, url: u } : { ok: false });
  try {
    m._reconstructWordLinks(root);
  } finally {
    window.validateLinkUrl = orig;
  }

  // Валидная: replaceChild капсулой с нормализованным (trim/collapse) текстом.
  assert.deepEqual(good.parent.ops[0][0], 'replace');
  assert.equal(good.parent.ops[0][1].__capsule, true);
  assert.equal(good.parent.ops[0][1].text, 'ссылка');
  assert.equal(good.parent.ops[0][1].url, 'http://example.com');
  // Невалидная: оба ребёнка вынесены insertBefore, затем сам <a> удалён.
  const badTypes = bad.parent.ops.map((o) => o[0]);
  assert.deepEqual(badTypes, ['insertBefore', 'insertBefore', 'remove']);
});

// ── Маршрутизация _buildPasteFragment (свой → Word → внешний) ─────────────────

/** Прогоняет _buildPasteFragment со стабами предикатов/строителей. */
function routePaste({ own = false, word = false }) {
  const m = mgr();
  const calls = [];
  m._isOwnClipboardHtml = () => own;
  m._isWordHtml = () => word;
  m._buildOwnPasteFragment = () => { calls.push('own'); return 'OWN'; };
  m._buildWordPasteFragment = () => { calls.push('word'); return 'WORD'; };
  m._buildExternalPasteFragment = () => { calls.push('external'); return 'EXT'; };
  const tel = [];
  const origTel = window.EditorTelemetry;
  window.EditorTelemetry = { track: (n) => tel.push(n) };
  let out;
  try {
    out = m._buildPasteFragment('<x>');
  } finally {
    window.EditorTelemetry = origTel;
  }
  return { out, calls, tel };
}

test('_buildPasteFragment: Word-ветка между своим и внешним + телеметрия word_paste', () => {
  const r = routePaste({ own: false, word: true });
  assert.equal(r.out, 'WORD');
  assert.deepEqual(r.calls, ['word']);
  assert.deepEqual(r.tel, ['word_paste']);
});

test('_buildPasteFragment: свой буфер выигрывает у Word (Word не зовётся)', () => {
  const r = routePaste({ own: true, word: true });
  assert.equal(r.out, 'OWN');
  assert.deepEqual(r.calls, ['own']);
  assert.deepEqual(r.tel, []);
});

test('_buildPasteFragment: не-свой не-Word → внешний путь', () => {
  const r = routePaste({ own: false, word: false });
  assert.equal(r.out, 'EXT');
  assert.deepEqual(r.calls, ['external']);
  assert.deepEqual(r.tel, []);
});
