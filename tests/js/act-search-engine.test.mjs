/**
 * B1: движок поиска/замены по текстблокам. Тестируем КРИТИЧНУЮ чистую логику без
 * реального DOM: сопоставление строк (литерал/регистр/whole-word-кириллица/regex/
 * перекрытия/лимит), guard невалидного regex, сегментацию пробегов с исключением
 * капсул и защиту замены от пересечения капсулы.
 *
 * Реального Range / CSS.highlights / document.createRange в node нет →
 * findInTarget/buildAllMatches (в части построения Range), _rangeFromRun, живая
 * замена через deleteContents и весь модуль подсветки ОТЛОЖЕНЫ в Playwright-спек
 * (B2). Здесь — только то, что тестируется на фейковых узлах без обмана ассертов.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActSearchEngine, FootnoteBodySearchTarget, TextBlockSearchTarget, ViolationFieldSearchTarget } from '../../static/js/constructor/search/act-search-engine.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';

globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

// --- Фейковые узлы (как fakeLink в dedup-тесте): ровно поля, что читает движок.

/** Текстовый узел. */
function txt(data) {
  return { nodeType: 3, data, textContent: data, firstChild: null, nextSibling: null, parentNode: null };
}

/** Элемент с детьми; связывает firstChild/nextSibling/parentNode. */
function elem(tagName, children = [], className = '') {
  const set = new Set(className ? className.split(' ') : []);
  const node = {
    nodeType: 1,
    tagName,
    classList: { contains: (c) => set.has(c) },
    firstChild: children[0] || null,
    nextSibling: null,
    parentNode: null,
  };
  let tc = '';
  children.forEach((c) => { tc += c.textContent || ''; });
  node.textContent = tc;
  for (let i = 0; i < children.length; i++) {
    children[i].nextSibling = children[i + 1] || null;
    children[i].parentNode = node;
  }
  return node;
}

/** Капсула-ссылка (contenteditable=false-атом) с текстом внутри. */
const capsule = (text) => elem('SPAN', [txt(text)], 'text-link');

/** Мутируемый текстовый узел: поддерживает replaceData (путь замены в одном
 *  узле). textContent/nodeValue следуют за data. */
function mtxt(data) {
  return {
    nodeType: 3, data, nodeValue: data,
    get textContent() { return this.data; },
    replaceData(offset, count, s) {
      this.data = this.data.slice(0, offset) + s + this.data.slice(offset + count);
      this.nodeValue = this.data;
    },
    firstChild: null, nextSibling: null, parentNode: null,
  };
}

/** Капсула с МУТИРУЕМЫМ текст-узлом + живым textContent (для replace-тестов:
 *  empty-guard читает cap.textContent, замена — cap.firstChild.replaceData). */
function mutableCapsule(text, className = 'text-link') {
  const inner = mtxt(text);
  const set = new Set(className.split(' '));
  const cap = {
    nodeType: 1, tagName: 'SPAN',
    classList: { contains: (c) => set.has(c) },
    firstChild: inner, nextSibling: null, parentNode: null,
    get textContent() { return this.firstChild ? this.firstChild.data : ''; },
  };
  inner.parentNode = cap;
  return cap;
}

/** Фейковый одноузловой Range с toString (нужен empty-guard'у replaceRange). */
function fakeRange(node, startOffset, endOffset) {
  return {
    startContainer: node, endContainer: node, startOffset, endOffset,
    toString: () => (node.data != null ? node.data.slice(startOffset, endOffset) : ''),
    setStart() {}, setEnd() {},
  };
}

/**
 * Фейковый span.text-footnote: РОВНО поля, что читает FootnoteBodySearchTarget
 * (getAttribute/setAttribute/closest) — не реальный DOM, без Range.
 * @param {{footnoteText?: string, footnoteId?: string, blockId?: string|null}} [opts]
 */
function fakeFootnoteEl({ footnoteText = '', footnoteId = 'footnote_1', blockId = 'tb1' } = {}) {
  const attrs = { 'data-footnote-text': footnoteText, 'data-footnote-id': footnoteId };
  const editor = blockId != null ? { dataset: { textBlockId: blockId } } : null;
  return {
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    setAttribute: (name, val) => { attrs[name] = val; },
    closest: (sel) => (sel === '.textblock-editor' ? editor : null),
    classList: { contains: () => false },
  };
}

/**
 * Фейковая поверхность rich-поля нарушения: РОВНО поля, что читает
 * ViolationFieldSearchTarget (id + commit/getContent/setContent). Не реальная
 * ViolationFieldSurface — цель духотипизирована на __surface, движку хватает
 * этого контракта.
 */
function fakeSurface({ id = 'viol:v1:violated', content = '' } = {}) {
  return {
    id,
    _content: content,
    commitCount: 0,
    setCalls: [],
    commit() { this.commitCount++; },
    getContent() { return this._content; },
    setContent(html) { this.setCalls.push(html); this._content = html; },
  };
}

