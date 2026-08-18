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
import { APIClient } from '../../static/js/shared/api.js';
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
let exitFlags;

beforeEach(() => {
  removeCalls = [];
  exportCalls = 0;
  putBodies = [];

  // PERSIST-4: реальная машинерия эпохи грязности участвует в finalizeDbSave.
  StorageManager._trackingDepth = 0;
  StorageManager._dirtyEpoch = 0;
  APIClient._saveInFlight = false;
  APIClient._saveInFlightPromise = null;

  // Пишущий стаб sessionStorage — проверяем честность exit-флагов.
  exitFlags = {};
  globalThis.sessionStorage = {
    getItem: (k) => (k in exitFlags ? exitFlags[k] : null),
    setItem: (k, v) => { exitFlags[k] = v; },
    removeItem: (k) => { delete exitFlags[k]; },
  };

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
  // Гасим debounce-таймер saveState, взведённый markAsUnsaved в тестах эпохи.
  StorageManager.destroy();
  StorageManager._trackingDepth = 0;
  APIClient._saveInFlight = false;
  APIClient._saveInFlightPromise = null;
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
  assert.equal(exitFlags.sessionExitedWithSave, 'true', 'плашка успеха честна — save прошёл');
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

// ─── PERSIST-4: эпоха-гейт выходного PUT ─────────────────────────────────────

test('правка после export до ответа PUT → снимок НЕ удалён, акт НЕ помечен синхронизированным', async () => {
  // Пользователь печатает пока выходной PUT в полёте: эти символы в
  // отправленную data не попали — безусловные removeSnapshot/markAsSyncedWithDB
  // похоронили бы их и в БД, и в localStorage.
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/content')) {
      putBodies.push(JSON.parse(options.body));
      StorageManager.markAsUnsaved(); // правка во время await PUT → эпоха растёт
      return { ok: true, status: 200, json: async () => ({ updated_at: '2026-08-18T12:00:00' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await LockManager._initiateExit('manualExit');

  assert.equal(putBodies.length, 1, 'PUT ушёл');
  assert.equal(removeCalls.length, 0, 'снимок-черновик НЕ удалён — он носитель поздних правок');
  assert.notEqual(StorageManager._state, 'saved', 'эпоха выросла → НЕ синхронизирован');
});

// ─── Честные exit-флаги при упавшем save ─────────────────────────────────────

test('PUT 409 при выходе → флаг sessionLockLost, а не ложное «вышли с сохранением»', async () => {
  stubFetch({ ok: false, status: 409, json: async () => ({ detail: 'конфликт' }) });

  await LockManager._initiateExit('manualExit');

  assert.equal(exitFlags.sessionLockLost, 'true', 'выставлен честный флаг «изменения НЕ в БД»');
  assert.equal('sessionExitedWithSave' in exitFlags, false, 'ложный флаг успеха не ставится');
  assert.equal(removeCalls.length, 0, 'снимок цел');
});

test('autoExit с упавшим PUT 409 → sessionLockLost вместо sessionAutoExited («сохранено»)', async () => {
  stubFetch({ ok: false, status: 409, json: async () => ({ detail: 'конфликт' }) });

  await LockManager._initiateExit('autoExit');

  assert.equal(exitFlags.sessionLockLost, 'true');
  assert.equal('sessionAutoExited' in exitFlags, false,
    'плашка autoExited лжёт «изменения сохранены» — не ставится');
});

test('обычная ошибка PUT (500) → флаг sessionExitSaveFailed, снимок цел', async () => {
  stubFetch({ ok: false, status: 500, json: async () => ({ detail: 'внутренняя ошибка' }) });

  await LockManager._initiateExit('manualExit');

  assert.equal(exitFlags.sessionExitSaveFailed, 'true', 'честный флаг «сохранить не удалось»');
  assert.equal('sessionExitedWithSave' in exitFlags, false);
  assert.equal(removeCalls.length, 0, 'снимок цел');
});

test('сетевой сбой PUT (исключение) → sessionExitSaveFailed, выход не ломается', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/content')) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await LockManager._initiateExit('manualExit');

  assert.equal(exitFlags.sessionExitSaveFailed, 'true');
  assert.equal('sessionExitedWithSave' in exitFlags, false);
  assert.equal(removeCalls.length, 0);
});

// ─── Сериализация с периодическим PUT (_saveInFlight) ────────────────────────

test('при активном _saveInFlight exit-PUT ждёт завершения чужого запроса', async () => {
  stubFetch({ ok: true, status: 200, json: async () => ({ updated_at: '2026-08-18T12:00:00' }) });

  // Имитация периодического PUT в полёте (как его публикует saveActContent).
  let releaseInFlight;
  APIClient._saveInFlight = true;
  APIClient._saveInFlightPromise = new Promise((r) => { releaseInFlight = r; });

  const exitPromise = LockManager._initiateExit('manualExit');
  // Даём выходу дойти до ожидания гарда.
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(putBodies.length, 0, 'exit-PUT не ушёл, пока чужой запрос в полёте');

  // Чужой PUT завершился — как в finally saveActContent.
  APIClient._saveInFlight = false;
  APIClient._saveInFlightPromise = null;
  releaseInFlight();
  await exitPromise;

  assert.equal(putBodies.length, 1, 'после освобождения гарда exit-PUT ушёл');
  assert.equal(APIClient._saveInFlight, false, 'гард снят после выходного PUT');
});
