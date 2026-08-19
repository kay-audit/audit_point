/**
 * Рассинхрон владения локом при браузерной навигации back/forward.
 *
 * Дефект: обработчик popstate грузил контент нового акта общим
 * _loadActIntoView, но лока не касался вовсе. После «Назад» в AppState лежал
 * акт A, а LockManager._actId оставался на акте B. Выходной save брал
 * `this._actId || window.currentActId` — то есть B — и отправлял туда тело,
 * собранное из AppState, то есть СОДЕРЖИМОЕ АКТА A. Акт B затирался чужим
 * контентом, а сам акт A сохранить было нельзя (PUT без лока → 409).
 *
 * Фикс — двухслойный:
 *  1) LockManager._initiateExit развязал роли: контент адресуется актом,
 *     который лежит в AppState (window.currentActId), лок снимается с акта,
 *     который реально залочен (this._actId). Порча данных невозможна даже
 *     при рассинхроне.
 *  2) ActsMenuManager._handleHistoryNavigation переносит лок на popstate так
 *     же, как это делает переключение через меню, — рассинхрон не возникает,
 *     и после «Назад» акт снова можно редактировать.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ActsMenuManager } from '../../static/js/constructor/header/acts-menu.js';
import { App } from '../../static/js/constructor/app.js';
import { LockManager } from '../../static/js/constructor/lock-manager.js';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { APIClient } from '../../static/js/shared/api.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { AuthManager } from '../../static/js/shared/auth.js';
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

const realFetchWithTimeout = APIClient._fetchWithTimeout;
const realFetchActContent = APIClient._fetchActContent;
const realApplyActContent = APIClient._applyActContent;
const realExport = StorageManager.exportActData;
const realRemoveSnapshot = StorageManager.removeSnapshot;
const realGetUser = AuthManager.getCurrentUser;
const realLockInit = LockManager.init;
const realSuccess = Notifications.success;
const realWarning = Notifications.warning;
const realError = Notifications.error;
const realRedirectDelay = AppConfig.timings.redirectAfterUnlock;

/** Все ушедшие запросы: {method, url, body}. */
let calls;
/** ID актов, для которых applied-фаза реально применила контент. */
let appliedTo;
/** ID актов, на которые брался лок. */
let lockInits;

/** Запросы к /content методом PUT. */
const contentPuts = () => calls.filter((c) => c.method === 'PUT' && c.url.includes('/content'));
/** Запросы разблокировки. */
const unlockPosts = () => calls.filter((c) => c.url.includes('/unlock'));

beforeEach(() => {
    calls = [];
    appliedTo = [];
    lockInits = [];

    globalThis.localStorage = makeStorage();
    globalThis.sessionStorage = makeStorage();
    globalThis.CustomEvent = globalThis.CustomEvent
        || class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
    globalThis.document.dispatchEvent = () => {};
    globalThis.addEventListener = globalThis.addEventListener || (() => {});
    globalThis.removeEventListener = globalThis.removeEventListener || (() => {});
    globalThis.location = { origin: 'http://test', pathname: '/', href: '' };
    globalThis.textBlockManager = { initGlobalToolbar() {}, hideToolbar() {} };
    // Обходим вычисление base URL через window.location (нет в стабах).
    AppConfig.api._baseUrlCache = 'http://test';
    // Редирект в finally _initiateExit — немедленно, чтобы таймер не пережил тест.
    AppConfig.timings.redirectAfterUnlock = 0;
    AppConfig.readOnlyMode.isReadOnly = false;

    // Единая точка перехвата: и PUT /content (saveActContent), и POST /unlock
    // (APIClient.unlockAct) идут через _fetchWithTimeout — по URL видно, какой
    // акт реально адресован.
    APIClient._fetchWithTimeout = async (url, options = {}) => {
        calls.push({
            method: options.method || 'GET',
            url,
            body: options.body ? JSON.parse(options.body) : null,
        });
        return {
            ok: true,
            status: 200,
            json: async () => ({ updated_at: '2026-08-19T10:00:00', content_version: 6 }),
        };
    };
    // Сырой unlock-fetch внутри _initiateExit.
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ method: options.method || 'GET', url, body: null });
        return { ok: true, status: 200, json: async () => ({}) };
    };

    APIClient._saveInFlight = false;
    APIClient._saveInFlightPromise = null;
    APIClient._viewPositionRestoredForActId = null;
    APIClient._pendingDefaultStructureSave = false;
    APIClient._applyActContent = async (actId) => { appliedTo.push(actId); };

    StorageManager._trackingDepth = 0;
    StorageManager._dirtyEpoch = 0;
    StorageManager._dbAutoSaveHalted = false;
    StorageManager.removeSnapshot = () => {};
    StorageManager.setBaseContentVersion(5);
    StorageManager._setState('unsaved');

    AuthManager.getCurrentUser = () => 'u42';
    Notifications.success = () => {};
    Notifications.warning = () => {};
    Notifications.error = () => {};

    // Реальный init ходит в сеть за конфигом и заводит watchdog. Нам важно
    // ровно одно его наблюдаемое свойство: _actId присваивается ДО попытки
    // захвата (lock-manager.js:61), поэтому при отказе лока он тоже сменится.
    LockManager.init = async (actId) => {
        LockManager._actId = actId;
        lockInits.push(actId);
    };
    LockManager._isExiting = false;
    LockManager._exitPromise = null;
    LockManager._manualUnlockTriggered = false;

    ActsMenuManager.currentActId = null;
    App._actSwitchInProgress = false;
});

