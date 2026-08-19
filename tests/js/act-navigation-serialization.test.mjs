/**
 * Переключения акта, запущенные внахлёст.
 *
 * Дефект: обработчик popstate асинхронен и не имел гарда повторного входа, а
 * с недавних пор он ещё и переносит лок. Удержанная кнопка «Назад» (или
 * второе «Назад», пока первое ждёт диалог/сеть) запускала два перехода
 * параллельно:
 *  - оба читали window.currentActId ДО того, как первый его обновит, поэтому
 *    оба снимали лок с ОДНОГО и того же покидаемого акта, а лок промежуточного
 *    так и оставался висеть на сервере;
 *  - каждый брал лок на свою цель, и применения контента перемежались.
 * Итог — ровно тот рассинхрон, ради устранения которого лок и стали
 * переносить: LockManager._actId на одном акте, currentActId/AppState на
 * другом. У явного переключения через меню (_switchToAct) экспозиция та же.
 *
 * Фикс: оба пути идут общей очередью ActsMenuManager._enqueueActNavigation —
 * переходы выполняются последовательно, ни один не отбрасывается (на popstate
 * навигация уже случилась: отброшенный переход оставил бы в адресной строке
 * один акт, а на экране другой).
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ActsMenuManager } from '../../static/js/constructor/header/acts-menu.js';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { LockManager } from '../../static/js/constructor/lock-manager.js';
import { APIClient } from '../../static/js/shared/api.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { AuthManager } from '../../static/js/shared/auth.js';
import { Notifications } from '../../static/js/shared/notifications.js';
import { ChangelogTracker } from '../../static/js/constructor/changelog-tracker.js';
import { DialogManager } from '../../static/js/shared/dialog/dialog-confirm.js';

const ACT_URL = (id) => `http://test/constructor?act_id=${id}`;

/** Слушатели 'popstate', зарегистрированные модулями приложения. */
let popstateListeners;
/** ID актов, для которых ушёл сетевой запрос контента (= начатых переходов). */
let fetchCalls;
/** ID актов, на которые брался лок. */
let lockInits;
/** ID актов, с которых снимался лок. */
let unlocks;
/** ID актов, чей контент реально применён к UI/состоянию. */
let appliedTo;
/** Отпускает зависшую сетевую фазу (моделирует задержку). */
let releaseFetch;

/**
 * history-стаб с настоящим стеком записей: back() двигает указатель,
 * восстанавливает СОХРАНЁННЫЙ state записи и — как браузер — асинхронно
 * рассылает popstate. Нажатия «Назад» подряд дают два события, не дожидаясь
 * реакции приложения на первое.
 */
function makeHistoryStub(entries, index) {
    const stack = entries.map((e) => ({ ...e }));
    let i = index;
    globalThis.location.href = stack[i].href;
    return {
        get state() { return stack[i].state; },
        replaceState(state, _title, href) {
            stack[i] = { state, href: href ?? stack[i].href };
            if (href) globalThis.location.href = href;
        },
        pushState(state, _title, href) {
            stack.length = i + 1;
            stack.push({ state, href: href ?? stack[i].href });
            i = stack.length - 1;
            if (href) globalThis.location.href = href;
        },
        back() {
            if (i === 0) return;
            i -= 1;
            globalThis.location.href = stack[i].href;
            const event = { state: stack[i].state };
            setTimeout(() => { popstateListeners.forEach((fn) => fn(event)); }, 0);
        },
    };
}

/** Даёт отработать микро- и макрозадачам (в т.ч. отложенным popstate). */
async function settle(ticks = 6) {
    for (let n = 0; n < ticks; n++) await new Promise((r) => setTimeout(r, 0));
}

const realFetchActContent = APIClient._fetchActContent;
const realApplyUserPermission = APIClient._applyUserPermission;
const realApplyActContent = APIClient._applyActContent;
const realUnlockAct = APIClient.unlockAct;
const realLockInit = LockManager.init;
const realLockDestroy = LockManager.destroy;
const realAutoLoadAct = ActsMenuManager._autoLoadAct;
const realGetUser = AuthManager.getCurrentUser;
const realSuccess = Notifications.success;
const realError = Notifications.error;
const realChangelogInit = ChangelogTracker.init;
const realChangelogDestroy = ChangelogTracker.destroy;
const realDialogShow = DialogManager.show;
const realBaseUrlCache = AppConfig.api._baseUrlCache;

beforeEach(() => {
    popstateListeners = [];
    fetchCalls = [];
    lockInits = [];
    unlocks = [];
    appliedTo = [];
    releaseFetch = null;

    globalThis.location = {
        href: ACT_URL(9),
        origin: 'http://test',
        hostname: 'test',
        pathname: '/constructor',
        search: '?act_id=9',
    };
    globalThis.addEventListener = (type, fn) => {
        if (type === 'popstate') popstateListeners.push(fn);
    };
    globalThis.removeEventListener = () => {};
    globalThis.document.addEventListener = () => {};
    globalThis.document.removeEventListener = () => {};
    globalThis.BroadcastChannel = undefined;
    AppConfig.api._baseUrlCache = 'http://test';

    // Сетевая фаза висит до releaseFetch: так первый переход гарантированно
    // ещё не завершён, когда приходит второй.
    const gate = new Promise((r) => { releaseFetch = r; });
    APIClient._fetchActContent = async (actId) => {
        fetchCalls.push(actId);
        await gate;
        return {
            metadata: { content_version: 1 },
            userPermission: { canEdit: true, role: 'author' },
            tree: { id: `act-${actId}` },
        };
    };
    APIClient._applyUserPermission = () => {};
    APIClient._applyActContent = async (actId) => { appliedTo.push(actId); };
    APIClient._pendingDefaultStructureSave = false;
    APIClient.unlockAct = async (actId) => { unlocks.push(actId); };
    LockManager.init = async (actId) => { lockInits.push(actId); LockManager._actId = actId; };
    LockManager.destroy = () => {};
    ActsMenuManager._autoLoadAct = async () => {};
    ActsMenuManager._actNavigationQueue = Promise.resolve();
    AuthManager.getCurrentUser = () => 'u1';
    Notifications.success = () => {};
    Notifications.error = () => {};
    ChangelogTracker.init = () => {};
    ChangelogTracker.destroy = () => {};
    DialogManager.show = async () => true;

    // Показан акт 9, до него в истории были 7 и 5. Правки синхронизированы —
    // диалог «несохранённые изменения» в этом тесте не участвует.
    ActsMenuManager.currentActId = 9;
    window.currentActId = 9;
    LockManager._actId = 9;
    StorageManager._setState('saved');
    globalThis.history = makeHistoryStub(
        [{ state: { actId: 5 }, href: ACT_URL(5) },
         { state: { actId: 7 }, href: ACT_URL(7) },
         { state: { actId: 9 }, href: ACT_URL(9) }],
        2
    );
});

