/**
 * ActsMenuManager._switchToAct (переключение акта через меню шапки) захватывал
 * лок НОВОГО акта, имея на руках права ПРЕДЫДУЩЕГО: старый порядок фаз —
 * unlock старого → LockManager.init(нового) → _loadActIntoView (сеть +
 * применение прав внутри, уже ПОСЛЕ лока). LockManager.init первым делом
 * смотрит AppConfig.readOnlyMode.isReadOnly (lock-manager.js) и при read-only
 * уходит в раннюю ветку — присваивает _actId и возвращается, не взяв лок.
 *
 * Отсюда два симметричных дефекта:
 *  1) предыдущий акт редактируемый → новый read-only: isReadOnly ещё false
 *     (права нового акта не применены) → делается лишняя попытка захвата
 *     лока для акта, где его не должно быть.
 *  2) предыдущий акт read-only → новый редактируемый (хуже): isReadOnly ещё
 *     true → LockManager.init уходит в раннюю ветку — пользователь получает
 *     редактируемый акт БЕЗ лока и без watchdog'а, сохранить его нельзя (PUT
 *     без лока → 409 → LockLostError → автосейв глушится).
 *
 * Фикс — тот же порядок фаз, что уже был у _handleHistoryNavigation (см.
 * lock-act-desync.test.mjs): сеть → права → перенос лока → применение.
 * Права нового акта известны ДО LockManager.init, так что лок берётся (или
 * осознанно не берётся) по ПРАВИЛЬНЫМ правам.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ActsMenuManager } from '../../static/js/constructor/header/acts-menu.js';
import { LockManager } from '../../static/js/constructor/lock-manager.js';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { APIClient } from '../../static/js/shared/api.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { Notifications } from '../../static/js/shared/notifications.js';

/** Минимальный in-memory Storage. */
function makeStorage() {
    const data = new Map();
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => data.set(k, String(v)),
        removeItem: (k) => data.delete(k),
    };
}

const realFetchActContent = APIClient._fetchActContent;
const realApplyActContent = APIClient._applyActContent;
const realUnlockAct = APIClient.unlockAct;
const realLockInit = LockManager.init;
const realLockDestroy = LockManager.destroy;
const realSuccess = Notifications.success;
const realWarning = Notifications.warning;
const realError = Notifications.error;
const realBaseUrlCache = AppConfig.api._baseUrlCache;

/** {actId, isReadOnly} на момент КАЖДОГО вызова LockManager.init. */
let lockAttempts;
/** ID актов, с которых снят лок. */
let unlockCalls;
/** Сколько раз реально позвали LockManager.destroy. */
let destroyCalls;
/** ID актов, для которых applied-фаза реально применила контент. */
let appliedTo;
/** URL'ы, переданные в history.pushState. */
let pushedUrls;

beforeEach(() => {
    lockAttempts = [];
    unlockCalls = [];
    destroyCalls = 0;
    appliedTo = [];
    pushedUrls = [];

    globalThis.localStorage = makeStorage();
    globalThis.sessionStorage = makeStorage();
    globalThis.textBlockManager = { initGlobalToolbar() {}, hideToolbar() {} };
    globalThis.history = { pushState: (state, title, url) => { pushedUrls.push(url); } };
    AppConfig.api._baseUrlCache = 'http://test';
    AppConfig.readOnlyMode.isReadOnly = false;

    APIClient.unlockAct = async (actId) => { unlockCalls.push(actId); };
    APIClient._applyActContent = async (actId, content) => {
        appliedTo.push(actId);
        APIClient._applyUserPermission(content);
    };

    // Стаб мимикрирует РЕАЛЬНУЮ раннюю ветку LockManager.init (lock-manager.js):
    // read-only → присвоить _actId и выйти БЕЗ реального захвата лока.
    LockManager.init = async (actId) => {
        lockAttempts.push({ actId, isReadOnly: AppConfig.readOnlyMode.isReadOnly });
        LockManager._actId = actId;
        if (AppConfig.readOnlyMode.isReadOnly) {
            return; // ранняя ветка — лок не берём
        }
        LockManager._locked = true; // маркер: лок реально запрошен
    };
    LockManager.destroy = () => { destroyCalls++; LockManager._locked = false; };
    LockManager._actId = null;
    LockManager._locked = false;

    Notifications.success = () => {};
    Notifications.warning = () => {};
    Notifications.error = () => {};

    StorageManager._trackingDepth = 0;
    StorageManager._setState('saved'); // hasUnsyncedChanges() === false — диалог не показываем

    ActsMenuManager.currentActId = null;
    window.currentActId = undefined;
});

