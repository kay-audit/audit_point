/**
 * Групповые операции над выделенными блоками поля нарушения: перестановка
 * пачки (moveBlocks + planBlocksReorder), групповое удаление (removeBlocks →
 * removeSelectedBlocks) и точки входа — контекстное меню, клавиша Delete,
 * dragstart за шапку.
 *
 * Инварианты:
 *  - пачка встаёт НЕПРЕРЫВНЫМ прогоном в исходном относительном порядке, даже
 *    если набор был несмежным; позиция вставки корректируется на число
 *    переносимых блоков ЛЕВЕЕ неё (одиночный блок вниз — классическое «-1»);
 *  - честный no-op: если итоговый порядок совпадает с исходным, мутатор
 *    отказывает — ни записи, ни превью, ни коммита drop'а;
 *  - групповое удаление — одна перерисовка и одно превью на пачку, при ≥2
 *    блоках обязателен диалог подтверждения (undo в конструкторе нет);
 *  - Delete в редактируемом контексте принадлежит редактору (isEditableTarget);
 *  - dragstart за шапку невыделенного блока схлопывает выделение на него.
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { DialogManager } from '../../static/js/shared/dialog/dialog-confirm.js';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import {
    violationMutations as mutations,
    planBlocksReorder,
} from '../../static/js/constructor/violation/violation-mutations.js';
import { ViolationContextMenu } from '../../static/js/constructor/context-menu/context-menu-violation.js';
import { BLOCK_TYPES } from '../../static/js/constructor/violation/violation-block-types.js';

let previewCalls = 0;
PreviewManager.updateBlock = () => { previewCalls += 1; };

// Счётчики общие на файл — чистим перед каждым тестом (мутаторные тесты идут
// без makeVm, который делает то же самое).
beforeEach(() => {
    previewCalls = 0;
    AppConfig.readOnlyMode.isReadOnly = false;
});

const FIELD = 'additionalContent';

/** Нарушение с блоками из массива id. */
function makeViolation(ids) {
    return {
        id: 'v1',
        [FIELD]: {
            enabled: true,
            blocks: ids.map(id => ({ id, type: BLOCK_TYPES.TEXT, content: id })),
        },
    };
}

const blockIds = (violation) => violation[FIELD].blocks.map(b => b.id);

/** Менеджер со счётчиками перерисовки и снятого rich-контроллера. */
function makeVm(violation) {
    previewCalls = 0;
    AppConfig.readOnlyMode.isReadOnly = false;

    const vm = new ViolationManager();
    vm._renderCalls = 0;
    vm._teardownCalls = 0;
    vm.renderBlocks = () => { vm._renderCalls += 1; };
    vm._teardownActiveRichField = () => { vm._teardownCalls += 1; };
    if (violation) vm.activeViolations.set(violation.id, violation);
    globalThis.document.querySelector = () => null;
    globalThis.document.querySelectorAll = () => [];
    return vm;
}

/** Контейнер содержимого поля с контейнером блоков внутри. */
function makeContentContainer() {
    const items = { querySelectorAll: () => [] };
    return { querySelector: (sel) => (sel === '.violation-blocks-items' ? items : null) };
}

// ── planBlocksReorder: чистая арифметика позиции вставки ─────────────────────

test('planBlocksReorder: одиночный блок вниз — та же поправка, что и раньше', () => {
    // ABCD, тащим A (индекс 0) на позицию 3 → BCAD.
    assert.deepEqual(planBlocksReorder(4, [0], 3), [1, 2, 0, 3]);
});

test('planBlocksReorder: позиции «над собой» и «под собой» — no-op (null)', () => {
    assert.equal(planBlocksReorder(3, [0], 0), null);
    assert.equal(planBlocksReorder(3, [0], 1), null);
});

test('planBlocksReorder: пачка внутри уже смежного прогона — no-op', () => {
    // Блоки 1 и 2 смежны; вставка в зазор между ними ничего не меняет.
    assert.equal(planBlocksReorder(4, [1, 2], 2), null);
    assert.equal(planBlocksReorder(4, [1, 2], 1), null);
    assert.equal(planBlocksReorder(4, [1, 2], 3), null);
});

test('planBlocksReorder: переносить нечего — null', () => {
    assert.equal(planBlocksReorder(3, [], 1), null);
    assert.equal(planBlocksReorder(3, [7], 1), null, 'индексы вне массива отброшены');
});

// ── moveBlocks: пачка ────────────────────────────────────────────────────────

test('moveBlocks: несмежная пачка встаёт прогоном в исходном порядке', () => {
    const violation = makeViolation(['A', 'B', 'C', 'D', 'E']);

    // Выбраны A и C, вставка перед E (позиция 4 в исходном массиве).
    assert.equal(mutations.moveBlocks.call({}, violation, FIELD, ['C', 'A'], 4), true);

    assert.deepEqual(blockIds(violation), ['B', 'D', 'A', 'C', 'E'],
        'порядок внутри пачки — исходный (A перед C), сама пачка непрерывна');
    assert.equal(previewCalls, 1, 'одно превью на всю пачку');
});