afterEach(async () => {
    if (releaseFetch) releaseFetch();
    await settle(2);
    delete globalThis.history;
    delete globalThis.location;
    delete globalThis.BroadcastChannel;
    APIClient._fetchActContent = realFetchActContent;
    APIClient._applyUserPermission = realApplyUserPermission;
    APIClient._applyActContent = realApplyActContent;
    APIClient.unlockAct = realUnlockAct;
    APIClient._pendingDefaultStructureSave = false;
    LockManager.init = realLockInit;
    LockManager.destroy = realLockDestroy;
    LockManager._actId = null;
    ActsMenuManager._autoLoadAct = realAutoLoadAct;
    ActsMenuManager._actNavigationQueue = Promise.resolve();
    ActsMenuManager.currentActId = null;
    window.currentActId = undefined;
    AuthManager.getCurrentUser = realGetUser;
    Notifications.success = realSuccess;
    Notifications.error = realError;
    ChangelogTracker.init = realChangelogInit;
    ChangelogTracker.destroy = realChangelogDestroy;
    DialogManager.show = realDialogShow;
    AppConfig.api._baseUrlCache = realBaseUrlCache;
    StorageManager._setState('saved');
});

// ─── Два «Назад» подряд ──────────────────────────────────────────────────────

test('удержанное «Назад»: переходы идут по очереди, каждый снимает лок со СВОЕГО акта', async () => {
    ActsMenuManager.init();

    window.history.back();  // 9 → 7
    window.history.back();  // 7 → 5, пока первый переход висит на сети
    await settle();

    assert.deepEqual(fetchCalls, [7],
        'второй переход не стартует, пока первый не завершён (иначе оба читают ' +
        'один и тот же window.currentActId)');

    releaseFetch();
    await settle();

    assert.deepEqual(fetchCalls, [7, 5], 'ни один переход не потерян');
    assert.deepEqual(unlocks, [9, 7],
        'каждый переход снимает лок с того акта, который покидает именно он — ' +
        'внахлёст оба снимали лок с акта 9, и лок акта 7 оставался висеть');
    assert.deepEqual(lockInits, [7, 5]);
    assert.deepEqual(appliedTo, [7, 5], 'контент применён в порядке переходов');
    assert.equal(window.currentActId, 5);
    assert.equal(ActsMenuManager.currentActId, 5);
    assert.equal(LockManager._actId, 5, 'владение локом сошлось с показанным актом');
});

test('повторное «Назад» на УЖЕ показанный акт — no-op (проверка внутри очереди)', async () => {
    ActsMenuManager.init();

    // Оба события несут акт 7: второе приходит, когда первое ещё в полёте, и
    // проверка «мы уже там» обязана смотреть на результат первого перехода.
    const event = { state: { actId: 7 } };
    const first = popstateListeners[0](event);
    const second = popstateListeners[0](event);
    releaseFetch();
    await Promise.all([first, second]);
    await settle();

    assert.deepEqual(fetchCalls, [7], 'второй переход отсеян уже обновлённым currentActId');
    assert.deepEqual(unlocks, [9]);
    assert.deepEqual(lockInits, [7]);
    assert.equal(window.currentActId, 7);
});

// ─── Меню поверх back/forward ────────────────────────────────────────────────

test('клик по акту в меню поверх незавершённого back-перехода: переключения не перемешиваются', async () => {
    ActsMenuManager.init();

    window.history.back();          // 9 → 7 (висит на сети)
    await settle(1);
    const menuSwitch = ActsMenuManager._switchToAct(5);   // клик по акту 5 в меню
    releaseFetch();
    await menuSwitch;
    await settle();

    assert.deepEqual(fetchCalls, [7, 5], 'сначала доезжает back-переход, затем клик по меню');
    assert.deepEqual(unlocks, [9, 7], 'лок снимается с фактически покидаемого акта');
    assert.deepEqual(lockInits, [7, 5]);
    assert.equal(window.currentActId, 5);
    assert.equal(LockManager._actId, 5);
});

// ─── Отказ одного перехода не рвёт очередь ───────────────────────────────────

test('упавший переход не блокирует следующий', async () => {
    ActsMenuManager.init();

    const failing = ActsMenuManager._enqueueActNavigation(async () => { throw new Error('boom'); });
    await assert.rejects(() => failing, /boom/, 'вызывающая сторона видит свою ошибку');

    const done = ActsMenuManager._enqueueActNavigation(async () => 'ok');
    assert.equal(await done, 'ok', 'хвост очереди не унёс чужой отказ');
});
