/**
 * B2: чистые (DOM-независимые) хелперы find-bar'а — текст подтверждения замены,
 * форматтер счётчика (в т.ч. capped), арифметика заворачивания prev/next,
 * группировка совпадений по цели, снимок/восстановление content'а блоков.
 *
 * Живой UI (панель, Range, CSS.highlights, replaceRange→persist, custom-undo)
 * DOM-зависим и ОТЛОЖЕН в Playwright-спек — здесь только чистая логика.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pluralRu,
  buildReplaceAllConfirmMessage,
  formatMatchCounter,
  wrapIndex,
  groupMatchesByTarget,
  snapshotTextBlockContents,
  applySnapshotRestore,
  snapshotSurfaceContents,
  restoreSurfaceSnapshot,
} from '../../static/js/constructor/search/act-search-replace.js';

/**
 * Фейковая цель-поверхность (ViolationFieldSearchTarget-контракт для undo):
 * id + getContent/setContent над локальной моделью. setCalls фиксирует
 * восстановление.
 */
function fakeSurfaceTarget(id, content) {
  return {
    id,
    _content: content,
    setCalls: [],
    getContent() { return this._content; },
    setContent(html) { this.setCalls.push(html); this._content = html; },
  };
}

// ── pluralRu ────────────────────────────────────────────────────────────────

test('pluralRu: три формы по стандартному правилу склонения', () => {
  const f = ['совпадение', 'совпадения', 'совпадений'];
  assert.equal(pluralRu(1, f), 'совпадение');  // n%10==1, n%100!=11 → one
  assert.equal(pluralRu(2, f), 'совпадения');  // n%10 in 2..4 → few
  assert.equal(pluralRu(5, f), 'совпадений');  // → many
  assert.equal(pluralRu(11, f), 'совпадений'); // 11 — исключение → many
  assert.equal(pluralRu(21, f), 'совпадение'); // оканч. на 1 (не 11) → one
  assert.equal(pluralRu(22, f), 'совпадения'); // оканч. на 2 → few
  assert.equal(pluralRu(25, f), 'совпадений'); // → many
});

// ── buildReplaceAllConfirmMessage ───────────────────────────────────────────

// «Фрагмент», а не «блок»: цели смешанные (текстблоки И rich-поля нарушений),
// «блок» — доменное имя текстблока, для поля нарушения вводило бы в заблуждение.
test('buildReplaceAllConfirmMessage: корректное склонение «совпадение/фрагмент»', () => {
  assert.equal(buildReplaceAllConfirmMessage(1, 1), 'Заменить 1 совпадение в 1 фрагменте?');
  assert.equal(buildReplaceAllConfirmMessage(3, 2), 'Заменить 3 совпадения в 2 фрагментах?');
  assert.equal(buildReplaceAllConfirmMessage(5, 5), 'Заменить 5 совпадений в 5 фрагментах?');
  assert.equal(buildReplaceAllConfirmMessage(7, 3), 'Заменить 7 совпадений в 3 фрагментах?');
  assert.equal(buildReplaceAllConfirmMessage(0, 0), 'Заменить 0 совпадений в 0 фрагментах?');
});

// ── formatMatchCounter ──────────────────────────────────────────────────────

test('formatMatchCounter: нет совпадений → «0 / 0»', () => {
  assert.equal(formatMatchCounter(-1, 0, false), '0 / 0');
  assert.equal(formatMatchCounter(0, 0, false), '0 / 0');
});

test('formatMatchCounter: «k / N» (индекс 1-based)', () => {
  assert.equal(formatMatchCounter(0, 5, false), '1 / 5');
  assert.equal(formatMatchCounter(4, 5, false), '5 / 5');
});

test('formatMatchCounter: currentIdx=-1 при наличии совпадений → «0 / N»', () => {
  assert.equal(formatMatchCounter(-1, 5, false), '0 / 5');
});

test('formatMatchCounter: capped → итог «MAX+»', () => {
  assert.equal(formatMatchCounter(0, 5000, true, 5000), '1 / 5000+');
  assert.equal(formatMatchCounter(10, 5000, true, 5000), '11 / 5000+');
});

