/**
 * Гонка двух независимых слушателей `popstate` в конструкторе.
 *
 * Дефект: на одно событие `popstate` были подписаны ДВА обработчика из разных
 * модулей, порядок подписки не гарантирован (StorageManager.init и
 * ActsMenuManager.init вызываются независимо):
 *  - страж несохранённых правок (StorageManager._navPopstateHandler) —
 *    проверял `hasUnsyncedChanges()` синхронно, а диалог показывал
 *    асинхронно;
 *  - переключатель акта (обработчик в ActsMenuManager.init) — сразу начинал
 *    _handleHistoryNavigation: снимал лок со старого акта, брал лок на новый
 *    и подменял AppState его контентом.
 * Пока пользователь читал «У вас есть несохранённые изменения. Уйти?»,
 * переключение уже произошло — кнопка «Остаться» не имела смысла: оставаться
 * было негде, правки покинутого акта жили только в снимке localStorage.
 * Сверх того «Уйти без сохранения» делало `history.back()`, а тот порождал
 * второй `popstate` (второе переключение) и затирал forward-запись истории.
 *
 * Фикс: владелец события один — обработчик в ActsMenuManager; он спрашивает
 * StorageManager.confirmHistoryNavigation ДО начала переключения, а
 * собственного слушателя `popstate` у StorageManager больше нет.
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

/** Слушатели 'popstate', зарегистрированные модулями приложения (в порядке подписки). */
let popstateListeners;
/** ID актов, для которых ушёл сетевой запрос контента (= начатых переключений). */
let fetchCalls;
/** ID актов, на которые брался лок. */
let lockInits;
/** ID актов, с которых снимался лок. */
let unlocks;
/** ID актов, чей контент реально применён к UI/состоянию. */
let appliedTo;
/** Ответ пользователя в диалоге «несохранённые изменения». */
let dialogAnswer;
/** Сколько раз диалог показывался. */
let dialogShows;
/** Отпускает зависший _fetchActContent (моделирует сетевую задержку). */
let releaseFetch;

/**
 * history-стаб с настоящим стеком записей: pushState обрезает forward-стек,
 * back() двигает указатель и восстанавливает СОХРАНЁННЫЙ state записи, после
 * чего — как настоящий браузер — асинхронно рассылает popstate всем
 * подписчикам. Именно рассылка на back() показывает второе переключение,
 * которое порождал прежний страж.
 */
function makeHistoryStub(entries, index) {
    const stack = entries.map((e) => ({ ...e }));
    let i = index;
    globalThis.location.href = stack[i].href;
    return {
        get state() { return stack[i].state; },
        /** Записи стека — для проверки forward-навигации. */
        get _stack() { return stack; },
        get _index() { return i; },
        replaceState(state, _title, href) {
            stack[i] = { state, href: href ?? stack[i].href };
            if (href) globalThis.location.href = href;
        },
        pushState(state, _title, href) {
            stack.length = i + 1; // обрезаем forward-стек
            stack.push({ state, href: href ?? stack[i].href });
            i = stack.length - 1;
            if (href) globalThis.location.href = href;
        },
        back() {
            if (i === 0) return;
            i -= 1;
            globalThis.location.href = stack[i].href;
            setTimeout(() => dispatchPopstate(), 0);
        },
    };
}

/** Рассылает popstate всем слушателям сразу (браузер их не ждёт по очереди). */
function dispatchPopstate() {
    const event = { state: history.state };
    return Promise.all(popstateListeners.map((fn) => fn(event)));
}