/** Фейковый хост .violation-field с обратной ссылкой __surface (как её ставит
 *  _createRichFieldEditor). children — как у elem (для collectRuns). */
function fakeViolationHost(surface, children = []) {
  const host = elem('DIV', children, 'violation-field');
  host.__surface = surface;
  return host;
}

// ---------------------------------------------------------------------------
// _matchesInString — литерал / регистр / whole-word / regex / перекрытия / лимит
// ---------------------------------------------------------------------------

test('_matchesInString: литерал, регистронезависимо по умолчанию', () => {
  const r = ActSearchEngine._matchesInString('Foo foo FOO', 'foo', {});
  assert.deepEqual(r.matches, [{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 11 }]);
  assert.equal(r.capped, false);
});

test('_matchesInString: литерал, caseSensitive матчит только точный регистр', () => {
  const r = ActSearchEngine._matchesInString('Foo foo', 'foo', { caseSensitive: true });
  assert.deepEqual(r.matches, [{ start: 4, end: 7 }]);
});

test('_matchesInString: спецсимволы экранируются (литерал), regex-режим — нет', () => {
  const lit = ActSearchEngine._matchesInString('a.b.c', '.', {});
  assert.deepEqual(lit.matches, [{ start: 1, end: 2 }, { start: 3, end: 4 }]); // только точки
  const rx = ActSearchEngine._matchesInString('a.b.c', '.', { regex: true });
  assert.equal(rx.matches.length, 5); // '.' — любой символ
});

test('_matchesInString: whole-word кириллица — «акт» НЕ внутри «характеристика»', () => {
  // Подстрокой находится (индекс 3), whole-word — нет.
  assert.equal(ActSearchEngine._matchesInString('характеристика', 'акт', {}).matches.length, 1);
  assert.deepEqual(ActSearchEngine._matchesInString('характеристика', 'акт', { wholeWord: true }).matches, []);
});

test('_matchesInString: whole-word матчит отдельное слово, на границах и у пунктуации', () => {
  assert.deepEqual(ActSearchEngine._matchesInString('акт', 'акт', { wholeWord: true }).matches,
    [{ start: 0, end: 3 }]);
  assert.deepEqual(ActSearchEngine._matchesInString('это акт документ', 'акт', { wholeWord: true }).matches,
    [{ start: 4, end: 7 }]);
  assert.deepEqual(ActSearchEngine._matchesInString('«акт».', 'акт', { wholeWord: true }).matches,
    [{ start: 1, end: 4 }]); // рядом кавычка/точка — граница слова
});

test('_matchesInString: whole-word регистронезависим', () => {
  assert.deepEqual(ActSearchEngine._matchesInString('АКТ и ещё', 'акт', { wholeWord: true }).matches,
    [{ start: 0, end: 3 }]);
});

