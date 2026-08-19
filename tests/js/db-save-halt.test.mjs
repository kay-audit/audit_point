/**
 * Остановка автосохранения в БД (409-конфликт / потеря лока) — дефекты
 * третьего код-ревью.
 *
 * 1) Причина остановки запоминается: отказ «на входе» (forceSaveToDb не шлёт
 *    заведомо обречённый PUT) обязан отдавать ошибку ТОГО ЖЕ типа, что живой
 *    отказ сервера. Иначе потеря лока маскировалась под конфликт версий —
 *    и плашка выхода, и ветвление в аварийной эскалации врали о причине.
 * 2) Ретрай по 'online' разбирает причину сбоя так же, как периодический тик:
 *    прежний голый catch не взводил halt, молчал перед пользователем и
 *    оставлял подписку на 'online' слать новые обречённые PUT.
 * 3) Аварийная эскалация при переполнении localStorage показывает совет
 *    «экспортируйте акт» при ЛЮБОЙ причине отказа: сюда попадают именно
 *    потому, что снимок в localStorage записать не удалось — «правки
 *    защищены черновиком» здесь неверно.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { APIClient, ContentConflictError, LockLostError } from '../../static/js/shared/api.js';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { AppState } from '../../static/js/constructor/state/state-core.js';
import { AuthManager } from '../../static/js/shared/auth.js';
import { Notifications } from '../../static/js/shared/notifications.js';

const realGetUser = AuthManager.getCurrentUser;
const realSave = APIClient.saveActContent;
const realForce = APIClient.forceSaveToDb;
const realExport = StorageManager.exportActData;
const realHasUnsynced = StorageManager.hasUnsyncedChanges;
const realWarning = Notifications.warning;
const realError = Notifications.error;
const realSuccess = Notifications.success;

let warnings;
let errors;

beforeEach(() => {
    warnings = [];
    errors = [];
    Notifications.warning = (m) => warnings.push(m);
    Notifications.error = (m) => errors.push(m);
    Notifications.success = () => {};
    AuthManager.getCurrentUser = () => 'u42';
    StorageManager.exportActData = () => ({ tree: {} });
    StorageManager.hasUnsyncedChanges = () => true;
    StorageManager._dbAutoSaveHalted = false;
    StorageManager._dbAutoSaveHaltCause = null;
    StorageManager._dbSaveInProgress = false;
    StorageManager._dbSaveFailureNotified = false;
    StorageManager._quotaEscalationInFlight = false;
    StorageManager._quotaEscalationNotified = false;
    AppState._dragInProgress = false;
    window.currentActId = 7;
    globalThis.location = { origin: 'http://test', pathname: '/' };
    window.addEventListener = window.addEventListener || (() => {});
    window.removeEventListener = window.removeEventListener || (() => {});
});

afterEach(() => {
    Notifications.warning = realWarning;
    Notifications.error = realError;
    Notifications.success = realSuccess;
    AuthManager.getCurrentUser = realGetUser;
    APIClient.saveActContent = realSave;
    APIClient.forceSaveToDb = realForce;
    StorageManager.exportActData = realExport;
    StorageManager.hasUnsyncedChanges = realHasUnsynced;
    StorageManager._dbAutoSaveHalted = false;
    StorageManager._dbAutoSaveHaltCause = null;
    window.currentActId = undefined;
    delete globalThis.location;
});

// --- 1) Тип ошибки отказа «на входе» совпадает с причиной остановки ---------

test('halt по потере лока → forceSaveToDb бросает LockLostError, а не конфликт версий', async () => {
    StorageManager._handleDbSaveFailure(new LockLostError('лок снят'));
    assert.equal(StorageManager.getDbAutoSaveHaltCause(), 'lock');

    await assert.rejects(
        () => APIClient.forceSaveToDb(7),
        (err) => err instanceof LockLostError && !(err instanceof ContentConflictError),
        'иначе плашка выхода и эскалация объясняли бы отказ конфликтом версий'
    );
});

test('halt по конфликту версий → forceSaveToDb бросает ContentConflictError', async () => {
    StorageManager.handleContentConflict(new ContentConflictError('изменён другим'));
    assert.equal(StorageManager.getDbAutoSaveHaltCause(), 'conflict');

    await assert.rejects(() => APIClient.forceSaveToDb(7), ContentConflictError);
});

test('markAsSyncedWithDB снимает и флаг остановки, и её причину', () => {
    StorageManager.handleContentConflict(new ContentConflictError('изменён другим'));
    StorageManager.markAsSyncedWithDB();

    assert.equal(StorageManager.isDbAutoSaveHalted(), false);
    assert.equal(StorageManager.getDbAutoSaveHaltCause(), null,
        'иначе следующий halt по сети унаследовал бы чужую причину');
});

// --- 2) Ретрай по 'online' разбирает причину сбоя ---------------------------

test('_retryDbSave: 409 content-conflict взводит halt и объясняет причину пользователю', async () => {
    APIClient.saveActContent = async () => {
        throw new ContentConflictError('изменён', { last_edited_by: 'ivanov' });
    };

    await StorageManager._retryDbSave();

    assert.equal(StorageManager.isDbAutoSaveHalted(), true,
        'ретрай с той же базой обречён — авто-PUT остановлены');
    assert.equal(StorageManager.getDbAutoSaveHaltCause(), 'conflict');
    assert.ok(warnings.some((m) => m.includes('ivanov')),
        'пользователю честно сказано, кто изменил акт');
});

test('_retryDbSave: потеря лока взводит halt (прежде сбой уходил в голый catch)', async () => {
    APIClient.saveActContent = async () => { throw new LockLostError('лок снят'); };

    await StorageManager._retryDbSave();

    assert.equal(StorageManager.isDbAutoSaveHalted(), true);
    assert.equal(StorageManager.getDbAutoSaveHaltCause(), 'lock');
    assert.ok(warnings.some((m) => m.includes('Блокировка акта потеряна')));
});

test('_retryDbSave: сетевой сбой halt НЕ взводит — ретрай по-прежнему осмыслен', async () => {
    APIClient.saveActContent = async () => { throw new TypeError('Failed to fetch'); };

    await StorageManager._retryDbSave();

    assert.equal(StorageManager.isDbAutoSaveHalted(), false);
});

// --- 3) Эскалация при переполнении localStorage ----------------------------

test('эскалация при halt по локу: критический совет экспортировать акт показан', async () => {
    StorageManager._handleDbSaveFailure(new LockLostError('лок снят'));
    warnings.length = 0;

    StorageManager._escalateQuotaToDb();
    await new Promise((r) => setTimeout(r, 1));

    assert.ok(
        errors.some((m) => m.includes('Экспортируйте акт в файл')),
        'снимок в localStorage не записался и PUT не прошёл — молчать нельзя'
    );
});

test('эскалация при конфликте версий: и причина, и совет экспортировать', async () => {
    APIClient.forceSaveToDb = async () => {
        throw new ContentConflictError('изменён', { last_edited_by: 'petrov' });
    };

    StorageManager._escalateQuotaToDb();
    await new Promise((r) => setTimeout(r, 1));

    assert.ok(warnings.some((m) => m.includes('petrov')), 'причина названа');
    assert.ok(errors.some((m) => m.includes('Экспортируйте акт в файл')), 'совет не проглочен');
    assert.equal(StorageManager.isDbAutoSaveHalted(), true);
});

test('эскалация при сетевом сбое: только совет экспортировать, без ложного «сохранены локально»', async () => {
    APIClient.forceSaveToDb = async () => { throw new TypeError('Failed to fetch'); };

    StorageManager._escalateQuotaToDb();
    await new Promise((r) => setTimeout(r, 1));

    assert.ok(errors.some((m) => m.includes('Экспортируйте акт в файл')));
    assert.equal(
        warnings.some((m) => m.includes('сохранены локально')), false,
        'локально сохранить как раз и не удалось — обещать это нельзя'
    );
});
