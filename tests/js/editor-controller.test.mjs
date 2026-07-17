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
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EditorController } from '../../static/js/constructor/textblock/editor-controller.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';

let toolbarLog;
let capsuleLog;

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
        _fire(type) { listeners[type](); },
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

    assert.deepEqual(s.log, ['commit', 'removeEventListener:input', 'removeEventListener:blur']);
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

    assert.deepEqual(s.log, ['commit', 'removeEventListener:input', 'removeEventListener:blur']);
    assert.equal(EditorRegistry.getActive(), null);
});

test('mount(B) при активной A: сначала A.unmount (commit+detach), потом B mount (одна активная)', () => {
    const a = fakeSurface('A');
    const b = fakeSurface('B');
    EditorController.mount(a);
    toolbarLog.length = 0; // интересует детач A / attach B

    EditorController.mount(b);

    assert.deepEqual(a.log, ['commit', 'removeEventListener:input', 'removeEventListener:blur'],
        'A не коммитнута/отвязана перед mount B');
    assert.deepEqual(toolbarLog, [['detach'], ['attach', b]], 'детач A должен предшествовать attach B');
    assert.equal(EditorRegistry.getActive(), b);
    assert.equal(b.element._hasListener('input'), true);
});

// ── Task 1.3.4-B2: интерактивный capsule-lifecycle (гейт rich+violationField) ──

test('mount: rich violationField-поверхность — ставит capsule-lifecycle (observer, tooltip, beforeinput/keydown/copy)', () => {
    const s = fakeSurface('v1', 'violationField', true);
    EditorController.mount(s);

    assert.deepEqual(capsuleLog[0], ['installCapsuleObserver', s.element]);
    assert.ok(capsuleLog.some((e) => e[0] === 'attachLinkFootnoteHandlers'),
        'attachLinkFootnoteHandlers не вызван');
    assert.equal(s.element._hasListener('beforeinput'), true);
    assert.equal(s.element._hasListener('keydown'), true);
    assert.equal(s.element._hasListener('copy'), true);
});

test('mount: НЕ-violationField поверхность (kind="textblock", rich=true) — capsule-lifecycle НЕ ставится (гейт по kind)', () => {
    const s = fakeSurface('tb1', 'textblock', true);
    EditorController.mount(s);

    assert.deepEqual(capsuleLog, [], 'capsule-lifecycle методы не должны звать не-violationField поверхность');
    assert.equal(s.element._hasListener('beforeinput'), false);
    assert.equal(s.element._hasListener('keydown'), false);
    assert.equal(s.element._hasListener('copy'), false);
});

test('mount: violationField-поверхность БЕЗ rich (rich=false) — capsule-lifecycle НЕ ставится (гейт по rich)', () => {
    const s = fakeSurface('v1', 'violationField', false);
    EditorController.mount(s);

    assert.deepEqual(capsuleLog, [], 'capsule-lifecycle методы не должны звать non-rich поверхность');
    assert.equal(s.element._hasListener('beforeinput'), false);
});

test('unmount: снимает capsule-lifecycle (observer.disconnect + beforeinput/keydown/copy)', () => {
    const s = fakeSurface('v1', 'violationField', true);
    EditorController.mount(s);
    capsuleLog.length = 0; // интересует снятие, не установку

    EditorController.unmount();

    assert.deepEqual(capsuleLog, [['disconnect']]);
    assert.equal(s.element._hasListener('beforeinput'), false);
    assert.equal(s.element._hasListener('keydown'), false);
    assert.equal(s.element._hasListener('copy'), false);
});

test('unmount: НЕ-violationField поверхность — detach не трогает capsule-lifecycle (его и не было)', () => {
    const s = fakeSurface('tb1', 'textblock', true);
    EditorController.mount(s);
    capsuleLog.length = 0;

    assert.doesNotThrow(() => EditorController.unmount());
    assert.deepEqual(capsuleLog, []);
});