afterEach(() => {
    APIClient._fetchActContent = realFetchActContent;
    APIClient._applyActContent = realApplyActContent;
    APIClient.unlockAct = realUnlockAct;
    LockManager.init = realLockInit;
    LockManager.destroy = realLockDestroy;
    LockManager._actId = null;
    LockManager._locked = false;
    Notifications.success = realSuccess;
    Notifications.warning = realWarning;
    Notifications.error = realError;
    AppConfig.api._baseUrlCache = realBaseUrlCache;
    AppConfig.readOnlyMode.isReadOnly = false;
    ActsMenuManager.currentActId = null;
    window.currentActId = undefined;
});

/** Стаб сетевой фазы: content нового акта с заданными правами. */
function stubFetchActContent(canEdit) {
    APIClient._fetchActContent = async (actId) => ({
        metadata: { content_version: 1, updated_at: '2026-08-19T09:00:00' },
        userPermission: { canEdit, role: canEdit ? 'author' : 'participant' },
        tree: { id: `act-${actId}` },
    });
}

// ─── 1) editable → read-only: лишняя попытка захвата лока для read-only ──────

test('переключение на read-only акт: LockManager.init видит УЖЕ read-only права нового акта', async () => {
    stubFetchActContent(false); // новый акт — read-only

    ActsMenuManager.currentActId = 1;
    window.currentActId = 1;
    AppConfig.readOnlyMode.isReadOnly = false; // предыдущий акт был редактируемым

    await ActsMenuManager._switchToAct(2);

    assert.equal(lockAttempts.length, 1, 'LockManager.init позван ровно один раз');
    assert.equal(
        lockAttempts[0].isReadOnly, true,
        'к моменту вызова LockManager.init права УЖЕ обновлены под новый (read-only) акт — ' +
        'без фикса тут было бы false (права старого акта), и лок брался бы напрасно'
    );
    assert.equal(LockManager._locked, false, 'реального захвата лока для read-only акта не было');
    assert.deepEqual(unlockCalls, [1], 'лок покидаемого акта снят');
    assert.equal(destroyCalls, 1);
    assert.deepEqual(appliedTo, [2], 'контент нового акта применён');
    assert.equal(window.currentActId, 2);
    assert.equal(AppConfig.readOnlyMode.isReadOnly, true);
    assert.equal(pushedUrls.length, 1, 'pushState вызван после успешной загрузки');
});

// ─── 2) read-only → editable: лок молча НЕ захватывается (хуже) ──────────────

test('переключение с read-only акта на редактируемый: лок реально захватывается, а не пропускается', async () => {
    stubFetchActContent(true); // новый акт — редактируемый

    ActsMenuManager.currentActId = 1;
    window.currentActId = 1;
    AppConfig.readOnlyMode.isReadOnly = true; // предыдущий акт был read-only

    await ActsMenuManager._switchToAct(2);

    assert.equal(lockAttempts.length, 1);
    assert.equal(
        lockAttempts[0].isReadOnly, false,
        'к моменту вызова LockManager.init права УЖЕ обновлены под новый (редактируемый) акт — ' +
        'без фикса тут было бы true (права старого read-only акта), и LockManager.init молча ' +
        'ушёл бы в раннюю ветку без watchdog\'а и без реального лока'
    );
    assert.equal(LockManager._locked, true, 'лок нового акта реально запрошен');
    assert.deepEqual(unlockCalls, [1]);
    assert.deepEqual(appliedTo, [2]);
    assert.equal(window.currentActId, 2);
    assert.equal(AppConfig.readOnlyMode.isReadOnly, false);
});

// ─── 3) восстановительный catch остаётся корректным при новом порядке ────────

test('ошибка применения контента после захвата лока: catch пере-захватывает лок ПОКИДАЕМОГО акта', async () => {
    stubFetchActContent(true);

    ActsMenuManager.currentActId = 1;
    window.currentActId = 1;
    AppConfig.readOnlyMode.isReadOnly = false;

    // Ошибка ПОСЛЕ захвата лока нового акта, но ДО обновления window.currentActId
    // (тот присваивается только на успешном выходе _loadActIntoView).
    APIClient._applyActContent = async () => { throw new Error('boom'); };

    let errorShown = false;
    Notifications.error = () => { errorShown = true; };

    await ActsMenuManager._switchToAct(2);

    assert.equal(errorShown, true, 'пользователь получает честное сообщение об ошибке');
    assert.equal(window.currentActId, 1, 'AppState всё ещё указывает на старый акт (загрузка не завершилась)');
    // Recovery: catch зовёт LockManager.init(window.currentActId) — т.е. акта 1,
    // это ВТОРОЙ вызов init поверх того, что был сделан для акта 2 при переключении.
    assert.deepEqual(
        lockAttempts.map((a) => a.actId), [2, 1],
        'после провала загрузки нового акта (2) лок пере-захвачен на покидаемом (1)'
    );
});
