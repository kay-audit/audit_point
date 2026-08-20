/**
 * Таблица «Результаты оценки качества процесса» в разделе 2.
 *
 * Создаётся автоматически только для процессной проверки, удаляется как
 * обычный контент и пересоздаётся через пункт контекстного меню
 * (AppState.addQualityAssessmentTable).
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppState } from '../../static/js/constructor/state/state-core.js';
import '../../static/js/constructor/state/state-tree.js';
import '../../static/js/constructor/state/state-content.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { ChangelogTracker } from '../../static/js/constructor/changelog-tracker.js';
import { isPinnedTable } from '../../static/js/constructor/table/table-kind.js';

const QA_LABEL = 'Результаты оценки качества процесса';

beforeEach(() => {
    AppState.treeData = null;
    AppState.tables = {};
    AppState.textBlocks = {};
    AppState.violations = {};
    AppState._rebuildNodeIndex();
    AppConfig.readOnlyMode.isReadOnly = false;
});

/** Узел таблицы оценки качества среди прямых детей раздела 2. */
function qa() {
    const node2 = AppState.findNodeById('2');
    return node2?.children?.find(c => c.special === 'quality_assessment');
}

test('процессная проверка: таблица создаётся с согласованным названием', () => {
    AppState.initializeTree(true);
    const node = qa();
    assert.ok(node, 'таблица оценки качества не найдена в разделе 2');
    assert.equal(node.type, AppConfig.nodeTypes.TABLE);
    assert.equal(node.label, QA_LABEL);
    assert.equal(node.customLabel, QA_LABEL);
});

test('таблица защищена от перемещения, но удаляема', () => {
    AppState.initializeTree(true);
    const node = qa();
    assert.equal(node.protected, true);
    assert.equal(node.deletable, true);
});

test('таблица не закреплена вверху children (kind остаётся regular)', () => {
    AppState.initializeTree(true);
    const node = qa();
    assert.equal(node.kind, undefined);
    assert.equal(isPinnedTable(node), false);
});

test('непроцессная проверка: таблица не создаётся', () => {
    AppState.initializeTree(false);
    assert.equal(qa(), undefined);
    assert.deepEqual(AppState.findNodeById('2').children, []);
});

test('пресет таблицы совпадает с AppConfig', () => {
    AppState.initializeTree(true);
    const preset = AppConfig.content.tablePresets.qualityAssessment;
    const table = AppState.tables[qa().tableId];
    assert.ok(table, 'объект таблицы не создан');
    assert.equal(table.grid.length, preset.rows + 1);
    assert.deepEqual(table.grid[0].map(cell => cell.content), preset.headers);
});

test('оба гейта удаления пропускают таблицу', () => {
    AppState.initializeTree(true);
    const node = qa();
    // UI-гейт (context-menu-tree.js::handleDelete) — только deletable === false.
    assert.equal(node.deletable === false, false, 'UI-гейт отбил бы удаление');
    // Гейт состояния (state-tree.js::deleteNode) — строже: protected без
    // явного deletable === true тоже отбивает.
    assert.equal(
        (node.protected && node.deletable !== true) || node.deletable === false,
        false,
        'гейт состояния отбил бы удаление',
    );
});

test('таблицу можно удалить штатным deleteNode', () => {
    AppState.initializeTree(true);
    const node = qa();
    const tableId = node.tableId;
    assert.equal(AppState.deleteNode(node.id), true);
    assert.equal(qa(), undefined);
    assert.equal(AppState.tables[tableId], undefined);
});

test('addQualityAssessmentTable отбивает повторное создание', () => {
    AppState.initializeTree(true);
    const res = AppState.addQualityAssessmentTable();
    assert.equal(res.valid, false);
    assert.match(res.message, /уже/i);
    assert.equal(AppState.findNodeById('2').children.filter(
        c => c.special === 'quality_assessment',
    ).length, 1);
});

test('после удаления таблицу можно создать заново', () => {
    AppState.initializeTree(true);
    assert.equal(AppState.deleteNode(qa().id), true);

    const res = AppState.addQualityAssessmentTable();
    assert.ok(res.valid, res.message);

    const node = qa();
    assert.ok(node, 'таблица не пересоздана');
    assert.equal(node.customLabel, QA_LABEL);
    assert.equal(node.protected, true);
    assert.equal(node.deletable, true);
    assert.ok(AppState.tables[node.tableId], 'объект таблицы не создан');
});

test('пересозданная таблица встаёт в начало раздела 2', () => {
    AppState.initializeTree(true);
    assert.equal(AppState.deleteNode(qa().id), true);
    assert.ok(AppState.addTextBlockToNode('2').valid);

    assert.ok(AppState.addQualityAssessmentTable().valid);
    assert.equal(AppState.findNodeById('2').children[0].special, 'quality_assessment');
});

test('таблицу нельзя создать в непроцессном акте вне раздела 2', () => {
    AppState.initializeTree(false);
    const res = AppState.addQualityAssessmentTable();
    assert.ok(res.valid, res.message);
    assert.equal(AppState.findNodeById('2').children[0].special, 'quality_assessment');
});

test('в режиме только чтения создание запрещено', () => {
    AppState.initializeTree(true);
    assert.equal(AppState.deleteNode(qa().id), true);
    AppConfig.readOnlyMode.isReadOnly = true;
    try {
        assert.equal(AppState.addQualityAssessmentTable().valid, false);
        assert.equal(qa(), undefined);
    } finally {
        AppConfig.readOnlyMode.isReadOnly = false;
    }
});

test('addQualityAssessmentTable пишет запись add_table в changelog', () => {
    AppState.initializeTree(true);
    assert.equal(AppState.deleteNode(qa().id), true);

    const calls = [];
    const orig = ChangelogTracker.record;
    ChangelogTracker.record = (...a) => calls.push(a);
    try {
        AppState.addQualityAssessmentTable();
    } finally {
        ChangelogTracker.record = orig;
    }
    assert.ok(
        calls.some(([op, , label]) => op === 'add_table' && label === QA_LABEL),
        'нет записи add_table для таблицы оценки качества',
    );
});

test('сериализация сохраняет маркер special таблицы', () => {
    AppState.initializeTree(true);
    const exported = AppState.exportData();
    const section2 = exported.tree.children.find(c => c.id === '2');
    const serialized = section2.children.find(c => c.special === 'quality_assessment');
    assert.ok(serialized, 'маркер special потерян при сериализации');
    assert.equal(serialized.customLabel, QA_LABEL);
    assert.equal(serialized.deletable, true);
    assert.equal(serialized.protected, true);
});
