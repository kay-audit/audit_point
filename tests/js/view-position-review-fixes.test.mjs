/**
 * Три дефекта позиции просмотра, найденные повторным код-ревью:
 *
 * 1) popstate (браузерные back/forward) шёл мимо resetForActSwitch и не
 *    обновлял ActsMenuManager.currentActId/window.currentActId — позиция
 *    покидаемого акта писалась под ключ НОВОГО, позиция открываемого не
 *    восстанавливалась, пер-актное UI-состояние текло между актами.
 *    Фикс — общий приватный хелпер ActsMenuManager._loadActIntoView,
 *    используется и _switchToAct (после захвата лока), и popstate.
 *
 * 2) App._captureScrollAndAnchor снимал scrollTop СКРЫТОГО шага как 0 (у
 *    display:none элементов), а _saveViewPosition заменяла scroll ЦЕЛИКОМ —
 *    нули затирали честно сохранённую позицию другого шага. Фикс — снимать
 *    только видимый шаг (undefined для скрытого) + попольевой merge scroll.
 *
 * 3) APIClient._restoreViewPosition безусловно звал App.goToStep, а тот
 *    безусловно перерендеривал контент шага — второй ItemsRenderer.renderAll
 *    / PreviewManager.update поверх уже отрисованного _applyActContent.
 *    Фикс — App.goToStep({skipRender}) пропускает рендер, но не тулбар/
 *    read-only-ограничения (они не рендер, а разовая инициализация/политика).
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { App } from '../../static/js/constructor/app.js';
import { ActsMenuManager } from '../../static/js/constructor/header/acts-menu.js';
import { APIClient } from '../../static/js/shared/api.js';
import { ItemsRenderer } from '../../static/js/constructor/items/items-renderer.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
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

/** Стаб .step-content с рабочим classList.contains('hidden'). */
function makeStepStub(hidden, scrollTop = 0) {
    return {
        classList: { contains: (c) => (c === 'hidden' ? hidden : false) },
        scrollTop,
        getBoundingClientRect: () => ({ top: 0 }),
        querySelectorAll: () => [],
    };
}

const realGetElementById = document.getElementById;
const realLoadActContent = APIClient.loadActContent;
const realRenderAll = ItemsRenderer.renderAll;
const realPreviewUpdate = PreviewManager.update;
const realGoToStep = App.goToStep;

beforeEach(() => {
    globalThis.localStorage = makeStorage();
    globalThis.textBlockManager = { initGlobalToolbar() {}, hideToolbar() {} };
    globalThis.history = { pushState: () => {} };
    document.getElementById = realGetElementById;
    App._actSwitchInProgress = false;
    APIClient._viewPositionRestoredForActId = null;
    APIClient._pendingDefaultStructureSave = false;
    ActsMenuManager.currentActId = null;
    window.currentActId = undefined;
    AppConfig.readOnlyMode.isReadOnly = false;
});

afterEach(() => {
    document.getElementById = realGetElementById;
    APIClient.loadActContent = realLoadActContent;
    ItemsRenderer.renderAll = realRenderAll;
    PreviewManager.update = realPreviewUpdate;
    App.goToStep = realGoToStep;
    App._actSwitchInProgress = false;
    APIClient._viewPositionRestoredForActId = null;
    APIClient._pendingDefaultStructureSave = false;
});

// --- 1) popstate/switch используют общий _loadActIntoView -----------------

test('_loadActIntoView сбрасывает UI покидаемого акта, грузит новый, обновляет currentActId, НЕ трогает history', async () => {
    let loadedIds = [];
    let pushStateCalled = false;
    globalThis.history.pushState = () => { pushStateCalled = true; };
    APIClient.loadActContent = async (id) => { loadedIds.push(id); };

    ActsMenuManager.currentActId = 1;
    window.currentActId = 1;
    APIClient._viewPositionRestoredForActId = 1;

    await ActsMenuManager._loadActIntoView(2);

    assert.deepEqual(loadedIds, [2]);
    assert.equal(ActsMenuManager.currentActId, 2, 'currentActId обновлён на новый акт');
    assert.equal(window.currentActId, 2, 'window.currentActId обновлён на новый акт');
    assert.equal(APIClient._viewPositionRestoredForActId, null, 'resetForActSwitch сбросил маркер восстановления');
    assert.equal(pushStateCalled, false, '_loadActIntoView не трогает history — это забота вызывающего');
});

