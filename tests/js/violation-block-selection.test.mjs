/**
 * Мультивыделение блоков поля нарушения: состояние (violation-block-selection.js)
 * и его проводка на ViolationManager (violation-blocks.js).
 *
 * Инварианты, которые здесь закреплены:
 *  - клик по ШАПКЕ выделяет блок, Ctrl — toggle, Shift — диапазон от якоря
 *    (якорь двигают только клики без Shift);
 *  - выделение живёт строго в пределах пары (violationId, fieldKey): клик по
 *    шапке блока другого поля начинает выделение там с нуля;
 *  - сбрасывает выделение всё, кроме шапки блока: тело блока, пустое место,
 *    вставка контента, Escape;
 *  - выделение адресуется id, а НЕ DOM-ссылками: renderBlocks всегда
 *    пересоздаёт обёртки, и подсветка восстанавливается по id, а id
 *    исчезнувших блоков вычищаются (иначе групповое удаление промахнётся);
 *  - состояние живёт на менеджере, а не в AppState — Proxy состояния пометил
 *    бы акт несохранённым от простого клика.
 *
 * DOM фейковый: обёртки с dataset/classList и цепочкой closest, document
 * отвечает на два селектора, которыми пользуется проводка.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { EscapeStack } from '../../static/js/shared/escape-stack.js';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import { BlockSelection, pluralizeBlocks } from '../../static/js/constructor/violation/violation-block-selection.js';
import { BLOCK_TYPES } from '../../static/js/constructor/violation/violation-block-types.js';

// Превью не рисуем.
PreviewManager.updateBlock = () => {};

const FIELD = 'additionalContent';
const OTHER_FIELD = 'reasons';

/** Все обёртки всех полей текущего теста — по ним отвечает document. */
let allWrappers = [];
let allFields = [];

/** Обёртка блока: dataset + classList + цепочка closest (label → wrapper → items). */
function makeWrapper(blockId, items) {
    const classes = new Set();
    const wrapper = {
        dataset: { blockId },
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
        },
    };
    wrapper.closest = (sel) => (sel === '.violation-blocks-items' ? items : null);
    wrapper.label = { closest: (sel) => (sel === '.content-item-wrapper' ? wrapper : null) };
    return wrapper;
}

/** Поле с блоками: контейнер `.violation-blocks-items` + обёртки. */
function makeField(violationId, fieldKey, ids) {
    const wrappers = [];
    const items = {
        dataset: { violationId, fieldKey },
        querySelectorAll: (sel) => (sel === '.content-item-wrapper' ? wrappers : []),
    };
    ids.forEach((id) => wrappers.push(makeWrapper(id, items)));
    const field = { items, wrappers, violationId, fieldKey };
    allFields.push(field);
    allWrappers.push(...wrappers);
    return field;
}

/** Нарушение с блоками в двух полях. */
function makeViolation(idsMain, idsOther = []) {
    const blocks = (ids) => ids.map(id => ({ id, type: BLOCK_TYPES.TEXT, content: id }));
    return {
        id: 'v1',
        [FIELD]: { enabled: true, blocks: blocks(idsMain) },
        [OTHER_FIELD]: { enabled: true, blocks: blocks(idsOther) },
    };
}

/** Клик по шапке блока (объект события: target + модификаторы). */
function labelClick(field, index, modifiers = {}) {
    const wrapper = field.wrappers[index];
    return {
        button: 0,
        target: { closest: (sel) => (sel === '.content-item-label' ? wrapper.label : null) },
        ...modifiers,
    };
}

/** Клик мимо шапки (тело блока, тулбар, пустое место). */
function outsideClick() {
    return { button: 0, target: { closest: () => null } };
}

/** Свежий менеджер + document, отвечающий на селекторы проводки. */
function makeVm(violation) {
    allWrappers = [];
    allFields = [];
    AppConfig.readOnlyMode.isReadOnly = false;
    while (EscapeStack.size() > 0) EscapeStack._stack.pop();

    const vm = new ViolationManager();
    vm.renderBlocks = () => {};
    vm._teardownActiveRichField = () => {};
    if (violation) vm.activeViolations.set(violation.id, violation);

    globalThis.document.querySelectorAll = (sel) => (
        sel === '.content-item-wrapper.block-selected'
            ? allWrappers.filter(w => w.classList.contains('block-selected'))
            : []
    );
    globalThis.document.querySelector = (sel) => {
        const match = /data-violation-id="([^"]+)".*data-field-key="([^"]+)"/.exec(sel);
        if (!match) return null;
        const found = allFields.find(
            f => f.violationId === match[1] && f.fieldKey === match[2]);
        return found ? found.items : null;
    };
    return vm;
}

