/**
 * Тесты сохранения контента при выходе LockManager._initiateExit (OCC/H3).
 *
 * Выходной save идёт ЕДИНЫМ путём APIClient.saveActContent (никакого
 * дубль-fetch): общий in-flight гард с опубликованным _saveInFlightPromise,
 * эхо expected_content_version, эпоха-гейт finalizeDbSave, разбор 409.
 * Плашка на списке актов честная: 409 content-conflict → свой флаг
 * sessionExitContentConflict, 409 по локу → sessionLockLost, прочие сбои →
 * sessionExitSaveFailed; флаги успеха при несохранённом контенте не ставятся.
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

const realFetchWithTimeout = APIClient._fetchWithTimeout;
const realExport = StorageManager.exportActData;
const realRemove = StorageManager.removeSnapshot;
const realGetUser = AuthManager.getCurrentUser;
const realSuccess = Notifications.success;
const realWarning = Notifications.warning;
const realError = Notifications.error;
const realRedirectDelay = AppConfig.timings.redirectAfterUnlock;

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
  StorageManager._dbAutoSaveHalted = false;
  APIClient._saveInFlight = false;
  APIClient._saveInFlightPromise = null;

  StorageManager.exportActData = () => {
    exportCalls++;
    return { tree: {}, tables: {}, textBlocks: {}, violations: {}, invoiceNodeIds: [] };
  };
  StorageManager.removeSnapshot = (actId) => { removeCalls.push(actId); };
  StorageManager.setBaseContentVersion(5);
  StorageManager._setState('unsaved');
  AuthManager.getCurrentUser = () => 'u42';
  Notifications.success = () => {};
  Notifications.warning = () => {};
  Notifications.error = () => {};

  // Пишущий стаб sessionStorage — проверяем честность exit-флагов.
  exitFlags = {};
  globalThis.sessionStorage = {
    getItem: (k) => (k in exitFlags ? exitFlags[k] : null),
    setItem: (k, v) => { exitFlags[k] = v; },
    removeItem: (k) => { delete exitFlags[k]; },
  };

  // Success-ветка saveActContent диспатчит CustomEvent — стабы для node.
  globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
  globalThis.document.dispatchEvent = () => {};

  // Обходим вычисление base URL через window.location (нет в стабах).
  AppConfig.api._baseUrlCache = 'http://test';
  // Редирект в finally — немедленно, чтобы таймер не переживал тест.
  AppConfig.timings.redirectAfterUnlock = 0;
  // location для присвоения href в finally-редиректе.
  globalThis.location = { origin: 'http://test', pathname: '/', href: '' };
  // markAsSyncedWithDB → _resetDbSaveFailureState → removeEventListener.
  globalThis.addEventListener = globalThis.addEventListener || (() => {});
  globalThis.removeEventListener = globalThis.removeEventListener || (() => {});

  // Штатный случай конструктора: залоченный акт и акт в AppState — один и тот
  // же. Выходной save адресуется window.currentActId (владелец контента), а не
  // локу, поэтому оба поля обязаны быть выставлены (см. lock-act-desync.test.mjs).
  LockManager._actId = 7;
  window.currentActId = 7;
  LockManager._isExiting = false;
  LockManager._exitPromise = null;
  LockManager._manualUnlockTriggered = false;

  // unlock-POST в _initiateExit идёт сырым fetch — всегда успешен.
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
});

afterEach(async () => {
  // Даём отработать нулевому setTimeout редиректа до чистки глобалов.
  await new Promise((r) => setTimeout(r, 1));
  // Гасим debounce-таймер saveState, взведённый markAsUnsaved в тестах эпохи.
  StorageManager.destroy();
  StorageManager._trackingDepth = 0;
  APIClient._saveInFlight = false;
  APIClient._saveInFlightPromise = null;
  APIClient._fetchWithTimeout = realFetchWithTimeout;
  StorageManager.exportActData = realExport;
  StorageManager.removeSnapshot = realRemove;
  StorageManager.setBaseContentVersion(null);
  StorageManager._setState('saved');
  StorageManager._programmaticExit = false;
  AuthManager.getCurrentUser = realGetUser;
  Notifications.success = realSuccess;
  Notifications.warning = realWarning;
  Notifications.error = realError;
  AppConfig.timings.redirectAfterUnlock = realRedirectDelay;
  delete globalThis.fetch;
  LockManager._actId = null;
  window.currentActId = undefined;
  LockManager._isExiting = false;
  LockManager._exitPromise = null;
});

/** Стаб _fetchWithTimeout (PUT /content единого save-пути) по сценарию. */
function stubContentPut(response) {
  APIClient._fetchWithTimeout = async (url, options = {}) => {
    putBodies.push(JSON.parse(options.body));
    return response;
  };
}