// ── wrapIndex ───────────────────────────────────────────────────────────────

test('wrapIndex: заворачивание вперёд/назад по кольцу', () => {
  assert.equal(wrapIndex(0, 3), 0);
  assert.equal(wrapIndex(3, 3), 0);      // next с последнего → первый
  assert.equal(wrapIndex(-1, 3), 2);     // prev с первого → последний
  assert.equal(wrapIndex(4, 3), 1);
  assert.equal(wrapIndex(-4, 3), 2);
});

test('wrapIndex: пустой список → −1', () => {
  assert.equal(wrapIndex(0, 0), -1);
  assert.equal(wrapIndex(5, 0), -1);
});

// ── groupMatchesByTarget ────────────────────────────────────────────────────

test('groupMatchesByTarget: группирует по targetId, сохраняя порядок целей и совпадений', () => {
  const matches = [
    { targetId: 'a', start: 0 },
    { targetId: 'a', start: 5 },
    { targetId: 'b', start: 2 },
    { targetId: 'a', start: 9 },
  ];
  const g = groupMatchesByTarget(matches);
  assert.deepEqual([...g.keys()], ['a', 'b']);       // порядок первого появления
  assert.equal(g.get('a').length, 3);
  assert.equal(g.get('b').length, 1);
  assert.deepEqual(g.get('a').map((m) => m.start), [0, 5, 9]); // порядок сохранён
});

test('groupMatchesByTarget: пустой/битый вход не падает', () => {
  assert.equal(groupMatchesByTarget([]).size, 0);
  assert.equal(groupMatchesByTarget(null).size, 0);
  assert.equal(groupMatchesByTarget([{ start: 1 }, null]).size, 0); // без targetId — пропуск
});

// ── snapshotTextBlockContents ───────────────────────────────────────────────

test('snapshotTextBlockContents: снимает content по id, пропуская отсутствующие', () => {
  const store = { a: { content: 'AAA' }, b: { content: 'BBB' }, c: { content: 'CCC' } };
  const snap = snapshotTextBlockContents(['a', 'c', 'zzz'], store);
  assert.equal(snap.size, 2);
  assert.equal(snap.get('a'), 'AAA');
  assert.equal(snap.get('c'), 'CCC');
  assert.equal(snap.has('zzz'), false); // нет в store — не попал
});

test('snapshotTextBlockContents: блок без строкового content пропускается', () => {
  const store = { a: { content: 'AAA' }, b: {} };
  const snap = snapshotTextBlockContents(['a', 'b'], store);
  assert.deepEqual([...snap.keys()], ['a']);
});

// ── applySnapshotRestore ────────────────────────────────────────────────────

test('applySnapshotRestore: пишет content обратно и зовёт onEach по каждому id', () => {
  const store = { a: { content: 'NEW-A' }, b: { content: 'NEW-B' } };
  const snapshot = new Map([['a', 'OLD-A'], ['b', 'OLD-B']]);
  const rerendered = [];
  const n = applySnapshotRestore(snapshot, store, (id) => rerendered.push(id));
  assert.equal(n, 2);
  assert.equal(store.a.content, 'OLD-A');
  assert.equal(store.b.content, 'OLD-B');
  assert.deepEqual(rerendered.sort(), ['a', 'b']);
});

test('applySnapshotRestore: отсутствующий в store блок пропускается (без onEach)', () => {
  const store = { a: { content: 'NEW-A' } };
  const snapshot = new Map([['a', 'OLD-A'], ['gone', 'X']]);
  const rerendered = [];
  const n = applySnapshotRestore(snapshot, store, (id) => rerendered.push(id));
  assert.equal(n, 1);
  assert.equal(store.a.content, 'OLD-A');
  assert.deepEqual(rerendered, ['a']); // 'gone' не перерисован
});

test('applySnapshotRestore: пустой снимок → 0, без исключения', () => {
  assert.equal(applySnapshotRestore(null, {}, () => {}), 0);
  assert.equal(applySnapshotRestore(new Map(), {}, () => {}), 0);
});

