/**
 * Тесты NotificationCenter: список персистентных (limit=50) тянется по сети
 * ТОЛЬКО когда меню открыто/открывается — закрытому бейджу хватает
 * unread-count. Экономит SQL/HTTP на каждый поллинг-тик (see
 * notification-center.js: _loadPersisted({listToo}) / _pollTick).
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationCenter } from '../../static/js/shared/notifications-center/notification-center.js';
import { AppConfig } from '../../static/js/shared/app-config.js';

/** Минимальный DOM-стаб — то, что трогают init()/open()/_renderList/_renderBadge. */
function makeStubElement() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    style: {},
    textContent: '',
    innerHTML: '',
  };
}

/** Центр с подставленными DOM-ссылками напрямую (минуя init()/getElementById). */
function makeCenter() {
  const center = new NotificationCenter();
  center.btn = makeStubElement();
  center.menu = makeStubElement();
  center.body = makeStubElement();
  center.badge = makeStubElement();
  return center;
}

let calls;

beforeEach(() => {
  calls = [];
  // Обходим вычисление base URL через window.location (нет в стабах).
  AppConfig.api._baseUrlCache = 'http://test';
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/unread-count')) {
      return { ok: true, json: async () => ({ count: 1, severity: 'info' }) };
    }
    return { ok: true, json: async () => [] };
  };
});

afterEach(() => {
  delete globalThis.fetch;
  AppConfig.api._resetCache();
});

function countCallsWith(needle) {
  return calls.filter((u) => u.includes(needle)).length;
}

test('_loadPersisted() по умолчанию тянет и список, и unread-count', async () => {
  const center = makeCenter();
  await center._loadPersisted();
  assert.equal(countCallsWith('/api/v1/notifications?limit=50'), 1);
  assert.equal(countCallsWith('/unread-count'), 1);
});

test('_loadPersisted({listToo:false}) тянет только unread-count', async () => {
  const center = makeCenter();
  await center._loadPersisted({ listToo: false });
  assert.equal(countCallsWith('limit=50'), 0);
  assert.equal(countCallsWith('/unread-count'), 1);
});

test('поллинг-тик при закрытом меню не фетчит список', async () => {
  const center = makeCenter();
  assert.equal(center.isOpen, false);
  await center._pollTick();
  assert.equal(countCallsWith('limit=50'), 0);
  assert.equal(countCallsWith('/unread-count'), 1);
});

test('поллинг-тик при открытом меню фетчит и список, и unread-count', async () => {
  const center = makeCenter();
  center.isOpen = true;
  await center._pollTick();
  assert.equal(countCallsWith('limit=50'), 1);
  assert.equal(countCallsWith('/unread-count'), 1);
});

test('visibilitychange при закрытом меню не фетчит список', async () => {
  const center = makeCenter();
  await center._handleVisibilityChange();
  assert.equal(countCallsWith('limit=50'), 0);
  assert.equal(countCallsWith('/unread-count'), 1);
});

test('visibilitychange при открытом меню фетчит список', async () => {
  const center = makeCenter();
  center.isOpen = true;
  await center._handleVisibilityChange();
  assert.equal(countCallsWith('limit=50'), 1);
  assert.equal(countCallsWith('/unread-count'), 1);
});

test('open() всегда делает полную загрузку (список + unread-count)', async () => {
  const center = makeCenter();
  center.open();
  assert.equal(center.isOpen, true);
  // _loadPersisted внутри open() не await'ится синхронно — ждём микротаски.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(countCallsWith('/api/v1/notifications?limit=50'), 1);
  assert.equal(countCallsWith('/unread-count'), 1);
});

test('init() тянет только unread-count (список — при первом открытии меню)', async () => {
  // Полноценный прогон реального init(): подсовываем document.getElementById
  // нужные id и window.addEventListener (в чистом node:test глобала нет).
  const elements = {
    notificationsBtn: makeStubElement(),
    notificationsMenu: makeStubElement(),
    notificationsBody: makeStubElement(),
    notificationsBadge: makeStubElement(),
  };
  const originalGetById = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => elements[id] || null;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};

  const center = new NotificationCenter();
  try {
    center.init();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(countCallsWith('limit=50'), 0);
    assert.equal(countCallsWith('/unread-count'), 1);
  } finally {
    center.destroy();
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    globalThis.document.getElementById = originalGetById;
  }
});