test('moveBlocks: все выбранные ЛЕВЕЕ цели — позиция уменьшается на их число', () => {
    const violation = makeViolation(['A', 'B', 'C', 'D']);

    // A и B (индексы 0 и 1) → позиция 3 (между C и D).
    assert.equal(mutations.moveBlocks.call({}, violation, FIELD, ['A', 'B'], 3), true);
    assert.deepEqual(blockIds(violation), ['C', 'A', 'B', 'D']);
});

test('moveBlocks: все выбранные ПРАВЕЕ цели — поправки нет', () => {
    const violation = makeViolation(['A', 'B', 'C', 'D']);

    // C и D (индексы 2 и 3) → позиция 1 (между A и B).
    assert.equal(mutations.moveBlocks.call({}, violation, FIELD, ['C', 'D'], 1), true);
    assert.deepEqual(blockIds(violation), ['A', 'C', 'D', 'B']);
});

test('moveBlocks: выбранные по обе стороны цели', () => {
    const violation = makeViolation(['A', 'B', 'C', 'D', 'E']);

    // A (0) и E (4) → позиция 3 (между C и D): левее цели один блок.
    assert.equal(mutations.moveBlocks.call({}, violation, FIELD, ['A', 'E'], 3), true);
    assert.deepEqual(blockIds(violation), ['B', 'C', 'A', 'E', 'D']);
});

test('moveBlocks: честный no-op не пишет в модель и не планирует превью', () => {
    const violation = makeViolation(['A', 'B', 'C']);

    assert.equal(mutations.moveBlocks.call({}, violation, FIELD, ['A', 'B'], 2), false);
    assert.deepEqual(blockIds(violation), ['A', 'B', 'C']);
    assert.equal(previewCalls, 0);
});

test('moveBlocks: массив блоков пересобирается НА МЕСТЕ (ссылка сохраняется)', () => {
    const violation = makeViolation(['A', 'B', 'C']);
    const arrayRef = violation[FIELD].blocks;

    mutations.moveBlocks.call({}, violation, FIELD, ['A'], 3);

    assert.equal(violation[FIELD].blocks, arrayRef, 'снимок аудита держит ту же ссылку');
    assert.deepEqual(blockIds(violation), ['B', 'C', 'A']);
});

// ── removeBlocks ─────────────────────────────────────────────────────────────

test('removeBlocks удаляет пачку по id, одно превью; неизвестные id игнорируются', () => {
    const violation = makeViolation(['A', 'B', 'C', 'D']);

    assert.equal(mutations.removeBlocks.call({}, violation, FIELD, ['B', 'D', 'нет-такого']), true);
    assert.deepEqual(blockIds(violation), ['A', 'C']);
    assert.equal(previewCalls, 1);
});

test('removeBlocks: ни один id не найден → false, превью нет', () => {
    const violation = makeViolation(['A']);

    assert.equal(mutations.removeBlocks.call({}, violation, FIELD, ['X']), false);
    assert.deepEqual(blockIds(violation), ['A']);
    assert.equal(previewCalls, 0);
});

test('removeBlocks блокируется в read-only', () => {
    const violation = makeViolation(['A', 'B']);
    AppConfig.readOnlyMode.isReadOnly = true;
    try {
        assert.equal(mutations.removeBlocks.call({}, violation, FIELD, ['A']), false);
    } finally {
        AppConfig.readOnlyMode.isReadOnly = false;
    }
    assert.deepEqual(blockIds(violation), ['A', 'B']);
});

// ── removeSelectedBlocks: подтверждение и одна перерисовка ───────────────────

/** Подменяет диалог подтверждения, собирая показанные сообщения. */
function stubDialog(answer, log = []) {
    const original = DialogManager.show;
    DialogManager.show = async (options) => {
        log.push(options.message);
        return answer;
    };
    return () => { DialogManager.show = original; };
}

test('удаление пачки: один диалог, один teardown, ОДНА перерисовка на всю пачку', async () => {
    const violation = makeViolation(['A', 'B', 'C']);
    const vm = makeVm(violation);
    const messages = [];
    const restore = stubDialog(true, messages);

    let removed;
    try {
        removed = await vm.removeSelectedBlocks(violation, FIELD, makeContentContainer(), ['A', 'C']);
    } finally { restore(); }

    assert.equal(removed, true);
    assert.deepEqual(blockIds(violation), ['B']);
    assert.equal(vm._renderCalls, 1, 'одна перерисовка');
    assert.equal(vm._teardownCalls, 1, 'один teardown rich-поля');
    assert.equal(previewCalls, 1, 'одно превью');
    assert.match(messages[0], /Удалить 2 блока/);
});

