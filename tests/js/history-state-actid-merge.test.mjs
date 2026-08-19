/**
 * Слияние actId/_lockNavGuard в history.state конструктора.
 *
 * Дефект: URL и показанный акт расходились при первом «Назад». Запись
 * истории пишут ДВА независимых модуля:
 *  - StorageManager._setupNavigationInterception на init делал
 *    `history.replaceState({_lockNavGuard: true}, ...)` — заменял state
 *    ТЕКУЩЕЙ записи целиком;
 *  - ActsMenuManager._autoLoadAct (первичная загрузка акта по ?act_id=)
 *    вообще не писал в историю; _switchToAct пишет actId через pushState
 *    только при явном переключении.
 * Итог: первая запись истории (страница открылась с ?act_id=5) либо не
 * несла actId вовсе, либо теряла его, если StorageManager.init отрабатывал
 * ПОСЛЕ ActsMenuManager.init (порядок между двумя независимыми init'ами не
 * гарантирован). После переключения на другой акт (pushState({actId:7}))
 * первое «Назад» приходило с state без actId — popstate-обработчик
 * ActsMenuManager (`if (!actId ...) return`) молча выходил: адресная строка
 * показывала act_id=5, а приложение продолжало показывать акт 7 (и держать
 * его лок).
 *
 * Фикс — оба писателя мержат поля в текущий history.state, а не заменяют
 * его целиком: `history.replaceState/pushState({...(history.state||{}), ...}, ...)`.
 * Корректно при любом порядке init'ов.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ActsMenuManager } from '../../static/js/constructor/header/acts-menu.js';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { LockManager } from '../../static/js/constructor/lock-manager.js';
import { APIClient } from '../../static/js/shared/api.js';
import { AuthManager } from '../../static/js/shared/auth.js';
import { Notifications } from '../../static/js/shared/notifications.js';
import { ChangelogTracker } from '../../static/js/constructor/changelog-tracker.js';
import { DialogManager } from '../../static/js/shared/dialog/dialog-confirm.js';

/**
 * history-стаб с реальным стеком записей (в отличие от no-op заглушек в
 * других тестах): replaceState меняет текущую запись, pushState добавляет
 * новую (обрезая forward-стек), back() двигает указатель назад и восстанавливает
 * СОХРАНЁННЫЙ state этой записи — как настоящий браузер, а не последнее
 * записанное значение.
 */
function makeHistoryStub(initialState = null, initialHref = 'http://test/') {
    const stack = [{ state: initialState, href: initialHref }];
    let index = 0;
    return {
        get state() { return stack[index].state; },
        replaceState(state, _title, href) {
            stack[index] = { state, href: href ?? stack[index].href };
            if (href) globalThis.location.href = href;
        },
        pushState(state, _title, href) {
            stack.length = index + 1; // обрезаем forward-стек
            stack.push({ state, href: href ?? stack[index].href });
            index = stack.length - 1;
            if (href) globalThis.location.href = href;
        },
        back() {
            if (index > 0) {
                index -= 1;
                globalThis.location.href = stack[index].href;
            }
        },
    };
}

const realFetchActContent = APIClient._fetchActContent;
const realApplyUserPermission = APIClient._applyUserPermission;
const realApplyActContent = APIClient._applyActContent;
const realLockInit = LockManager.init;
const realGetUser = AuthManager.getCurrentUser;
const realSuccess = Notifications.success;
const realError = Notifications.error;
const realChangelogInit = ChangelogTracker.init;
const realDialogShow = DialogManager.show;

beforeEach(() => {
    globalThis.location = {
        href: 'http://test/constructor?act_id=5',
        hostname: 'test',
        pathname: '/constructor',
        search: '?act_id=5',
    };
    globalThis.history = makeHistoryStub();
    globalThis.addEventListener = globalThis.addEventListener || (() => {});
    globalThis.document.addEventListener = globalThis.document.addEventListener || (() => {});

    APIClient._fetchActContent = async (actId) => ({
        metadata: { content_version: 1 },
        userPermission: { canEdit: true, role: 'author' },
        tree: { id: `act-${actId}` },
    });
    APIClient._applyUserPermission = () => {};
    APIClient._applyActContent = async () => {};
    APIClient._pendingDefaultStructureSave = false;
    LockManager.init = async () => {};
    AuthManager.getCurrentUser = () => 'u1';
    Notifications.success = () => {};
    Notifications.error = () => {};
    ChangelogTracker.init = () => {};
    DialogManager.show = async () => false;

    ActsMenuManager.currentActId = null;
    ActsMenuManager._initialLoadInProgress = false;
    window.currentActId = undefined;
    StorageManager._setState('saved');
});