test('_matchesInString: перекрытия — продвигаемся за конец (не перекрываем)', () => {
  const r = ActSearchEngine._matchesInString('aaaa', 'aa', {});
  assert.deepEqual(r.matches, [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
});

test('_matchesInString: жёсткий лимит совпадений (cap) → capped=true', () => {
  const r = ActSearchEngine._matchesInString('aaaa', 'a', { cap: 2 });
  assert.equal(r.matches.length, 2);
  assert.equal(r.capped, true);
});

test('_matchesInString: пустой запрос → нет совпадений, без ошибки', () => {
  const r = ActSearchEngine._matchesInString('foo', '', {});
  assert.deepEqual(r.matches, []);
  assert.equal(r.error, undefined);
});

test('_matchesInString: валидный regex-паттерн', () => {
  const r = ActSearchEngine._matchesInString('a1b22c333', '\\d+', { regex: true });
  assert.deepEqual(r.matches, [{ start: 1, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 9 }]);
});

test('_matchesInString: regex с пустыми совпадениями (\\d*) НЕ возвращает пустых матчей', () => {
  // \d* на строке без цифр даёт только пустые совпадения — их быть не должно
  // (пустой матч → Range на весь пробег → потеря текста при замене).
  assert.deepEqual(ActSearchEngine._matchesInString('foobar', '\\d*', { regex: true }).matches, []);
  // среди цифр — только непустые куски, пустые между ними отброшены.
  assert.deepEqual(ActSearchEngine._matchesInString('a1b2', '\\d*', { regex: true }).matches,
    [{ start: 1, end: 2 }, { start: 3, end: 4 }]);
});

test('_scanWithRegex: пустое совпадение (a*) не зацикливается и пропускается', () => {
  const r = ActSearchEngine._scanWithRegex('baa', /a*/g, 5000);
  assert.deepEqual(r.matches, [{ start: 1, end: 3 }]); // только непустой «aa», без пустых
});

test('_locate: offset 0 → начало ПЕРВОГО сегмента (не конец пробега) для start и end', () => {
  const run = { segments: [{ node: 'A', start: 0, end: 3 }, { node: 'B', start: 3, end: 6 }] };
  assert.deepEqual(ActSearchEngine._locate(run, 0, false), { node: 'A', offset: 0 });
  assert.deepEqual(ActSearchEngine._locate(run, 0, true), { node: 'A', offset: 0 }); // регресс: было {B,3}
  assert.deepEqual(ActSearchEngine._locate(run, 5, true), { node: 'B', offset: 2 });
  assert.deepEqual(ActSearchEngine._locate(run, 3, true), { node: 'A', offset: 3 }); // граница → ранний сегмент
  assert.deepEqual(ActSearchEngine._locate(run, 3, false), { node: 'B', offset: 0 }); // граница → поздний сегмент
});

// ---------------------------------------------------------------------------
// _buildMatcher — guard невалидного regex (никогда не бросает)
// ---------------------------------------------------------------------------

test('_buildMatcher: невалидный regex → {error}, без исключения', () => {
  assert.ok(ActSearchEngine._buildMatcher('[', { regex: true }).error);
  assert.ok(ActSearchEngine._buildMatcher('(', { regex: true }).error);
});

test('_buildMatcher: те же символы как ЛИТЕРАЛ экранируются — не ошибка', () => {
  assert.ok(ActSearchEngine._buildMatcher('[', {}).regex instanceof RegExp);
  assert.ok(ActSearchEngine._buildMatcher('(', {}).regex instanceof RegExp);
});

test('_buildMatcher: пустой запрос → {empty:true}', () => {
  const b = ActSearchEngine._buildMatcher('', {});
  assert.equal(b.empty, true);
  assert.equal(b.regex, null);
});

test('_matchesInString: невалидный regex → структурная ошибка, matches пуст', () => {
  const r = ActSearchEngine._matchesInString('foo', '(', { regex: true });
  assert.ok(r.error);
  assert.deepEqual(r.matches, []);
});

test('buildAllMatches: невалидный regex → {error} без обхода целей и без Range', () => {
  const r = ActSearchEngine.buildAllMatches('[', { regex: true });
  assert.ok(r.error);
  assert.deepEqual(r.matches, []);
});

// ---------------------------------------------------------------------------
// collectRuns — исключение капсул, склейка формата, разрывы <br>/guard
// ---------------------------------------------------------------------------

// ИЗМЕНЕНО (было: «текст капсулы нигде в пробегах»): текст капсулы теперь
// ищется — попадает в СОБСТВЕННЫЙ помеченный пробег между «foo» и «bar», но
// НЕ протекает в соседние пробеги (старая проверка «нигде» ослаблена сознательно,
// это и есть предмет задачи; проверка «не в соседних» — новая, строже старой
// по конкретике).
test('collectRuns: foo<capsule>x</capsule>bar → пробеги [foo, x(capsuleText), bar], «x» не протекает в соседние', () => {
  const editor = elem('DIV', [txt('foo'), capsule('x'), txt('bar')]);
  const runs = ActSearchEngine.collectRuns(editor);
  assert.deepEqual(runs.map((r) => r.text), ['foo', 'x', 'bar']);
  assert.deepEqual(runs.map((r) => !!r.capsuleText), [false, true, false]);
  assert.equal('capsuleText' in runs[0], false); // поле отсутствует у обычных пробегов, не просто falsy
  assert.ok(!runs[0].text.includes('x') && !runs[2].text.includes('x'));
});

// ИЗМЕНЕНО: runIndex «bar» сдвинулся с 1 на 2 — между ним и «foo» появился
// пробег капсулы. Сама проверяемая гарантия (совпадение не пересекает границу
// капсулы) не ослаблена — 'oobar'/'xba'/'fox' по-прежнему не находятся.
test('collectRuns: совпадение НЕ пересекает границу капсулы (внешние пробеги матчатся штатно)', () => {
  const editor = elem('DIV', [txt('foo'), capsule('x'), txt('bar')]);
  const runs = ActSearchEngine.collectRuns(editor);
  // Поиск через границу капсулы даёт ноль — совпадение не может её пересечь.
  assert.deepEqual(ActSearchEngine.findInRuns(runs, 'oobar', {}).matches, []);
  assert.deepEqual(ActSearchEngine.findInRuns(runs, 'xba', {}).matches, []);
  assert.deepEqual(ActSearchEngine.findInRuns(runs, 'fox', {}).matches, []);
  // Внешние пробеги матчатся штатно.
  assert.deepEqual(ActSearchEngine.findInRuns(runs, 'foo', {}).matches, [{ runIndex: 0, start: 0, end: 3 }]);
  assert.deepEqual(ActSearchEngine.findInRuns(runs, 'bar', {}).matches, [{ runIndex: 2, start: 0, end: 3 }]);
});

// ИЗМЕНЕНО (было: «текст из-под капсулы нигде»): вложенное форматирование
// капсулы теперь ЕСТЬ в её собственном пробеге (транзитивный обход, требование
// задачи), но по-прежнему не протекает в соседние пробеги.
test('collectRuns: форматирование ВНУТРИ капсулы собирается в её СОБСТВЕННЫЙ пробег, не протекает в соседние', () => {
  const nestedCap = elem('SPAN', [elem('B', [txt('SECRET')])], 'text-link');
  const editor = elem('DIV', [txt('foo'), nestedCap, txt('bar')]);
  const runs = ActSearchEngine.collectRuns(editor);
  assert.deepEqual(runs.map((r) => r.text), ['foo', 'SECRET', 'bar']);
  assert.equal(runs[1].capsuleText, true);
  assert.ok(!runs[0].text.includes('SECRET') && !runs[2].text.includes('SECRET'));
});

test('collectRuns: inline-форматирование (b/i/span) склеивается в ОДИН пробег', () => {
  const editor = elem('DIV', [txt('foo'), elem('B', [txt('bar')]), txt('baz')]);
  const runs = ActSearchEngine.collectRuns(editor);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, 'foobarbaz');
  assert.equal(runs[0].segments.length, 3); // 3 текстовых узла в одном пробеге
  // Совпадение через границу формата находится (кросс-формат).
  assert.deepEqual(ActSearchEngine.findInRuns(runs, 'obarb', {}).matches, [{ runIndex: 0, start: 2, end: 7 }]);
});

test('collectRuns: <br> разрывает пробег', () => {
  const editor = elem('DIV', [txt('foo'), elem('BR', []), txt('bar')]);
  assert.deepEqual(ActSearchEngine.collectRuns(editor).map((r) => r.text), ['foo', 'bar']);
});

test('collectRuns: caret-guard U+FEFF и якорь размера U+200B пропускаются без разрыва', () => {
  const editor = elem('DIV', [txt('foo'), txt('﻿'), txt('​'), txt('bar')]);
  const runs = ActSearchEngine.collectRuns(editor);
  assert.deepEqual(runs.map((r) => r.text), ['foobar']); // один пробег, невидимки вырезаны
});

test('collectRuns: <img> (void-атом) разрывает пробег — замена не удалит картинку', () => {
  const editor = elem('DIV', [txt('foo'), elem('IMG', []), txt('bar')]);
  const runs = ActSearchEngine.collectRuns(editor);
  assert.deepEqual(runs.map((r) => r.text), ['foo', 'bar']);
  // Совпадение не может «перепрыгнуть» картинку.
  assert.deepEqual(ActSearchEngine.findInRuns(runs, 'oobar', {}).matches, []);
});

// ИЗМЕНЕНО (было: «LINK нигде»): капсула внутри форматирования по-прежнему
// разрывает ОКРУЖАЮЩИЙ пробег, но её текст теперь есть в собственном пробеге.
test('collectRuns: капсула внутри форматирования разрывает ОКРУЖАЮЩИЙ пробег (её текст — в своём)', () => {
  const editor = elem('DIV', [elem('B', [txt('foo'), capsule('LINK'), txt('bar')])]);
  const runs = ActSearchEngine.collectRuns(editor);
  assert.deepEqual(runs.map((r) => r.text), ['foo', 'LINK', 'bar']);
  assert.equal(runs[1].capsuleText, true);
  assert.ok(!runs[0].text.includes('LINK') && !runs[2].text.includes('LINK'));
});

// ---------------------------------------------------------------------------
// collectRuns / findInRuns — собственный текст капсулы теперь ИЩЕТСЯ (отдельный
// пробег capsuleText:true), но остаётся неприкосновенным для ЗАМЕНЫ.
// ---------------------------------------------------------------------------

test('collectRuns: сегменты пробега капсулы указывают на РЕАЛЬНЫЙ текстовый узел (не синтетика)', () => {
  const cap = capsule('LinkText');
  const editor = elem('DIV', [txt('foo'), cap, txt('bar')]);
  const runs = ActSearchEngine.collectRuns(editor);
  const capRun = runs[1];
  assert.deepEqual(capRun.segments, [{ node: cap.firstChild, start: 0, end: 8 }]);
});

test('collectRuns: форматирование ВНУТРИ капсулы (b/i/span) склеивается в её пробег транзитивно', () => {
  const nestedCap = elem('SPAN', [txt('Link'), elem('B', [txt('Bold')])], 'text-link');
  const editor = elem('DIV', [txt('foo'), nestedCap, txt('bar')]);
  const runs = ActSearchEngine.collectRuns(editor);
  assert.deepEqual(runs.map((r) => r.text), ['foo', 'LinkBold', 'bar']);
  assert.equal(runs[1].capsuleText, true);
  assert.equal(runs[1].segments.length, 2); // прямой текст-узел + вложенный <b>
});

test('collectRuns: пустая капсула (без видимого текста) не добавляет пустой пробег', () => {
  const editor = elem('DIV', [txt('foo'), capsule(''), txt('bar')]);
  const runs = ActSearchEngine.collectRuns(editor);
  assert.deepEqual(runs.map((r) => r.text), ['foo', 'bar']);
});

test('findInRuns: текст капсулы находится и помечен capsuleText:true; обычные совпадения — без пометки', () => {
  const editor = elem('DIV', [txt('foo'), capsule('LinkText'), txt('bar')]);
  const runs = ActSearchEngine.collectRuns(editor);

  const capMatch = ActSearchEngine.findInRuns(runs, 'LinkText', {});
  assert.deepEqual(capMatch.matches, [{ runIndex: 1, start: 0, end: 8, capsuleText: true }]);

  const ordinaryMatch = ActSearchEngine.findInRuns(runs, 'foo', {});
  assert.deepEqual(ordinaryMatch.matches, [{ runIndex: 0, start: 0, end: 3 }]); // поля capsuleText нет вовсе
});

// ---------------------------------------------------------------------------
// replaceRange — защита от пересечения капсулы + сплайс в одном узле
// ---------------------------------------------------------------------------

test('_capsuleAncestorOf: текст внутри капсулы → сама капсула; вне → null', () => {
  const cap = capsule('x');
  assert.equal(ActSearchEngine._capsuleAncestorOf(cap.firstChild), cap); // txt('x') под капсулой
  assert.equal(ActSearchEngine._capsuleAncestorOf(txt('plain')), null);
});

test('replaceRange: обе границы в ОДНОЙ капсуле → replaceData по узлу внутри (подпись меняется, span цел)', () => {
  // Фича: подпись ссылки/якорь сноски теперь ЗАМЕНЯЕМЫ. Обе границы под одной
  // капсулой → мутируем её текст-узел, сам span не трогаем.
  const cap = mutableCapsule('LinkText');
  const inner = cap.firstChild;
  ActSearchEngine.replaceRange(fakeRange(inner, 0, 4), 'Web'); // "Link" → "Web"
  assert.equal(inner.data, 'WebText');
  assert.equal(cap.textContent, 'WebText');
});

test('replaceRange: Range из пробега capsuleText теперь ЗАМЕНЯЕТ текст капсулы (была фича «неприкасаемости», снята)', () => {
  // Тот же путь, что в UI: пробег capsuleText → _locate → replaceRange. Раньше
  // бросал (_hasCapsuleAncestor), теперь заменяет — оставаясь помеченным capsuleText.
  const cap = mutableCapsule('LinkText');
  const editor = elem('DIV', [txt('foo'), cap, txt('bar')]);
  const runs = ActSearchEngine.collectRuns(editor);
  const capRun = runs[1];
  const found = ActSearchEngine.findInRuns(runs, 'Link', {});
  assert.equal(found.matches[0].capsuleText, true);
  const s = ActSearchEngine._locate(capRun, found.matches[0].start, false);
  const e = ActSearchEngine._locate(capRun, found.matches[0].end, true);
  ActSearchEngine.replaceRange(fakeRange(cap.firstChild, s.offset, e.offset), 'Web');
  assert.equal(cap.firstChild.data, 'WebText');
});

test('replaceRange: замена, ОПУСТОШАЮЩАЯ подпись капсулы, → бросает (вызывающий считает пропуском)', () => {
  const cap = mutableCapsule('word');
  const inner = cap.firstChild;
  assert.throws(() => ActSearchEngine.replaceRange(fakeRange(inner, 0, 4), ''), /опустош/);
  assert.equal(inner.data, 'word'); // не тронуто
  // Пробельная замена на всю подпись — тоже опустошение.
  assert.throws(() => ActSearchEngine.replaceRange(fakeRange(inner, 0, 4), '   '), /опустош/);
  // Zero-width (U+200B) на всю подпись — тоже опустошение (trim его не ловит).
  assert.throws(() => ActSearchEngine.replaceRange(fakeRange(inner, 0, 4), '\u200B'), /опустош/);
  // Частичная замена (остаётся видимый текст) — проходит.
  ActSearchEngine.replaceRange(fakeRange(inner, 0, 2), '');
  assert.equal(inner.data, 'rd');
});

test('replaceRange: границы в РАЗНЫХ капсулах → бросает (пересечение границы)', () => {
  const capA = mutableCapsule('aaa');
  const capB = mutableCapsule('bbb');
  const range = {
    startContainer: capA.firstChild, endContainer: capB.firstChild,
    startOffset: 0, endOffset: 1, toString: () => 'a', setStart() {}, setEnd() {},
  };
  assert.throws(() => ActSearchEngine.replaceRange(range, 'z'), /границу капсулы/);
});

test('replaceRange: одна граница в капсуле, другая снаружи → бросает', () => {
  const cap = mutableCapsule('xyz');
  const outside = txt('plain');
  const range = {
    startContainer: cap.firstChild, endContainer: outside,
    startOffset: 0, endOffset: 1, toString: () => 'x', setStart() {}, setEnd() {},
  };
  assert.throws(() => ActSearchEngine.replaceRange(range, 'z'), /границу капсулы/);
});

// ---------------------------------------------------------------------------
// FootnoteBodySearchTarget — тело сноски (data-footnote-text), невидимая в
// DOM поверхность поиска: run без DOM-сегментов, замена — сплайсом атрибута,
// не Range API.
// ---------------------------------------------------------------------------

test('FootnoteBodySearchTarget: id составной (blockId:footnote:footnoteId), blockId — отдельное поле', () => {
  const fn = fakeFootnoteEl({ footnoteId: 'footnote_42', blockId: 'tb7' });
  const target = new FootnoteBodySearchTarget(fn);
  assert.equal(target.id, 'tb7:footnote:footnote_42');
  assert.equal(target.blockId, 'tb7');
});

test('FootnoteBodySearchTarget: без родительского .textblock-editor → blockId null, id всё равно детерминирован', () => {
  const fn = fakeFootnoteEl({ footnoteId: 'footnote_1', blockId: null });
  const target = new FootnoteBodySearchTarget(fn);
  assert.equal(target.blockId, null);
  assert.equal(target.id, ':footnote:footnote_1');
});

test('FootnoteBodySearchTarget.collectRuns: один run, text=data-footnote-text, segments:[], footnoteEl===элемент', () => {
  const fn = fakeFootnoteEl({ footnoteText: 'Текст тела сноски' });
  const target = new FootnoteBodySearchTarget(fn);
  const runs = target.collectRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, 'Текст тела сноски');
  assert.deepEqual(runs[0].segments, []);
  assert.equal(runs[0].footnoteBody, true);
  assert.equal(runs[0].footnoteEl, fn);
});