test('отказ в диалоге не удаляет ничего', async () => {
    const violation = makeViolation(['A', 'B']);
    const vm = makeVm(violation);
    const restore = stubDialog(false);

    let removed;
    try {
        removed = await vm.removeSelectedBlocks(violation, FIELD, makeContentContainer(), ['A', 'B']);
    } finally { restore(); }

    assert.equal(removed, false);
    assert.deepEqual(blockIds(violation), ['A', 'B']);
    assert.equal(vm._renderCalls, 0);
    assert.equal(vm._teardownCalls, 0, 'редактор не трогали — удаления не было');
});

test('один блок удаляется без подтверждения', async () => {
    const violation = makeViolation(['A', 'B']);
    const vm = makeVm(violation);
    let asked = 0;
    const restore = stubDialog(true);
    const wrapped = DialogManager.show;
    DialogManager.show = async (o) => { asked += 1; return wrapped(o); };

    try {
        await vm.removeSelectedBlocks(violation, FIELD, makeContentContainer(), ['A']);
    } finally { restore(); }

    assert.equal(asked, 0, 'диалога не было');
    assert.deepEqual(blockIds(violation), ['B']);
});

test('removeSelectedBlocks берёт живое выделение, если id не переданы', async () => {
    const violation = makeViolation(['A', 'B', 'C']);
    const vm = makeVm(violation);
    vm.blockSelection.applyClick('v1', FIELD, 'C', {}, blockIds(violation));
    vm.blockSelection.applyClick('v1', FIELD, 'A', { ctrlKey: true }, blockIds(violation));
    const restore = stubDialog(true);

    try {
        await vm.removeSelectedBlocks(violation, FIELD, makeContentContainer());
    } finally { restore(); }

    assert.deepEqual(blockIds(violation), ['B']);
    assert.equal(vm.blockSelection.isEmpty(), true, 'выделение снято вместе с блоками');
});

// ── Клавиша Delete ───────────────────────────────────────────────────────────

test('Delete удаляет выделение, когда фокус вне редактируемого поля', async () => {
    const violation = makeViolation(['A', 'B', 'C']);
    const vm = makeVm(violation);
    vm.blockSelection.applyClick('v1', FIELD, 'A', {}, blockIds(violation));
    vm.blockSelection.applyClick('v1', FIELD, 'B', { ctrlKey: true }, blockIds(violation));
    const restore = stubDialog(true);

    try {
        vm._handleBlockSelectionKeydown({
            key: 'Delete',
            target: { tagName: 'DIV', closest: () => null },
            preventDefault() {},
        });
        await Promise.resolve();
        await Promise.resolve();
    } finally { restore(); }

    assert.deepEqual(blockIds(violation), ['C']);
});

test('Delete в редактируемом контексте принадлежит редактору', () => {
    const violation = makeViolation(['A', 'B']);
    const vm = makeVm(violation);
    vm.blockSelection.applyClick('v1', FIELD, 'A', {}, blockIds(violation));
    let prevented = false;

    vm._handleBlockSelectionKeydown({
        key: 'Delete',
        target: { tagName: 'DIV', isContentEditable: true, closest: () => null },
        preventDefault() { prevented = true; },
    });

    assert.equal(prevented, false, 'событие не перехвачено');
    assert.deepEqual(blockIds(violation), ['A', 'B']);
    assert.equal(vm.blockSelection.size(), 1, 'выделение не тронуто');
});

test('Delete без выделения ничего не делает', () => {
    const violation = makeViolation(['A']);
    const vm = makeVm(violation);
    let prevented = false;

    vm._handleBlockSelectionKeydown({
        key: 'Delete',
        target: { tagName: 'DIV', closest: () => null },
        preventDefault() { prevented = true; },
    });

    assert.equal(prevented, false);
    assert.deepEqual(blockIds(violation), ['A']);
});

// ── Контекстное меню ─────────────────────────────────────────────────────────

/** Меню со шпионом на createMenuItem: собираем подписи и обработчики. */
function makeMenu() {
    const menu = new ViolationContextMenu();
    const items = [];
    menu.createMenuItem = (label, handler, isDanger = false, disabled = false) => {
        items.push({ label, handler, isDanger, disabled });
        return { label };
    };
    menu.createSeparator = () => ({});
    menu.removeExistingMenu = () => {};
    menu._items = items;
    return menu;
}

