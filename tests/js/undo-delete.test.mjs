/**
 * Откат удалений блоков (решение Б-4: только undo для delete).
 *
 * Гарантии:
 *  - capture→undo round-trip: дерево и словари (tables/textBlocks/violations)
 *    байт-в-байт совпадают до удаления и после отката;
 *  - restore по сохранённому индексу с clamp'ом по pinned-инварианту;
 *  - LIFO, глубина 20, очистка стека;
 *  - отказ с уведомлением при удалённом родителе;
 *  - риск-таблица + сводные (каскад §5) восстанавливаются вместе;
 *  - индекс узлов консистентен после undo (warn-fallback не срабатывает);
 *  - read-only блокирует откат;
 *  - action-toast уведомлений не группируется (у каждого свой обработчик).
 *
 * Тестируются РЕАЛЬНЫЕ модули (стабы браузерных глобалов — _browser-stub.mjs,
 * импорт ПЕРВЫМ — порядок load-bearing).
 */
import './_browser-stub.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppState } from '../../static/js/constructor/state/state-core.js';
import '../../static/js/constructor/state/state-tree.js';
import '../../static/js/constructor/state/state-content.js';
import { MetricsRiskCoordinator } from '../../static/js/constructor/state/metrics-risk-coordinator.js';
import {
    UndoDeleteManager,
    UNDO_STACK_DEPTH,
} from '../../static/js/constructor/state/undo-delete.js';
import { TreeUtils } from '../../static/js/constructor/tree/tree-utils.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { Notifications } from '../../static/js/shared/notifications.js';
import {
    getImageLimits,
    getStructureLimits,
    resetImageLimitsForTests,
} from '../../static/js/constructor/violation/violation-image-validator.js';

// ── Шпионы: console.warn (fallback индекса) и Notifications ─────────────────
const warns = [];
const notified = { error: [], info: [], success: [], warning: [] };
const originalWarn = console.warn;
const originalNotifications = {
    error: Notifications.error,
    info: Notifications.info,
    success: Notifications.success,
    warning: Notifications.warning,
};

beforeEach(() => {
    warns.length = 0;
    console.warn = (...args) => { warns.push(args.join(' ')); };
    for (const key of Object.keys(notified)) {
        notified[key].length = 0;
        Notifications[key] = (msg) => { notified[key].push(msg); };
    }
    // Чистое состояние между тестами.
    AppState.treeData = null;
    AppState.tables = {};
    AppState.textBlocks = {};
    AppState.violations = {};
    AppState._rebuildNodeIndex();
    UndoDeleteManager.clear();
    AppConfig.readOnlyMode.isReadOnly = false;
});

afterEach(() => {
    console.warn = originalWarn;
    Object.assign(Notifications, originalNotifications);
    AppConfig.readOnlyMode.isReadOnly = false;
    resetImageLimitsForTests();
});

// ── Хелперы ──────────────────────────────────────────────────────────────────

/** Добавляет item-узел и возвращает его (tracked). */
function addItem(parentId, label = 'Пункт') {
    const res = AppState.addNode(parentId, label, true);
    assert.ok(res.valid, `addNode(${parentId}): ${res.message}`);
    return AppState.findNodeById(parentId).children.at(-1);
}

/** Plain-снимок состояния (дерево + словари) для deep-equal сравнений. */
function snapshotState() {
    return JSON.parse(JSON.stringify({
        tree: AppState.exportData().tree,
        tables: AppState.exportData().tables,
        textBlocks: AppState.exportData().textBlocks,
        violations: AppState.exportData().violations,
    }));
}

/** Полный обход дерева: эталонные карты id→node и childId→parent. */
function walkReference(root) {
    const nodes = new Map();
    const parents = new Map();
    const walk = (node, parent) => {
        nodes.set(node.id, node);
        if (parent) parents.set(node.id, parent);
        (node.children || []).forEach(child => walk(child, node));
    };
    if (root) walk(root, null);
    return { nodes, parents };
}

