/**
 * Guard-логика вокруг гонки actId при переключении акта (код-ревью нашло
 * узкое окно): в ActsMenuManager._switchToAct/popstate между
 * resetForActSwitch (снимок позиции СТАРОГО акта) и присвоением
 * window.currentActId НОВОМУ акту window.currentActId какое-то время ещё
 * указывает на старый. Если в этом окне сработает App.goToStep (клик по
 * табу шага) с persist=true, шаг НОВОГО акта примешался бы в сохранённую
 * позицию СТАРОГО. App._actSwitchInProgress гасит персист на время окна.
 *
 * Отдельно: APIClient._restoreViewPosition не должен восстанавливать позицию
 * повторно при загрузке ТОГО ЖЕ акта посреди работы (обновление метаданных,
 * restore версии) — только при первом входе в акт за сессию.
 * ActsMenuManager.resetForActSwitch сбрасывает маркер при уходе с акта.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../../static/js/constructor/app.js';
import { ChangelogTracker } from '../../static/js/constructor/changelog-tracker.js';
import { ActsMenuManager } from '../../static/js/constructor/header/acts-menu.js';
import { StorageManager } from '../../static/js/constructor/storage-manager.js';
import { AppState } from '../../static/js/constructor/state/state-core.js';
import { APIClient } from '../../static/js/shared/api.js';
import { AuthManager } from '../../static/js/shared/auth.js';
import { loadViewPosition, saveViewPosition } from '../../static/js/constructor/state/view-position-store.js';

/** Минимальный in-memory Storage. */
function makeStorage() {
    const data = new Map();
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => data.set(k, String(v)),
        removeItem: (k) => data.delete(k),
    };
}

const realGoToStep = App.goToStep;

beforeEach(() => {
    globalThis.localStorage = makeStorage();
    globalThis.textBlockManager = { initGlobalToolbar() {}, hideToolbar() {} };
    App._actSwitchInProgress = false;
    APIClient._viewPositionRestoredForActId = null;
});

afterEach(() => {
    App.goToStep = realGoToStep;
    App._actSwitchInProgress = false;
    APIClient._viewPositionRestoredForActId = null;
});

test('App.goToStep персистит step, когда переключение акта не идёт', () => {
    globalThis.currentActId = 42;
    App.goToStep(1);
    const pos = loadViewPosition(localStorage, 42);
    assert.equal(pos.step, 1);
});

test('App.goToStep НЕ персистит step, пока App._actSwitchInProgress взведён (окно гонки actId при switch)', () => {
    globalThis.currentActId = 42;
    saveViewPosition(localStorage, 42, {
        step: 1,
        scroll: { treeColumn: 10, previewColumn: 0, step2: 0 },
        anchorNodeId: null,
    });

    App._actSwitchInProgress = true;
    // Клик по табу «шаг 2» в окне гонки: window.currentActId=42 в этот момент
    // ЕЩЁ старый акт (реальный switch присвоит новый только после await).
    App.goToStep(2);
    App._actSwitchInProgress = false;

    const pos = loadViewPosition(localStorage, 42);
    assert.equal(pos.step, 1, 'шаг НОВОГО акта не должен примешаться в позицию старого');
    assert.equal(pos.scroll.treeColumn, 10, 'остальная позиция акта 42 не тронута');
});

test('после снятия guard App.goToStep снова персистит как обычно', () => {
    globalThis.currentActId = 42;
    App._actSwitchInProgress = true;
    App.goToStep(2);
    App._actSwitchInProgress = false;
    App.goToStep(2);

    const pos = loadViewPosition(localStorage, 42);
    assert.equal(pos.step, 2);
});

test('ActsMenuManager.resetForActSwitch сбрасывает маркер «уже восстанавливали позицию» у APIClient', () => {
    APIClient._viewPositionRestoredForActId = 5;
    ActsMenuManager.currentActId = null; // без старого акта App.persistViewPositionForAct не дёргается
    ActsMenuManager.resetForActSwitch();
    assert.equal(APIClient._viewPositionRestoredForActId, null);
});

