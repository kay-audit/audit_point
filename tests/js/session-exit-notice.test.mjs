/**
 * Тесты выбора плашки завершения сессии (G5).
 *
 * Ключевой инвариант: при потере блокировки (sessionLockLost) сообщение НЕ
 * утверждает, что данные сохранены — это была бы ложь (save вернул 409,
 * изменения в БД не записаны). Этот случай приоритетнее обычного autoExit'а.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSessionExitNotice } from '../../static/js/portal/acts-manager/session-exit-notice.js';

test('пусто без флагов', () => {
  assert.equal(pickSessionExitNotice({}), null);
  assert.equal(pickSessionExitNotice({ lockLost: false, autoExited: false }), null);
});

test('lockLost: честное сообщение — НЕ сохранено в БД, черновик локально', () => {
  const n = pickSessionExitNotice({ lockLost: true });
  assert.equal(n.flag, 'sessionLockLost');
  assert.equal(n.type, 'warning');
  // Не лжём про сохранение.
  assert.ok(!/Изменения сохранены\.$/.test(n.message), n.message);
  assert.ok(n.message.includes('НЕ сохранены в базе данных'), n.message);
  assert.ok(n.message.includes('локальном черновике'), n.message);
});

test('lockLost приоритетнее autoExited (важнее: потеря данных из БД)', () => {
  const n = pickSessionExitNotice({ lockLost: true, autoExited: true });
  assert.equal(n.flag, 'sessionLockLost');
});

test('saveFailed: честное «сохранить не удалось», черновик локально', () => {
  const n = pickSessionExitNotice({ saveFailed: true });
  assert.equal(n.flag, 'sessionExitSaveFailed');
  assert.equal(n.type, 'warning');
  assert.ok(!/Изменения сохранены\.$/.test(n.message), n.message);
  assert.ok(n.message.includes('не удалось'), n.message);
  assert.ok(n.message.includes('локальном черновике'), n.message);
});

test('lockLost приоритетнее saveFailed, saveFailed приоритетнее плашек успеха', () => {
  assert.equal(pickSessionExitNotice({ lockLost: true, saveFailed: true }).flag, 'sessionLockLost');
  assert.equal(
    pickSessionExitNotice({ saveFailed: true, autoExited: true, exitedWithSave: true }).flag,
    'sessionExitSaveFailed'
  );
});

test('autoExited: плашка автовыхода (сохранено)', () => {
  const n = pickSessionExitNotice({ autoExited: true });
  assert.equal(n.flag, 'sessionAutoExited');
  assert.ok(n.message.includes('Изменения сохранены'), n.message);
});

test('exitedWithSave: плашка обычного выхода с сохранением', () => {
  const n = pickSessionExitNotice({ exitedWithSave: true });
  assert.equal(n.flag, 'sessionExitedWithSave');
  assert.equal(n.type, 'success');
});

test('autoExited приоритетнее exitedWithSave', () => {
  const n = pickSessionExitNotice({ autoExited: true, exitedWithSave: true });
  assert.equal(n.flag, 'sessionAutoExited');
});