/** id блоков с классом выделения (в порядке обёрток поля). */
const highlighted = (field) => field.wrappers
    .filter(w => w.classList.contains('block-selected'))
    .map(w => w.dataset.blockId);

// ── Чистое состояние ─────────────────────────────────────────────────────────

test('applyClick: обычный клик — единичное выделение и якорь на нём', () => {
    const selection = new BlockSelection();
    selection.applyClick('v1', FIELD, 'B', {}, ['A', 'B', 'C']);

    assert.deepEqual([...selection.ids], ['B']);
    assert.equal(selection.anchorId, 'B');
    assert.equal(selection.isSelected('v1', FIELD, 'B'), true);
    assert.equal(selection.isSelected('v1', OTHER_FIELD, 'B'), false, 'чужое поле — не выделено');
});

test('applyClick: Ctrl добавляет и снимает блок, последний Ctrl очищает адрес поля', () => {
    const selection = new BlockSelection();
    const ids = ['A', 'B', 'C'];

    selection.applyClick('v1', FIELD, 'A', {}, ids);
    selection.applyClick('v1', FIELD, 'C', { ctrlKey: true }, ids);
    assert.deepEqual([...selection.ids].sort(), ['A', 'C']);

    selection.applyClick('v1', FIELD, 'A', { ctrlKey: true }, ids);
    assert.deepEqual([...selection.ids], ['C'], 'повторный Ctrl снимает блок');

    selection.applyClick('v1', FIELD, 'C', { ctrlKey: true }, ids);
    assert.equal(selection.isEmpty(), true);
    assert.equal(selection.violationId, null, 'опустевшее выделение адрес поля не держит');
});

test('applyClick: Shift выделяет диапазон от якоря, сам якорь не двигает', () => {
    const selection = new BlockSelection();
    const ids = ['A', 'B', 'C', 'D', 'E'];

    selection.applyClick('v1', FIELD, 'B', {}, ids);
    selection.applyClick('v1', FIELD, 'D', { shiftKey: true }, ids);
    assert.deepEqual([...selection.ids], ['B', 'C', 'D']);
    assert.equal(selection.anchorId, 'B', 'якорь остался на первом клике');

    // Второй Shift сужает полосу от того же якоря, а не наращивает прежнюю.
    selection.applyClick('v1', FIELD, 'C', { shiftKey: true }, ids);
    assert.deepEqual([...selection.ids], ['B', 'C']);

    // Диапазон работает и вверх от якоря.
    selection.applyClick('v1', FIELD, 'A', { shiftKey: true }, ids);
    assert.deepEqual([...selection.ids], ['A', 'B']);
});

test('applyClick: клик в другое поле начинает выделение там, модификаторы игнорируются', () => {
    const selection = new BlockSelection();
    selection.applyClick('v1', FIELD, 'A', {}, ['A', 'B']);
    selection.applyClick('v1', OTHER_FIELD, 'R2', { ctrlKey: true }, ['R1', 'R2']);

    assert.equal(selection.fieldKey, OTHER_FIELD);
    assert.deepEqual([...selection.ids], ['R2'], 'Ctrl не дополняет выделение чужого поля');
    assert.deepEqual(selection.idsInOrder('v1', FIELD, ['A', 'B']), [], 'прежнее поле пусто');
});

test('prune: id исчезнувших блоков вычищаются, пустое выделение сбрасывается', () => {
    const selection = new BlockSelection();
    selection.applyClick('v1', FIELD, 'A', {}, ['A', 'B', 'C']);
    selection.applyClick('v1', FIELD, 'C', { ctrlKey: true }, ['A', 'B', 'C']);

    assert.equal(selection.prune('v1', FIELD, ['A', 'B']), true, 'C исчез — состав изменился');
    assert.deepEqual([...selection.ids], ['A']);

    assert.equal(selection.prune('v1', OTHER_FIELD, []), false, 'чужое поле не трогаем');
    assert.deepEqual([...selection.ids], ['A']);

    selection.prune('v1', FIELD, []);
    assert.equal(selection.isEmpty(), true);
    assert.equal(selection.fieldKey, null);
});

test('idsInOrder отдаёт выделенное В ПОРЯДКЕ ПОЛЯ, а не в порядке кликов', () => {
    const selection = new BlockSelection();
    const ids = ['A', 'B', 'C', 'D'];
    selection.applyClick('v1', FIELD, 'D', {}, ids);
    selection.applyClick('v1', FIELD, 'B', { ctrlKey: true }, ids);

    assert.deepEqual(selection.idsInOrder('v1', FIELD, ids), ['B', 'D']);
});