afterEach(async () => {
    // Даём отработать нулевому setTimeout редиректа до чистки глобалов.
    await new Promise((r) => setTimeout(r, 1));
    StorageManager.destroy();
    StorageManager._trackingDepth = 0;
    StorageManager.exportActData = realExport;
    StorageManager.removeSnapshot = realRemoveSnapshot;
    StorageManager.setBaseContentVersion(null);
    StorageManager._setState('saved');
    APIClient._fetchWithTimeout = realFetchWithTimeout;
    APIClient._fetchActContent = realFetchActContent;
    APIClient._applyActContent = realApplyActContent;
    APIClient._saveInFlight = false;
    APIClient._saveInFlightPromise = null;
    APIClient._viewPositionRestoredForActId = null;
    APIClient._pendingDefaultStructureSave = false;
    AuthManager.getCurrentUser = realGetUser;
    Notifications.success = realSuccess;
    Notifications.warning = realWarning;
    Notifications.error = realError;
    AppConfig.timings.redirectAfterUnlock = realRedirectDelay;
    LockManager.init = realLockInit;
    LockManager._actId = null;
    LockManager._isExiting = false;
    LockManager._exitPromise = null;
    LockManager._manualUnlockTriggered = false;
    ActsMenuManager.currentActId = null;
    window.currentActId = undefined;
    delete globalThis.fetch;
});

/**
 * Ставит содержимое «акта {id}» в AppState-сериализатор: маркер в теле PUT
 * показывает, ЧЕЙ контент уехал, а URL — В КАКОЙ акт.
 */
function stubAppStateOfAct(id) {
    StorageManager.exportActData = () => ({
        tree: { marker: `содержимое акта ${id}` },
        tables: {},
        textBlocks: {},
        violations: {},
        invoiceNodeIds: [],
    });
}

/** Стаб сетевой фазы загрузки акта. */
function stubFetchActContent() {
    APIClient._fetchActContent = async (actId) => ({
        metadata: { content_version: 1, updated_at: '2026-08-19T09:00:00' },
        userPermission: { canEdit: true, role: 'author' },
        tree: { id: `act-${actId}` },
    });
}

// ─── 1) Порча данных: содержимое одного акта в другом акте ───────────────────

test('рассинхрон владения: выходной save адресует акт из AppState, лок снимается со своего', async () => {
    // Состояние после «Назад» на старом коде: показан акт 1, лок повис на 2.
    stubAppStateOfAct(1);
    window.currentActId = 1;
    LockManager._actId = 2;

    await LockManager._initiateExit('autoExit');

    const puts = contentPuts();
    assert.equal(puts.length, 1, 'выходной PUT ушёл один раз');
    assert.ok(
        puts[0].url.endsWith('/api/v1/acts/1/content'),
        `содержимое акта 1 обязано уехать в акт 1, а не в залоченный 2 (ушло: ${puts[0].url})`
    );
    assert.equal(puts[0].body.tree.marker, 'содержимое акта 1',
        'тело собрано из AppState — это контент показанного акта');

    const unlocks = unlockPosts();
    assert.equal(unlocks.length, 1, 'разблокировка ушла один раз');
    assert.ok(
        unlocks[0].url.endsWith('/api/v1/acts/2/unlock'),
        `разблокировать надо реально залоченный акт 2 (ушло: ${unlocks[0].url})`
    );
});

test('акт в AppState не определён (страница списка актов) → контент не сохраняется, лок снимается', async () => {
    // LockManager импортирует AppState статически, поэтому на портальной
    // странице метаданных guard `AppState?.exportData` проходит, а состояние
    // пустое. Адресация по window.currentActId (не задан) не даёт увести
    // пустой AppState в реально редактируемый акт.
    stubAppStateOfAct('пусто');
    window.currentActId = undefined;
    LockManager._actId = 3;

    await LockManager._initiateExit('autoExit');

    assert.equal(contentPuts().length, 0, 'PUT контента не ушёл — сохранять нечего');
    assert.equal(unlockPosts().length, 1, 'лок акта 3 всё равно снят');
    assert.ok(unlockPosts()[0].url.endsWith('/api/v1/acts/3/unlock'));
});

