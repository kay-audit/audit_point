/**
 * Тесты optimistic-конкуренции сохранения акта (OCC, H3-конфликт).
 *
 * Гарантии:
 *  1. Каждый PUT /content уносит expected_content_version ЭХОМ — тем же int,
 *     что пришёл с сервера (StorageManager.getBaseContentVersion); 0 —
 *     ВАЛИДНОЕ значение (проверка на null/undefined, не на falsy); при
 *     неустановленной базе поле не отправляется вовсе.
 *  2. 409 с code='content-conflict' разбирается в типизированную
 *     ContentConflictError (current_content_version/автор/метка из extra),
 *     прочие 409 остаются LockLostError; снимок при конфликте НЕ удаляется.
 *  3. content-conflict/потеря лока в любом пути останавливают авто-PUT
 *     (единый handleContentConflict, halt до перезагрузки/входа в акт),
 *     уведомление честное и ОДНО (без дублей при mash'е Ctrl+S);
 *     forceSaveToDb при halt не шлёт заведомо обречённый PUT;
 *     markAsSyncedWithDB (успешный save / вход в новый акт) снимает halt.
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

let removeCalls;
let warnings;

beforeEach(() => {
  StorageManager._trackingDepth = 0;
  StorageManager._dirtyEpoch = 0;
  StorageManager._setState('unsaved');
  StorageManager._dbAutoSaveHalted = false;
  StorageManager._dbSaveFailureNotified = false;
  StorageManager._onlineRetryHandler = null;
  StorageManager.setBaseContentVersion(null);
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
  StorageManager.setBaseContentVersion(null);
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
    json: async () => ({
      updated_at: '2026-08-18T11:00:00.000000',
      content_version: 6,
      validation_status: 'ok',
      validation_issues: [],
    }),
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
        current_content_version: 7,
        last_edited_by: 'ivanov',
        last_edited_at: '2026-08-18T10:30:00.000000',
        ...extra,
      },
    }),
  };
}

// ─── 1. Эхо expected_content_version в payload PUT ───────────────────────────

test('OCC: saveActContent уносит expected_content_version тем же int, что пришёл с сервера', async () => {
  StorageManager.setBaseContentVersion(5);
  let sentBody = null;
  APIClient._fetchWithTimeout = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return okResponse();
  };

  await APIClient.saveActContent(7, { saveType: 'manual' });

  assert.equal(sentBody.expected_content_version, 5, 'версия ушла эхом, без преобразований');
  assert.equal(StorageManager.getBaseContentVersion(), 6,
    'база обновлена из content_version ответа PUT');
});

test('OCC: версия 0 — валидная база, уходит в payload (не отбрасывается как falsy)', async () => {
  StorageManager.setBaseContentVersion(0);
  let sentBody = null;
  APIClient._fetchWithTimeout = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return okResponse();
  };

  await APIClient.saveActContent(7, { saveType: 'manual' });

  assert.equal(sentBody.expected_content_version, 0);
});

test('OCC: база не установлена (null) → поле expected_content_version не отправляется', async () => {
  StorageManager.setBaseContentVersion(null);
  let sentBody = null;
  APIClient._fetchWithTimeout = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return okResponse();
  };

  await APIClient.saveActContent(7, { saveType: 'manual' });

  assert.equal('expected_content_version' in sentBody, false,
    'без базы optimistic-проверка на сервере пропускается — поле не шлём');
});

test('OCC: forceSaveToDb уносит expected_content_version тем же эхом', async () => {
  StorageManager.setBaseContentVersion(5);
  let sentBody = null;
  APIClient._fetchWithTimeout = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return okResponse();
  };

  await APIClient.forceSaveToDb(7);

  assert.equal(sentBody.expected_content_version, 5);
  assert.equal(StorageManager.getBaseContentVersion(), 6);
});

// ─── 2. Разбор 409 ───────────────────────────────────────────────────────────

test('409 content-conflict → ContentConflictError с полями из extra, снимок не удалён', async () => {
  StorageManager.setBaseContentVersion(5);
  APIClient._fetchWithTimeout = async () => conflictResponse();

  await assert.rejects(
    APIClient.saveActContent(7, { saveType: 'periodic' }),
    (err) => {
      assert.ok(err instanceof ContentConflictError, 'типизированная ошибка конфликта');
      assert.equal(err.lastEditedBy, 'ivanov');
      assert.equal(err.lastEditedAt, '2026-08-18T10:30:00.000000');
      assert.equal(err.currentContentVersion, 7);
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

// ─── 3. Единый handleContentConflict: halt + честные слова, без дублей ───────

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

test('handleContentConflict не дублирует уведомление при уже взведённом halt (mash Ctrl+S)', () => {
  const err = new ContentConflictError('конфликт', { last_edited_by: 'ivanov' });

  StorageManager.handleContentConflict(err);
  StorageManager.handleContentConflict(err);
  StorageManager.handleContentConflict(err);

  assert.equal(warnings.length, 1, 'уведомление показано ровно один раз на halt-цикл');
  assert.equal(StorageManager._dbAutoSaveHalted, true);
});

test('content-conflict без имени редактора → «другим пользователем»', () => {
  StorageManager.handleContentConflict(new ContentConflictError('конфликт', {}));

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

test('forceSaveToDb при взведённом halt не шлёт обречённый PUT, а сразу кидает конфликт', async () => {
  StorageManager._dbAutoSaveHalted = true;
  let putCalls = 0;
  APIClient._fetchWithTimeout = async () => { putCalls++; return okResponse(); };

  await assert.rejects(
    APIClient.forceSaveToDb(7),
    (err) => err instanceof ContentConflictError
  );
  assert.equal(putCalls, 0, 'PUT не отправлен');
});

test('markAsSyncedWithDB снимает halt: вход в новый акт (in-page переключение) размораживает автосейв', async () => {
  // Halt взведён на акте A…
  StorageManager.handleContentConflict(new ContentConflictError('конфликт', {}));
  assert.equal(StorageManager._dbAutoSaveHalted, true);

  // …переключение на акт B: bootstrap (_loadActIntoView) зовёт markAsSyncedWithDB.
  StorageManager.markAsSyncedWithDB();
  assert.equal(StorageManager._dbAutoSaveHalted, false, 'halt акта A не глушит акт B');

  // Периодический сейв акта B снова работает (ретрай-путь тот же).
  StorageManager._setState('unsaved');
  globalThis.currentActId = 8;
  let putCalls = 0;
  APIClient._fetchWithTimeout = async () => { putCalls++; return okResponse(); };
  try {
    await StorageManager._retryDbSave();
  } finally {
    delete globalThis.currentActId;
  }
  assert.equal(putCalls, 1, 'авто-PUT нового акта отправляется');
});

test('destroy сбрасывает остановку авто-PUT (новая сессия конструктора — с чистого листа)', () => {
  StorageManager._dbAutoSaveHalted = true;

  StorageManager.destroy();

  assert.equal(StorageManager._dbAutoSaveHalted, false);
});
