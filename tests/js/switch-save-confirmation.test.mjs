/**
 * «Сохранить и переключить» подтверждал несостоявшуюся запись.
 *
 * APIClient.saveActContent — гард от двойного PUT: если другой PUT (обычно
 * периодический) уже в полёте, вызов молча no-op'ится и возвращает null.
 * Диалог переключения акта возвращаемое значение игнорировал: показывал
 * «Изменения сохранены» и шёл дальше разбирать UI покидаемого акта. Правки
 * оставались только в локальном черновике, а пользователь был уверен, что
 * они в БД.
 *
 * Фикс — та же развязка, что у стража кликов по ссылкам
 * (StorageManager._setupNavigationInterception): дождаться чужого PUT и, если
 * акт всё ещё не синхронизирован, дожать forceSaveToDb. Подтверждение
 * показывается только после реальной записи.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ActsMenuManager } from '../../static/js/constructor/header/acts-menu.js';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { LockManager } from '../../static/js/constructor/lock-manager.js';
import { APIClient, ContentConflictError } from '../../static/js/shared/api.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { AuthManager } from '../../static/js/shared/auth.js';
import { Notifications } from '../../static/js/shared/notifications.js';
import { ChangelogTracker } from '../../static/js/constructor/changelog-tracker.js';
import { DialogManager } from '../../static/js/shared/dialog/dialog-confirm.js';

/** Порядок событий сохранения/переключения — чтобы видеть, что чему предшествует. */
let trace;
/** Тексты показанных уведомлений. */
let successes;
let warnings;
/** Значение hasUnsyncedChanges (правки уезжают в БД только явной записью). */
let unsynced;

const realSave = APIClient.saveActContent;
const realForce = APIClient.forceSaveToDb;
const realFetchActContent = APIClient._fetchActContent;
const realApplyUserPermission = APIClient._applyUserPermission;
const realApplyActContent = APIClient._applyActContent;
const realUnlockAct = APIClient.unlockAct;
const realHasUnsynced = StorageManager.hasUnsyncedChanges;
const realMarkSynced = StorageManager.markAsSyncedWithDB;
const realLockInit = LockManager.init;
const realLockDestroy = LockManager.destroy;
const realGetUser = AuthManager.getCurrentUser;
const realSuccess = Notifications.success;
const realWarning = Notifications.warning;
const realError = Notifications.error;
const realChangelogInit = ChangelogTracker.init;
const realChangelogDestroy = ChangelogTracker.destroy;
const realDialogShow = DialogManager.show;
const realBaseUrlCache = AppConfig.api._baseUrlCache;

beforeEach(() => {
    trace = [];
    successes = [];
    warnings = [];
    unsynced = true;

    globalThis.location = { href: 'http://test/constructor?act_id=1', hostname: 'test' };
    globalThis.history = { pushState: () => {} };
    globalThis.textBlockManager = { initGlobalToolbar() {}, hideToolbar() {} };
    AppConfig.api._baseUrlCache = 'http://test';

    APIClient._saveInFlight = false;
    APIClient._saveInFlightPromise = null;
    APIClient._pendingDefaultStructureSave = false;
    APIClient._fetchActContent = async (actId) => ({
        metadata: { content_version: 1 },
        userPermission: { canEdit: true, role: 'author' },
        tree: { id: `act-${actId}` },
    });
    APIClient._applyUserPermission = () => {};
    APIClient._applyActContent = async (actId) => { trace.push(`applied:${actId}`); };
    APIClient.unlockAct = async () => {};
    LockManager.init = async () => {};
    LockManager.destroy = () => {};
    StorageManager.hasUnsyncedChanges = () => unsynced;
    StorageManager.markAsSyncedWithDB = () => {};
    StorageManager._dbAutoSaveHalted = false;
    StorageManager._dbAutoSaveHaltCause = null;
    AuthManager.getCurrentUser = () => 'u1';
    Notifications.success = (m) => { successes.push(m); trace.push('success'); };
    Notifications.warning = (m) => { warnings.push(m); };
    Notifications.error = () => {};
    ChangelogTracker.init = () => {};
    ChangelogTracker.destroy = () => {};
    DialogManager.show = async () => true; // «Сохранить и переключить»

    ActsMenuManager._actNavigationQueue = Promise.resolve();
    ActsMenuManager.currentActId = 1;
    window.currentActId = 1;
});