afterEach(() => {
    delete globalThis.history;
    delete globalThis.location;
    APIClient._fetchActContent = realFetchActContent;
    APIClient._applyUserPermission = realApplyUserPermission;
    APIClient._applyActContent = realApplyActContent;
    LockManager.init = realLockInit;
    AuthManager.getCurrentUser = realGetUser;
    Notifications.success = realSuccess;
    Notifications.error = realError;
    ChangelogTracker.init = realChangelogInit;
    DialogManager.show = realDialogShow;
    ActsMenuManager.currentActId = null;
    window.currentActId = undefined;
    StorageManager._setState('saved');
});

// ─── _autoLoadAct пишет actId в историю ──────────────────────────────────────

test('_autoLoadAct пишет actId в history.state первой записи (страница открылась с ?act_id=)', async () => {
    await ActsMenuManager._autoLoadAct(5);
    assert.equal(history.state?.actId, 5);
});

test('_autoLoadAct мержит actId, не стирая уже записанный StorageManager._lockNavGuard', async () => {
    // StorageManager.init успел отработать раньше (порядок init'ов не гарантирован).
    globalThis.history = makeHistoryStub({ _lockNavGuard: true });

    await ActsMenuManager._autoLoadAct(5);

    assert.equal(history.state.actId, 5, 'actId дописан');
    assert.equal(history.state._lockNavGuard, true, 'флаг StorageManager не стёрт');
});

// ─── StorageManager мержит _lockNavGuard, не стирая actId ────────────────────

test('_setupNavigationInterception мержит _lockNavGuard, не стирая actId, записанный ActsMenuManager раньше', () => {
    // ActsMenuManager._autoLoadAct успел отработать раньше.
    globalThis.history = makeHistoryStub({ actId: 5 });

    StorageManager._setupNavigationInterception();

    assert.equal(history.state.actId, 5, 'actId не стёрт инициализацией StorageManager');
    assert.equal(history.state._lockNavGuard, true, 'флаг StorageManager записан');
});

test('порядок init не важен: оба поля выживают при любой последовательности', async () => {
    // StorageManager первым.
    StorageManager._setupNavigationInterception();
    await ActsMenuManager._autoLoadAct(5);
    assert.deepEqual(history.state, { _lockNavGuard: true, actId: 5 });
});

test('порядок init не важен (обратный): ActsMenuManager первым', async () => {
    await ActsMenuManager._autoLoadAct(5);
    StorageManager._setupNavigationInterception();
    assert.deepEqual(history.state, { actId: 5, _lockNavGuard: true });
});

// ─── Воспроизведение сценария из отчёта ──────────────────────────────────────

test('акт 5 → переключение на 7 → «Назад» восстанавливает запись с actId (без фикса падает)', async () => {
    // Открыт акт 5 (оба init отработали, порядок роли не играет).
    await ActsMenuManager._autoLoadAct(5);
    StorageManager._setupNavigationInterception();
    assert.equal(history.state.actId, 5, 'первая запись истории несёт actId');

    // Переключение на акт 7 через меню — pushState({actId: 7}) (ровно та же
    // запись, что делает _switchToAct; сама эта строка вне зоны правки).
    window.history.pushState({ actId: 7 }, '', 'http://test/constructor?act_id=7');
    assert.equal(history.state.actId, 7);

    // «Назад» браузером: реальный history.back() восстанавливает СОХРАНЁННЫЙ
    // state первой записи (а не последнее записанное значение).
    window.history.back();

    assert.equal(history.state.actId, 5,
        'popstate-обработчик ActsMenuManager получит actId и не выйдет no-op\'ом ' +
        '(без фикса эта запись была бы {_lockNavGuard: true} без actId)');
});

// ─── _navPopstateHandler: guard-pushState тоже мержит ────────────────────────

test('_navPopstateHandler.pushState мержит текущий history.state (не стирает поля)', async () => {
    StorageManager._setupNavigationInterception();
    window.currentActId = 5;
    StorageManager._setState('unsaved'); // hasUnsyncedChanges() === true

    // В момент popstate history.state уже указывает на state целевой записи
    // (браузер меняет его ДО вызова обработчика).
    globalThis.history = makeHistoryStub({ actId: 7 });

    await StorageManager._navPopstateHandler({ state: { actId: 7 } });

    assert.equal(history.state._lockNavGuard, true, 'guard-флаг записан');
    assert.equal(history.state.actId, 7, 'actId из state не стёрт мержем');
});
