/**
 * Тесты drop-индикатора блоков поля нарушения и «drag только с шапки».
 *
 * dragover/drop висят на КОНТЕЙНЕРЕ поля, а не на обёртках блоков: над зазором
 * между карточками обёртки нет, и без контейнерного preventDefault браузер
 * запрещал там drop. Инварианты:
 *  - перетаскивание разрешено ТОЛЬКО с шапки блока (`armBlockDrag` включает
 *    `draggable` на mousedown по `.content-item-label`, renderBlocks оставляет
 *    его выключенным);
 *  - под курсором обёртка — позиция по половинам с гистерезисом
 *    (MIDDLE_DEAD_BAND_PX): дрожание у середины позицию не переключает, переход
 *    на другой блок пересчитывает её всегда;
 *  - под курсором зазор — ближайшая по вертикали граница вставки;
 *  - позиции вставки «прямо над» и «прямо под» перетаскиваемым блоком ничего не
 *    меняют — индикатор в них не рисуется (но индекс сохраняется, чтобы drop
 *    остался no-op'ом);
 *  - вне активного перетаскивания индикатора не существует вовсе: слежения за
 *    мышью (mousemove) больше нет;
 *  - сам индикатор — ОВЕРЛЕЙ: метка `drop-before`/`drop-after` на обёртке, ни
 *    одного узла в потоке списка (иначе карточки разъезжались бы).
 *
 * DOM фейковый: контейнер отдаёт заранее заданные обёртки с геометрией,
 * updateInsertIndicator/removeInsertIndicators застабены счётчиками вызовов
 * (кроме тестов самого индикатора), requestAnimationFrame — с ручным прогоном
 * кадров (dragover троттлится кадром).
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

/**
 * Событие dragover с курсором на clientY над обёрткой hovered; hovered === null
 * — курсор в зазоре между карточками (обёртки под ним нет).
 */