/** Сверка индекса с эталонным обходом + сверка findNodeById с обходом. */
function assertIndexConsistent(label = '') {
    const { nodes, parents } = walkReference(AppState.treeData);
    assert.equal(AppState._nodeIndex.size, nodes.size, `${label}: размер _nodeIndex`);
    assert.equal(AppState._parentIndex.size, parents.size, `${label}: размер _parentIndex`);
    for (const [id, node] of nodes) {
        assert.equal(AppState._nodeIndex.get(id), node, `${label}: _nodeIndex['${id}'] — не тот объект`);
        assert.equal(AppState.findNodeById(id), node, `${label}: findNodeById('${id}') ≠ обход`);
    }
    for (const [id, parent] of parents) {
        assert.equal(AppState._parentIndex.get(id), parent, `${label}: _parentIndex['${id}'] — не тот объект`);
    }
}

/** Промахов индекса (warn-fallback) быть не должно. */
function assertNoIndexMiss() {
    const misses = warns.filter(w => w.includes('промах индекса'));
    assert.deepEqual(misses, [], 'fallback индекса — пропущенная инвалидация');
}

/** Строит §5-кластер: 5.1 → 5.1.1 с риск-таблицей + сводные (per-point и main). */
function buildSection5Cluster() {
    const n51 = addItem('5', 'Пункт 5.1');
    const n511 = addItem(n51.id, 'Подпункт 5.1.1');
    AppState.generateNumbering();

    assert.ok(AppState._createRegularRiskTable(n511.id).valid);
    AppState.generateNumbering();
    assert.ok(MetricsRiskCoordinator.onRiskTableAdded(n511.id));

    const riskNode = n511.children.find(c => c.kind === 'regularRisk');
    const metricsNode = n51.children.find(c => c.kind === 'metrics');
    const mainNode = AppState.findNodeById('5').children.find(c => c.kind === 'mainMetrics');
    assert.ok(riskNode, 'риск-таблица не создана');
    assert.ok(metricsNode, 'per-point сводная не создана');
    assert.ok(mainNode, 'главная сводная не создана');

    return { n51, n511, riskNode, metricsNode, mainNode };
}

// ── Round-trip: capture → undo ───────────────────────────────────────────────

test('round-trip: удаление и откат item-поддерева с таблицей, текстблоком и нарушением', () => {
    AppState.initializeTree(true);
    const item = addItem('4', 'Пункт с контентом');
    assert.ok(AppState.addTableToNode(item.id).valid);
    assert.ok(AppState.addTextBlockToNode(item.id).valid);
    assert.ok(AppState.addViolationToNode(item.id).valid);
    AppState.generateNumbering();

    const before = snapshotState();
    const tableId = item.children.find(c => c.tableId)?.tableId;
    const textBlockId = item.children.find(c => c.textBlockId)?.textBlockId;
    const violationId = item.children.find(c => c.violationId)?.violationId;

    assert.ok(AppState.deleteNode(item.id));
    assert.equal(AppState.findNodeById(item.id), null);
    assert.equal(AppState.tables[tableId], undefined, 'запись таблицы должна быть удалена');
    assert.equal(AppState.textBlocks[textBlockId], undefined);
    assert.equal(AppState.violations[violationId], undefined);
    assert.ok(UndoDeleteManager.canUndo());

    assert.ok(UndoDeleteManager.undoLast(), 'undoLast должен восстановить узел');

    assert.deepEqual(snapshotState(), before, 'дерево и словари после отката не совпали со снимком');
    assert.equal(notified.success.length, 1, 'должно быть уведомление об успехе отката');
    assertIndexConsistent('round-trip');
    assertNoIndexMiss();
});

test('round-trip: восстановление по исходному индексу среди сиблингов', () => {
    AppState.initializeTree(true);
    const a = addItem('4', 'А');
    const b = addItem('4', 'Б');
    const c = addItem('4', 'В');
    AppState.generateNumbering();

    assert.ok(AppState.deleteNode(b.id));
    assert.ok(UndoDeleteManager.undoLast());

    const ids = AppState.findNodeById('4').children.map(n => n.id);
    assert.deepEqual(ids, [a.id, b.id, c.id], 'Б должен вернуться между А и В');
    assertNoIndexMiss();
});

// ── insertNodeAt: clamp по pinned и длине ────────────────────────────────────