test('успешный выход: единый save-путь, эхо expected_content_version, снимок снят, базы обновлены', async () => {
  stubContentPut({
    ok: true,
    status: 200,
    json: async () => ({
      updated_at: '2026-08-18T12:00:00.654321',
      content_version: 6,
      validation_status: 'ok',
      validation_issues: [],
    }),
  });

  await LockManager._initiateExit('manualExit');

  assert.equal(exportCalls, 1,
    'payload собран через StorageManager.exportActData (flush активного редактора)');
  assert.equal(putBodies.length, 1, 'PUT /content ушёл один раз');
  assert.equal(putBodies[0].expected_content_version, 5, 'база OCC ушла эхом тем же int');
  assert.deepEqual(removeCalls, [7],
    'осиротевший снимок снят — следующее открытие не покажет ложный конфликт');
  assert.equal(StorageManager._state, 'saved', 'акт помечен синхронизированным');
  assert.equal(StorageManager.getBaseContentVersion(), 6, 'база OCC обновлена из ответа PUT');
  assert.equal(exitFlags.sessionExitedWithSave, 'true', 'плашка успеха честна — save прошёл');
});

test('PUT при выходе упал (500): снимок остаётся последним носителем правок', async () => {
  stubContentPut({ ok: false, status: 500, json: async () => ({ detail: 'внутренняя ошибка' }) });

  await LockManager._initiateExit('manualExit');

  assert.equal(removeCalls.length, 0, 'снимок-черновик НЕ удалён');
  assert.notEqual(StorageManager._state, 'saved', 'акт не помечен синхронизированным');
  assert.equal(StorageManager.getBaseContentVersion(), 5, 'база не тронута');
  assert.equal(exitFlags.sessionExitSaveFailed, 'true', 'честный флаг «сохранить не удалось»');
  assert.equal('sessionExitedWithSave' in exitFlags, false);
});

test('база не установлена (null) → выходной PUT без поля expected_content_version', async () => {
  StorageManager.setBaseContentVersion(null);
  stubContentPut({
    ok: true,
    status: 200,
    json: async () => ({ updated_at: '2026-08-18T12:00:00', content_version: 1 }),
  });

  await LockManager._initiateExit('manualExit');

  assert.equal(putBodies.length, 1);
  assert.equal('expected_content_version' in putBodies[0], false);
});

// ─── PERSIST-4: эпоха-гейт выходного PUT ─────────────────────────────────────

test('правка после export до ответа PUT → снимок НЕ удалён, акт НЕ помечен синхронизированным', async () => {
  // Пользователь печатает пока выходной PUT в полёте: эти символы в
  // отправленную data не попали — безусловные removeSnapshot/markAsSyncedWithDB
  // похоронили бы их и в БД, и в localStorage.
  APIClient._fetchWithTimeout = async (url, options = {}) => {
    putBodies.push(JSON.parse(options.body));
    StorageManager.markAsUnsaved(); // правка во время await PUT → эпоха растёт
    return {
      ok: true,
      status: 200,
      json: async () => ({ updated_at: '2026-08-18T12:00:00', content_version: 6 }),
    };
  };

  await LockManager._initiateExit('manualExit');

  assert.equal(putBodies.length, 1, 'PUT ушёл');
  assert.equal(removeCalls.length, 0, 'снимок-черновик НЕ удалён — он носитель поздних правок');
  assert.notEqual(StorageManager._state, 'saved', 'эпоха выросла → НЕ синхронизирован');
});

// ─── Честные exit-флаги при упавшем save ─────────────────────────────────────

test('409 content-conflict при выходе → флаг sessionExitContentConflict (не «лок снят»)', async () => {
  stubContentPut({
    ok: false,
    status: 409,
    json: async () => ({
      detail: 'Содержимое акта изменено',
      code: 'content-conflict',
      extra: { current_content_version: 9, last_edited_by: 'ivanov', last_edited_at: '2026-08-18T11:00:00' },
    }),
  });

  await LockManager._initiateExit('manualExit');

  assert.equal(exitFlags.sessionExitContentConflict, 'true',
    'конфликт версий получает свой честный флаг');
  assert.equal('sessionLockLost' in exitFlags, false,
    'плашка «лок снят по бездействию» лгала бы о причине');
  assert.equal('sessionExitedWithSave' in exitFlags, false);
  assert.equal(removeCalls.length, 0, 'снимок цел');
});

