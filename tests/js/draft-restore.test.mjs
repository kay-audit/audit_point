/**
 * Тесты чистого предиката восстановления черновика (H3).
 *
 * shouldOfferRestore решает судьбу снимка localStorage при загрузке акта:
 * 'restore' — предложить восстановление (акт не менялся с момента снимка),
 * 'conflict' — акт менялся после снимка, выбор версии за пользователем
 * (диалог конфликта; молча снимок НЕ удаляется),
 * 'discard' — молча удалить (структурно повреждён), 'none' — снимка нет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldOfferRestore } from '../../static/js/constructor/state/draft-restore.js';

/** Валидный снимок с данными и базовой меткой. */
function makeSnapshot(overrides = {}) {
  return {
    actId: 7,
    savedAt: '2026-06-11T12:00:00.000Z',
    baseUpdatedAt: '2026-06-11T10:00:00.123456',
    version: 2,
    data: { tree: { id: 'root', children: [] }, tables: {}, textBlocks: {}, violations: {} },
    ...overrides,
  };
}

test('нет снимка → none', () => {
  assert.equal(shouldOfferRestore(null, '2026-06-11T10:00:00.123456'), 'none');
  assert.equal(shouldOfferRestore(undefined, '2026-06-11T10:00:00.123456'), 'none');
});

test('метки совпадают посимвольно → restore', () => {
  const snap = makeSnapshot();
  assert.equal(shouldOfferRestore(snap, '2026-06-11T10:00:00.123456'), 'restore');
});

// Сознательная смена семантики: раньше расхождение меток давало 'discard'
// (черновик молча уничтожался), теперь — 'conflict' (выбор за пользователем).
test('метки не совпадают (акт менялся) → conflict, а не молчаливый discard', () => {
  const snap = makeSnapshot();
  assert.equal(shouldOfferRestore(snap, '2026-06-11T11:30:00.000000'), 'conflict');
});

test('акт менялся: серверная метка позже базы снимка → conflict', () => {
  const snap = makeSnapshot({ baseUpdatedAt: '2026-06-10T09:00:00.000000' });
  assert.equal(shouldOfferRestore(snap, '2026-06-12T09:00:00.000000'), 'conflict');
});

test('один момент времени в разной записи → restore (эпоха-фоллбэк)', () => {
  const snap = makeSnapshot({ baseUpdatedAt: '2026-06-11T10:00:00' });
  assert.equal(shouldOfferRestore(snap, '2026-06-11T10:00:00.000'), 'restore');
});

test('снимок без baseUpdatedAt → discard (нельзя проверить, менялся ли акт)', () => {
  const snap = makeSnapshot({ baseUpdatedAt: null });
  assert.equal(shouldOfferRestore(snap, '2026-06-11T10:00:00.123456'), 'discard');
});

test('нет серверного updated_at → discard', () => {
  const snap = makeSnapshot();
  assert.equal(shouldOfferRestore(snap, null), 'discard');
  assert.equal(shouldOfferRestore(snap, undefined), 'discard');
});

test('повреждённый снимок (нет data) → discard', () => {
  assert.equal(
    shouldOfferRestore(makeSnapshot({ data: null }), '2026-06-11T10:00:00.123456'),
    'discard'
  );
  assert.equal(
    shouldOfferRestore(makeSnapshot({ data: 'мусор' }), '2026-06-11T10:00:00.123456'),
    'discard'
  );
});

test('повреждённый снимок (data без дерева) → discard', () => {
  const snap = makeSnapshot({ data: { tables: {} } });
  assert.equal(shouldOfferRestore(snap, '2026-06-11T10:00:00.123456'), 'discard');
});

test('структурно битый снимок при расходящихся метках → всё равно discard, не conflict', () => {
  // 'conflict' — только для восстановимых снимков: диалог конфликта не должен
  // предлагать восстановить черновик, из которого нечего восстановить.
  const snap = makeSnapshot({ data: { tables: {} } });
  assert.equal(shouldOfferRestore(snap, '2026-06-12T10:00:00.000000'), 'discard');
});

// Сознательная смена: нечитаемые, но присутствующие метки — снимок структурно
// валиден, а «менялся ли акт» проверить нельзя. Раньше — молчаливый discard;
// теперь честный диалог конфликта (пользователь сам решает судьбу правок).
test('нечитаемые метки времени → conflict, а не ложный restore и не молчаливый discard', () => {
  const snap = makeSnapshot({ baseUpdatedAt: 'не-дата' });
  assert.equal(shouldOfferRestore(snap, 'тоже-не-дата'), 'conflict');
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
  assert.equal(shouldOfferRestore(snap, '2026-06-11T10:00:00.123456'), 'restore');
});