function dragOverEvent(hovered, clientY) {
    return {
        preventDefault() {},
        dataTransfer: { dropEffect: null, types: ['text/plain', 'application/x-violation-block'] },
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

/** Четыре карточки по 100px с зазором 20px: границы вставки — 0/110/230/350/460. */
function gappedWrappers() {
    return [makeWrapper(0), makeWrapper(120), makeWrapper(240), makeWrapper(360)];
}

test('курсор в зазоре между карточками: позиция — ближайшая граница вставки', () => {
    const wrappers = gappedWrappers();
    const container = makeContainer(wrappers);
    const vm = makeVm(wrappers, 0); // тащим A: no-op позиции — 0 и 1

    // Курсор в зазоре B|C (граница 230) — обёртки под ним нет.
    vm.handleDragOver(dragOverEvent(null, 232), VIOLATION, FIELD, container);
    flushFrames();
    assert.deepEqual(vm._indicatorCalls.at(-1), { type: 'show', position: 2 },
        'ближайший зазор — между B и C');

    // Зазор C|D (граница 350) — соседний, а не тот же самый.
    vm.handleDragOver(dragOverEvent(null, 344), VIOLATION, FIELD, container);
    flushFrames();
    assert.deepEqual(vm._indicatorCalls.at(-1), { type: 'show', position: 3 });

    // Курсор в отступе НИЖЕ последней карточки — вставка в конец.
    vm.handleDragOver(dragOverEvent(null, 600), VIOLATION, FIELD, container);
    flushFrames();
    assert.deepEqual(vm._indicatorCalls.at(-1), { type: 'show', position: 4 });
});

test('курсор в отступе выше первой карточки — вставка в начало', () => {
    const wrappers = gappedWrappers();
    const container = makeContainer(wrappers);
    const vm = makeVm(wrappers, 2); // тащим C: no-op позиции — 2 и 3

    vm.handleDragOver(dragOverEvent(null, -30), VIOLATION, FIELD, container);
    flushFrames();

    assert.deepEqual(vm._indicatorCalls.at(-1), { type: 'show', position: 0 });
});

test('зазор рядом с перетаскиваемым блоком индикатор не рисует', () => {
    const wrappers = gappedWrappers();
    const container = makeContainer(wrappers);
    const vm = makeVm(wrappers, 1); // тащим B

    // Зазор A|B (граница 110) — это позиция 1, там B и так лежит.
    vm.handleDragOver(dragOverEvent(null, 112), VIOLATION, FIELD, container);
    flushFrames();
    assert.deepEqual(vm._indicatorCalls.at(-1), { type: 'hide' });
    assert.equal(vm.lastDragOverIndex, 1, 'индекс сохранён — drop останется no-op');
});

test('без активного перетаскивания индикатор не появляется', () => {
    const wrappers = [makeWrapper(0), makeWrapper(100)];
    const container = makeContainer(wrappers);
    const vm = makeVm(wrappers, 0);
    // Перетаскиваемого блока в документе нет: drag не начинался (mousemove за
    // индикатор больше не отвечает — следить не за чем).
    globalThis.document.querySelector = () => null;

    vm.handleDragOver(dragOverEvent(wrappers[1], 150), VIOLATION, FIELD, container);
    flushFrames();

    assert.deepEqual(vm._indicatorCalls, []);
    assert.equal(vm.lastDragOverIndex, null);
});

test('файловый drag контейнер перестановки не перехватывает', () => {
    const wrappers = [makeWrapper(0), makeWrapper(100)];
    const container = makeContainer(wrappers);
    const vm = makeVm(wrappers, 0);

    const e = dragOverEvent(wrappers[1], 150);
    e.dataTransfer.types = ['Files'];
    vm.handleDragOver(e, VIOLATION, FIELD, container);

    assert.equal(frames.length, 0, 'кадр не планируется — файлы принимает file-upload');
    assert.equal(vm._indicatorCalls.length, 0);
});

// --- Сам индикатор: оверлей, а не узел в потоке ---

/** Обёртка с трекингом классов — для проверок самого индикатора. */
function makeClassWrapper() {
    const classes = new Set();
    return {
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
        },
    };
}

/** Контейнер, запоминающий любые вставленные в него узлы. */
function makeDomContainer(wrappers) {
    const inserted = [];
    return {
        _inserted: inserted,
        appendChild: (node) => inserted.push(node),
        insertBefore: (node) => inserted.push(node),
        querySelectorAll: (selector) => (selector === '.content-item-wrapper' ? wrappers : []),
    };
}

test('индикатор не вставляет узлов в список — помечает границу обёртки', () => {
    const vm = new ViolationManager();
    const wrappers = [makeClassWrapper(), makeClassWrapper(), makeClassWrapper()];
    const container = makeDomContainer(wrappers);

    vm.updateInsertIndicator(container, 1);

    assert.deepEqual(container._inserted, [],
        'ни одного узла в потоке: карточки не должны разъезжаться');
    assert.equal(wrappers[1].classList.contains('drop-before'), true, 'полоска над вторым блоком');
    assert.equal(wrappers[0].classList.contains('drop-after'), false, 'соседа не помечаем');

    // Смена позиции снимает предыдущую метку.
    vm.updateInsertIndicator(container, 0);
    assert.equal(wrappers[1].classList.contains('drop-before'), false);
    assert.equal(wrappers[0].classList.contains('drop-before'), true);
});

test('вставка в конец помечает последнюю обёртку снизу', () => {
    const vm = new ViolationManager();
    const wrappers = [makeClassWrapper(), makeClassWrapper()];
    const container = makeDomContainer(wrappers);

    vm.updateInsertIndicator(container, 2);

    assert.equal(wrappers[1].classList.contains('drop-after'), true);
    assert.equal(wrappers[0].classList.contains('drop-before'), false);
    assert.deepEqual(container._inserted, []);
});

test('в пустом контейнере индикатора нет (подсказка зоны остаётся видимой)', () => {
    const vm = new ViolationManager();
    const container = makeDomContainer([]);

    vm.updateInsertIndicator(container, 0);

    assert.deepEqual(container._inserted, []);
});

test('removeInsertIndicators снимает обе метки со всех обёрток', () => {
    const vm = new ViolationManager();
    const wrappers = [makeClassWrapper(), makeClassWrapper()];
    const container = makeDomContainer(wrappers);
    wrappers[0].classList.add('drop-before');
    wrappers[1].classList.add('drop-after');

    vm.removeInsertIndicators(container);

    assert.equal(wrappers[0].classList.contains('drop-before'), false);
    assert.equal(wrappers[1].classList.contains('drop-after'), false);
});

test('drop досчитывает dragover, кадр которого не успел прийти; поздний кадр молчит', () => {
    const wrappers = [makeWrapper(0), makeWrapper(100), makeWrapper(200)];
    const container = makeContainer(wrappers);
    const vm = makeVm(wrappers, 0);
    vm.renderBlocks = () => {};
    const moved = [];
    vm.moveBlock = (_violation, _fieldKey, from, to) => { moved.push([from, to]); return true; };

    // Курсор в самом низу третьего блока — позиция 3. Кадр НЕ прогоняем: кнопку
    // отпустили раньше ближайшего repaint.
    vm.handleDragOver(dragOverEvent(wrappers[2], 295), VIOLATION, FIELD, container);

    const violation = {
        id: 'v1',
        [FIELD]: { enabled: true, blocks: [{ id: 'X', type: 'text', content: '' }] },
    };
    vm.handleDrop(
        {
            preventDefault() {},
            stopPropagation() {},
            dataTransfer: { getData: () => '', types: ['application/x-violation-block'] },
            clientY: 295,
            target: { closest: () => null },
        },
        violation, FIELD, container,
    );

    assert.deepEqual(moved, [[0, 3]], 'вставка туда, куда указывал курсор, а не на блок под ним');

    const callsAtDrop = vm._indicatorCalls.length;
    flushFrames();
    assert.equal(vm._indicatorCalls.length, callsAtDrop,
        'снимок снят при drop — поздний кадр в перерисованный контейнер не рисует');
});

test('mouseup мимо блока снимает разрешение на drag', () => {
    // Кнопку отпустили за пределами обёртки, drag так и не начался: ни mouseup
    // на обёртке, ни dragend не придут — разоружает одноразовый слушатель
    // документа, иначе следующее протягивание в теле блока утащило бы блок.
    const vm = new ViolationManager();
    const wrapper = { draggable: false };
    const docHandlers = [];
    const origAdd = globalThis.document.addEventListener;
    globalThis.document.addEventListener = (type, handler, options) => {
        if (type === 'mouseup') docHandlers.push({ handler, options });
    };
    try {
        vm.armBlockDrag(mouseDownEvent(true), wrapper);
    } finally { globalThis.document.addEventListener = origAdd; }

    assert.equal(docHandlers.length, 1);
    assert.equal(docHandlers[0].options.once, true, 'слушатель одноразовый — не копится');
    docHandlers[0].handler();
    assert.equal(wrapper.draggable, false);
});

test('нажатие в теле блока слушателя на документ не вешает', () => {
    const vm = new ViolationManager();
    const wrapper = { draggable: false };
    let added = 0;
    const origAdd = globalThis.document.addEventListener;
    globalThis.document.addEventListener = () => { added++; };
    try {
        vm.armBlockDrag(mouseDownEvent(false), wrapper);
    } finally { globalThis.document.addEventListener = origAdd; }

    assert.equal(added, 0);
});
