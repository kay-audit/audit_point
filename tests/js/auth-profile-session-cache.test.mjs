/**
 * Тесты кеша профиля в sessionStorage (auth.js).
 *
 * Модуль грузится браузером дважды как два разных ES-модуля: шаблоны
 * импортируют его с ?v=<версия>, а импорты внутри модулей — без неё.
 * checkAuth() отрабатывает в одном графе, а топбар и аватарка читают
 * профиль во втором — связь между ними держит sessionStorage.
 *
 * «Второй граф» имитируем сбросом кеша в памяти (AuthManager._profile):
 * у свежего экземпляра класса поле ровно такое же — null.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AuthManager } from '../../static/js/shared/auth.js';

const realFetch = globalThis.fetch;
const stubSessionStorage = globalThis.sessionStorage;

const PROFILE = {
  authenticated: true,
  username: '22494524',
  sub: '22494524',
  email: 'ivanov@example.com',
  login: '22494524',
  fullname: 'МАШТАКОВ ДЕНИС РОМАНОВИЧ',
  job: 'Менеджер направления',
  teams: [],
  roles: ['Цифровой акт'],
  avatar_version: 1753963200,
};

/** Рабочий sessionStorage поверх Map (стаб из _browser-stub.mjs — заглушка). */
function makeSessionStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

beforeEach(() => {
  globalThis.location = { origin: 'http://test', pathname: '/' };
  globalThis.sessionStorage = makeSessionStorage();
  AuthManager._profile = null;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.sessionStorage = stubSessionStorage;
  delete globalThis.location;
  AuthManager._profile = null;
});

/** Успешный ответ /api/v1/auth/me. */
function stubMe(profile = PROFILE) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => profile });
}

test('checkAuth: профиль кладётся в sessionStorage целиком', async () => {
  stubMe();

  await AuthManager.checkAuth();

  const stored = JSON.parse(sessionStorage.getItem('auth_profile'));
  assert.deepEqual(stored, PROFILE);
});

test('второй ES-граф видит профиль: кеш в памяти пуст, данные берутся из хранилища', async () => {
  stubMe();
  await AuthManager.checkAuth();

  // Топбар живёт в графе, где checkAuth() не вызывался.
  AuthManager._profile = null;

  const profile = AuthManager.getCurrentUserProfile();
  assert.equal(profile.fullname, 'МАШТАКОВ ДЕНИС РОМАНОВИЧ');
  assert.equal(profile.job, 'Менеджер направления');
  assert.equal(profile.avatar_version, 1753963200);
});

test('getCurrentUserProfile: пустое хранилище — null', () => {
  assert.equal(AuthManager.getCurrentUserProfile(), null);
});

test('getCurrentUserProfile: битый JSON — null, без исключения', () => {
  sessionStorage.setItem('auth_profile', '{не json');

  assert.equal(AuthManager.getCurrentUserProfile(), null);
});

test('updateAvatarVersion: новая версия видна второму графу', async () => {
  stubMe();
  await AuthManager.checkAuth();

  AuthManager.updateAvatarVersion(1800000000);
  AuthManager._profile = null;

  assert.equal(AuthManager.getCurrentUserProfile().avatar_version, 1800000000);
});

test('updateAvatarVersion: удаление фото (null) тоже уходит в хранилище', async () => {
  stubMe();
  await AuthManager.checkAuth();

  AuthManager.updateAvatarVersion(null);
  AuthManager._profile = null;

  assert.equal(AuthManager.getCurrentUserProfile().avatar_version, null);
});

test('updateAvatarVersion: профиля нет — тихо ничего не делает', () => {
  AuthManager.updateAvatarVersion(1800000000);

  assert.equal(sessionStorage.getItem('auth_profile'), null);
});

test('checkAuth: неавторизован — профиль из хранилища вычищен', async () => {
  stubMe();
  await AuthManager.checkAuth();

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ authenticated: false, username: null }),
  });
  await AuthManager.checkAuth();

  assert.equal(sessionStorage.getItem('auth_profile'), null);
  assert.equal(AuthManager.getCurrentUserProfile(), null);
});

test('logout: профиль из хранилища вычищен', async () => {
  stubMe();
  await AuthManager.checkAuth();

  AuthManager.logout();

  assert.equal(sessionStorage.getItem('auth_profile'), null);
  assert.equal(AuthManager.getCurrentUserProfile(), null);
});
