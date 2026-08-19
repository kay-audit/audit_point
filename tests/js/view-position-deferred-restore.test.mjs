/**
 * Отложенное восстановление позиции просмотра (дефект третьего код-ревью).
 *
 * Скрытый шаг — `display: none !important`: у его контейнеров нет бокса, и
 * присваивание scrollTop молча ничего не делает (значение остаётся 0).
 * Прежний код восстанавливал позицию ОБОИХ шагов сразу, поэтому половина
 * бережно снятой позиции терялась: восстановились на шаг 2 — колонки шага 1
 * оказывались вверху, и наоборот. Снимающая сторона (_captureScrollAndAnchor)
 * скрытый шаг как раз не трогает — восстановление теперь симметрично:
 * видимому шагу применяем сразу, второй ждёт в очереди до перехода на него.
 *
 * Здесь же — устойчивость к падению goToStep: маркер «позиция восстановлена»
 * взводится до перехода, и раньше исключение внутри goToStep навсегда
 * отменяло восстановление для этого входа в акт.
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../../static/js/constructor/app.js';
import { APIClient } from '../../static/js/shared/api.js';
import { saveViewPosition } from '../../static/js/constructor/state/view-position-store.js';

/** Минимальный in-memory Storage. */
function makeStorage() {
    const data = new Map();
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => data.set(k, String(v)),
        removeItem: (k) => data.delete(k),
    };
}

/** Стаб контейнера шага с переключаемой видимостью. */
function makeStep(hidden) {
    return {
        hidden,
        classList: { contains(c) { return c === 'hidden' ? this._owner.hidden : false; } },
        scrollTop: 0,
        getBoundingClientRect: () => ({ top: 0 }),
        querySelectorAll: () => [],
    };
}

/** Колонка шага 1 (scrollTop пишется только когда шаг виден). */
function makeColumn() {
    return { scrollTop: 0 };
}

const realGetElementById = document.getElementById;
const realRaf = globalThis.requestAnimationFrame;

let els;

beforeEach(() => {
    globalThis.localStorage = makeStorage();
    // Стаб rAF в _browser-stub.mjs колбэк НЕ вызывает — восстановление скролла
    // живёт именно в нём, поэтому здесь выполняем синхронно.
    globalThis.requestAnimationFrame = (cb) => { cb(); return 0; };

    const step1 = makeStep(false);
    const step2 = makeStep(true);
    step1.classList._owner = step1;
    step2.classList._owner = step2;
    els = {
        step1,
        step2,
        treeColumn: makeColumn(),
        previewColumn: makeColumn(),
        itemsContainer: { querySelectorAll: () => [] },
    };
    document.getElementById = (id) => els[id] || null;

    App._pendingViewRestore = null;
    APIClient._viewPositionRestoredForActId = null;
});

afterEach(() => {
    document.getElementById = realGetElementById;
    globalThis.requestAnimationFrame = realRaf;
    App._pendingViewRestore = null;
    APIClient._viewPositionRestoredForActId = null;
    delete globalThis.treeManager;
});

const POS = {
    scroll: { treeColumn: 400, previewColumn: 250, step2: 900 },
    anchorNodeId: null,
};

test('шаг 2 виден: его скролл применён сразу, колонки шага 1 ждут в очереди (не обнулены)', () => {
    els.step1.hidden = true;
    els.step2.hidden = false;

    App.queueViewScrollRestore(POS);

    assert.equal(els.step2.scrollTop, 900, 'видимый шаг 2 получил свой скролл');
    assert.equal(els.treeColumn.scrollTop, 0,
        'в скрытый шаг 1 не пишем — присваивание там всё равно no-op');
    assert.ok(App._pendingViewRestore, 'позиция шага 1 осталась в очереди');
    assert.equal(App._pendingViewRestore.treeColumn, 400);
});

test('переход на шаг 1 применяет отложенную позицию его колонок и опустошает очередь', () => {
    els.step1.hidden = true;
    els.step2.hidden = false;
    App.queueViewScrollRestore(POS);

    // Пользователь переключился на шаг 1.
    els.step1.hidden = false;
    els.step2.hidden = true;
    App._flushPendingViewRestore();

    assert.equal(els.treeColumn.scrollTop, 400, 'колонка дерева восстановлена при показе шага');
    assert.equal(els.previewColumn.scrollTop, 250, 'колонка превью восстановлена');
    assert.equal(App._pendingViewRestore, null, 'очередь опустошена — повтора не будет');
});

test('шаг 1 виден: колонки применены сразу, позиция шага 2 ждёт перехода на него', () => {
    App.queueViewScrollRestore(POS);

    assert.equal(els.treeColumn.scrollTop, 400);
    assert.equal(els.step2.scrollTop, 0, 'в скрытый шаг 2 не пишем');
    assert.equal(App._pendingViewRestore.step2, 900, 'позиция шага 2 в очереди');

    els.step1.hidden = true;
    els.step2.hidden = false;
    App._flushPendingViewRestore();

    assert.equal(els.step2.scrollTop, 900, 'при показе шага 2 позиция применена');
    assert.equal(App._pendingViewRestore, null);
});

test('отложенная позиция шага 2 восстанавливается по якорю, а не сырым scrollTop', () => {
    const target = { id: 'anchor-el' };
    let scrolledTo = null;
    globalThis.treeManager = {
        _findPreviewElement: () => target,
        _performScroll: (el) => { scrolledTo = el; },
    };

    els.step1.hidden = true;
    els.step2.hidden = false;
    App.queueViewScrollRestore({ scroll: { ...POS.scroll }, anchorNodeId: 'n-7' });

    assert.equal(scrolledTo, target, 'скролл к якорному узлу');
    assert.equal(els.step2.scrollTop, 0, 'сырой scrollTop не применялся — якорь точнее');
});

test('якорного узла больше нет → откат на сохранённый scrollTop', () => {
    globalThis.treeManager = {
        _findPreviewElement: () => null,
        _performScroll: () => { throw new Error('не должен вызываться'); },
    };

    els.step1.hidden = true;
    els.step2.hidden = false;
    App.queueViewScrollRestore({ scroll: { ...POS.scroll }, anchorNodeId: 'n-удалён' });

    assert.equal(els.step2.scrollTop, 900);
});

test('clearPendingViewRestore: у акта без сохранённой позиции очередь предыдущего не применяется', () => {
    App.queueViewScrollRestore(POS);
    assert.ok(App._pendingViewRestore, 'позиция шага 2 отложена');

    APIClient._restoreViewPosition(42); // позиции для акта 42 в хранилище нет

    assert.equal(App._pendingViewRestore, null,
        'чужая отложенная позиция снята — иначе применилась бы к другому акту');
});

test('_restoreViewPosition: падение goToStep не отменяет восстановление скролла', () => {
    saveViewPosition(localStorage, 7, {
        step: 1,
        scroll: { treeColumn: 120, previewColumn: 80, step2: 0 },
        anchorNodeId: null,
    });
    const realGoToStep = App.goToStep;
    App.goToStep = () => { throw new Error('тулбар ещё не инициализирован'); };

    try {
        assert.doesNotThrow(() => APIClient._restoreViewPosition(7),
            'сбой перехода по шагам не роняет загрузку акта');
        assert.equal(els.treeColumn.scrollTop, 120,
            'скролл видимого шага восстановлен, несмотря на падение goToStep');
    } finally {
        App.goToStep = realGoToStep;
    }
});