test('insertNodeAt: clamp индекса по pinned-инварианту и длине children', () => {
    AppState.initializeTree(true);
    const n51 = addItem('5', 'Пункт 5.1');
    AppState.generateNumbering();
    assert.ok(AppState._createRegularRiskTable(n51.id).valid, 'риск на уровне пункта 5.X разрешён');
    assert.ok(TreeUtils.isPinnedTable(n51.children[0]), 'риск-таблица закреплена первой');

    // Вставка с index=0 не должна попасть раньше pinned-таблицы.
    const nodeA = { id: 'undo_test_a', label: 'А', children: [], content: '' };
    assert.ok(AppState.insertNodeAt(n51.id, nodeA, 0).valid);
    assert.ok(TreeUtils.isPinnedTable(n51.children[0]), 'pinned-таблица осталась первой');
    assert.equal(n51.children[1].id, 'undo_test_a');

    // Индекс за пределами длины — append в конец.
    const nodeB = { id: 'undo_test_b', label: 'Б', children: [], content: '' };
    assert.ok(AppState.insertNodeAt(n51.id, nodeB, 999).valid);
    assert.equal(n51.children.at(-1).id, 'undo_test_b');

    assertIndexConsistent('insertNodeAt');
    assertNoIndexMiss();
});

test('undo с pinned-clamp: родитель получил pinned-таблицу после удаления', () => {
    AppState.initializeTree(true);
    const n51 = addItem('5', 'Пункт 5.1');
    const itemA = addItem(n51.id, 'А');
    AppState.generateNumbering();

    // Удаляем itemA (index 0), затем на 5.1 появляется pinned риск-таблица.
    assert.ok(AppState.deleteNode(itemA.id));
    assert.ok(AppState._createRegularRiskTable(n51.id).valid);
    AppState.generateNumbering();

    assert.ok(UndoDeleteManager.undoLast());

    assert.ok(TreeUtils.isPinnedTable(n51.children[0]), 'pinned-инвариант после отката');
    assert.equal(n51.children[1].id, itemA.id, 'восстановленный узел — после pinned');
    assertIndexConsistent('pinned-clamp');
    assertNoIndexMiss();
});

// ── LIFO / глубина / очистка ─────────────────────────────────────────────────

test('LIFO: откаты идут в обратном порядке удалений, глубина стека ограничена', () => {
    AppState.initializeTree(true);
    const total = UNDO_STACK_DEPTH + 5;
    const items = [];
    for (let i = 0; i < total; i++) {
        items.push(addItem('4', `Пункт ${i}`));
    }
    for (const item of items) {
        assert.ok(AppState.deleteNode(item.id));
    }

    assert.equal(UndoDeleteManager._stack.length, UNDO_STACK_DEPTH, 'глубина стека = 20');

    // Откатываются последние UNDO_STACK_DEPTH удалений в обратном порядке.
    const expected = items.slice(-UNDO_STACK_DEPTH).map(n => n.id).reverse();
    const restored = [];
    while (UndoDeleteManager.canUndo()) {
        const top = UndoDeleteManager._stack.at(-1).nodeId;
        assert.ok(UndoDeleteManager.undoLast());
        restored.push(top);
    }
    assert.deepEqual(restored, expected, 'LIFO-порядок восстановления');
    assert.equal(UndoDeleteManager.undoLast(), false, 'пустой стек — откат невозможен');

    // Первые 5 удалений вытеснены — узлы потеряны (by design, глубина 20).
    for (const lost of items.slice(0, 5)) {
        assert.equal(AppState.findNodeById(lost.id), null);
    }
    assertNoIndexMiss();
});

test('clear() очищает стек (resetForActSwitch)', () => {
    AppState.initializeTree(true);
    const item = addItem('4');
    assert.ok(AppState.deleteNode(item.id));
    assert.ok(UndoDeleteManager.canUndo());

    UndoDeleteManager.clear();
    assert.equal(UndoDeleteManager.canUndo(), false);
    assert.equal(UndoDeleteManager.undoLast(), false);
});

// ── Отказы ───────────────────────────────────────────────────────────────────

