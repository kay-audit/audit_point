/**
 * Тесты сохранения контента при выходе LockManager._initiateExit (OCC/H3).
 *
 * Раньше это был самый небрежный путь записи: слал AppState.exportData()
 * напрямую (мимо flush'а активного редактора), не обновлял baseUpdatedAt из
 * ответа и звал markAsSyncedWithDB без removeSnapshot — осиротевший снимок
 * со старым baseUpdatedAt давал ложный конфликт при следующем открытии.
 * Теперь: экспорт через StorageManager.exportActData, payload уносит
 * expected_updated_at эхом, при успехе — свежая база + removeSnapshot +
 * markAsSyncedWithDB, при ошибке — снимок остаётся.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LockManager } from '../../static/js/constructor/lock-manager.js';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { AuthManager } from '../../static/js/shared/auth.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { Notifications } from '../../static/js/shared/notifications.js';

const realExport = StorageManager.exportActData;
const realRemove = StorageManager.removeSnapshot;
const realGetUser = AuthManager.getCurrentUser;
const realWarning = Notifications.warning;
const realRedirectDelay = AppConfig.timings.redirectAfterUnlock;

const BASE_UPDATED_AT = '2026-08-18T10:00:00.123456';

let removeCalls;
let exportCalls;
let putBodies;

beforeEach(() => {
  removeCalls = [];
  exportCalls = 0;
  putBodies = [];

  StorageManager.exportActData = () => {
    exportCalls++;
    return { tree: {}, tables: {}, textBlocks: {}, violations: {}, invoiceNodeIds: [] };
  };
  StorageManager.removeSnapshot = (actId) => { removeCalls.push(actId); };
  StorageManager.setBaseUpdatedAt(BASE_UPDATED_AT);
  StorageManager._setState('unsaved');
  AuthManager.getCurrentUser = () => 'u42';
  Notifications.warning = () => {};

  // Обходим вычисление base URL через window.location (нет в стабах).
  AppConfig.api._baseUrlCache = 'http://test';
  // Редирект в finally — немедленно, чтобы таймер не переживал тест.
  AppConfig.timings.redirectAfterUnlock = 0;
  // location для присвоения href в finally-редиректе.
  globalThis.location = { origin: 'http://test', pathname: '/', href: '' };
  // markAsSyncedWithDB → _resetDbSaveFailureState → removeEventListener.
  globalThis.addEventListener = globalThis.addEventListener || (() => {});
  globalThis.removeEventListener = globalThis.removeEventListener || (() => {});

  LockManager._actId = 7;
  LockManager._isExiting = false;
  LockManager._exitPromise = null;
  LockManager._manualUnlockTriggered = false;
});

afterEach(async () => {
  // Даём отработать нулевому setTimeout редиректа до чистки глобалов.
  await new Promise((r) => setTimeout(r, 1));
  StorageManager.exportActData = realExport;
  StorageManager.removeSnapshot = realRemove;
  StorageManager.setBaseUpdatedAt(null);
  StorageManager._setState('saved');
  StorageManager._programmaticExit = false;
  AuthManager.getCurrentUser = realGetUser;
  Notifications.warning = realWarning;
  AppConfig.timings.redirectAfterUnlock = realRedirectDelay;
  delete globalThis.fetch;
  LockManager._actId = null;
  LockManager._isExiting = false;
  LockManager._exitPromise = null;
});

/** Стаб fetch: PUT /content по сценарию, unlock всегда успешен. */
function stubFetch(contentResponse) {
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/content')) {
      putBodies.push(JSON.parse(options.body));
      return contentResponse;
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

test('успешный выход: экспорт с flush, эхо expected_updated_at, снимок снят, база обновлена', async () => {
  stubFetch({
    ok: true,
    status: 200,
    json: async () => ({ updated_at: '2026-08-18T12:00:00.654321' }),
  });

  await LockManager._initiateExit('manualExit');

  assert.equal(exportCalls, 1,
    'payload собран через StorageManager.exportActData (flush активного редактора), не AppState.exportData напрямую');
  assert.equal(putBodies.length, 1, 'PUT /content ушёл один раз');
  assert.equal(putBodies[0].expected_updated_at, BASE_UPDATED_AT,
    'серверная метка ушла эхом, той же строкой');
  assert.deepEqual(removeCalls, [7],
    'осиротевший снимок снят — следующее открытие не покажет ложный конфликт');
  assert.equal(StorageManager._state, 'saved', 'markAsSyncedWithDB вызван после успеха');
  assert.equal(StorageManager.getBaseUpdatedAt(), '2026-08-18T12:00:00.654321',
    'база обновлена из ответа PUT');
});

test('PUT при выходе упал: снимок остаётся последним носителем правок', async () => {
  stubFetch({ ok: false, status: 409, json: async () => ({ detail: 'конфликт' }) });

  await LockManager._initiateExit('manualExit');

  assert.equal(removeCalls.length, 0, 'снимок-черновик НЕ удалён');
  assert.notEqual(StorageManager._state, 'saved', 'акт не помечен синхронизированным');
  assert.equal(StorageManager.getBaseUpdatedAt(), BASE_UPDATED_AT, 'база не тронута');
});

test('база не установлена (null) → выходной PUT без поля expected_updated_at', async () => {
  StorageManager.setBaseUpdatedAt(null);
  stubFetch({ ok: true, status: 200, json: async () => ({ updated_at: '2026-08-18T12:00:00' }) });

  await LockManager._initiateExit('manualExit');

  assert.equal(putBodies.length, 1);
  assert.equal('expected_updated_at' in putBodies[0], false);
});
