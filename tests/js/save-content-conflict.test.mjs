/**
 * Тесты optimistic-конкуренции сохранения акта (OCC, H3-конфликт).
 *
 * Три гарантии:
 *  1. Каждый PUT /content уносит expected_updated_at ЭХОМ — той же строкой,
 *     что пришла с сервера (StorageManager.getBaseUpdatedAt), без прогона
 *     через new Date(...).toISOString(); при неустановленной базе поле
 *     не отправляется вовсе.
 *  2. 409 с code='content-conflict' разбирается в типизированную
 *     ContentConflictError (метки/автор из extra), прочие 409 остаются
 *     LockLostError; снимок-черновик при конфликте НЕ удаляется.
 *  3. Периодический тик при content-conflict/потере лока останавливает
 *     дальнейшие авто-PUT (флаг до перезагрузки) и говорит честно, без
 *     ложного «повторная попытка — автоматически».
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { APIClient, ContentConflictError, LockLostError } from '../../static/js/shared/api.js';
import { AuthManager } from '../../static/js/shared/auth.js';
import { Notifications } from '../../static/js/shared/notifications.js';

const realFetch = APIClient._fetchWithTimeout;
const realExport = StorageManager.exportActData;
const realRemove = StorageManager.removeSnapshot;
const realGetUser = AuthManager.getCurrentUser;
const realSuccess = Notifications.success;
const realWarning = Notifications.warning;
const realError = Notifications.error;

// Naive-метка pydantic (без tz): прогон через Date исказил бы её — тест
// ловит именно посимвольное эхо.
const BASE_UPDATED_AT = '2026-08-18T10:00:00.123456';

let removeCalls;
let warnings;

beforeEach(() => {
  StorageManager._trackingDepth = 0;
  StorageManager._dirtyEpoch = 0;
  StorageManager._setState('unsaved');
  StorageManager._dbAutoSaveHalted = false;
  StorageManager._dbSaveFailureNotified = false;
  StorageManager._onlineRetryHandler = null;
  StorageManager.setBaseUpdatedAt(null);
  APIClient._saveInFlight = false;
  APIClient._saveInFlightPromise = null;

  removeCalls = 0;
  warnings = [];
  StorageManager.removeSnapshot = () => { removeCalls++; };
  StorageManager.exportActData = () => ({ tree: {}, tables: {}, textBlocks: {}, violations: {}, invoiceNodeIds: [] });
  AuthManager.getCurrentUser = () => 'u42';
  Notifications.success = () => {};
  Notifications.warning = (msg) => warnings.push(msg);
  Notifications.error = () => {};

  // Success-ветка saveActContent диспатчит CustomEvent — стабы для node.
  globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
  globalThis.document.dispatchEvent = () => {};
  // AppConfig.api.getUrl читает window.location.{origin,pathname}.
  globalThis.location = { origin: 'http://test', pathname: '/' };
  // _notifyDbSaveFailure подписывается на window 'online' — в node глобальных
  // addEventListener/removeEventListener нет.
  globalThis.addEventListener = globalThis.addEventListener || (() => {});
  globalThis.removeEventListener = globalThis.removeEventListener || (() => {});
});

afterEach(() => {
  StorageManager.destroy();
  StorageManager._trackingDepth = 0;
  StorageManager._setState('saved');
  StorageManager._dbAutoSaveHalted = false;
  StorageManager.setBaseUpdatedAt(null);
  APIClient._fetchWithTimeout = realFetch;
  StorageManager.exportActData = realExport;
  StorageManager.removeSnapshot = realRemove;
  AuthManager.getCurrentUser = realGetUser;
  Notifications.success = realSuccess;
  Notifications.warning = realWarning;
  Notifications.error = realError;
  delete globalThis.location;
});

/** Фейковый успешный ответ PUT /content. */
function okResponse() {
  return {
    ok: true,
    json: async () => ({ updated_at: '2026-08-18T11:00:00.000000', validation_status: 'ok', validation_issues: [] }),
  };
}

/** Фейковый 409 content-conflict с envelope бэкенда. */
function conflictResponse(extra = {}) {
  return {
    ok: false,
    status: 409,
    json: async () => ({
      detail: 'Содержимое акта изменено другим пользователем',
      code: 'content-conflict',
      extra: {
        current_updated_at: '2026-08-18T10:30:00.000000',
        last_edited_by: 'ivanov',
        last_edited_at: '2026-08-18T10:30:00.000000',
        ...extra,
      },
    }),
  };
}

// ─── 1. Эхо expected_updated_at в payload PUT ────────────────────────────────

test('OCC: saveActContent уносит expected_updated_at той же строкой, что пришла с сервера', async () => {
  StorageManager.setBaseUpdatedAt(BASE_UPDATED_AT);
  let sentBody = null;
  APIClient._fetchWithTimeout = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return okResponse();
  };

  await APIClient.saveActContent(7, { saveType: 'manual' });

  assert.equal(sentBody.expected_updated_at, BASE_UPDATED_AT,
    'метка ушла эхом, посимвольно — без преобразований дат');
});