// ── snapshotSurfaceContents (undo replace-all для violation-полей) ───────────
// Модель rich-поля нарушения НЕ в AppState.textBlocks — снимаем через саму
// цель (getContent), симметрично snapshotTextBlockContents по .content блока.

test('snapshotSurfaceContents: снимает getContent по id цели', () => {
  const targets = [fakeSurfaceTarget('viol:v1:violated', 'AAA'), fakeSurfaceTarget('viol:v2:established', 'BBB')];
  const snap = snapshotSurfaceContents(targets);
  assert.equal(snap.size, 2);
  assert.equal(snap.get('viol:v1:violated'), 'AAA');
  assert.equal(snap.get('viol:v2:established'), 'BBB');
});

test('snapshotSurfaceContents: цель без getContent / нестроковый content пропускаются', () => {
  const noGetter = { id: 'x' };                                  // нет getContent
  const nonString = { id: 'y', getContent: () => ({}) };         // не строка (мусор)
  const ok = fakeSurfaceTarget('z', '');                         // пустая строка — валидна
  const snap = snapshotSurfaceContents([noGetter, nonString, ok]);
  assert.deepEqual([...snap.keys()], ['z']);
  assert.equal(snap.get('z'), '');
});

test('snapshotSurfaceContents: пустой/битый вход → пустой Map, без исключения', () => {
  assert.equal(snapshotSurfaceContents([]).size, 0);
  assert.equal(snapshotSurfaceContents(null).size, 0);
});

// ── restoreSurfaceSnapshot (divergence-guard по getContent()===after) ────────

test('restoreSurfaceSnapshot: восстанавливает before через setContent, когда поле не менялось (getContent===after)', () => {
  const t = fakeSurfaceTarget('viol:v1:violated', 'ПОСЛЕ');       // текущее === after
  const targetsById = new Map([[t.id, t]]);
  const undoMap = new Map([['viol:v1:violated', { before: 'ДО', after: 'ПОСЛЕ' }]]);
  const res = restoreSurfaceSnapshot(undoMap, targetsById);
  assert.deepEqual(res, { restored: 1, skipped: 0 });
  assert.deepEqual(t.setCalls, ['ДО']);
  assert.equal(t.getContent(), 'ДО');
});

test('restoreSurfaceSnapshot: поле изменилось после замены (getContent!==after) → пропуск, без затирания', () => {
  const t = fakeSurfaceTarget('viol:v1:violated', 'ПРАВКА ЮЗЕРА'); // разошлось с after
  const targetsById = new Map([[t.id, t]]);
  const undoMap = new Map([['viol:v1:violated', { before: 'ДО', after: 'ПОСЛЕ' }]]);
  const res = restoreSurfaceSnapshot(undoMap, targetsById);
  assert.deepEqual(res, { restored: 0, skipped: 1 });
  assert.deepEqual(t.setCalls, []);                                // не тронуто
});

test('restoreSurfaceSnapshot: цель исчезла из DOM (нет в targetsById) → пропуск', () => {
  const undoMap = new Map([['viol:gone:violated', { before: 'ДО', after: 'ПОСЛЕ' }]]);
  const res = restoreSurfaceSnapshot(undoMap, new Map());
  assert.deepEqual(res, { restored: 0, skipped: 1 });
});

test('restoreSurfaceSnapshot: цель без setContent (поверхность не умеет писать) → пропуск, не падение', () => {
  const t = { id: 'viol:v1:violated:block:text_1', getContent: () => 'ПОСЛЕ' }; // без setContent
  const undoMap = new Map([[t.id, { before: 'ДО', after: 'ПОСЛЕ' }]]);
  const res = restoreSurfaceSnapshot(undoMap, new Map([[t.id, t]]));
  assert.deepEqual(res, { restored: 0, skipped: 1 });
});

test('restoreSurfaceSnapshot: пустой снимок → {0,0}, без исключения', () => {
  assert.deepEqual(restoreSurfaceSnapshot(null, new Map()), { restored: 0, skipped: 0 });
  assert.deepEqual(restoreSurfaceSnapshot(new Map(), new Map()), { restored: 0, skipped: 0 });
});
