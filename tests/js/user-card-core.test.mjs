/**
 * Тесты чистого ядра карточки пользователя (user-card-core.js).
 *
 * Покрывают resolveUserCardFields: полный профиль, пустая должность/email
 * (не подставляют плейсхолдер), отсутствие профиля (фолбэк на username),
 * отсутствие и профиля, и username.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUserCardFields } from '../../static/js/portal/user-card-core.js';

test('resolveUserCardFields: полный профиль — все поля из него', () => {
  const profile = { fullname: 'Иванов Иван Иванович', job: 'Аудитор', email: 'ivanov@example.com' };
  assert.deepEqual(resolveUserCardFields(profile, '12345'), {
    name: 'Иванов Иван Иванович',
    job: 'Аудитор',
    email: 'ivanov@example.com',
  });
});

test('resolveUserCardFields: пустая должность — пустая строка, не плейсхолдер', () => {
  const profile = { fullname: 'Иванов И.И.', job: '', email: 'ivanov@example.com' };
  assert.equal(resolveUserCardFields(profile, '12345').job, '');
});

test('resolveUserCardFields: пустой email — пустая строка', () => {
  const profile = { fullname: 'Иванов И.И.', job: 'Аудитор', email: '' };
  assert.equal(resolveUserCardFields(profile, '12345').email, '');
});

test('resolveUserCardFields: профиль не загружен (null) — имя падает на username', () => {
  assert.deepEqual(resolveUserCardFields(null, '12345'), {
    name: '12345',
    job: '',
    email: '',
  });
});

test('resolveUserCardFields: ни профиля, ни username — пустые строки', () => {
  assert.deepEqual(resolveUserCardFields(null, null), { name: '', job: '', email: '' });
});

test('resolveUserCardFields: fullname пустой в профиле — имя падает на username', () => {
  const profile = { fullname: '', job: 'Аудитор', email: 'ivanov@example.com' };
  const fields = resolveUserCardFields(profile, '12345');
  assert.equal(fields.name, '12345');
  assert.equal(fields.job, 'Аудитор');
});