test('отказ с уведомлением, если родитель восстановленного узла удалён', () => {
    AppState.initializeTree(true);
    const parent = addItem('4', 'Родитель');
    const child = addItem(parent.id, 'Ребёнок');
    AppState.generateNumbering();

    assert.ok(AppState.deleteNode(child.id));
    // Родителя сносим в обход captureDeletion (имитация вытеснения снимка).
    assert.ok(AppState._deleteNodeUnchecked(parent, parent.id));

    assert.equal(UndoDeleteManager.undoLast(), false);
    assert.equal(notified.error.length, 1, 'должно быть уведомление об отказе');
    assert.match(notified.error[0], /родительский элемент тоже удалён/);
    assert.equal(UndoDeleteManager.canUndo(), false, 'снимок выброшен');
    assertNoIndexMiss();
});

test('LIFO сам восстанавливает родителя раньше ребёнка', () => {
    AppState.initializeTree(true);
    const parent = addItem('4', 'Родитель');
    const child = addItem(parent.id, 'Ребёнок');
    AppState.generateNumbering();

    assert.ok(AppState.deleteNode(child.id));
    assert.ok(AppState.deleteNode(parent.id));

    assert.ok(UndoDeleteManager.undoLast(), 'сначала родитель');
    assert.ok(AppState.findNodeById(parent.id));
    assert.ok(UndoDeleteManager.undoLast(), 'затем ребёнок');
    assert.equal(AppState.findParentNode(child.id).id, parent.id);
    assertIndexConsistent('LIFO родитель→ребёнок');
    assertNoIndexMiss();
});

test('защищённый узел не попадает в стек (deleteNode отказал)', () => {
    AppState.initializeTree(true);
    assert.equal(AppState.deleteNode('1'), false);
    assert.equal(UndoDeleteManager.canUndo(), false);
});

test('узел уже в дереве (rollback каскада вернул его) — откат пропускается', () => {
    AppState.initializeTree(true);
    const item = addItem('4');
    const snapshot = UndoDeleteManager.captureDeletion(item.id);
    UndoDeleteManager.commit(snapshot);
    // Узел НЕ удалён — undoLast должен распознать это и не дублировать.
    assert.equal(UndoDeleteManager.undoLast(), false);
    assert.equal(notified.info.length, 1);
    assert.equal(UndoDeleteManager.canUndo(), false);
});

test('read-only: откат недоступен', () => {
    AppState.initializeTree(true);
    const item = addItem('4');
    assert.ok(AppState.deleteNode(item.id));

    AppConfig.readOnlyMode.isReadOnly = true;
    assert.equal(UndoDeleteManager.undoLast(), false);
    assert.equal(notified.warning.length, 1);
    assert.ok(UndoDeleteManager.canUndo(), 'снимок сохранён — откат возможен после выхода из read-only');
});

// ── PERSIST-2: лимит текстблоков-на-узел при восстановлении ─────────────────

test('undo текстблока отклоняется на лимите узла: снимок остаётся в стеке, ретрай после освобождения лимита проходит', () => {
    AppState.initializeTree(true);
    getStructureLimits().textBlocksPerNode = 2;
    const item = addItem('4', 'Пункт');
    assert.ok(AppState.addTextBlockToNode(item.id).valid);
    assert.ok(AppState.addTextBlockToNode(item.id).valid);
    const tb1 = item.children.find(c => c.type === 'textblock');
    AppState.generateNumbering();

    assert.ok(AppState.deleteNode(tb1.id));
    assert.ok(AppState.addTextBlockToNode(item.id).valid); // узел снова на лимите (2/2)
    AppState.generateNumbering();

    const childrenBefore = item.children.length;
    assert.equal(UndoDeleteManager.undoLast(), false, 'откат отклонён — узел на лимите текстблоков');
    assert.equal(notified.error.filter(m => /текстовых блоков/i.test(m)).length, 1, 'тост про лимит текстблоков');
    assert.equal(item.children.length, childrenBefore, 'состояние не изменилось (атомарно)');
    assert.ok(UndoDeleteManager.canUndo(), 'снимок остался в стеке — ретрай возможен');

    // Лимит увеличен (место освобождено иным путём) — повтор проходит.
    getStructureLimits().textBlocksPerNode = 3;
    assert.ok(UndoDeleteManager.undoLast(), 'повторный откат проходит после снятия ограничения');
    assert.equal(item.children.filter(c => c.type === 'textblock').length, 3);
    assertIndexConsistent('undo текстблока после ретрая');
    assertNoIndexMiss();
});

