/**
 * Тесты чистой логики блока-таблицы нарушения (violation-table-block.js):
 * инициализация дефолтной сетки и структурные операции строк/столбцов
 * (веса колонок поддерживаются целыми — контракт colWidths: list[int]).
 * DOM-редактор (dblclick/resize) тестируется вручную, как у таблиц
 * конструктора; мутация ячейки — в violation-mutations.test.mjs.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ensureDefaultGrid,
    tableStructureOps,
} from '../../static/js/constructor/violation/violation-table-block.js';

function emptyTable() {
    return { grid: [], colWidths: [] };
}

function filledTable() {
    const t = emptyTable();
    ensureDefaultGrid(t);
    t.grid[0][0].content = 'H1';
    t.grid[1][1].content = 'D2';
    return t;
}

test('ensureDefaultGrid: пустая сетка → 2×2, первая строка — шапка, веса поровну', () => {
    const t = emptyTable();
    assert.equal(ensureDefaultGrid(t), true);
    assert.equal(t.grid.length, 2);
    assert.equal(t.grid[0].length, 2);
    assert.equal(t.grid[0][0].isHeader, true);
    assert.equal(t.grid[1][0].isHeader, undefined);
    assert.deepEqual(t.colWidths, [100, 100]);
});

test('ensureDefaultGrid: непустая сетка не трогается', () => {
    const t = filledTable();
    const snapshot = JSON.parse(JSON.stringify(t));
    assert.equal(ensureDefaultGrid(t), false);
    assert.deepEqual(t, snapshot);
});

test('addRow добавляет строку данных той же ширины', () => {
    const t = filledTable();
    assert.equal(tableStructureOps.addRow(t), true);
    assert.equal(t.grid.length, 3);
    assert.equal(t.grid[2].length, 2);
    assert.equal(t.grid[2][0].isHeader, undefined, 'новая строка — не шапка');
});

test('removeRow не удаляет последнюю строку', () => {
    const t = filledTable();
    assert.equal(tableStructureOps.removeRow(t), true);
    assert.equal(t.grid.length, 1);
    assert.equal(tableStructureOps.removeRow(t), false, 'минимум одна строка');
});

test('addColumn расширяет все строки и вставляет целый вес', () => {
    const t = filledTable();
    t.colWidths = [120, 80];
    assert.equal(tableStructureOps.addColumn(t), true);
    assert.equal(t.grid[0].length, 3);
    assert.equal(t.grid[1].length, 3);
    assert.equal(t.grid[0][2].isHeader, true, 'колонка шапки продолжает шапку');
    assert.equal(t.colWidths.length, 3);
    assert.ok(t.colWidths.every(w => Number.isInteger(w) && w >= 1), 'веса целые ≥ 1');
});

test('removeColumn сжимает все строки и убирает вес; последняя колонка не удаляется', () => {
    const t = filledTable();
    assert.equal(tableStructureOps.removeColumn(t), true);
    assert.equal(t.grid[0].length, 1);
    assert.equal(t.colWidths.length, 1);
    assert.equal(tableStructureOps.removeColumn(t), false, 'минимум одна колонка');
});

test('структурные операции сохраняют содержимое остальных ячеек', () => {
    const t = filledTable();
    tableStructureOps.addRow(t);
    tableStructureOps.addColumn(t);
    assert.equal(t.grid[0][0].content, 'H1');
    assert.equal(t.grid[1][1].content, 'D2');
});
