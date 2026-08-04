/**
 * Тесты guard'а legacy-обработчиков ESC при активном EscapeStack (§5.9).
 *
 * Снятие выделения узла дерева (tree-core) и снятие выделения ячеек таблицы
 * (table-core) — document-listener'ы в bubbling, написанные ДО централизации ESC
 * в стеке. Пока стек глушил событие безусловно, они молчали при любом открытом
 * слое. С появлением отказа (слой зоны нарушений отдаёт ESC редактору, когда
 * каретка в поле) пропущенное событие стало доходить до них: Escape, адресованный
 * редактору, незаметно стирал выделение дерева и ячеек. Guard — EscapeStack.isActive().
 *
 * Модель цепочки в тестах повторяет браузерную: listener стека висит на document
 * в capture-фазе (идёт первым), legacy-обработчики — в bubbling, и до них событие
 * доходит, только если стек не позвал stopImmediatePropagation.
 *
 * Файл НЕ использует _browser-stub целиком: tree-core на module-level создаёт
 * TreeManager('tree'), которому нужны document.getElementById → элемент и
 * MutationObserver, а document.addEventListener должен записывать слушателей.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Минимальный DOM-элемент под нужды TreeManager/TableManager. */
function makeStubElement(id = '') {
    return {
        id,
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        removeChild() {},
        remove() {},
        setAttribute() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        contains: () => false,
        textContent: '',
        innerHTML: '',
    };
}

// Записываем document-слушатели keydown: их ставят оба legacy-обработчика.
const keydownListeners = [];

globalThis.window = globalThis;
globalThis.document = {
    createElement: () => makeStubElement(),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    addEventListener(type, cb) { if (type === 'keydown') keydownListeners.push(cb); },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: (id) => makeStubElement(id),
    body: makeStubElement('body'),
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
};

const { EscapeStack } = await import('../../static/js/shared/escape-stack.js');
// Оба singleton'а создаются на module-level и там же ставят свои document-listener'ы.
// Порядок импорта роли не играет: граф tree-core сам тянет table-core.
const { treeManager } = await import('../../static/js/constructor/tree/tree-core.js');
const { tableManager } = await import('../../static/js/constructor/table/table-core.js');

/** Слушатели legacy-обработчиков (всё, что зарегистрировано при импорте модулей). */
const legacyListeners = keydownListeners.slice();

// Свой listener EscapeStack ставит лениво — при первом push.
EscapeStack.push(() => {})();
const stackListener = keydownListeners[legacyListeners.length];

function drainStack() {
    while (EscapeStack.size() > 0) EscapeStack._stack.pop();
}

/**
 * Полная цепочка ESC: стек (capture) → legacy-обработчики (bubbling), если
 * событие не заглушено. Считает снятия выделения дерева и ячеек.
 * @returns {{tree: number, table: number, stopped: boolean}}
 */
function dispatchEscape() {
    let tree = 0;
    let table = 0;
    let stopped = false;
    const origTree = treeManager.clearSelection;
    const origTable = tableManager.clearSelection;
    treeManager.clearSelection = () => { tree += 1; };
    tableManager.clearSelection = () => { table += 1; };
    try {
        const e = { key: 'Escape', stopImmediatePropagation() { stopped = true; } };
        stackListener(e);
        if (!stopped) legacyListeners.forEach((l) => l(e));
    } finally {
        treeManager.clearSelection = origTree;
        tableManager.clearSelection = origTable;
    }
    return { tree, table, stopped };
}

test('legacy-обработчики ESC зарегистрированы (иначе тесты ниже ничего не проверяют)', () => {
    assert.equal(legacyListeners.length, 2, 'по одному document-listener keydown у дерева и таблиц');
    assert.equal(typeof stackListener, 'function', 'listener EscapeStack перехвачен');
});

test('стек пуст → ESC снимает выделение дерева и ячеек (прежнее поведение)', () => {
    drainStack();
    treeManager.editingElement = null;

    assert.deepEqual(dispatchEscape(), { tree: 1, table: 1, stopped: false });
});

test('все слои отказались → событие уходит в DOM, но выделение не стирается', () => {
    drainStack();
    treeManager.editingElement = null;
    // Слой зоны нарушений при каретке в поле: ESC принадлежит редактору.
    const unsub = EscapeStack.push(() => EscapeStack.PASS);

    const { tree, table, stopped } = dispatchEscape();

    assert.equal(stopped, false, 'стек не глушит событие — редактор его получит');
    assert.deepEqual([tree, table], [0, 0], 'выделение дерева и ячеек цело');

    unsub();
    assert.deepEqual(dispatchEscape(), { tree: 1, table: 1, stopped: false }, 'слой снят — поведение вернулось');
});

test('каскад: ESC сквозь отказавшийся слой закрывает панель поиска, выделение цело', () => {
    drainStack();
    treeManager.editingElement = null;
    let findBarClosed = 0;
    EscapeStack.push(() => { findBarClosed += 1; });            // панель поиска — ниже
    EscapeStack.push(() => EscapeStack.PASS);                    // зона нарушений — выше

    const { tree, table, stopped } = dispatchEscape();

    assert.equal(findBarClosed, 1, 'каскад дошёл до нижнего слоя');
    assert.equal(stopped, true, 'панель поиска съела событие');
    assert.deepEqual([tree, table], [0, 0], 'выделение дерева и ячеек не тронуто');
});

test('редактирование заголовка узла по-прежнему блокирует снятие выделения дерева', () => {
    drainStack();
    treeManager.editingElement = makeStubElement('editing');

    assert.equal(dispatchEscape().tree, 0);

    treeManager.editingElement = null;
});