test('undo item-поддерева с текстблоками сверх ТЕКУЩЕГО лимита (лимит снижен между удалением и откатом) — отказ, дерево не меняется', () => {
    AppState.initializeTree(true);
    getStructureLimits().textBlocksPerNode = 5;
    const item = addItem('4', 'Пункт с текстблоками');
    assert.ok(AppState.addTextBlockToNode(item.id).valid);
    assert.ok(AppState.addTextBlockToNode(item.id).valid);
    assert.ok(AppState.addTextBlockToNode(item.id).valid);
    AppState.generateNumbering();

    assert.ok(AppState.deleteNode(item.id));
    // Лимит снижается между удалением и попыткой отката.
    getStructureLimits().textBlocksPerNode = 2;

    assert.equal(UndoDeleteManager.undoLast(), false, 'откат отклонён — поддерево нарушает текущий лимит');
    assert.equal(AppState.findNodeById(item.id), null, 'узел остался неудалённым (откат не применился)');
    assert.ok(UndoDeleteManager.canUndo(), 'снимок остался в стеке');
    assertNoIndexMiss();
});

// ── Ревью #6: лимит ЭЛЕМЕНТОВ доп. контента снимка НЕ блокирует undo ────────
// (в отличие от лимита блоков-на-узле выше — items считаются по словарю
// САМОГО СНИМКА, пользователь их снаружи облегчить не может).

test('undo нарушения с items сверх ТЕКУЩЕГО лимита элементов доп. контента — проходит', () => {
    AppState.initializeTree(true);
    const item = addItem('4', 'Пункт с нарушением');
    assert.ok(AppState.addViolationToNode(item.id).valid);
    const violationNode = item.children.find(c => c.type === 'violation');
    const violationId = violationNode.violationId;
    AppState.generateNumbering();

    // Нарушение легитимно накопило 5 элементов (лимит на тот момент был выше).
    // Админ снижает лимит НИЖЕ фактического количества ДО удаления.
    AppState.violations[violationId].additionalContent.enabled = true;
    AppState.violations[violationId].additionalContent.items =
        Array.from({length: 5}, (_, i) => ({id: `it${i}`, type: 'freeText', text: ''}));
    getImageLimits().maxItemsPerViolation = 2;

    assert.ok(AppState.deleteNode(violationNode.id));
    assert.equal(AppState.violations[violationId], undefined);

    assert.ok(UndoDeleteManager.undoLast(), 'лимит items снимка не должен клинить undo');
    assert.equal(notified.error.length, 0, 'отказа по лимиту items быть не должно');

    const restored = item.children.find(c => c.type === 'violation');
    assert.ok(restored, 'узел нарушения восстановлен');
    assert.equal(
        AppState.violations[violationId].additionalContent.items.length, 5,
        'все 5 элементов восстановлены целиком, incl. сверх лимита'
    );
    assertIndexConsistent('undo нарушения сверх items-лимита');
    assertNoIndexMiss();
});

test('лимит items снимка не клинит ВЕСЬ LIFO-стек: undo верхнего (нарушение) не блокирует нижележащий', () => {
    AppState.initializeTree(true);
    const older = addItem('4', 'Старый пункт'); // удалён первым → окажется НИЖЕ в стеке
    const item = addItem('4', 'Пункт с нарушением');
    assert.ok(AppState.addViolationToNode(item.id).valid);
    const violationNode = item.children.find(c => c.type === 'violation');
    const violationId = violationNode.violationId;
    AppState.generateNumbering();

    AppState.violations[violationId].additionalContent.enabled = true;
    AppState.violations[violationId].additionalContent.items =
        Array.from({length: 3}, (_, i) => ({id: `it${i}`, type: 'freeText', text: ''}));
    getImageLimits().maxItemsPerViolation = 1;

    // Порядок удаления: older → потом нарушение (нарушение — верх стека).
    assert.ok(AppState.deleteNode(older.id));
    assert.ok(AppState.deleteNode(violationNode.id));

    // ДО фикса: верхний снимок (нарушение, items сверх лимита) отклонял бы
    // undoLast НАВСЕГДА — older остался бы недостижим (undoLast всегда берёт
    // только верхний снимок стека).
    assert.ok(UndoDeleteManager.undoLast(), 'undo верхнего снимка (нарушение) должен пройти');
    assert.ok(item.children.some(c => c.type === 'violation'), 'нарушение восстановлено');

    assert.ok(UndoDeleteManager.undoLast(), 'стек не заклинен — нижележащий снимок (older) достижим');
    assert.ok(AppState.findNodeById(older.id), 'older восстановлен');

    assert.equal(UndoDeleteManager.canUndo(), false, 'стек пуст');
    assertIndexConsistent('стек разблокирован после items-фикса');
    assertNoIndexMiss();
});

