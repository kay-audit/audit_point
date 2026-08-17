/**
 * Тесты стабильности drop-индикатора и «drag только с шапки» для блоков поля
 * нарушения.
 *
 * Три инварианта dragover (violation-drag-drop.js):
 *  - перетаскивание разрешено ТОЛЬКО с шапки блока (`armBlockDrag` включает
 *    `draggable` на mousedown по `.content-item-label`, renderBlocks оставляет
 *    его выключенным);
 *  - позиции вставки «прямо над» и «прямо под» перетаскиваемым блоком ничего не
 *    меняют — индикатор в них не рисуется (но индекс сохраняется, чтобы drop
 *    остался no-op'ом);
 *  - у середины блока действует гистерезис (MIDDLE_DEAD_BAND_PX) — позиция не
 *    переключается от дрожания курсора; переход на другой блок пересчитывает
 *    позицию всегда.
 *
 * DOM фейковый: контейнер отдаёт заранее заданные обёртки с геометрией,
 * updateInsertIndicator/removeInsertIndicators застабены счётчиками вызовов,
 * requestAnimationFrame — с ручным прогоном кадров (dragover троттлится кадром).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';

const FIELD = 'additionalContent';
const VIOLATION = { id: 'v1' };

// Кадры прогоняем вручную: стаб из _browser-stub.mjs колбэк не вызывает вовсе.
const frames = [];
globalThis.requestAnimationFrame = (cb) => frames.push(cb);

/** Прогоняет все запланированные кадры (dragover считает позицию именно в них). */
function flushFrames() {
    frames.splice(0).forEach((cb) => cb());
}

/** Обёртка блока с геометрией: [top; top+height) по вертикали. */
function makeWrapper(top, height = 100) {
    return {
        draggable: false,
        getBoundingClientRect: () => ({ top, height, bottom: top + height }),
    };
}

/** Контейнер блоков: отдаёт только переданные обёртки. */
function makeContainer(wrappers) {
    return {
        innerHTML: '',
        appendChild() {},
        querySelectorAll: (selector) => (selector === '.content-item-wrapper' ? wrappers : []),
    };
}

/** Событие dragover с курсором на clientY над обёрткой hovered. */
function dragOverEvent(hovered, clientY) {
    return {
        preventDefault() {},
        dataTransfer: { dropEffect: null },
        clientY,
        target: { closest: (selector) => (selector === '.content-item-wrapper' ? hovered : null) },
    };
}

/**
 * VM с застабленным индикатором: `vm._indicatorCalls` — лог вида
 * {type: 'show', position} / {type: 'hide'}.
 *
 * @param {Object[]} wrappers Обёртки блоков в порядке контейнера.
 * @param {number} draggingIndex Индекс перетаскиваемой обёртки.
 */
function makeVm(wrappers, draggingIndex) {
    const vm = new ViolationManager();
    vm._dragPayload = { violationId: VIOLATION.id, fieldKey: FIELD, blockId: 'X' };

    const calls = [];
    vm.updateInsertIndicator = (_container, position) => calls.push({ type: 'show', position });
    vm.removeInsertIndicators = () => calls.push({ type: 'hide' });
    vm._indicatorCalls = calls;

    // handleDragOver ищет перетаскиваемую обёртку по классу .dragging.
    globalThis.document.querySelector = (selector) => (
        selector === '.dragging' ? wrappers[draggingIndex] : null
    );
    return vm;
}

/** Фейковый элемент блока для renderBlocks: копит слушателей по типу события. */
function makeBlockElement() {
    const listeners = {};
    return {
        dataset: {},
        draggable: true, // ловим, что renderBlocks выключает флаг явно
        listeners,
        addEventListener(type, handler) {
            (listeners[type] || (listeners[type] = [])).push(handler);
        },
    };
}

/** Событие mousedown: попало в шапку блока или в его тело. */
function mouseDownEvent(onLabel) {
    return {
        target: { closest: (selector) => (selector === '.content-item-label' && onLabel ? {} : null) },
    };
}