test('FootnoteBodySearchTarget.collectRuns: пустое тело сноски → [] (симметрично flush()/_collectCapsuleTextRun)', () => {
  const fn = fakeFootnoteEl({ footnoteText: '' });
  const target = new FootnoteBodySearchTarget(fn);
  assert.deepEqual(target.collectRuns(), []);
});

test('TextBlockSearchTarget: blockId совпадает с id (симметрия контракта с FootnoteBodySearchTarget)', () => {
  const editor = { dataset: { textBlockId: 'tb9' } };
  const target = new TextBlockSearchTarget(editor);
  assert.equal(target.id, 'tb9');
  assert.equal(target.blockId, 'tb9');
});

test('findInRuns: пробрасывает footnoteBody+footnoteEl на матч; обычные/capsuleText-пробеги их не получают', () => {
  const fn = fakeFootnoteEl();
  const runs = [
    { text: 'foo', segments: [] },                                   // обычный (в жизни всегда есть segments, но поле неважно тут)
    { text: 'нашли слово тут', segments: [], footnoteBody: true, footnoteEl: fn },
  ];
  const res = ActSearchEngine.findInRuns(runs, 'слово', {});
  assert.deepEqual(res.matches, [{ runIndex: 1, start: 6, end: 11, footnoteBody: true, footnoteEl: fn }]);
  assert.equal('footnoteBody' in res.matches[0], true);

  const ordinary = ActSearchEngine.findInRuns(runs, 'foo', {});
  assert.deepEqual(ordinary.matches, [{ runIndex: 0, start: 0, end: 3 }]);
  assert.equal('footnoteBody' in ordinary.matches[0], false); // поле отсутствует, не просто falsy
});