test('pluralizeBlocks: 1 блок / 2 блока / 5 блоков / 11 блоков', () => {
    assert.equal(pluralizeBlocks(1), 'блок');
    assert.equal(pluralizeBlocks(3), 'блока');
    assert.equal(pluralizeBlocks(5), 'блоков');
    assert.equal(pluralizeBlocks(11), 'блоков');
    assert.equal(pluralizeBlocks(21), 'блок');
});

// ── Проводка: клики по шапке ─────────────────────────────────────────────────

test('клик по шапке выделяет блок и подсвечивает его обёртку', () => {
    const violation = makeViolation(['A', 'B', 'C']);
    const vm = makeVm(violation);
    const field = makeField('v1', FIELD, ['A', 'B', 'C']);

    vm._handleBlockSelectionClick(labelClick(field, 1));

    assert.deepEqual(highlighted(field), ['B']);
    assert.equal(vm.blockSelection.size(), 1);
});

test('Ctrl+клик набирает несмежную пачку, Shift+клик — диапазон', () => {
    const violation = makeViolation(['A', 'B', 'C', 'D']);
    const vm = makeVm(violation);
    const field = makeField('v1', FIELD, ['A', 'B', 'C', 'D']);

    vm._handleBlockSelectionClick(labelClick(field, 0));
    vm._handleBlockSelectionClick(labelClick(field, 2, { ctrlKey: true }));
    assert.deepEqual(highlighted(field), ['A', 'C']);

    vm._handleBlockSelectionClick(labelClick(field, 0));
    vm._handleBlockSelectionClick(labelClick(field, 2, { shiftKey: true }));
    assert.deepEqual(highlighted(field), ['A', 'B', 'C']);
});

test('клик по шапке другого поля переносит выделение и гасит подсветку прежнего', () => {
    const violation = makeViolation(['A', 'B'], ['R1', 'R2']);
    const vm = makeVm(violation);
    const main = makeField('v1', FIELD, ['A', 'B']);
    const other = makeField('v1', OTHER_FIELD, ['R1', 'R2']);

    vm._handleBlockSelectionClick(labelClick(main, 0));
    vm._handleBlockSelectionClick(labelClick(other, 1));

    assert.deepEqual(highlighted(main), [], 'подсветка прежнего поля снята');
    assert.deepEqual(highlighted(other), ['R2']);
    assert.equal(vm.blockSelection.fieldKey, OTHER_FIELD);
});

test('клик мимо шапки снимает выделение', () => {
    const violation = makeViolation(['A', 'B']);
    const vm = makeVm(violation);
    const field = makeField('v1', FIELD, ['A', 'B']);

    vm._handleBlockSelectionClick(labelClick(field, 0));
    vm._handleBlockSelectionClick(outsideClick());

    assert.equal(vm.blockSelection.isEmpty(), true);
    assert.deepEqual(highlighted(field), []);
});

test('ПКМ (button !== 0) выделение не трогает — у него своя политика', () => {
    const violation = makeViolation(['A', 'B']);
    const vm = makeVm(violation);
    const field = makeField('v1', FIELD, ['A', 'B']);

    vm._handleBlockSelectionClick(labelClick(field, 0));
    vm._handleBlockSelectionClick({ button: 2, target: { closest: () => null } });

    assert.deepEqual(highlighted(field), ['A'], 'правая кнопка выделение не сбросила');
});

test('режим просмотра: клик по шапке не выделяет', () => {
    const violation = makeViolation(['A', 'B']);
    const vm = makeVm(violation);
    const field = makeField('v1', FIELD, ['A', 'B']);

    AppConfig.readOnlyMode.isReadOnly = true;
    try {
        vm._handleBlockSelectionClick(labelClick(field, 0));
    } finally {
        AppConfig.readOnlyMode.isReadOnly = false;
    }

    assert.equal(vm.blockSelection.isEmpty(), true);
    assert.deepEqual(highlighted(field), []);
});

// ── Escape ───────────────────────────────────────────────────────────────────

test('Escape: слой живёт только при непустом выделении и снимает его', () => {
    const violation = makeViolation(['A', 'B']);
    const vm = makeVm(violation);
    const field = makeField('v1', FIELD, ['A', 'B']);

    assert.equal(EscapeStack.size(), 0, 'без выделения слоя в стеке нет');

    vm._handleBlockSelectionClick(labelClick(field, 0));
    assert.equal(EscapeStack.size(), 1, 'выделение положило слой поверх стека');

    const top = EscapeStack._stack[EscapeStack._stack.length - 1];
    const verdict = top({ key: 'Escape' });

    assert.notEqual(verdict, EscapeStack.PASS, 'событие съедено — ESC принадлежал выделению');
    assert.equal(vm.blockSelection.isEmpty(), true);
    assert.deepEqual(highlighted(field), []);
    assert.equal(EscapeStack.size(), 0, 'слой снят вместе с выделением');
});

