/**
 * Тесты чистых функций блока пользователя в топбаре (user-card-core.js):
 * выбор двух строк (имя + логин) и построение пути к фото профиля.
 *
 * Вторая строка раньше была статичной заглушкой «Сотрудник»; теперь там
 * логин, и его нужно прятать, когда логин уже показан первой строкой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAvatarPath,
  formatShortFio,
  resolveTopbarUserLines,
} from '../../static/js/portal/user-card-core.js';

test('resolveTopbarUserLines: есть ФИО — в топбаре без отчества, полное отдельным полем', () => {
  const profile = { fullname: 'Иванов Иван Иванович', login: '12345' };
  assert.deepEqual(resolveTopbarUserLines(profile, '12345'), {
    name: 'Иванов Иван',
    fullName: 'Иванов Иван Иванович',
    login: '12345',
  });
});

test('resolveTopbarUserLines: ФИО не подтянулось — логин только в первой строке', () => {
  const profile = { fullname: '', login: '12345' };
  assert.deepEqual(resolveTopbarUserLines(profile, '12345'), {
    name: '12345',
    fullName: '12345',
    login: '',
  });
});

test('resolveTopbarUserLines: профиль не загружен — имя из username, вторая строка пуста', () => {
  assert.deepEqual(resolveTopbarUserLines(null, '12345'), {
    name: '12345',
    fullName: '12345',
    login: '',
  });
});

test('resolveTopbarUserLines: ни профиля, ни username — обе строки пусты', () => {
  assert.deepEqual(resolveTopbarUserLines(null, null), {
    name: '',
    fullName: '',
    login: '',
  });
});

test('formatShortFio: три слова — фамилия и имя', () => {
  assert.equal(formatShortFio('МАШТАКОВ ДЕНИС РОМАНОВИЧ'), 'МАШТАКОВ ДЕНИС');
});

test('formatShortFio: два слова и одно — как есть', () => {
  assert.equal(formatShortFio('Иванов И.И.'), 'Иванов И.И.');
  assert.equal(formatShortFio('12345'), '12345');
});

test('formatShortFio: лишние пробелы схлопываются', () => {
  assert.equal(formatShortFio('  Волкова   Наталья  Александровна '), 'Волкова Наталья');
});

test('formatShortFio: пустое значение — пустая строка', () => {
  assert.equal(formatShortFio(''), '');
  assert.equal(formatShortFio(null), '');
  assert.equal(formatShortFio(undefined), '');
});

test('formatShortFio: больше трёх слов — всё равно первые два', () => {
  assert.equal(formatShortFio('Де Ла Круз Хуан'), 'Де Ла');
});

test('resolveTopbarUserLines: логин из профиля важнее username-фолбэка', () => {
  const profile = { fullname: 'Петров П.П.', login: '67890' };
  assert.equal(resolveTopbarUserLines(profile, '12345').login, '67890');
});

test('buildAvatarPath: username и версия — путь с ?v=', () => {
  assert.equal(
    buildAvatarPath('12345', 1753963200),
    '/api/v1/auth/avatar/12345?v=1753963200',
  );
});

test('buildAvatarPath: версии нет (фото не загружено) — null', () => {
  assert.equal(buildAvatarPath('12345', null), null);
  assert.equal(buildAvatarPath('12345', undefined), null);
  assert.equal(buildAvatarPath('12345', ''), null);
});

test('buildAvatarPath: нет username — null', () => {
  assert.equal(buildAvatarPath(null, 1753963200), null);
});

test('buildAvatarPath: версия 0 — валидная версия, не «фото нет»', () => {
  assert.equal(buildAvatarPath('12345', 0), '/api/v1/auth/avatar/12345?v=0');
});

test('buildAvatarPath: username экранируется', () => {
  assert.equal(
    buildAvatarPath('a/b?c', 7),
    '/api/v1/auth/avatar/a%2Fb%3Fc?v=7',
  );
});