test('buildAllMatches: пробег БЕЗ DOM-сегментов (footnoteBody) не падает на createRange — range:null + метаданные', () => {
  // buildTargets() читает реальный document; подменяем его на фейковую цель
  // без DOM (та же гарантия должна держаться и через buildTargets(), но
  // подмена изолирует тест от реального DOM/Range, недоступных в node).
  const fn = fakeFootnoteEl({ footnoteText: 'привет мир', blockId: 'tb1' });
  const fakeTarget = { id: 'tb1:footnote:footnote_1', collectRuns: () => [{ text: 'привет мир', segments: [], footnoteBody: true, footnoteEl: fn }] };
  const original = ActSearchEngine.buildTargets;
  ActSearchEngine.buildTargets = () => [fakeTarget];
  try {
    const res = ActSearchEngine.buildAllMatches('мир', {});
    assert.equal(res.error, undefined);
    assert.equal(res.matches.length, 1);
    const m = res.matches[0];
    assert.equal(m.range, null);
    assert.equal(m.targetId, 'tb1:footnote:footnote_1');
    assert.equal(m.footnoteBody, true);
    assert.equal(m.footnoteEl, fn);
    assert.equal(m.start, 7);
    assert.equal(m.end, 10);
  } finally {
    ActSearchEngine.buildTargets = original;
  }
});