test('Escape при пустом выделении отдаёт событие ниже (сентинел PASS)', () => {
    const vm = makeVm(makeViolation(['A']));
    const field = makeField('v1', FIELD, ['A']);

    vm._handleBlockSelectionClick(labelClick(field, 0));
    const top = EscapeStack._stack[EscapeStack._stack.length - 1];
    vm.blockSelection.clear(); // состояние очищено в обход clearBlockSelection

    assert.equal(top({ key: 'Escape' }), EscapeStack.PASS);
});

// ── Перерисовка и вставка ────────────────────────────────────────────────────

test('после перерисовки подсветка восстанавливается по id на НОВЫХ обёртках', () => {
    const violation = makeViolation(['A', 'B', 'C']);
    const vm = makeVm(violation);
    const field = makeField('v1', FIELD, ['A', 'B', 'C']);

    vm._handleBlockSelectionClick(labelClick(field, 0));
    vm._handleBlockSelectionClick(labelClick(field, 2, { ctrlKey: true }));

    // renderBlocks выбрасывает прежние обёртки целиком (innerHTML = '').
    const rerendered = makeField('v1', FIELD, ['A', 'B', 'C']);
    vm._syncBlockSelectionClasses(violation, FIELD, rerendered.items);

    assert.deepEqual(highlighted(rerendered), ['A', 'C']);
});

test('перерисовка вычищает id блоков, которых в поле больше нет', () => {
    const violation = makeViolation(['A', 'B', 'C']);
    const vm = makeVm(violation);
    const field = makeField('v1', FIELD, ['A', 'B', 'C']);

    vm._handleBlockSelectionClick(labelClick(field, 1));
    vm._handleBlockSelectionClick(labelClick(field, 2, { ctrlKey: true }));

    // B удалён мимо выделения (например, откатом версии).
    violation[FIELD].blocks = violation[FIELD].blocks.filter(b => b.id !== 'B');
    const rerendered = makeField('v1', FIELD, ['A', 'C']);
    vm._syncBlockSelectionClasses(violation, FIELD, rerendered.items);

    assert.deepEqual([...vm.blockSelection.ids], ['C'], 'мёртвый id забыт');
    assert.deepEqual(highlighted(rerendered), ['C']);
});

test('renderBlocks зовёт восстановление подсветки', () => {
    const violation = makeViolation([]);
    const vm = makeVm(violation);
    const calls = [];
    vm._syncBlockSelectionClasses = (v, key) => calls.push([v.id, key]);
    delete vm.renderBlocks; // возвращаем настоящий renderBlocks из прототипа

    vm.renderBlocks(violation, FIELD, { innerHTML: '', appendChild() {} }, false);

    assert.deepEqual(calls, [['v1', FIELD]]);
});

test('вставка блока снимает выделение (единая точка _insertBlocksBulk)', () => {
    const violation = makeViolation(['A', 'B']);
    const vm = makeVm(violation);
    const field = makeField('v1', FIELD, ['A', 'B']);
    const contentContainer = {
        querySelector: (sel) => (sel === '.violation-blocks-items' ? field.items : null),
    };

    vm._handleBlockSelectionClick(labelClick(field, 0));
    assert.equal(vm.blockSelection.size(), 1);

    vm.addBlockAtPosition(violation, FIELD, BLOCK_TYPES.TEXT, contentContainer, 2);

    assert.equal(vm.blockSelection.isEmpty(), true, 'вставка сбросила выделение');
    assert.deepEqual(highlighted(field), []);
});

test('destroy и removeViolation сбрасывают выделение', () => {
    const violation = makeViolation(['A']);
    const vm = makeVm(violation);
    const field = makeField('v1', FIELD, ['A']);

    vm._handleBlockSelectionClick(labelClick(field, 0));
    vm.removeViolation('v1');
    assert.equal(vm.blockSelection.isEmpty(), true);
    assert.equal(EscapeStack.size(), 0);

    const vm2 = makeVm(violation);
    const field2 = makeField('v1', FIELD, ['A']);
    vm2._handleBlockSelectionClick(labelClick(field2, 0));
    vm2.destroy();
    assert.equal(vm2.blockSelection.isEmpty(), true);
    assert.equal(EscapeStack.size(), 0);
});
