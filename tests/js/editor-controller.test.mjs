/**
 * Task 1.3.1: перемонтируемый контроллер активной поверхности редактора
 * (EditorController.mount/unmount). textBlockManager.attachToolbarTo/
 * detachToolbar застаблены no-op-спаями на импортированном singleton —
 * тестируем врезку контроллера (реестр + слушатели + порядок), не реальный
 * DOM-тулбар (тот требует document.getElementById('globalTextBlockToolbar')
 * и т.п., см. textblock-toolbar.js).
 *
 * Task 1.3.4-B2: аналогично застаблены capsule-lifecycle методы
 * (installCapsuleObserver/handleEditorBeforeInput/handleEditorKeydown/
 * handleEditorCopy/attachLinkFootnoteHandlers) — реальные требуют
 * MutationObserver и живой DOM (querySelectorAll и т.п.), недоступные в
 * node-стабе. Тестируем ТОЛЬКО факт вызова/навешивания по гейту
 * rich+kind==='violationField' и снятие на unmount; реальная heal/caret-
 * логика — Playwright/verify-фаза.
 *
 * Task 2 (паритет обработчиков rich-поля с текстблоком): аналогично
 * застаблены handleSelectionChange/handleEditorInput/handleEditorPaste
 * (реальные читают Selection/живой DOM) и _clearNodeSelected/
 * _cleanOrphanSizeAnchors (unmount-гигиена, зеркало handleEditorBlur) —
 * тестируем факт вызова/аргументы и гейты (mouseup/keyup — для ЛЮБОЙ
 * поверхности, input-паритет/paste/гигиена — только rich+violationField).
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EditorController } from '../../static/js/constructor/textblock/editor-controller.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';

let toolbarLog;
let capsuleLog;
let parityLog;

/**
 * Фейковая поверхность: element с рабочими add/removeEventListener (хранят
 * обработчик и позволяют его дёрнуть через _fire) + commit-спай, пишущий в
 * общий с removeEventListener лог surface.log — так проверяется ПОРЯДОК
 * (commit ДО removeEventListener) внутри unmount. rich=false по умолчанию —
 * как у всех поверхностей ДО Task 1.3.4-B2 (капсульный гейт на них не должен
 * срабатывать).
 */
function fakeSurface(id, kind = 'violationField', rich = false) {
    const log = [];
    const listeners = {};
    const element = {
        addEventListener(type, handler) { listeners[type] = handler; },
        removeEventListener(type, handler) {
            if (listeners[type] === handler) {
                log.push(`removeEventListener:${type}`);
                delete listeners[type];
            }
        },
        _fire(type, evt) { listeners[type](evt); },
        _hasListener(type) { return typeof listeners[type] === 'function'; },
    };
    return { kind, id, rich, log, element, commit() { log.push('commit'); } };
}

beforeEach(() => {
    EditorController.unmount(); // сброс возможного «хвоста» предыдущего теста
    EditorRegistry.clear();
    toolbarLog = [];
    capsuleLog = [];
    textBlockManager.attachToolbarTo = (surface) => toolbarLog.push(['attach', surface]);
    textBlockManager.detachToolbar = () => toolbarLog.push(['detach']);
    // Спай ставит на element.__capsuleObserver фейковый observer с disconnect-
    // спаем — зеркалит реальный контракт installCapsuleObserver достаточно,
    // чтобы проверить симметрию mount(install)/unmount(disconnect).
    textBlockManager.installCapsuleObserver = (element) => {
        capsuleLog.push(['installCapsuleObserver', element]);
        element.__capsuleObserver = { disconnect: () => capsuleLog.push(['disconnect']) };
    };
    textBlockManager.handleEditorBeforeInput = (...args) => capsuleLog.push(['handleEditorBeforeInput', ...args]);
    textBlockManager.handleEditorKeydown = (...args) => capsuleLog.push(['handleEditorKeydown', ...args]);
    textBlockManager.handleEditorCopy = (...args) => capsuleLog.push(['handleEditorCopy', ...args]);
    textBlockManager.attachLinkFootnoteHandlers = () => capsuleLog.push(['attachLinkFootnoteHandlers']);

    // Task 2: отдельный журнал — не capsuleLog/toolbarLog, иначе существующие
    // exact-match проверки тех журналов ловили бы чужие записи.
    parityLog = [];
    textBlockManager.handleSelectionChange = (...args) => parityLog.push(['handleSelectionChange', ...args]);
    textBlockManager.handleEditorInput = (...args) => parityLog.push(['handleEditorInput', ...args]);
    textBlockManager.handleEditorPaste = (...args) => parityLog.push(['handleEditorPaste', ...args]);
    textBlockManager.handleEditorDrop = (...args) => parityLog.push(['handleEditorDrop', ...args]);
    // Без typeof-гварда в реализации (в отличие от _cleanOrphanSizeAnchors) —
    // должен существовать всегда, иначе unmount rich-поверхности бросит TypeError.
    textBlockManager._clearNodeSelected = (...args) => parityLog.push(['_clearNodeSelected', ...args]);
    textBlockManager._cleanOrphanSizeAnchors = (...args) => parityLog.push(['_cleanOrphanSizeAnchors', ...args]);
});

