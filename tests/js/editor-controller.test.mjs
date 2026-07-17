/**
 * Task 1.3.1: перемонтируемый контроллер активной поверхности редактора
 * (EditorController.mount/unmount). textBlockManager.attachToolbarTo/
 * detachToolbar застаблены no-op-спаями на импортированном singleton —
 * тестируем врезку контроллера (реестр + слушатели + порядок), не реальный
 * DOM-тулбар (тот требует document.getElementById('globalTextBlockToolbar')
 * и т.п., см. textblock-toolbar.js).
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EditorController } from '../../static/js/constructor/textblock/editor-controller.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';

let toolbarLog;

/**
 * Фейковая поверхность: element с рабочими add/removeEventListener (хранят
 * обработчик и позволяют его дёрнуть через _fire) + commit-спай, пишущий в
 * общий с removeEventListener лог surface.log — так проверяется ПОРЯДОК
 * (commit ДО removeEventListener) внутри unmount.
 */
function fakeSurface(id, kind = 'violationField') {
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
    return { kind, id, log, element, commit() { log.push('commit'); } };
}

beforeEach(() => {
    EditorController.unmount(); // сброс возможного «хвоста» предыдущего теста
    EditorRegistry.clear();
    toolbarLog = [];
    textBlockManager.attachToolbarTo = (surface) => toolbarLog.push(['attach', surface]);
    textBlockManager.detachToolbar = () => toolbarLog.push(['detach']);
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
