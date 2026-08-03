/**
 * Тесты AuthManager.getCurrentUserProfile() — полный профиль из ответа
 * GET /api/v1/auth/me, сохраняемый рядом с существующим getCurrentUser()
 * (username-строка, контракт которой не менялся).
 *
 * Профиль кэшируется в sessionStorage (ключ `auth_profile`, см.
 * auth-profile-session-cache.test.mjs) — в localStorage, как и раньше,
 * персистится только username.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AuthManager } from '../../static/js/shared/auth.js';

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.location = { origin: 'http://test', pathname: '/' };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.location;
});

test('getCurrentUserProfile: после checkAuth() возвращает профиль целиком', async () => {
  const profile = {
    authenticated: true,
    username: '12345',
    sub: '12345',
    email: 'ivanov@example.com',
    login: '12345',
    fullname: 'Иванов И.И.',
    job: 'Аудитор',
    teams: [],
    roles: ['Цифровой акт'],
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => profile });

  await AuthManager.checkAuth();

  assert.deepEqual(AuthManager.getCurrentUserProfile(), profile);
  // Существующий контракт getCurrentUser() (username-строка) не менялся.
  assert.equal(AuthManager.getCurrentUser(), '12345');
});

test('getCurrentUserProfile: неавторизован — null', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ authenticated: false, username: null }),
  });

  await AuthManager.checkAuth();

  assert.equal(AuthManager.getCurrentUserProfile(), null);
});

test('getCurrentUserProfile: сетевая ошибка — null, checkAuth() не бросает', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };

  const result = await AuthManager.checkAuth();

  assert.equal(result.authenticated, false);
  assert.equal(AuthManager.getCurrentUserProfile(), null);
});