/** Даёт отработать микро- и макрозадачам (в т.ч. отложенным popstate). */
async function settle(ticks = 5) {
    for (let n = 0; n < ticks; n++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Поднимает боевую подписку обоих модулей в заданном порядке — так же, как
 * это делают их init'ы на странице конструктора.
 */
function wireModules(order) {
    if (order === 'storage-first') {
        StorageManager._setupNavigationInterception();
        ActsMenuManager.init();
    } else {
        ActsMenuManager.init();
        StorageManager._setupNavigationInterception();
    }
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
    dialogAnswer = false;
    dialogShows = 0;
    releaseFetch = null;

    globalThis.location = {
        href: ACT_URL(7),
        origin: 'http://test',
        hostname: 'test',
        pathname: '/constructor',
        search: '?act_id=7',
    };
    globalThis.addEventListener = (type, fn) => {
        if (type === 'popstate') popstateListeners.push(fn);
    };
    globalThis.removeEventListener = () => {};
    globalThis.document.addEventListener = () => {};
    globalThis.document.removeEventListener = () => {};
    // ActsMenuManager.init подписывается на cross-tab шину; живой
    // BroadcastChannel держал бы event loop и подвешивал прогон.
    globalThis.BroadcastChannel = undefined;
    AppConfig.api._baseUrlCache = 'http://test';

    // Сетевая фаза висит, пока тест её не отпустит: так видно переключения,
    // начатые, но ещё не доехавшие до применения контента.
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
    // Автозагрузка акта по ?act_id= — не предмет теста, состояние ставим руками.
    ActsMenuManager._autoLoadAct = async () => {};
    AuthManager.getCurrentUser = () => 'u1';
    Notifications.success = () => {};
    Notifications.error = () => {};
    ChangelogTracker.init = () => {};
    ChangelogTracker.destroy = () => {};
    DialogManager.show = async () => {
        dialogShows += 1;
        // Пользователь думает: даём сопернику по гонке шанс отработать.
        await settle(2);
        return dialogAnswer;
    };

    // Показан акт 7, пришли на него с акта 5; правки не синхронизированы с БД.
    ActsMenuManager.currentActId = 7;
    window.currentActId = 7;
    LockManager._actId = 7;
    StorageManager._setState('unsaved');
    globalThis.history = makeHistoryStub(
        [{ state: { actId: 5, _lockNavGuard: true }, href: ACT_URL(5) },
         { state: { actId: 7, _lockNavGuard: true }, href: ACT_URL(7) }],
        1
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
    ActsMenuManager.currentActId = null;
    window.currentActId = undefined;
    window._allowNavigation = false;
    AuthManager.getCurrentUser = realGetUser;
    Notifications.success = realSuccess;
    Notifications.error = realError;
    ChangelogTracker.init = realChangelogInit;
    ChangelogTracker.destroy = realChangelogDestroy;
    DialogManager.show = realDialogShow;
    AppConfig.api._baseUrlCache = realBaseUrlCache;
    StorageManager._setState('saved');
});

// ─── 1) У события ровно один владелец ────────────────────────────────────────

for (const order of ['storage-first', 'acts-menu-first']) {
    test(`popstate подписан ровно одним модулем (порядок init: ${order})`, () => {
        wireModules(order);

        assert.equal(popstateListeners.length, 1,
            'два независимых слушателя одного события гонялись между собой; ' +
            'владелец должен быть один — обработчик ActsMenuManager');
    });
}

// ─── 2) «Остаться» действительно оставляет на прежнем акте ───────────────────

for (const order of ['storage-first', 'acts-menu-first']) {
    test(`«Остаться»: лок не переехал, AppState не подменён, URL — показанного акта (порядок init: ${order})`, async () => {
        wireModules(order);
        dialogAnswer = false;

        window.history.back();      // «Назад» браузером на акт 5
        await settle();             // диалог показан и отвечен
        releaseFetch();
        await settle();

        assert.equal(dialogShows, 1, 'диалог показан');
        assert.deepEqual(fetchCalls, [],
            'переключение не должно было даже начаться: диалог спрашивают ДО него');
        assert.deepEqual(unlocks, [], 'лок акта 7 не снят');
        assert.deepEqual(lockInits, [], 'лок акта 5 не взят');
        assert.deepEqual(appliedTo, [], 'контент акта 5 в AppState не попал');
        assert.equal(LockManager._actId, 7, 'владение локом осталось на акте 7');
        assert.equal(window.currentActId, 7, 'в AppState по-прежнему акт 7');
        assert.equal(ActsMenuManager.currentActId, 7);
        assert.equal(globalThis.location.href, ACT_URL(7),
            'адресная строка вернулась к показанному акту');
        assert.equal(history.state.actId, 7,
            'запись истории описывает показанный акт, а не цель back');
    });
}

// ─── 3) «Уйти без сохранения» — ровно одно переключение ──────────────────────

test('«Уйти без сохранения»: ровно одно переключение акта, forward-запись цела', async () => {
    wireModules('storage-first');
    dialogAnswer = true;

    window.history.back();
    await settle();             // диалог отвечен, переключение начато и висит на сети
    releaseFetch();
    await settle();

    assert.equal(dialogShows, 1, 'диалог показан один раз');
    assert.deepEqual(fetchCalls, [5],
        'переключение началось ровно один раз (history.back() в ветке ' +
        'подтверждения порождал второй popstate и второе переключение)');
    assert.deepEqual(unlocks, [7], 'лок акта 7 снят один раз');
    assert.deepEqual(lockInits, [5], 'лок акта 5 взят один раз');
    assert.deepEqual(appliedTo, [5], 'контент акта 5 применён один раз');
    assert.equal(window.currentActId, 5);

    // Forward-запись (акт 7) должна пережить переход: прежний страж пушил свою
    // запись поверх неё и делал её недостижимой.
    assert.equal(history._stack.length, 2, 'стек истории не перестроен');
    assert.equal(history._stack[1].href, ACT_URL(7),
        'запись акта 7 на месте — forward-навигация не потеряна');

    assert.equal(window._allowNavigation, false,
        'флаг программной навигации не должен оставаться взведённым: он глушит ' +
        'страж кликов по ссылкам до конца сессии');
});

// ─── 4) Без несохранённых правок поведение прежнее ───────────────────────────

test('нет несохранённых правок: диалога нет, переключение по back проходит как раньше', async () => {
    wireModules('storage-first');
    StorageManager._setState('saved');

    window.history.back();
    await settle();
    releaseFetch();
    await settle();

    assert.equal(dialogShows, 0, 'спрашивать нечего');
    assert.deepEqual(fetchCalls, [5]);
    assert.deepEqual(unlocks, [7]);
    assert.deepEqual(lockInits, [5]);
    assert.deepEqual(appliedTo, [5]);
    assert.equal(window.currentActId, 5);
    assert.equal(globalThis.location.href, ACT_URL(5));
});