test('mount: активирует поверхность в реестре, врезает тулбар, навешивает input/blur', () => {
    const s = fakeSurface('v1');
    EditorController.mount(s);

    assert.equal(EditorRegistry.getActive(), s);
    assert.deepEqual(toolbarLog, [['attach', s]]);
    assert.equal(s.element._hasListener('input'), true, 'input-слушатель не навешен');
    assert.equal(s.element._hasListener('blur'), true, 'blur-слушатель не навешен');
});

test('mount: input-событие коммитит поверхность (write-through element→модель)', () => {
    const s = fakeSurface('v1');
    EditorController.mount(s);

    s.element._fire('input');

    assert.deepEqual(s.log, ['commit']);
    assert.deepEqual(parityLog, [], 'non-rich/non-violationField — handleEditorInput не должен звать (гейт БАГ-1)');
});

test('mount: повторный mount той же поверхности — no-op (без повторной врезки тулбара)', () => {
    const s = fakeSurface('v1');
    EditorController.mount(s);
    EditorController.mount(s);

    assert.deepEqual(toolbarLog, [['attach', s]], 'attachToolbarTo не должен звать повторно');
});

test('unmount: коммитит поверхность, снимает слушатели, отвязывает тулбар, чистит реестр', () => {
    const s = fakeSurface('v1');
    EditorController.mount(s);
    toolbarLog.length = 0; // интересует детач, не предыдущий attach

    EditorController.unmount();

    assert.deepEqual(s.log, [
        'commit',
        'removeEventListener:input', 'removeEventListener:blur',
        'removeEventListener:mouseup', 'removeEventListener:keyup', // БАГ-2: тулбар по каретке — для любой поверхности
    ]);
    assert.deepEqual(toolbarLog, [['detach']]);
    assert.equal(EditorRegistry.getActive(), null);
});

test('unmount: порядок — commit идёт ДО removeEventListener (иначе висящий ввод теряется)', () => {
    const s = fakeSurface('v1');
    EditorController.mount(s);

    EditorController.unmount();

    const commitIdx = s.log.indexOf('commit');
    const removeIdx = s.log.findIndex((entry) => entry.startsWith('removeEventListener'));
    assert.ok(commitIdx !== -1 && removeIdx !== -1 && commitIdx < removeIdx,
        'commit должен предшествовать removeEventListener');
});

test('unmount: без активной поверхности — no-op без throw', () => {
    assert.doesNotThrow(() => EditorController.unmount());
});

test('blur-событие на поверхности вызывает unmount (commit + детач + очистка реестра)', () => {
    const s = fakeSurface('v1');
    EditorController.mount(s);

    s.element._fire('blur');

    assert.deepEqual(s.log, [
        'commit',
        'removeEventListener:input', 'removeEventListener:blur',
        'removeEventListener:mouseup', 'removeEventListener:keyup',
    ]);
    assert.equal(EditorRegistry.getActive(), null);
});

test('mount(B) при активной A: сначала A.unmount (commit+detach), потом B mount (одна активная)', () => {
    const a = fakeSurface('A');
    const b = fakeSurface('B');
    EditorController.mount(a);
    toolbarLog.length = 0; // интересует детач A / attach B

    EditorController.mount(b);

    assert.deepEqual(a.log, [
        'commit',
        'removeEventListener:input', 'removeEventListener:blur',
        'removeEventListener:mouseup', 'removeEventListener:keyup',
    ], 'A не коммитнута/отвязана перед mount B');
    assert.deepEqual(toolbarLog, [['detach'], ['attach', b]], 'детач A должен предшествовать attach B');
    assert.equal(EditorRegistry.getActive(), b);
    assert.equal(b.element._hasListener('input'), true);
});

// ── Task 1.3.4-B2: интерактивный capsule-lifecycle (гейт rich+violationField) ──