test('409 по локу (без code) при выходе → sessionLockLost, а не ложное «вышли с сохранением»', async () => {
  stubContentPut({ ok: false, status: 409, json: async () => ({ detail: 'лок снят' }) });

  await LockManager._initiateExit('manualExit');

  assert.equal(exitFlags.sessionLockLost, 'true');
  assert.equal('sessionExitedWithSave' in exitFlags, false);
  assert.equal(removeCalls.length, 0, 'снимок цел');
});

test('autoExit с упавшим PUT 409 → честный флаг вместо sessionAutoExited («сохранено»)', async () => {
  stubContentPut({ ok: false, status: 409, json: async () => ({ detail: 'лок снят' }) });

  await LockManager._initiateExit('autoExit');

  assert.equal(exitFlags.sessionLockLost, 'true');
  assert.equal('sessionAutoExited' in exitFlags, false,
    'плашка autoExited лжёт «изменения сохранены» — не ставится');
});

test('сетевой сбой PUT (исключение) → sessionExitSaveFailed, выход не ломается', async () => {
  APIClient._fetchWithTimeout = async () => { throw new TypeError('Failed to fetch'); };

  await LockManager._initiateExit('manualExit');

  assert.equal(exitFlags.sessionExitSaveFailed, 'true');
  assert.equal('sessionExitedWithSave' in exitFlags, false);
  assert.equal(removeCalls.length, 0);
});

// ─── Сериализация с периодическим PUT (_saveInFlight) ────────────────────────

test('при активном _saveInFlight exit ждёт чужой PUT; свой гард публикует и промис', async () => {
  stubContentPut({
    ok: true,
    status: 200,
    json: async () => ({ updated_at: '2026-08-18T12:00:00', content_version: 6 }),
  });

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

test('во время exit-PUT промис in-flight ОПУБЛИКОВАН — forceSaveToDb не проскочит мимо гарда', async () => {
  // Прежний сырой exit-fetch ставил _saveInFlight без _saveInFlightPromise:
  // wait-петля forceSaveToDb требует ОБА и проскакивала, слала конкурентный
  // PUT, а её finally сбрасывала гард пока exit-PUT ещё в полёте.
  let inFlightPromiseDuringPut = null;
  APIClient._fetchWithTimeout = async (url, options = {}) => {
    putBodies.push(JSON.parse(options.body));
    inFlightPromiseDuringPut = APIClient._saveInFlightPromise;
    return {
      ok: true,
      status: 200,
      json: async () => ({ updated_at: '2026-08-18T12:00:00', content_version: 6 }),
    };
  };

  await LockManager._initiateExit('manualExit');

  assert.ok(inFlightPromiseDuringPut instanceof Promise,
    'единый save-путь публикует _saveInFlightPromise на время exit-PUT');
});

test('forceSaveToDb тоже публикует промис — иначе exit проскакивает ожидание и молча не сохраняет', async () => {
  // Аварийная эскалация квоты держала _saveInFlight БЕЗ промиса. Wait-петля
  // выхода требует ОБА, поэтому не ждала ничего, а её saveActContent
  // no-op'ился по гарду (return null, без исключения) — контент не уезжал
  // в БД, а пользователь получал плашку «вышли с сохранением».
  StorageManager.exportActData = () => ({ tree: {} });
  let promiseDuringForce = null;
  APIClient._fetchWithTimeout = async () => {
    promiseDuringForce = APIClient._saveInFlightPromise;
    return { ok: true, status: 200, json: async () => ({ updated_at: '2026-08-18T12:00:00', content_version: 6 }) };
  };

  await APIClient.forceSaveToDb(7);

  assert.ok(promiseDuringForce instanceof Promise,
    'гард форс-сохранения опубликован симметрично saveActContent');
  assert.equal(APIClient._saveInFlightPromise, null, 'после завершения промис снят');
});

test('save при выходе пропущен чужим гардом → честный флаг сбоя, а не «вышли с сохранением»', async () => {
  // Гард удерживает кто-то, кто промис не опубликовал: saveActContent тогда
  // возвращает null вместо исключения. Считать это успехом нельзя.
  stubContentPut({ ok: true, status: 200, json: async () => ({ content_version: 6 }) });
  APIClient._saveInFlight = true;
  APIClient._saveInFlightPromise = null;

  await LockManager._initiateExit('manualExit');

  assert.equal(putBodies.length, 0, 'PUT действительно не ушёл');
  assert.equal(exitFlags.sessionExitSaveFailed, 'true', 'плашка честна — контент не сохранён');
  assert.equal('sessionExitedWithSave' in exitFlags, false);
  assert.equal(removeCalls.length, 0, 'снимок-черновик остался носителем правок');
});