test('buildAllMatches: несколько footnoteBody-целей — targetId/порядок сохраняются, ни одна не роняет Range-построение', () => {
  const fn1 = fakeFootnoteEl({ footnoteText: 'первая сноска', blockId: 'tb1' });
  const fn2 = fakeFootnoteEl({ footnoteText: 'вторая сноска', blockId: 'tb1' });
  const targets = [
    { id: 'tb1:footnote:fn1', collectRuns: () => [{ text: 'первая сноска', segments: [], footnoteBody: true, footnoteEl: fn1 }] },
    { id: 'tb1:footnote:fn2', collectRuns: () => [{ text: 'вторая сноска', segments: [], footnoteBody: true, footnoteEl: fn2 }] },
  ];
  const original = ActSearchEngine.buildTargets;
  ActSearchEngine.buildTargets = () => targets;
  try {
    const res = ActSearchEngine.buildAllMatches('сноска', {});
    assert.equal(res.matches.length, 2);
    assert.deepEqual(res.matches.map((m) => m.targetId), ['tb1:footnote:fn1', 'tb1:footnote:fn2']);
    assert.deepEqual(res.matches.map((m) => m.range), [null, null]);
    assert.deepEqual(res.matches.map((m) => m.footnoteEl), [fn1, fn2]);
  } finally {
    ActSearchEngine.buildTargets = original;
  }
});

