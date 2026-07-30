/**
 * Тесты расширенного диффа дерева (#8 full, item): раньше `_diffTree` сравнивал
 * только label+type узла. Теперь также сравниваются number/customLabel/kind
 * (расхождение → 'modified' + `_fieldChanges` old→new) и детектируется
 * перемещение узла (`_moved`): смена родителя ИЛИ порядка среди ОБЩИХ сиблингов
 * (устойчиво к вставкам/удалениям — не дорогой LCS).
 *
 * Поле `node.content` НЕ диффится сознательно: во фронт-модели оно мёртвое
 * (создаётся как '' в state-tree._createNewNode, нигде не читается/пишется,
 * сериализуется всегда как '' — см. state-core._serializeTree). Диффить
 * всегда-пустое поле бессмысленно.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiffEngine } from '../../static/js/portal/acts-manager/diff-engine.js';

function node(over = {}) {
    return { id: over.id || 'n', label: '', type: 'item', children: [], ...over };
}

/** Аннотированный узел нового дерева по id (обходит дерево). */
function findAnnotated(tree, id) {
    if (!tree) return null;
    if (tree.id === id) return tree;
    for (const child of tree.children || []) {
        const found = findAnnotated(child, id);
        if (found) return found;
    }
    return null;
}

// --- атрибуты узла ----------------------------------------------------------

test('label меняется → modified + _fieldChanges.label (сохранено прежнее поведение)', () => {
    const oldTree = node({ id: 'root', label: 'Старый' });
    const newTree = node({ id: 'root', label: 'Новый' });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(d.hasChanges, true);
    assert.equal(d.tree._diff, 'modified');
    assert.deepEqual(d.tree._fieldChanges.label, { old: 'Старый', new: 'Новый' });
});

test('customLabel меняется → modified + _fieldChanges.customLabel', () => {
    const oldTree = node({ id: 'root', customLabel: 'A' });
    const newTree = node({ id: 'root', customLabel: 'B' });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(d.tree._diff, 'modified');
    assert.deepEqual(d.tree._fieldChanges.customLabel, { old: 'A', new: 'B' });
});

test('number меняется → modified + _fieldChanges.number', () => {
    const oldTree = node({ id: 'root', number: '1.1' });
    const newTree = node({ id: 'root', number: '1.2' });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(d.tree._diff, 'modified');
    assert.deepEqual(d.tree._fieldChanges.number, { old: '1.1', new: '1.2' });
});

test('kind таблицы-узла меняется → modified + _fieldChanges.kind', () => {
    const oldTree = node({ id: 'root', type: 'table', kind: 'regular' });
    const newTree = node({ id: 'root', type: 'table', kind: 'metrics' });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(d.tree._diff, 'modified');
    assert.deepEqual(d.tree._fieldChanges.kind, { old: 'regular', new: 'metrics' });
});

test('kind: отсутствие в снимке нормализуется к regular (нет ложного modified)', () => {
    const oldTree = node({ id: 'root', type: 'item' }); // без kind
    const newTree = node({ id: 'root', type: 'item', kind: 'regular' });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(d.tree._diff, 'unchanged');
    assert.equal(d.hasChanges, false);
});

test('node.content НЕ диффится (мёртвое поле): разный content → unchanged', () => {
    const oldTree = node({ id: 'root', content: '' });
    const newTree = node({ id: 'root', content: 'что-то' });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(d.tree._diff, 'unchanged');
    assert.equal(d.hasChanges, false);
});

test('идентичный узел → unchanged, без _moved/_fieldChanges', () => {
    const oldTree = node({ id: 'root', label: 'X', number: '1' });
    const newTree = node({ id: 'root', label: 'X', number: '1' });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(d.tree._diff, 'unchanged');
    assert.equal(d.tree._moved, undefined);
    assert.equal(d.tree._fieldChanges, undefined);
});

// --- добавление / удаление --------------------------------------------------

test('добавленный узел → added', () => {
    const oldTree = node({ id: 'root', children: [] });
    const newTree = node({ id: 'root', children: [node({ id: 'a' })] });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(findAnnotated(d.tree, 'a')._diff, 'added');
    assert.equal(d.hasChanges, true);
});

test('удалённый узел → removedNodes', () => {
    const oldTree = node({ id: 'root', children: [node({ id: 'a' })] });
    const newTree = node({ id: 'root', children: [] });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(d.removedNodes.length, 1);
    assert.equal(d.removedNodes[0].id, 'a');
    assert.equal(d.removedNodes[0]._diff, 'removed');
});

// --- перемещение ------------------------------------------------------------

test('смена родителя → _moved + hasChanges', () => {
    const oldTree = node({
        id: 'root',
        children: [
            node({ id: 'a', children: [node({ id: 'c' })] }),
            node({ id: 'b' }),
        ],
    });
    const newTree = node({
        id: 'root',
        children: [
            node({ id: 'a' }),
            node({ id: 'b', children: [node({ id: 'c' })] }),
        ],
    });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(findAnnotated(d.tree, 'c')._moved, true);
    assert.equal(d.hasChanges, true);
    // Родители не считаются перемещёнными.
    assert.equal(findAnnotated(d.tree, 'a')._moved, undefined);
    assert.equal(findAnnotated(d.tree, 'b')._moved, undefined);
});

