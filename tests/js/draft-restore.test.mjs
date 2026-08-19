/**
 * Тесты чистого предиката восстановления черновика (H3).
 *
 * shouldOfferRestore решает судьбу снимка localStorage при загрузке акта
 * сверкой int-счётчиков контента (baseContentVersion снимка ↔ серверный
 * acts.content_version):
 * 'restore' — контент не менялся с момента снимка,
 * 'conflict' — контент менялся, выбор версии за пользователем
 * (диалог конфликта; молча снимок НЕ удаляется),
 * 'discard' — молча удалить (структурно повреждён), 'none' — снимка нет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldOfferRestore } from '../../static/js/constructor/state/draft-restore.js';

/** Валидный снимок с данными и базовой версией контента. */
function makeSnapshot(overrides = {}) {
  return {
    actId: 7,
    savedAt: '2026-06-11T12:00:00.000Z',
    baseUpdatedAt: '2026-06-11T10:00:00.123456', // справочное, в решении не участвует
    baseContentVersion: 5,
    version: 2,
    data: { tree: { id: 'root', children: [] }, tables: {}, textBlocks: {}, violations: {} },
    ...overrides,
  };
}

test('нет снимка → none', () => {
  assert.equal(shouldOfferRestore(null, 5), 'none');
  assert.equal(shouldOfferRestore(undefined, 5), 'none');
});

test('версии контента совпадают → restore', () => {
  assert.equal(shouldOfferRestore(makeSnapshot(), 5), 'restore');
});

test('OCC-выигрыш content_version: смена updated_at (метаданные/соседние части КМ) черновик НЕ инвалидирует', () => {
  // Раньше сверка шла по updated_at, который бампится и НЕ-контентными
  // записями — черновик ложно конфликтовал. Теперь updated_at в решении
  // не участвует вовсе: при равных content_version — restore.
  const snap = makeSnapshot({ baseUpdatedAt: '2026-06-11T10:00:00.123456' });
  // Сервер: updated_at сменился (кто-то правил метаданные), контент — нет.
  assert.equal(shouldOfferRestore(snap, 5), 'restore');
});

test('версия 0 — валидная база: 0 === 0 → restore (не falsy-discard)', () => {
  const snap = makeSnapshot({ baseContentVersion: 0 });
  assert.equal(shouldOfferRestore(snap, 0), 'restore');
});

test('версии не совпадают (контент менялся) → conflict, а не молчаливый discard', () => {
  assert.equal(shouldOfferRestore(makeSnapshot(), 6), 'conflict');
  assert.equal(shouldOfferRestore(makeSnapshot({ baseContentVersion: 0 }), 1), 'conflict');
});

test('снимок без baseContentVersion → discard (нельзя проверить, менялся ли контент)', () => {
  assert.equal(shouldOfferRestore(makeSnapshot({ baseContentVersion: null }), 5), 'discard');
  assert.equal(shouldOfferRestore(makeSnapshot({ baseContentVersion: undefined }), 5), 'discard');
});

test('нет серверного content_version → discard', () => {
  assert.equal(shouldOfferRestore(makeSnapshot(), null), 'discard');
  assert.equal(shouldOfferRestore(makeSnapshot(), undefined), 'discard');
});

test('нечисловые версии → discard, а не ложный restore/conflict', () => {
  assert.equal(shouldOfferRestore(makeSnapshot({ baseContentVersion: '5' }), 5), 'discard');
  assert.equal(shouldOfferRestore(makeSnapshot(), '5'), 'discard');
});

test('повреждённый снимок (нет data) → discard', () => {
  assert.equal(shouldOfferRestore(makeSnapshot({ data: null }), 5), 'discard');
  assert.equal(shouldOfferRestore(makeSnapshot({ data: 'мусор' }), 5), 'discard');
});

test('повреждённый снимок (data без дерева) → discard', () => {
  assert.equal(shouldOfferRestore(makeSnapshot({ data: { tables: {} } }), 5), 'discard');
});

test('структурно битый снимок при расходящихся версиях → всё равно discard, не conflict', () => {
  // 'conflict' — только для восстановимых снимков: диалог конфликта не должен
  // предлагать восстановить черновик, из которого нечего восстановить.
  assert.equal(shouldOfferRestore(makeSnapshot({ data: { tables: {} } }), 9), 'discard');
});

test('#10 (Variant Б): несогласованный, но свежий снимок → restore (не discard)', () => {
  // Сирота-запись словаря (textBlock ссылается на nodeId, которого нет в дереве)
  // + висячая ссылка узла. Раньше молча выбрасывалось (потеря правок); теперь
  // восстанавливается, а sanitizeActContent на пути загрузки чинит неразрушающе.
  const snap = makeSnapshot({
    data: {
      tree: { id: 'root', children: [{ id: 'n1', textBlockId: 'tbX' }] },
      tables: {},
      textBlocks: { tbOrphan: { nodeId: 'nMissing', content: 'сирота' } },
      violations: {},
    },
  });
  assert.equal(shouldOfferRestore(snap, 5), 'restore');
});