test('findInTarget: тот же tolerant-фикс _rangeFromRun (второй caller) — footnoteBody не падает, range:null', () => {
  const fn = fakeFootnoteEl({ footnoteText: 'слово тут', blockId: 'tb1' });
  const target = { collectRuns: () => [{ text: 'слово тут', segments: [], footnoteBody: true, footnoteEl: fn }] };
  const res = ActSearchEngine.findInTarget(target, 'слово', {});
  assert.equal(res.error, undefined);
  assert.deepEqual(res.matches, [{ range: null, runIndex: 0, start: 0, end: 5, footnoteBody: true, footnoteEl: fn }]);
});

test('buildTargets: одна FootnoteBodySearchTarget НА КАЖДУЮ сноску блока (несколько на блок), после TextBlockSearchTarget блока', () => {
  const fn1 = fakeFootnoteEl({ footnoteId: 'fn_a', footnoteText: 'a' });
  const fn2 = fakeFootnoteEl({ footnoteId: 'fn_b', footnoteText: 'b' });
  const editor1 = {
    dataset: { textBlockId: 'tb1' },
    querySelectorAll: (sel) => (sel === '.text-footnote' ? [fn1, fn2] : []),
  };
  // closest() у fn1/fn2 уже настроен fakeFootnoteEl на СВОЙ синтетический
  // editor {dataset:{textBlockId:'tb1'}} (не обязательно === editor1, id
  // блока совпадает — этого достаточно для проверки id/blockId ниже).
  const editor2 = {
    dataset: { textBlockId: 'tb2' },
    querySelectorAll: () => [],
  };
  // buildTargets теперь скоупится КОМБИНИРОВАННЫМ селектором (textblock +
  // violation-поле) ради порядка документа — мок отвечает на него. Редакторы
  // без __surface → ветка текстблока (диспетч по __surface, не по классу).
  const COMBINED_SELECTOR = '.textblock-editor[data-text-block-id], .violation-field';
  const fakeContainer = {
    querySelectorAll: (sel) => (sel === COMBINED_SELECTOR ? [editor1, editor2] : []),
  };
  const originalGetById = document.getElementById;
  document.getElementById = (id) => (id === 'itemsContainer' ? fakeContainer : null);
  try {
    const targets = ActSearchEngine.buildTargets();
    assert.equal(targets.length, 4); // editor1 + 2 сноски + editor2
    assert.ok(targets[0] instanceof TextBlockSearchTarget);
    assert.equal(targets[0].id, 'tb1');
    assert.ok(targets[1] instanceof FootnoteBodySearchTarget);
    assert.equal(targets[1].id, 'tb1:footnote:fn_a');
    assert.ok(targets[2] instanceof FootnoteBodySearchTarget);
    assert.equal(targets[2].id, 'tb1:footnote:fn_b');
    assert.ok(targets[3] instanceof TextBlockSearchTarget);
    assert.equal(targets[3].id, 'tb2');
  } finally {
    document.getElementById = originalGetById;
  }
});

// ---------------------------------------------------------------------------
// ViolationFieldSearchTarget — rich-поля нарушения как поверхность поиска
// (духотипизация на host.__surface; движок остаётся violation-агностичным).
// ---------------------------------------------------------------------------

test('ViolationFieldSearchTarget: id/blockId из __surface.id, isViolationField=true', () => {
  const surface = fakeSurface({ id: 'viol:v1:violated' });
  const target = new ViolationFieldSearchTarget(fakeViolationHost(surface));
  assert.equal(target.id, 'viol:v1:violated');
  assert.equal(target.blockId, 'viol:v1:violated'); // нет textblock — id сам себе «блок»
  assert.equal(target.isViolationField, true);       // дискриминатор для undo в find-bar
});

test('ViolationFieldSearchTarget.collectRuns: пробеги хоста тем же DFS, что у текстблока', () => {
  const host = fakeViolationHost(fakeSurface(), [txt('foo'), capsule('x'), txt('bar')]);
  const runs = new ViolationFieldSearchTarget(host).collectRuns();
  assert.deepEqual(runs.map((r) => r.text), ['foo', 'x', 'bar']);
  assert.deepEqual(runs.map((r) => !!r.capsuleText), [false, true, false]);
});