test('ПКМ по выделению из 2+ блоков даёт пункт «Удалить N блоков»', () => {
    const violation = makeViolation(['A', 'B', 'C']);
    const menu = makeMenu();
    const calls = [];
    globalThis.violationManager = { removeSelectedBlocks: (...args) => calls.push(args) };

    menu.createMenu(violation, FIELD, makeContentContainer(), 'A', 0, ['A', 'C']);

    const danger = menu._items.filter(item => item.isDanger);
    assert.equal(danger.length, 1);
    assert.match(danger[0].label, /Удалить 2 блока/);

    danger[0].handler();
    assert.equal(calls.length, 1, 'вызвано групповое удаление');
    assert.deepEqual(calls[0][3], ['A', 'C'], 'id сняты в момент показа меню');
});

test('ПКМ вне выделения (или по одиночному блоку) — прежний пункт «Удалить»', () => {
    const violation = makeViolation(['A', 'B']);
    const menu = makeMenu();
    const single = [];
    globalThis.violationManager = { removeBlockFromField: (...args) => single.push(args) };

    menu.createMenu(violation, FIELD, makeContentContainer(), 'B', 0, ['B']);

    const danger = menu._items.filter(item => item.isDanger);
    assert.deepEqual(danger.map(i => i.label), ['🗑️ Удалить']);

    danger[0].handler();
    assert.equal(single.length, 1, 'одиночный путь удаления жив');
    assert.equal(single[0][2], 'B');
});

test('ПКМ по пустому месту: пунктов удаления нет вовсе', () => {
    const violation = makeViolation(['A']);
    const menu = makeMenu();

    menu.createMenu(violation, FIELD, makeContentContainer(), null, 0, []);

    assert.deepEqual(menu._items.filter(item => item.isDanger), []);
});

// ── dragstart: пачка ─────────────────────────────────────────────────────────

/** Событие dragstart с рабочим dataTransfer. */
function dragStartEvent(wrapper) {
    const data = {};
    return {
        currentTarget: wrapper,
        dataTransfer: {
            effectAllowed: null,
            setData: (type, value) => { data[type] = value; },
            setDragImage() {},
            _data: data,
        },
    };
}

/** Обёртка блока с classList и путём до контейнера блоков. */
function makeDragWrapper() {
    return {
        classList: { add() {}, remove() {} },
        closest: () => null,
    };
}

test('dragstart за шапку выделенного блока тащит всю пачку', () => {
    const violation = makeViolation(['A', 'B', 'C']);
    const vm = makeVm(violation);
    vm._syncBlockSelectionClasses = () => {};
    vm.blockSelection.applyClick('v1', FIELD, 'C', {}, blockIds(violation));
    vm.blockSelection.applyClick('v1', FIELD, 'A', { ctrlKey: true }, blockIds(violation));

    const e = dragStartEvent(makeDragWrapper());
    vm.handleDragStart(e, violation, FIELD, 0, violation[FIELD].blocks[0]);

    assert.deepEqual(vm._dragPayload.blockIds, ['A', 'C'], 'пачка в порядке поля');
    const wire = JSON.parse(e.dataTransfer._data['application/x-violation-block']);
    assert.deepEqual(wire.blockIds, ['A', 'C']);
});

test('dragstart за шапку невыделенного блока схлопывает выделение на него', () => {
    const violation = makeViolation(['A', 'B', 'C']);
    const vm = makeVm(violation);
    vm._syncBlockSelectionClasses = () => {};
    vm.blockSelection.applyClick('v1', FIELD, 'A', {}, blockIds(violation));

    const e = dragStartEvent(makeDragWrapper());
    vm.handleDragStart(e, violation, FIELD, 2, violation[FIELD].blocks[2]);

    assert.deepEqual(vm._dragPayload.blockIds, ['C']);
    assert.deepEqual([...vm.blockSelection.ids], ['C'], 'выделение переехало на схваченный блок');
});

test('миниатюра пачки — счётный бейдж, одиночного блока — тип блока', () => {
    const vm = makeVm(null);
    const block = { id: 'A', type: BLOCK_TYPES.TEXT };

    assert.match(vm.createDragMiniature(block, 3).innerHTML, /3 блока/);
    assert.match(vm.createDragMiniature(block, 1).innerHTML, /Текст/);
});

test('drop переносит всю пачку одним мутатором и одной перерисовкой', () => {
    const violation = makeViolation(['A', 'B', 'C', 'D']);
    const vm = makeVm(violation);
    vm.lastDragOverIndex = 4; // в конец поля

    vm.handleDrop(
        {
            preventDefault() {},
            stopPropagation() {},
            dataTransfer: {
                getData: (type) => (type === 'application/x-violation-block'
                    ? JSON.stringify({ violationId: 'v1', fieldKey: FIELD, blockIds: ['A', 'C'] })
                    : ''),
            },
        },
        violation, FIELD, { querySelectorAll: () => [] },
    );

    assert.deepEqual(blockIds(violation), ['B', 'D', 'A', 'C']);
    assert.equal(vm._renderCalls, 1);
    assert.equal(previewCalls, 1);
    assert.equal(vm._dropCommitted, true);
});