afterEach(() => {
    delete globalThis.history;
    delete globalThis.location;
    APIClient.saveActContent = realSave;
    APIClient.forceSaveToDb = realForce;
    APIClient._fetchActContent = realFetchActContent;
    APIClient._applyUserPermission = realApplyUserPermission;
    APIClient._applyActContent = realApplyActContent;
    APIClient.unlockAct = realUnlockAct;
    APIClient._saveInFlight = false;
    APIClient._saveInFlightPromise = null;
    StorageManager.hasUnsyncedChanges = realHasUnsynced;
    StorageManager.markAsSyncedWithDB = realMarkSynced;
    StorageManager._dbAutoSaveHalted = false;
    StorageManager._dbAutoSaveHaltCause = null;
    LockManager.init = realLockInit;
    LockManager.destroy = realLockDestroy;
    AuthManager.getCurrentUser = realGetUser;
    Notifications.success = realSuccess;
    Notifications.warning = realWarning;
    Notifications.error = realError;
    ChangelogTracker.init = realChangelogInit;
    ChangelogTracker.destroy = realChangelogDestroy;
    DialogManager.show = realDialogShow;
    AppConfig.api._baseUrlCache = realBaseUrlCache;
    ActsMenuManager._actNavigationQueue = Promise.resolve();
    ActsMenuManager.currentActId = null;
    window.currentActId = undefined;
});

test('PUT no-op\'нулся из-за чужого in-flight: правки дожимаются forceSaveToDb ДО подтверждения', async () => {
    // Периодический PUT в полёте — ручной вызов молча возвращает null.
    let releaseOther;
    APIClient._saveInFlightPromise = new Promise((r) => { releaseOther = r; });
    APIClient.saveActContent = async () => { trace.push('save:no-op'); return null; };
    APIClient.forceSaveToDb = async (actId) => {
        trace.push(`force:${actId}`);
        unsynced = false;
    };
    setTimeout(() => releaseOther(), 0);

    await ActsMenuManager._switchToAct(2);

    assert.deepEqual(trace, ['save:no-op', 'force:1', 'success', 'applied:2', 'success'],
        'сначала гарантированная запись правок акта 1, потом подтверждение и только потом переключение');
    assert.equal(successes[0], 'Изменения сохранены');
});

test('обычный PUT прошёл: лишнего форс-сохранения нет', async () => {
    APIClient.saveActContent = async () => { trace.push('save:ok'); unsynced = false; return { content_version: 2 }; };
    APIClient.forceSaveToDb = async () => { trace.push('force'); };

    await ActsMenuManager._switchToAct(2);

    assert.equal(trace.includes('force'), false, 'акт синхронизирован — дожимать нечего');
    assert.equal(successes[0], 'Изменения сохранены');
    assert.equal(window.currentActId, 2, 'переключение состоялось');
});

test('дожать не удалось (конфликт версий): подтверждения нет, остаёмся на текущем акте', async () => {
    APIClient.saveActContent = async () => null;
    APIClient.forceSaveToDb = async () => {
        throw new ContentConflictError('изменён', { last_edited_by: 'ivanov' });
    };

    await ActsMenuManager._switchToAct(2);

    assert.deepEqual(successes, [], 'ложного «Изменения сохранены» не было');
    assert.equal(window.currentActId, 1, 'акт не переключён — правки решает пользователь');
    assert.ok(warnings.some((m) => m.includes('ivanov')), 'причина названа честно');
    assert.equal(StorageManager.isDbAutoSaveHalted(), true, 'обречённые авто-PUT остановлены');
});