test('_loadActIntoView гасит персист шага на всё время await (полный сценарий гонки из ревью)', async () => {
    saveViewPosition(localStorage, 1, {
        step: 1,
        scroll: { treeColumn: 5, previewColumn: 0, step2: 0 },
        anchorNodeId: null,
    });

    let resolveLoad;
    APIClient.loadActContent = () => new Promise((resolve) => { resolveLoad = resolve; });
    ActsMenuManager.currentActId = 1;
    window.currentActId = 1;

    const switchPromise = ActsMenuManager._loadActIntoView(2);

    // await ещё не завершился — window.currentActId ЕЩЁ указывает на старый акт (1).
    assert.equal(window.currentActId, 1);
    // Клик по табу шага в этом окне — раньше примешивал бы шаг акта 2 в позицию акта 1.
    App.goToStep(2);

    resolveLoad();
    await switchPromise;

    const posOld = loadViewPosition(localStorage, 1);
    assert.equal(posOld.step, 1, 'шаг НОВОГО акта не примешался в сохранённую позицию СТАРОГО');
});

test('popstate-обработчик не делает pushState (иначе сломал бы forward-навигацию)', () => {
    // Структурная проверка: popstate — реакция на уже случившуюся навигацию
    // браузера, а не инициатор новой. _loadActIntoView (общий для switch и
    // popstate) сам не зовёт pushState — это подтверждено тестом выше;
    // pushState в acts-menu.js встречается ровно один раз — в _switchToAct,
    // ПОСЛЕ await this._loadActIntoView(actId), не в обработчике popstate.
    const src = fs.readFileSync(
        new URL('../../static/js/constructor/header/acts-menu.js', import.meta.url),
        'utf8'
    );
    const popstateBlock = src.slice(src.indexOf("addEventListener('popstate'"), src.indexOf("const param = new URLSearchParams"));
    // Проверяем реальный ВЫЗОВ, не голое слово — блок объясняющим комментарием
    // упоминает «pushState» в прозе (почему НЕ делаем), это не вызов.
    assert.ok(!popstateBlock.includes('.pushState('), 'popstate не должен звать history.pushState');
    assert.ok(popstateBlock.includes('_loadActIntoView'), 'popstate должен идти через общий хелпер');
});

// --- 2) capture/merge позиции только видимого шага -------------------------

test('_captureScrollAndAnchor: шаг 1 скрыт, шаг 2 виден — treeColumn/previewColumn НЕ снимаются', () => {
    const elements = {
        step1: makeStepStub(true),
        step2: makeStepStub(false, 123),
        treeColumn: { scrollTop: 999 },
        previewColumn: { scrollTop: 888 },
    };
    document.getElementById = (id) => elements[id] || null;

    const { scroll, anchorNodeId } = App._captureScrollAndAnchor();

    assert.equal(scroll.treeColumn, undefined);
    assert.equal(scroll.previewColumn, undefined);
    assert.equal(scroll.step2, 123);
    assert.equal(anchorNodeId, null);
});

test('_captureScrollAndAnchor: шаг 2 скрыт, шаг 1 виден — step2/anchor НЕ снимаются', () => {
    const elements = {
        step1: makeStepStub(false),
        step2: makeStepStub(true, 777),
        treeColumn: { scrollTop: 42 },
        previewColumn: { scrollTop: 24 },
    };
    document.getElementById = (id) => elements[id] || null;

    const { scroll, anchorNodeId } = App._captureScrollAndAnchor();

    assert.equal(scroll.treeColumn, 42);
    assert.equal(scroll.previewColumn, 24);
    assert.equal(scroll.step2, undefined);
    assert.equal(anchorNodeId, undefined);
});