test('перетаскивание вооружается только с шапки блока', () => {
    const vm = new ViolationManager();
    const wrapper = { draggable: false };

    vm.armBlockDrag(mouseDownEvent(true), wrapper);
    assert.equal(wrapper.draggable, true, 'нажатие на шапку разрешает drag');

    vm.armBlockDrag(mouseDownEvent(false), wrapper);
    assert.equal(wrapper.draggable, false, 'нажатие в теле блока drag не начинает');
});

test('renderBlocks оставляет блок неперетаскиваемым до mousedown на шапке', () => {
    const vm = new ViolationManager();
    const element = makeBlockElement();
    vm.createTextBlockElement = () => element;

    const violation = {
        id: 'v1',
        [FIELD]: { enabled: true, blocks: [{ id: 'A', type: 'text', content: 'A' }] },
    };
    vm.renderBlocks(violation, FIELD, makeContainer([]), false);

    assert.equal(element.draggable, false, 'по умолчанию drag выключен');
    assert.equal(element.listeners.mousedown?.length, 1, 'слушатель шапки навешен');

    // Тело блока: drag не включается — значит dragstart невозможен.
    element.listeners.mousedown[0](mouseDownEvent(false));
    assert.equal(element.draggable, false);

    // Шапка: drag включается.
    element.listeners.mousedown[0](mouseDownEvent(true));
    assert.equal(element.draggable, true);

    // mouseup возвращает исходное состояние.
    element.listeners.mouseup[0]();
    assert.equal(element.draggable, false);
});

test('dragEnd снимает разрешение на drag', () => {
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};
    const wrapper = { draggable: true, classList: { remove() {} } };

    vm.handleDragEnd(
        { target: wrapper, currentTarget: wrapper },
        { id: 'v1', [FIELD]: { enabled: true, blocks: [] } },
        FIELD,
        makeContainer([]),
    );

    assert.equal(wrapper.draggable, false);
    assert.equal(vm.lastDragOverIndex, null);
    assert.equal(vm._lastDragOverElement, null);
});

test('dragover троттлится кадром: серия событий считается один раз, по последнему', () => {
    const wrappers = [makeWrapper(0), makeWrapper(100), makeWrapper(200)];
    const vm = makeVm(wrappers, 0); // тащим A

    // Три события в одном кадре: 210 (верх C), 260 (низ C), 240 (снова верх C).
    vm.handleDragOver(dragOverEvent(wrappers[2], 210), VIOLATION, FIELD, makeContainer(wrappers));
    vm.handleDragOver(dragOverEvent(wrappers[2], 260), VIOLATION, FIELD, makeContainer(wrappers));
    vm.handleDragOver(dragOverEvent(wrappers[2], 240), VIOLATION, FIELD, makeContainer(wrappers));

    assert.equal(vm._indicatorCalls.length, 0, 'до кадра индикатор не трогаем');
    assert.equal(frames.length, 1, 'на серию событий — один запланированный кадр');

    flushFrames();

    assert.deepEqual(vm._indicatorCalls, [{ type: 'show', position: 2 }],
        'учтён только последний dragover (240 — верхняя половина C)');
    assert.equal(vm.lastDragOverIndex, 2);
});

test('dragover чужого поля кадр не планирует', () => {
    const wrappers = [makeWrapper(0), makeWrapper(100)];
    const vm = makeVm(wrappers, 0);
    vm._dragPayload = { violationId: 'v1', fieldKey: 'reasons', blockId: 'R1' };

    vm.handleDragOver(dragOverEvent(wrappers[1], 150), VIOLATION, FIELD, makeContainer(wrappers));

    assert.equal(frames.length, 0);
    assert.equal(vm._indicatorCalls.length, 0);
});