test('mount: rich violationField-поверхность — ставит capsule-lifecycle (observer, tooltip, beforeinput/keydown/copy/cut)', () => {
    const s = fakeSurface('v1', 'violationField', true);
    EditorController.mount(s);

    assert.deepEqual(capsuleLog[0], ['installCapsuleObserver', s.element]);
    assert.ok(capsuleLog.some((e) => e[0] === 'attachLinkFootnoteHandlers'),
        'attachLinkFootnoteHandlers не вызван');
    assert.equal(s.element._hasListener('beforeinput'), true);
    assert.equal(s.element._hasListener('keydown'), true);
    assert.equal(s.element._hasListener('copy'), true);
    assert.equal(s.element._hasListener('cut'), true, 'cut не навешен (CORE-4: guard\'ы утекут в клипборд)');
    assert.equal(s.element._hasListener('paste'), true, 'paste не навешен (вставка через textblock-путь)');
});

test('mount: НЕ-violationField поверхность (kind="textblock", rich=true) — capsule-lifecycle НЕ ставится (гейт по kind)', () => {
    const s = fakeSurface('tb1', 'textblock', true);
    EditorController.mount(s);

    assert.deepEqual(capsuleLog, [], 'capsule-lifecycle методы не должны звать не-violationField поверхность');
    assert.equal(s.element._hasListener('beforeinput'), false);
    assert.equal(s.element._hasListener('keydown'), false);
    assert.equal(s.element._hasListener('copy'), false);
    assert.equal(s.element._hasListener('cut'), false);
    assert.equal(s.element._hasListener('paste'), false);
});

test('mount: violationField-поверхность БЕЗ rich (rich=false) — capsule-lifecycle НЕ ставится (гейт по rich)', () => {
    const s = fakeSurface('v1', 'violationField', false);
    EditorController.mount(s);

    assert.deepEqual(capsuleLog, [], 'capsule-lifecycle методы не должны звать non-rich поверхность');
    assert.equal(s.element._hasListener('beforeinput'), false);
    assert.equal(s.element._hasListener('paste'), false);
});

test('unmount: снимает capsule-lifecycle (observer.disconnect + beforeinput/keydown/copy/cut/paste)', () => {
    const s = fakeSurface('v1', 'violationField', true);
    EditorController.mount(s);
    capsuleLog.length = 0; // интересует снятие, не установку

    EditorController.unmount();

    assert.deepEqual(capsuleLog, [['disconnect']]);
    assert.equal(s.element._hasListener('beforeinput'), false);
    assert.equal(s.element._hasListener('keydown'), false);
    assert.equal(s.element._hasListener('copy'), false);
    assert.equal(s.element._hasListener('cut'), false);
    assert.equal(s.element._hasListener('paste'), false);
});

test('unmount: НЕ-violationField поверхность — detach не трогает capsule-lifecycle (его и не было)', () => {
    const s = fakeSurface('tb1', 'textblock', true);
    EditorController.mount(s);
    capsuleLog.length = 0;

    assert.doesNotThrow(() => EditorController.unmount());
    assert.deepEqual(capsuleLog, []);
});

// ── Task 2: паритет обработчиков rich-поля с текстблоком (БАГ-1, БАГ-2, paste) ──

test('mount: mouseup/keyup вызывают textBlockManager.handleSelectionChange (БАГ-2, для ЛЮБОЙ поверхности)', () => {
    const s = fakeSurface('v1'); // rich=false — тулбар должен обновляться по каретке независимо от гейта
    EditorController.mount(s);

    assert.equal(s.element._hasListener('mouseup'), true, 'mouseup-слушатель не навешен');
    assert.equal(s.element._hasListener('keyup'), true, 'keyup-слушатель не навешен');

    s.element._fire('mouseup');
    s.element._fire('keyup');

    assert.deepEqual(parityLog, [['handleSelectionChange'], ['handleSelectionChange']]);
});

test('mount: rich violationField — paste вызывает textBlockManager.handleEditorPaste(e, element, null)', () => {
    const s = fakeSurface('v1', 'violationField', true);
    EditorController.mount(s);

    const fakeEvent = { type: 'paste' };
    s.element._fire('paste', fakeEvent);

    assert.deepEqual(parityLog, [['handleEditorPaste', fakeEvent, s.element, null]]);
});

// ── T7 (#6/#14b): policy-driven drop в rich-поле нарушения ────────────────────