// ── Каскад metrics↔risk (§5-кластер) ────────────────────────────────────────

test('удаление риск-таблицы: риск восстановлен, сводные пересобраны каскадом', () => {
    AppState.initializeTree(true);
    const { n51, riskNode, metricsNode, mainNode } = buildSection5Cluster();
    const riskTableId = riskNode.tableId;

    assert.ok(AppState.deleteNode(riskNode.id));
    // Каскад снёс сводные.
    assert.equal(AppState.findNodeById(riskNode.id), null);
    assert.equal(AppState.findNodeById(metricsNode.id), null, 'per-point сводная снесена каскадом');
    assert.equal(AppState.findNodeById(mainNode.id), null, 'главная сводная снесена каскадом');
    assert.equal(AppState.tables[riskTableId], undefined, 'запись риск-таблицы снесена');

    assert.ok(UndoDeleteManager.undoLast());

    // Удалённый риск-узел возвращается ПОД СВОИМ id (восстановление, не пересоздание).
    const restoredRisk = AppState.findNodeById(riskNode.id);
    assert.ok(restoredRisk, 'риск-таблица восстановлена под исходным id');
    assert.ok(AppState.tables[riskTableId], 'запись риск-таблицы восстановлена');

    // Сводные пересобраны каскадом (id новые — auto-derived, важно лишь наличие).
    const metricsBack = n51.children.find(c => c.kind === 'metrics');
    const mainBack = AppState.findNodeById('5').children.find(c => c.kind === 'mainMetrics');
    assert.ok(metricsBack, 'per-point сводная пересобрана каскадом');
    assert.ok(mainBack, 'главная сводная пересобрана каскадом');

    assertIndexConsistent('каскад undo');
    assertNoIndexMiss();
});

test('удаление item-поддерева с риск-таблицей: восстановление + пересборка сводных', () => {
    AppState.initializeTree(true);
    const { n51, n511, riskNode } = buildSection5Cluster();
    const riskTableId = riskNode.tableId;

    // Удаляем 5.1.1 целиком (риск внутри) — каскад снесёт сводные.
    assert.ok(AppState.deleteNode(n511.id));
    assert.equal(AppState.findNodeById(n511.id), null);
    assert.equal(AppState.tables[riskTableId], undefined, 'запись риск-таблицы снесена с поддеревом');

    assert.ok(UndoDeleteManager.undoLast());

    // Поддерево с риском вернулось под своими id.
    assert.ok(AppState.findNodeById(n511.id), 'подпункт 5.1.1 восстановлен');
    assert.ok(AppState.findNodeById(riskNode.id), 'риск-таблица восстановлена под исходным id');
    assert.ok(AppState.tables[riskTableId], 'запись риск-таблицы восстановлена');

    // Сводные пересобраны каскадом.
    assert.ok(n51.children.find(c => c.kind === 'metrics'), 'per-point сводная пересобрана');
    assert.ok(AppState.findNodeById('5').children.find(c => c.kind === 'mainMetrics'), 'главная сводная пересобрана');

    assertIndexConsistent('каскад item undo');
    assertNoIndexMiss();
});

// ── Регрессия FINDINGS 1+4: правки соседних §5-таблиц переживают откат ────────