test('APIClient._restoreViewPosition восстанавливает позицию один раз за вход в акт', () => {
    saveViewPosition(localStorage, 7, {
        step: 2,
        scroll: { treeColumn: 0, previewColumn: 0, step2: 0 },
        anchorNodeId: null,
    });

    let calls = 0;
    App.goToStep = () => { calls++; };

    APIClient._restoreViewPosition(7);
    assert.equal(calls, 1, 'первый вход в акт 7 — восстанавливаем');

    // Повторная загрузка ТОГО ЖЕ акта посреди работы (обновление метаданных,
    // restore версии, refresh после сохранения структуры) — без прыжка скролла.
    APIClient._restoreViewPosition(7);
    assert.equal(calls, 1, 'повторный вызов для того же акта — НЕ восстанавливаем повторно');

    // Для акта 9 сохранённой позиции нет — goToStep вообще не должен дёргаться.
    APIClient._restoreViewPosition(9);
    assert.equal(calls, 1, 'для акта без сохранённой позиции восстанавливать нечего');
});

test('_loadActIntoView держит guard до присвоения нового actId, а не до конца загрузки контента', async () => {
    // Окно, которое закрывает guard, кончается не на загрузке контента, а на
    // присвоении window.currentActId. Между ними у новых/пустых актов ждёт
    // сеть (_saveDefaultStructure) — снятый в finally сразу после загрузки
    // флаг открывал ровно ту гонку, ради которой он и заведён.
    const realApply = APIClient._applyActContent;
    const realDefaultSave = APIClient._saveDefaultStructure;
    const realGetUser = AuthManager.getCurrentUser;
    const realChangelogInit = ChangelogTracker.init;
    const realChangelogDestroy = ChangelogTracker.destroy;
    const realSynced = StorageManager.markAsSyncedWithDB;
    const realClearCache = ActsMenuManager._clearCache;

    globalThis.currentActId = 42;
    ActsMenuManager.currentActId = 42;
    // Покидаемый акт 42 стоит на шаге 1 — именно его resetForActSwitch снимет
    // в позицию акта 42 (штатно, до окна гонки).
    AppState.currentStep = 1;
    saveViewPosition(localStorage, 42, {
        step: 1,
        scroll: { treeColumn: 10, previewColumn: 0, step2: 0 },
        anchorNodeId: null,
    });

    let guardDuringDefaultSave = null;
    APIClient._applyActContent = async () => {};
    APIClient._pendingDefaultStructureSave = true;
    APIClient._saveDefaultStructure = async () => {
        guardDuringDefaultSave = App._actSwitchInProgress;
        // Клик по табу «шаг 2», пока PUT дефолтной структуры в полёте:
        // window.currentActId здесь ЕЩЁ 42 (старый акт).
        App.goToStep(2);
    };
    AuthManager.getCurrentUser = () => 'u1';
    ChangelogTracker.init = () => {};
    ChangelogTracker.destroy = () => {};
    StorageManager.markAsSyncedWithDB = () => {};
    ActsMenuManager._clearCache = () => {};

    try {
        await ActsMenuManager._loadActIntoView(99, { tree: {} });

        assert.equal(guardDuringDefaultSave, true,
            'guard обязан быть взведён всё время сетевого ожидания');
        const pos = loadViewPosition(localStorage, 42);
        assert.equal(pos.step, 1, 'шаг НОВОГО акта не примешался в позицию старого');
        assert.equal(App._actSwitchInProgress, false, 'после переключения guard снят');
        assert.equal(window.currentActId, 99);
    } finally {
        APIClient._applyActContent = realApply;
        APIClient._saveDefaultStructure = realDefaultSave;
        APIClient._pendingDefaultStructureSave = false;
        AuthManager.getCurrentUser = realGetUser;
        ChangelogTracker.init = realChangelogInit;
        ChangelogTracker.destroy = realChangelogDestroy;
        StorageManager.markAsSyncedWithDB = realSynced;
        ActsMenuManager._clearCache = realClearCache;
        ActsMenuManager.currentActId = null;
        window.currentActId = undefined;
    }
});

test('после resetForActSwitch повторный вход в тот же акт восстанавливает позицию заново', () => {
    saveViewPosition(localStorage, 7, {
        step: 2,
        scroll: { treeColumn: 0, previewColumn: 0, step2: 0 },
        anchorNodeId: null,
    });

    let calls = 0;
    App.goToStep = () => { calls++; };

    APIClient._restoreViewPosition(7);
    assert.equal(calls, 1);

    APIClient._restoreViewPosition(7);
    assert.equal(calls, 1, 'дедуп внутри одного входа в акт');

    ActsMenuManager.currentActId = null;
    ActsMenuManager.resetForActSwitch();

    APIClient._restoreViewPosition(7);
    assert.equal(calls, 2, 'после ухода с акта (resetForActSwitch) — новый вход, восстановление снова');
});