test('persistViewPositionForAct на скрытом шаге НЕ затирает сохранённую позицию другого шага (обе стороны)', () => {
    // Направление А: было сохранено (шаг2=легитимный скролл), теперь снимаем
    // на шаге 1 (шаг2 скрыт) — старое значение step2 должно выжить.
    saveViewPosition(localStorage, 5, {
        step: 2,
        scroll: { treeColumn: 0, previewColumn: 0, step2: 500 },
        anchorNodeId: 'node-x',
    });
    document.getElementById = (id) => ({
        step1: makeStepStub(false),
        step2: makeStepStub(true, 0),
        treeColumn: { scrollTop: 11 },
        previewColumn: { scrollTop: 22 },
    }[id] || null);

    App.persistViewPositionForAct(5);

    const pos = loadViewPosition(localStorage, 5);
    assert.equal(pos.scroll.step2, 500, 'скролл скрытого шага 2 не затёрт нулём');
    assert.equal(pos.anchorNodeId, 'node-x', 'якорь скрытого шага 2 не затёрт');
    assert.equal(pos.scroll.treeColumn, 11, 'скролл видимого шага 1 обновлён');
    assert.equal(pos.scroll.previewColumn, 22);

    // Направление Б: симметрично — снимаем на шаге 2, шаг 1 скрыт.
    document.getElementById = (id) => ({
        step1: makeStepStub(true, 0),
        step2: makeStepStub(false, 600),
        treeColumn: { scrollTop: 999 },
        previewColumn: { scrollTop: 999 },
    }[id] || null);

    App.persistViewPositionForAct(5);

    const pos2 = loadViewPosition(localStorage, 5);
    assert.equal(pos2.scroll.treeColumn, 11, 'скролл скрытого теперь шага 1 не затёрт');
    assert.equal(pos2.scroll.previewColumn, 22);
    assert.equal(pos2.scroll.step2, 600, 'скролл видимого шага 2 обновлён');
});

// --- 3) без двойного рендера при восстановлении -----------------------------

test('goToStep({skipRender:true}) не рендерит повторно (ни ItemsRenderer, ни PreviewManager), но инициализирует тулбар и read-only', () => {
    window.currentActId = 1;
    let renderAllCalls = 0;
    let toolbarCalls = 0;
    let readOnlyContentCalls = 0;
    ItemsRenderer.renderAll = () => { renderAllCalls++; };
    globalThis.textBlockManager = { initGlobalToolbar: () => { toolbarCalls++; }, hideToolbar() {} };
    AppConfig.readOnlyMode.isReadOnly = true;
    const realApplyRO = App._applyReadOnlyToContent;
    App._applyReadOnlyToContent = () => { readOnlyContentCalls++; };

    try {
        App.goToStep(2, { skipRender: true });
        assert.equal(renderAllCalls, 0, 'ItemsRenderer.renderAll НЕ вызван повторно');
        assert.equal(toolbarCalls, 1, 'тулбар шага 2 инициализируется даже при skipRender');
        assert.equal(readOnlyContentCalls, 1, 'read-only-ограничения применяются даже при skipRender');
    } finally {
        App._applyReadOnlyToContent = realApplyRO;
    }
});

test('goToStep(1, {skipRender:true}) не планирует PreviewManager.update', () => {
    window.currentActId = 1;
    let updateCalls = 0;
    PreviewManager.update = () => { updateCalls++; };
    const realRAF = globalThis.requestAnimationFrame;
    // Синхронный RAF: если бы update() был запланирован, он бы выполнился тут же.
    globalThis.requestAnimationFrame = (cb) => cb();

    try {
        App.goToStep(1, { skipRender: true });
        assert.equal(updateCalls, 0, 'PreviewManager.update НЕ запланирован повторно');
    } finally {
        globalThis.requestAnimationFrame = realRAF;
    }
});

test('goToStep без skipRender (обычное поведение) по-прежнему рендерит', () => {
    window.currentActId = 1;
    let renderAllCalls = 0;
    ItemsRenderer.renderAll = () => { renderAllCalls++; };

    App.goToStep(2);
    assert.equal(renderAllCalls, 1, 'обычный переход на шаг 2 рендерит контент');
});

test('APIClient._restoreViewPosition зовёт App.goToStep с {persist:false, skipRender:true}', () => {
    saveViewPosition(localStorage, 9, {
        step: 2,
        scroll: { treeColumn: 0, previewColumn: 0, step2: 0 },
        anchorNodeId: null,
    });

    let capturedArgs = null;
    App.goToStep = (step, opts) => { capturedArgs = [step, opts]; };

    APIClient._restoreViewPosition(9);

    assert.deepEqual(capturedArgs, [2, { persist: false, skipRender: true }]);
});