test('OCC: база не установлена (null) → поле expected_updated_at не отправляется', async () => {
  StorageManager.setBaseUpdatedAt(null);
  let sentBody = null;
  APIClient._fetchWithTimeout = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return okResponse();
  };

  await APIClient.saveActContent(7, { saveType: 'manual' });

  assert.equal('expected_updated_at' in sentBody, false,
    'без базы optimistic-проверка на сервере пропускается — поле не шлём');
});

test('OCC: forceSaveToDb уносит expected_updated_at тем же эхом', async () => {
  StorageManager.setBaseUpdatedAt(BASE_UPDATED_AT);
  let sentBody = null;
  APIClient._fetchWithTimeout = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return okResponse();
  };

  await APIClient.forceSaveToDb(7);

  assert.equal(sentBody.expected_updated_at, BASE_UPDATED_AT);
});

// ─── 2. Разбор 409 ───────────────────────────────────────────────────────────

test('409 content-conflict → ContentConflictError с полями из extra, снимок не удалён', async () => {
  StorageManager.setBaseUpdatedAt(BASE_UPDATED_AT);
  APIClient._fetchWithTimeout = async () => conflictResponse();

  await assert.rejects(
    APIClient.saveActContent(7, { saveType: 'periodic' }),
    (err) => {
      assert.ok(err instanceof ContentConflictError, 'типизированная ошибка конфликта');
      assert.equal(err.lastEditedBy, 'ivanov');
      assert.equal(err.lastEditedAt, '2026-08-18T10:30:00.000000');
      assert.equal(err.currentUpdatedAt, '2026-08-18T10:30:00.000000');
      return true;
    }
  );
  assert.equal(removeCalls, 0, 'снимок-черновик — последний носитель правок, не удалён');
});

test('409 без code (потеря лока) → прежняя семантика LockLostError', async () => {
  APIClient._fetchWithTimeout = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ detail: 'Блокировка принадлежит другому пользователю' }),
  });

  await assert.rejects(
    APIClient.saveActContent(7, { saveType: 'periodic' }),
    (err) => err instanceof LockLostError
  );
  assert.equal(removeCalls, 0);
});

test('409 с нечитаемым телом → LockLostError (разбор не роняет обработку)', async () => {
  APIClient._fetchWithTimeout = async () => ({
    ok: false,
    status: 409,
    json: async () => { throw new Error('не JSON'); },
  });

  await assert.rejects(
    APIClient.forceSaveToDb(7),
    (err) => err instanceof LockLostError
  );
});

// ─── 3. Реакция периодического сейва: остановка авто-PUT + честные слова ─────

test('content-conflict в фоновом сейве: авто-PUT остановлены, сообщение честное', () => {
  const err = new ContentConflictError('конфликт', { last_edited_by: 'ivanov' });

  StorageManager._handleDbSaveFailure(err);

  assert.equal(StorageManager._dbAutoSaveHalted, true, 'дальнейшие авто-PUT остановлены');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Акт изменён пользователем ivanov/);
  assert.match(warnings[0], /сохранены локально как черновик/);
  assert.match(warnings[0], /Обновите страницу/);
  assert.doesNotMatch(warnings[0], /повторная попытка/,
    'ложного «повторная попытка — автоматически» больше нет');
});

test('content-conflict без имени редактора → «другим пользователем»', () => {
  const err = new ContentConflictError('конфликт', {});

  StorageManager._handleDbSaveFailure(err);

  assert.match(warnings[0], /Акт изменён другим пользователем/);
});

test('потеря лока в фоновом сейве: авто-PUT остановлены, без ложного «повторим автоматически»', () => {
  StorageManager._handleDbSaveFailure(new LockLostError());

  assert.equal(StorageManager._dbAutoSaveHalted, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Блокировка акта потеряна/);
  assert.match(warnings[0], /сохранены локально как черновик/);
  assert.doesNotMatch(warnings[0], /повторная попытка/);
});

test('прочий сбой (сеть/5xx) → прежняя offline-машинерия с авторетраем', () => {
  StorageManager._handleDbSaveFailure(new Error('Failed to fetch'));

  assert.equal(StorageManager._dbAutoSaveHalted, false, 'авто-PUT не останавливаются');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /повторная попытка — автоматически/);
});

test('после остановки _retryDbSave (ретрай по online) — no-op', async () => {
  StorageManager._dbAutoSaveHalted = true;
  globalThis.currentActId = 7;
  let putCalls = 0;
  APIClient._fetchWithTimeout = async () => { putCalls++; return okResponse(); };
  try {
    await StorageManager._retryDbSave();
  } finally {
    delete globalThis.currentActId;
  }

  assert.equal(putCalls, 0, 'остановленный авто-сейв не шлёт PUT даже по online');
});

test('destroy сбрасывает остановку авто-PUT (новая сессия конструктора — с чистого листа)', () => {
  StorageManager._dbAutoSaveHalted = true;

  StorageManager.destroy();

  assert.equal(StorageManager._dbAutoSaveHalted, false);
});