test('no-op позиции (над и под перетаскиваемым блоком) индикатор не показывают', () => {
    const wrappers = [makeWrapper(0), makeWrapper(100), makeWrapper(200)];
    const container = makeContainer(wrappers);
    const vm = makeVm(wrappers, 1); // тащим B (индекс 1)

    // Низ A → позиция 1 (между A и B) = там, где B и так лежит.
    vm.handleDragOver(dragOverEvent(wrappers[0], 80), VIOLATION, FIELD, container);
    flushFrames();
    assert.deepEqual(vm._indicatorCalls, [{ type: 'hide' }], 'полоска над B не рисуется');
    assert.equal(vm.lastDragOverIndex, 1, 'индекс сохранён — drop останется no-op');

    // Верх C → позиция 2 (между B и C) = снова исходное место B.
    vm.handleDragOver(dragOverEvent(wrappers[2], 210), VIOLATION, FIELD, container);
    flushFrames();
    assert.deepEqual(vm._indicatorCalls, [{ type: 'hide' }, { type: 'hide' }],
        'полоска под B не рисуется');
    assert.equal(vm.lastDragOverIndex, 2);

    // Низ C → позиция 3: перестановка реальная, индикатор нужен.
    vm.handleDragOver(dragOverEvent(wrappers[2], 290), VIOLATION, FIELD, container);
    flushFrames();
    assert.deepEqual(vm._indicatorCalls.at(-1), { type: 'show', position: 3 });
});

test('гистерезис: у середины блока позиция не переключается, дальше мёртвой зоны — переключается', () => {
    const wrappers = [makeWrapper(0), makeWrapper(100), makeWrapper(200)];
    const container = makeContainer(wrappers);
    const vm = makeVm(wrappers, 0); // тащим A, середина C = 250

    // Низ C, далеко от середины → позиция 3.
    vm.handleDragOver(dragOverEvent(wrappers[2], 295), VIOLATION, FIELD, container);
    flushFrames();
    assert.deepEqual(vm._indicatorCalls, [{ type: 'show', position: 3 }]);

    // Курсор перешёл середину, но всего на 5px — в мёртвой зоне, держим 3.
    vm.handleDragOver(dragOverEvent(wrappers[2], 245), VIOLATION, FIELD, container);
    flushFrames();
    assert.equal(vm._indicatorCalls.length, 1, 'внутри мёртвой зоны индикатор не двигается');
    assert.equal(vm.lastDragOverIndex, 3);

    // Ушёл от середины на 20px (> 12) — позиция переключается.
    vm.handleDragOver(dragOverEvent(wrappers[2], 230), VIOLATION, FIELD, container);
    flushFrames();
    assert.deepEqual(vm._indicatorCalls.at(-1), { type: 'show', position: 2 });
});

test('гистерезис не мешает переходу на другой блок', () => {
    const wrappers = [makeWrapper(0), makeWrapper(100), makeWrapper(200), makeWrapper(300)];
    const container = makeContainer(wrappers);
    const vm = makeVm(wrappers, 0); // тащим A

    // Низ третьего блока → позиция 3.
    vm.handleDragOver(dragOverEvent(wrappers[2], 295), VIOLATION, FIELD, container);
    flushFrames();
    assert.equal(vm.lastDragOverIndex, 3);

    // Четвёртый блок, курсор в 5px под его серединой (350): мёртвая зона, но
    // блок другой — позиция пересчитывается.
    vm.handleDragOver(dragOverEvent(wrappers[3], 355), VIOLATION, FIELD, container);
    flushFrames();
    assert.deepEqual(vm._indicatorCalls.at(-1), { type: 'show', position: 4 });
});

test('кадр, пришедший после drop, индикатор не дорисовывает', () => {
    const wrappers = [makeWrapper(0), makeWrapper(100), makeWrapper(200)];
    const container = makeContainer(wrappers);
    const vm = makeVm(wrappers, 0);
    vm.renderBlocks = () => {};
    vm.moveBlock = () => true;

    vm.handleDragOver(dragOverEvent(wrappers[2], 295), VIOLATION, FIELD, container);

    const violation = {
        id: 'v1',
        [FIELD]: { enabled: true, blocks: [{ id: 'X', type: 'text', content: '' }] },
    };
    vm.handleDrop(
        {
            preventDefault() {},
            stopPropagation() {},
            dataTransfer: { getData: () => '' },
        },
        violation, FIELD, 2, container,
    );

    flushFrames();

    assert.equal(vm._indicatorCalls.length, 0, 'снимок dragover снят при drop');
});