test('mount: rich violationField — drop навешен и вызывает textBlockManager.handleEditorDrop(e, element, null)', () => {
    const s = fakeSurface('v1', 'violationField', true);
    EditorController.mount(s);

    assert.equal(s.element._hasListener('drop'), true, 'drop-слушатель не навешен (санитизация/гейт сносок в обход)');

    const fakeEvent = { type: 'drop' };
    s.element._fire('drop', fakeEvent);

    assert.deepEqual(parityLog, [['handleEditorDrop', fakeEvent, s.element, null]]);
});

test('mount: НЕ-capsuleLifecycle поверхность (textblock) — drop НЕ навешен', () => {
    const s = fakeSurface('tb1', 'textblock', true);
    EditorController.mount(s);

    assert.equal(s.element._hasListener('drop'), false, 'drop не должен вешаться вне capsule-lifecycle');
});

test('unmount: rich violationField — снимает drop-слушатель', () => {
    const s = fakeSurface('v1', 'violationField', true);
    EditorController.mount(s);
    assert.equal(s.element._hasListener('drop'), true);

    EditorController.unmount();

    assert.equal(s.element._hasListener('drop'), false, 'drop-слушатель не снят на unmount');
});

test('mount: rich violationField — input вызывает commit() И textBlockManager.handleEditorInput(element, null) (БАГ-1)', () => {
    const s = fakeSurface('v1', 'violationField', true);
    EditorController.mount(s);

    s.element._fire('input');

    assert.deepEqual(s.log, ['commit'], 'write-through в модель выполнен');
    assert.deepEqual(parityLog, [['handleEditorInput', s.element, null]],
        'handleEditorInput не вызван — guard\'ы не переставятся, навигация у капсул останется битой');
});

test('unmount: rich violationField — вызывает _clearNodeSelected(element) и _cleanOrphanSizeAnchors(element, {ignoreCaret:true})', () => {
    const s = fakeSurface('v1', 'violationField', true);
    EditorController.mount(s);
    parityLog.length = 0; // интересует unmount, не возможные вызовы на mount

    EditorController.unmount();

    assert.deepEqual(parityLog.filter((e) => e[0] === '_clearNodeSelected'),
        [['_clearNodeSelected', s.element]]);
    assert.deepEqual(parityLog.filter((e) => e[0] === '_cleanOrphanSizeAnchors'),
        [['_cleanOrphanSizeAnchors', s.element, { ignoreCaret: true }]]);
});

test('unmount: rich violationField — чистит element.saveTimeout (clearTimeout + поле в null)', () => {
    const s = fakeSurface('v1', 'violationField', true);
    EditorController.mount(s);
    const timer = setTimeout(() => {}, 100000);
    s.element.saveTimeout = timer;
    // Подменяем clearTimeout, чтобы зафиксировать сброс именно этого таймера
    // (рецепт — tests/js/textblock-blur-preview.test.mjs).
    const origClear = globalThis.clearTimeout;
    let clearedWith = null;
    globalThis.clearTimeout = (t) => { clearedWith = t; origClear(t); };

    try {
        EditorController.unmount();
    } finally {
        globalThis.clearTimeout = origClear;
    }

    assert.equal(clearedWith, timer, 'clearTimeout не вызван с висящим saveTimeout');
    assert.equal(s.element.saveTimeout, null);
});

test('unmount: rich violationField — гигиена (saveTimeout-clear/_clearNodeSelected/_cleanOrphanSizeAnchors) строго ДО commit', () => {
    const s = fakeSurface('v1', 'violationField', true);
    EditorController.mount(s);

    const timer = setTimeout(() => {}, 100000);
    s.element.saveTimeout = timer;
    const origClear = globalThis.clearTimeout;
    globalThis.clearTimeout = (t) => { s.log.push('clearTimeout'); origClear(t); };
    // Локальный оверрайд общего спая: parityLog нельзя сравнить по позиции с
    // s.log напрямую (разные массивы) — порядок интересует ОТНОСИТЕЛЬНО
    // commit/removeEventListener, поэтому пишем в общий с ними журнал s.log.
    textBlockManager._clearNodeSelected = () => s.log.push('_clearNodeSelected');
    textBlockManager._cleanOrphanSizeAnchors = () => s.log.push('_cleanOrphanSizeAnchors');

    try {
        EditorController.unmount();
    } finally {
        globalThis.clearTimeout = origClear;
    }

    const commitIdx = s.log.indexOf('commit');
    assert.notEqual(commitIdx, -1, 'commit должен быть в журнале');
    ['clearTimeout', '_clearNodeSelected', '_cleanOrphanSizeAnchors'].forEach((marker) => {
        const idx = s.log.indexOf(marker);
        assert.ok(idx !== -1 && idx < commitIdx, `${marker} должен предшествовать commit`);
    });
});