test('правки соседней §5-таблицы НЕ откатываются при undo удаления риск-таблицы', () => {
    AppState.initializeTree(true);
    // Первый §5-кластер (5.1 → 5.1.1 с риском + сводные).
    const { riskNode } = buildSection5Cluster();

    // Соседняя §5-ветка 5.2 → 5.2.1 со своей риск-таблицей и своими сводными.
    const n52 = addItem('5', 'Пункт 5.2');
    const n521 = addItem(n52.id, 'Подпункт 5.2.1');
    AppState.generateNumbering();
    assert.ok(AppState._createRegularRiskTable(n521.id).valid);
    AppState.generateNumbering();
    assert.ok(MetricsRiskCoordinator.onRiskTableAdded(n521.id));

    const survivorRisk = n521.children.find(c => c.kind === 'regularRisk');
    assert.ok(survivorRisk, 'риск-таблица соседней ветки создана');
    const survivorTableId = survivorRisk.tableId;

    // Удаляем риск-таблицу ПЕРВОЙ ветки (это снесёт её сводные каскадом).
    assert.ok(AppState.deleteNode(riskNode.id));
    assert.equal(AppState.findNodeById(riskNode.id), null);

    // МЕЖДУ удалением и откатом редактируем СОСЕДНЮЮ (выжившую) §5-таблицу:
    //  - структурная правка узла (метка),
    //  - правка содержимого словаря (ячейка грида).
    const survivorNode = AppState.findNodeById(survivorRisk.id);
    survivorNode.label = 'ОТРЕДАКТИРОВАНО метка';
    AppState.tables[survivorTableId].grid[0][0].content = 'ОТРЕДАКТИРОВАНО ячейка';

    // Откатываем удаление риск-таблицы первой ветки.
    assert.ok(UndoDeleteManager.undoLast());

    // Правки соседней §5-таблицы СОХРАНЕНЫ (не откачены вместе с undo).
    assert.equal(
        AppState.findNodeById(survivorRisk.id).label,
        'ОТРЕДАКТИРОВАНО метка',
        'структурная правка соседней §5-таблицы должна сохраниться'
    );
    assert.equal(
        AppState.tables[survivorTableId].grid[0][0].content,
        'ОТРЕДАКТИРОВАНО ячейка',
        'правка содержимого соседней §5-таблицы должна сохраниться'
    );

    // Удалённый риск вернулся, сводные на месте.
    assert.ok(AppState.findNodeById(riskNode.id), 'риск первой ветки восстановлен');
    assert.ok(AppState.findNodeById('5').children.find(c => c.kind === 'mainMetrics'), 'главная сводная на месте');

    // Raw-lookup'ы резолвят все восстановленные id, индекс консистентен.
    assert.ok(AppState._findNodeRaw(riskNode.id), 'raw-lookup риск-узла');
    assert.ok(AppState._findNodeRaw(survivorRisk.id), 'raw-lookup выжившего риск-узла');
    assertIndexConsistent('соседняя §5 после undo');
    assertNoIndexMiss();
});

// ── Чистое ядро: TreeUtils.collectSubtreeDictEntries ─────────────────────────

test('TreeUtils.collectSubtreeDictEntries собирает записи словарей всех листьев поддерева', () => {
    AppState.initializeTree(true);
    const item = addItem('4');
    AppState.addTableToNode(item.id);
    AppState.addTextBlockToNode(item.id);
    AppState.addViolationToNode(item.id);

    const rawDicts = {
        tables: AppState.tables,
        textBlocks: AppState.textBlocks,
        violations: AppState.violations,
    };
    const entries = TreeUtils.collectSubtreeDictEntries(item, rawDicts);

    assert.equal(Object.keys(entries.tables).length, 1);
    assert.equal(Object.keys(entries.textBlocks).length, 1);
    assert.equal(Object.keys(entries.violations).length, 1);

    // Deep-копии: мутация снимка не трогает живой словарь.
    const tableId = Object.keys(entries.tables)[0];
    entries.tables[tableId].grid = null;
    assert.notEqual(AppState.tables[tableId].grid, null);
});

// ── Notifications: action-toast ──────────────────────────────────────────────

test('уведомления с action-кнопкой не группируются, обычные — группируются', () => {
    const id1 = Notifications.show('Элемент удалён', 'info', 50, {
        action: { label: 'Отменить', onClick: () => {} },
    });
    const id2 = Notifications.show('Элемент удалён', 'info', 50, {
        action: { label: 'Отменить', onClick: () => {} },
    });
    assert.notEqual(id1, id2, 'action-toast — всегда новое уведомление');

    const id3 = Notifications.show('Просто текст', 'info', 50);
    const id4 = Notifications.show('Просто текст', 'info', 50);
    assert.equal(id3, id4, 'обычные уведомления группируются по тексту');

    Notifications.hideAll();
});