test('перестановка сиблингов (swap) → оба _moved', () => {
    const oldTree = node({ id: 'root', children: [node({ id: 'x' }), node({ id: 'y' }), node({ id: 'z' })] });
    const newTree = node({ id: 'root', children: [node({ id: 'x' }), node({ id: 'z' }), node({ id: 'y' })] });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(findAnnotated(d.tree, 'y')._moved, true);
    assert.equal(findAnnotated(d.tree, 'z')._moved, true);
    assert.equal(findAnnotated(d.tree, 'x')._moved, undefined);
});

test('вставка соседа НЕ помечает существующие как _moved (устойчиво к вставкам)', () => {
    const oldTree = node({ id: 'root', children: [node({ id: 'x' }), node({ id: 'y' })] });
    const newTree = node({ id: 'root', children: [node({ id: 'x' }), node({ id: 'w' }), node({ id: 'y' })] });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(findAnnotated(d.tree, 'x')._moved, undefined);
    assert.equal(findAnnotated(d.tree, 'y')._moved, undefined);
    assert.equal(findAnnotated(d.tree, 'w')._diff, 'added');
});

test('удаление соседа НЕ помечает существующие как _moved (устойчиво к удалениям)', () => {
    const oldTree = node({ id: 'root', children: [node({ id: 'x' }), node({ id: 'w' }), node({ id: 'y' })] });
    const newTree = node({ id: 'root', children: [node({ id: 'x' }), node({ id: 'y' })] });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(findAnnotated(d.tree, 'x')._moved, undefined);
    assert.equal(findAnnotated(d.tree, 'y')._moved, undefined);
});

test('репарент: узел ушёл к новому родителю → сам _moved, оставшиеся same-parent соседи НЕ ложно _moved', () => {
    // Раздел S с пунктами 3.1..3.4; тащим 3.2 в дети 3.1.
    // Регресс: ранг оставшихся 3.3/3.4 не должен «съехать» из-за выбывшего 3.2.
    const oldTree = node({
        id: 'S',
        children: [
            node({ id: 'p1' }),
            node({ id: 'p2' }),
            node({ id: 'p3' }),
            node({ id: 'p4' }),
        ],
    });
    const newTree = node({
        id: 'S',
        children: [
            node({ id: 'p1', children: [node({ id: 'p2' })] }),
            node({ id: 'p3' }),
            node({ id: 'p4' }),
        ],
    });
    const d = DiffEngine._diffTree(oldTree, newTree);
    assert.equal(findAnnotated(d.tree, 'p2')._moved, true, 'реперентнутый узел должен быть _moved');
    assert.equal(findAnnotated(d.tree, 'p3')._moved, undefined, 'сосед 3.3 не должен ложно помечаться');
    assert.equal(findAnnotated(d.tree, 'p4')._moved, undefined, 'сосед 3.4 не должен ложно помечаться');
    assert.equal(findAnnotated(d.tree, 'p1')._moved, undefined, 'новый родитель не должен помечаться');
});

// --- направление перемещения (§5.10d) ---------------------------------------
// _moveDirection — только при перестановке среди сиблингов ОДНОГО родителя
// (ранги сопоставимы); при смене родителя ранги считаются в разных группах и
// несравнимы, поэтому направление не выставляется.

test('перестановка сиблингов: узел поднялся выше по списку → _moveDirection = "up"', () => {
    const oldTree = node({ id: 'root', children: [node({ id: 'x' }), node({ id: 'y' }), node({ id: 'z' })] });
    const newTree = node({ id: 'root', children: [node({ id: 'z' }), node({ id: 'x' }), node({ id: 'y' })] });
    const d = DiffEngine._diffTree(oldTree, newTree);
    // z был на индексе 2, стал на индексе 0 — поднялся.
    assert.equal(findAnnotated(d.tree, 'z')._moveDirection, 'up');
});

test('перестановка сиблингов: узел опустился ниже по списку → _moveDirection = "down"', () => {
    const oldTree = node({ id: 'root', children: [node({ id: 'x' }), node({ id: 'y' }), node({ id: 'z' })] });
    const newTree = node({ id: 'root', children: [node({ id: 'y' }), node({ id: 'z' }), node({ id: 'x' })] });
    const d = DiffEngine._diffTree(oldTree, newTree);
    // x был на индексе 0, стал на индексе 2 — опустился.
    assert.equal(findAnnotated(d.tree, 'x')._moveDirection, 'down');
});

test('смена родителя (репарент): _moved true, но _moveDirection не выставляется (ранги несравнимы)', () => {
    const oldTree = node({
        id: 'root',
        children: [
            node({ id: 'a', children: [node({ id: 'c' })] }),
            node({ id: 'b' }),
        ],
    });
    const newTree = node({
        id: 'root',
        children: [
            node({ id: 'a' }),
            node({ id: 'b', children: [node({ id: 'c' })] }),
        ],
    });
    const d = DiffEngine._diffTree(oldTree, newTree);
    const c = findAnnotated(d.tree, 'c');
    assert.equal(c._moved, true);
    assert.equal(c._moveDirection, undefined);
});

test('перемещённый узел без правок атрибутов → _diff остаётся unchanged, но _moved true', () => {
    const oldTree = node({
        id: 'root',
        children: [node({ id: 'a', children: [node({ id: 'c', label: 'C' })] }), node({ id: 'b' })],
    });
    const newTree = node({
        id: 'root',
        children: [node({ id: 'a' }), node({ id: 'b', children: [node({ id: 'c', label: 'C' })] })],
    });
    const d = DiffEngine._diffTree(oldTree, newTree);
    const c = findAnnotated(d.tree, 'c');
    assert.equal(c._diff, 'unchanged');
    assert.equal(c._moved, true);
});