// ─── 2) popstate переносит лок ───────────────────────────────────────────────

test('_handleHistoryNavigation переносит лок: старый акт разблокирован, новый залочен', async () => {
    stubFetchActContent();
    ActsMenuManager.currentActId = 2;
    window.currentActId = 2;
    LockManager._actId = 2;

    await ActsMenuManager._handleHistoryNavigation(1);

    assert.deepEqual(appliedTo, [1], 'контент акта 1 применён');
    assert.equal(window.currentActId, 1, 'в AppState теперь акт 1');
    assert.deepEqual(lockInits, [1], 'лок взят на акт 1');
    assert.equal(LockManager._actId, 1, 'владение локом следует за показанным актом');
    assert.equal(unlockPosts().length, 1, 'лок покидаемого акта снят');
    assert.ok(unlockPosts()[0].url.endsWith('/api/v1/acts/2/unlock'));
});

test('_handleHistoryNavigation ставит права ДО захвата лока (read-only лок не берёт)', async () => {
    const order = [];
    APIClient._fetchActContent = async () => {
        order.push('fetch');
        return {
            metadata: { content_version: 1 },
            userPermission: { canEdit: false, role: 'participant' },
            tree: {},
        };
    };
    LockManager.init = async (actId) => {
        order.push(`lock:readOnly=${AppConfig.readOnlyMode.isReadOnly}`);
        LockManager._actId = actId;
    };
    APIClient._applyActContent = async (actId) => { order.push('apply'); appliedTo.push(actId); };

    ActsMenuManager.currentActId = 2;
    window.currentActId = 2;
    LockManager._actId = 2;

    await ActsMenuManager._handleHistoryNavigation(1);

    assert.deepEqual(order, ['fetch', 'lock:readOnly=true', 'apply'],
        'сеть → права → лок → применение (как в _autoLoadAct)');
});

// ─── 3) Полный сценарий из отчёта ────────────────────────────────────────────

test('акт 1 → переключение на 2 → «Назад» → автовыход: контент акта 1 уезжает в акт 1', async () => {
    stubFetchActContent();

    // Открыт акт 1.
    ActsMenuManager.currentActId = 1;
    window.currentActId = 1;
    LockManager._actId = 1;

    // Переключение на акт 2 через меню (лок перенесён, pushState({actId: 1})
    // остался в истории).
    ActsMenuManager.currentActId = 2;
    window.currentActId = 2;
    LockManager._actId = 2;

    // «Назад» браузером на акт 1.
    await ActsMenuManager._handleHistoryNavigation(1);
    // Пользователь правит акт 1 и уходит по неактивности.
    stubAppStateOfAct(1);
    StorageManager._setState('unsaved');
    calls.length = 0;

    await LockManager._initiateExit('autoExit');

    const puts = contentPuts();
    assert.equal(puts.length, 1);
    assert.ok(puts[0].url.endsWith('/api/v1/acts/1/content'),
        `правки акта 1 обязаны уехать в акт 1 (ушло: ${puts[0].url})`);
    assert.equal(puts[0].body.tree.marker, 'содержимое акта 1');
    assert.equal(
        calls.some((c) => c.url.includes('/acts/2/content')), false,
        'в акт 2 не ушло ни байта чужого контента'
    );
});

// ─── 4) Отказ лока на popstate ───────────────────────────────────────────────

test('акт занят другим пользователем: контент не применяется, выходной save адресует прежний акт', async () => {
    stubFetchActContent();
    // Реальный init присваивает _actId ДО попытки захвата — при отказе поле
    // уже указывает на недоступный акт. Зеркальная порча («контент акта 2
    // уезжает в акт 1») закрыта тем же развязыванием ролей.
    LockManager.init = async (actId) => {
        LockManager._actId = actId;
        lockInits.push(actId);
        throw new Error('ACT_LOCKED');
    };

    ActsMenuManager.currentActId = 2;
    window.currentActId = 2;
    LockManager._actId = 2;

    await ActsMenuManager._handleHistoryNavigation(1);

    assert.deepEqual(appliedTo, [], 'контент занятого акта в AppState не попал');
    assert.equal(window.currentActId, 2, 'в AppState по-прежнему акт 2');
    assert.equal(LockManager._actId, 1, 'а _actId уже съехал на недоступный акт 1');

    stubAppStateOfAct(2);
    calls.length = 0;
    await LockManager._initiateExit('autoExit');

    const puts = contentPuts();
    assert.equal(puts.length, 1);
    assert.ok(puts[0].url.endsWith('/api/v1/acts/2/content'),
        `содержимое акта 2 обязано уехать в акт 2 (ушло: ${puts[0].url})`);
});
