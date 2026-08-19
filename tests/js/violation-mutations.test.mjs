/**
 * Тесты единого мутатора нарушения (violation-mutations.js) — блочная модель.
 *
 * Мутатор — единственная точка записи в объект violation из формы: каждый
 * метод сперва зовёт ValidationCore.requireWrite('cannotEdit'); в режиме
 * просмотра запись НЕ происходит и возвращается false. Здесь проверяется
 * ЛОГИКА мутатора без DOM: запись в правильное место, тип превью-вызова
 * (scheduleTypingBlock для печатного ввода / updateBlock для дискретных
 * действий), read-only-guard, адресация блоков по id и валидация fieldOrder.
 *
 * Реальные модули (ValidationCore читает AppConfig, PreviewManager) грузятся
 * под node:test через _browser-stub; превью-статики подменяются шпионами.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { violationMutations as mutations, findBlock } from '../../static/js/constructor/violation/violation-mutations.js';
import { createDefaultViolationShape } from '../../static/js/constructor/violation/violation-normalize.js';
import { createTextBlock, createImageBlock, createTableBlock } from '../../static/js/constructor/violation/violation-block-types.js';
import { VIOLATION_FIELD_KEYS } from '../../static/js/constructor/violation/violation-fields.js';

// Шпионы превью: записываем какой статик и с какими аргументами был вызван.
let previewCalls = [];
PreviewManager.scheduleTypingBlock = (type, id) => previewCalls.push({ fn: 'scheduleTypingBlock', type, id });
PreviewManager.updateBlock = (type, id) => previewCalls.push({ fn: 'updateBlock', type, id });

function reset(readOnly = false) {
    previewCalls = [];
    AppConfig.readOnlyMode.isReadOnly = readOnly;
}

function makeViolation() {
    return { id: 'v1', nodeId: 'n1', ...createDefaultViolationShape() };
}

// --- setFieldEnabled ---

test('setFieldEnabled включает поле и планирует discrete-превью', () => {
    reset();
    const v = makeViolation();
    const ok = mutations.setFieldEnabled.call({}, v, 'reasons', true);
    assert.equal(ok, true);
    assert.equal(v.reasons.enabled, true);
    assert.deepEqual(previewCalls, [{ fn: 'updateBlock', type: 'violation', id: 'v1' }]);
});

test('setFieldEnabled не выключает mandatory-поля (Нарушено/Установлено)', () => {
    reset();
    const v = makeViolation();
    assert.equal(mutations.setFieldEnabled.call({}, v, 'violated', false), false);
    assert.equal(v.violated.enabled, true, 'violated остался включён');
    assert.equal(mutations.setFieldEnabled.call({}, v, 'established', false), false);
    assert.equal(previewCalls.length, 0);
});

test('setFieldEnabled блокируется в read-only', () => {
    reset(true);
    const v = makeViolation();
    assert.equal(mutations.setFieldEnabled.call({}, v, 'reasons', true), false);
    assert.equal(v.reasons.enabled, false);
});

// --- setFieldOrder ---

test('setFieldOrder принимает валидную перестановку и копирует массив', () => {
    reset();
    const v = makeViolation();
    const order = [...VIOLATION_FIELD_KEYS].reverse();
    const ok = mutations.setFieldOrder.call({}, v, order);
    assert.equal(ok, true);
    assert.deepEqual(v.fieldOrder, order);
    assert.notEqual(v.fieldOrder, order, 'хранится копия, не ссылка');
    assert.deepEqual(previewCalls, [{ fn: 'updateBlock', type: 'violation', id: 'v1' }]);
});

test('setFieldOrder(null) возвращает стандартный порядок', () => {
    reset();
    const v = makeViolation();
    v.fieldOrder = [...VIOLATION_FIELD_KEYS].reverse();
    assert.equal(mutations.setFieldOrder.call({}, v, null), true);
    assert.equal(v.fieldOrder, null);
});

test('setFieldOrder отклоняет неполный/дублирующий/чужой порядок', () => {
    reset();
    const v = makeViolation();
    assert.equal(mutations.setFieldOrder.call({}, v, VIOLATION_FIELD_KEYS.slice(1)), false);
    assert.equal(mutations.setFieldOrder.call({}, v, [...VIOLATION_FIELD_KEYS.slice(0, 9), 'violated']), false);
    assert.equal(mutations.setFieldOrder.call({}, v, [...VIOLATION_FIELD_KEYS.slice(0, 9), 'alien']), false);
    assert.equal(v.fieldOrder, null);
    assert.equal(previewCalls.length, 0);
});

// --- addBlock / removeBlock / findBlock ---

test('addBlock вставляет блок в конец и по индексу', () => {
    reset();
    const v = makeViolation();
    const b1 = createTextBlock('первый');
    const b2 = createTextBlock('второй');
    const b3 = createTextBlock('между');
    assert.equal(mutations.addBlock.call({}, v, 'violated', b1), true);
    assert.equal(mutations.addBlock.call({}, v, 'violated', b2), true);
    assert.equal(mutations.addBlock.call({}, v, 'violated', b3, 1), true);
    assert.deepEqual(v.violated.blocks.map(b => b.content), ['первый', 'между', 'второй']);
    assert.equal(previewCalls.length, 3);
    assert.ok(previewCalls.every(c => c.fn === 'updateBlock'));
});

test('removeBlock удаляет блок по id; несуществующий id → false', () => {
    reset();
    const v = makeViolation();
    const b = createImageBlock({ url: 'data:image/png;base64,AAAA' });
    mutations.addBlock.call({}, v, 'additionalContent', b);
    assert.equal(mutations.removeBlock.call({}, v, 'additionalContent', b.id), true);
    assert.deepEqual(v.additionalContent.blocks, []);
    assert.equal(mutations.removeBlock.call({}, v, 'additionalContent', 'нет-такого'), false);
});

test('findBlock находит блок по id и не падает на повреждённом контейнере', () => {
    const v = makeViolation();
    const b = createTableBlock();
    v.codeMining.blocks.push(b);
    assert.equal(findBlock(v, 'codeMining', b.id), b);
    assert.equal(findBlock(v, 'codeMining', 'нет'), null);
    assert.equal(findBlock(v, 'нет-поля', b.id), null);
    assert.equal(findBlock({ codeMining: { blocks: 'мусор' } }, 'codeMining', b.id), null);
});

// --- setBlockField ---

test('setBlockField пишет content с typing-превью, width — с discrete', () => {
    reset();
    const v = makeViolation();
    const text = createTextBlock('');
    const image = createImageBlock({});
    mutations.addBlock.call({}, v, 'violated', text);
    mutations.addBlock.call({}, v, 'additionalContent', image);
    previewCalls = [];

    assert.equal(mutations.setBlockField.call({}, v, 'violated', text.id, 'content', '<p>x</p>'), true);
    assert.equal(text.content, '<p>x</p>');
    assert.equal(previewCalls[0].fn, 'scheduleTypingBlock');

    assert.equal(mutations.setBlockField.call({}, v, 'additionalContent', image.id, 'caption', 'подпись'), true);
    assert.equal(previewCalls[1].fn, 'scheduleTypingBlock');

    assert.equal(mutations.setBlockField.call({}, v, 'additionalContent', image.id, 'width', 50), true);
    assert.equal(image.width, 50);
    assert.equal(previewCalls[2].fn, 'updateBlock');
});

test('setBlockField на несуществующем блоке → false без превью', () => {
    reset();
    const v = makeViolation();
    assert.equal(mutations.setBlockField.call({}, v, 'violated', 'нет', 'content', 'x'), false);
    assert.equal(previewCalls.length, 0);
});

// Мутатора setTableCell больше нет: встроенная таблица обслуживается общей
// машинерией таблиц (table-cells-operations + cell-write-through), которая
// пишет в grid напрямую по адресу resolveTable, а read-only отсекают гейты
// startEditingCell / ContextMenuManager.show — как у узловых таблиц.

// --- moveBlocks (DnD внутри поля; пачка из одного блока — тот же путь) ---

test('moveBlocks переставляет одиночный блок вниз с поправкой toIndex', () => {
    reset();
    const v = makeViolation();
    const [a, b, c] = [createTextBlock('A'), createTextBlock('B'), createTextBlock('C')];
    v.reasons.blocks.push(a, b, c);
    // Тащим A (index 0) на позицию 2 (перед C в исходном массиве).
    assert.equal(mutations.moveBlocks.call({}, v, 'reasons', [a.id], 2), true);
    assert.deepEqual(v.reasons.blocks.map(x => x.content), ['B', 'A', 'C']);
});

test('moveBlocks: неизвестные id → false', () => {
    reset();
    const v = makeViolation();
    assert.equal(mutations.moveBlocks.call({}, v, 'reasons', ['нет-такого'], 1), false);
});

test('moveBlocks блокируется в read-only', () => {
    reset(true);
    const v = makeViolation();
    const [a, b] = [createTextBlock('A'), createTextBlock('B')];
    v.reasons.blocks.push(a, b);
    assert.equal(mutations.moveBlocks.call({}, v, 'reasons', [a.id], 2), false);
    assert.deepEqual(v.reasons.blocks.map(x => x.content), ['A', 'B']);
});

// --- Read-only guard на всём API ---

test('в read-only все мутации возвращают false и не трогают данные', () => {
    reset(true);
    const v = makeViolation();
    const block = createTextBlock('x');
    assert.equal(mutations.addBlock.call({}, v, 'violated', block), false);
    assert.equal(mutations.removeBlock.call({}, v, 'violated', 'id'), false);
    assert.equal(mutations.setBlockField.call({}, v, 'violated', 'id', 'content', 'y'), false);
    assert.equal(mutations.setFieldOrder.call({}, v, null), false);
    assert.deepEqual(v.violated.blocks, []);
    assert.equal(previewCalls.length, 0);
});