test('ViolationFieldSearchTarget.getContent/setContent делегируют в поверхность', () => {
  const surface = fakeSurface({ content: 'модель' });
  const target = new ViolationFieldSearchTarget(fakeViolationHost(surface));
  assert.equal(target.getContent(), 'модель');
  target.setContent('<b>новое</b>');
  assert.deepEqual(surface.setCalls, ['<b>новое</b>']);
});

test('ViolationFieldSearchTarget.persist: commit поверхности + toggleEmptyClass хоста (паритет finalizeEdit)', () => {
  // Программная замена НЕ шлёт input → placeholder-класс/капсульная гигиена сами
  // не обновятся; persist тоглит --empty явно (у текстблока это делает finalizeEdit).
  const surface = fakeSurface();
  const host = fakeViolationHost(surface);
  const target = new ViolationFieldSearchTarget(host);
  const toggled = [];
  const orig = textBlockManager._toggleEmptyClass;
  textBlockManager._toggleEmptyClass = (el) => toggled.push(el);
  try {
    target.persist();
    assert.equal(surface.commitCount, 1);
    assert.deepEqual(toggled, [host]);
  } finally {
    textBlockManager._toggleEmptyClass = orig;
  }
});

test('buildTargets: violation-поля в ПОРЯДКЕ ДОКУМЕНТА между текстблоками (v1, tb, v2)', () => {
  // Единый комбинированный селектор в порядке документа — иначе навигация/счётчик
  // сбились бы (все текстблоки, затем все поля). Диспетч ветвей — по __surface.
  const v1 = fakeViolationHost(fakeSurface({ id: 'viol:v1:violated' }));
  const editor = { dataset: { textBlockId: 'tb1' }, querySelectorAll: () => [] };
  const v2 = fakeViolationHost(fakeSurface({ id: 'viol:v2:violated' }));
  const COMBINED_SELECTOR = '.textblock-editor[data-text-block-id], .violation-field';
  const fakeContainer = {
    querySelectorAll: (sel) => (sel === COMBINED_SELECTOR ? [v1, editor, v2] : []),
  };
  const originalGetById = document.getElementById;
  document.getElementById = (id) => (id === 'itemsContainer' ? fakeContainer : null);
  try {
    const targets = ActSearchEngine.buildTargets();
    assert.equal(targets.length, 3);
    assert.ok(targets[0] instanceof ViolationFieldSearchTarget);
    assert.equal(targets[0].id, 'viol:v1:violated');
    assert.ok(targets[1] instanceof TextBlockSearchTarget);
    assert.equal(targets[1].id, 'tb1');
    assert.ok(targets[2] instanceof ViolationFieldSearchTarget);
    assert.equal(targets[2].id, 'viol:v2:violated');
  } finally {
    document.getElementById = originalGetById;
  }
});

test('buildTargets: violation-field без __surface (бэкреф не проставлен) — молча пропущено', () => {
  // В бою .violation-field ВСЕГДА несёт __surface; без него цель бесполезна
  // (persist/undo некуда адресовать) — пропускаем, а не роняем поиск.
  const orphan = elem('DIV', [], 'violation-field'); // ни __surface, ни dataset.textBlockId
  const COMBINED_SELECTOR = '.textblock-editor[data-text-block-id], .violation-field';
  const fakeContainer = {
    querySelectorAll: (sel) => (sel === COMBINED_SELECTOR ? [orphan] : []),
  };
  const originalGetById = document.getElementById;
  document.getElementById = (id) => (id === 'itemsContainer' ? fakeContainer : null);
  try {
    assert.deepEqual(ActSearchEngine.buildTargets(), []);
  } finally {
    document.getElementById = originalGetById;
  }
});

test('replaceRange: один текстовый узел → replaceData, НЕ nodeValue= (сохраняет чужие Range)', () => {
  // nodeValue= эквивалентен replaceData(0, len, ...) → схлопывает ВСЕ границы
  // живых Range в узле к 0 и ломает back-to-front replace-all. Движок обязан
  // звать replaceData(s, e-s, ...), правящий только [s, e).
  let call = null;
  const tn = {
    nodeType: 3, nodeValue: 'foobar', parentNode: null,
    replaceData(offset, count, data) {
      call = { offset, count, data };
      this.nodeValue = this.nodeValue.slice(0, offset) + data + this.nodeValue.slice(offset + count);
    },
  };
  let caretStart = null;
  const range = {
    startContainer: tn, endContainer: tn, startOffset: 0, endOffset: 3,
    setStart(_n, o) { caretStart = o; }, setEnd() {},
  };
  ActSearchEngine.replaceRange(range, 'XYZ');
  assert.deepEqual(call, { offset: 0, count: 3, data: 'XYZ' }); // именно replaceData(s, e-s, ...)
  assert.equal(tn.nodeValue, 'XYZbar');
  assert.equal(caretStart, 3); // каретка схлопнута на конец вставки
});
