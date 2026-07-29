/**
 * Тесты единого мутатора полей нарушения (violation-mutations.js, #33 + #1).
 *
 * Мутатор — единственная точка записи в объект violation из формы: каждый
 * метод сперва зовёт ValidationCore.requireWrite('cannotEdit'); в режиме
 * просмотра запись НЕ происходит и возвращается false. Здесь проверяется
 * ЛОГИКА мутатора без DOM: запись в правильное место, тип превью-вызова
 * (scheduleTypingBlock для печатного ввода / updateBlock для дискретных
 * действий) и read-only-guard.
 *
 * Реальные модули (ValidationCore читает AppConfig, PreviewManager) грузятся
 * под node:test через _browser-stub; превью-статики подменяются шпионами.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { violationMutations as mutations, parseFieldPath } from '../../static/js/constructor/violation/violation-mutations.js';

// Шпионы превью: записываем какой статик и с какими аргументами был вызван.
let previewCalls = [];
PreviewManager.scheduleTypingBlock = (type, id) => previewCalls.push({ fn: 'scheduleTypingBlock', type, id });
PreviewManager.updateBlock = (type, id) => previewCalls.push({ fn: 'updateBlock', type, id });

function reset(readOnly = false) {
    previewCalls = [];
    AppConfig.readOnlyMode.isReadOnly = readOnly;
}

function makeViolation() {
    return {
        id: 'v1',
        violated: '',
        established: '',
        descriptionList: { enabled: false, items: [] },
        additionalContent: { enabled: false, items: [] },
        reasons: { enabled: false, content: '' },
        consequences: { enabled: false, content: '' },
        responsible: { enabled: false, content: '' },
        measures: { enabled: false, content: '' },
    };
}

// --- parseFieldPath (V23): общий разбор пути для read (_readViolationField, ---
// violation-field-surface.js) и write (setViolationField ниже) -------------

test('parseFieldPath: плоский путь → key, subKey=null', () => {
    assert.deepEqual(parseFieldPath('violated'), { key: 'violated', subKey: null });
});

test('parseFieldPath: точечный путь → key + subKey', () => {
    assert.deepEqual(parseFieldPath('reasons.content'), { key: 'reasons', subKey: 'content' });
    assert.deepEqual(parseFieldPath('descriptionList.enabled'), { key: 'descriptionList', subKey: 'enabled' });
});

// --- setViolationField: плоские пути (печатный ввод → scheduleTypingBlock) ---

test('setViolationField пишет плоское поле violated и планирует typing-превью', () => {
    reset();
    const v = makeViolation();
    const ok = mutations.setViolationField.call({}, v, 'violated', 'текст нарушения');
    assert.equal(ok, true);
    assert.equal(v.violated, 'текст нарушения');
    assert.deepEqual(previewCalls, [{ fn: 'scheduleTypingBlock', type: 'violation', id: 'v1' }]);
});

test('setViolationField пишет established', () => {
    reset();
    const v = makeViolation();
    mutations.setViolationField.call({}, v, 'established', 'что установлено');
    assert.equal(v.established, 'что установлено');
    assert.equal(previewCalls[0].fn, 'scheduleTypingBlock');
});

// --- setViolationField: точечные пути *.content (typing) и *.enabled (discrete) ---

test('setViolationField пишет reasons.content и планирует typing-превью', () => {
    reset();
    const v = makeViolation();
    const ok = mutations.setViolationField.call({}, v, 'reasons.content', 'причина');
    assert.equal(ok, true);
    assert.equal(v.reasons.content, 'причина');
    assert.equal(v.reasons.enabled, false, 'соседний флаг не тронут');
    assert.deepEqual(previewCalls, [{ fn: 'scheduleTypingBlock', type: 'violation', id: 'v1' }]);
});

test('setViolationField пишет descriptionList.enabled и делает discrete-превью (updateBlock)', () => {
    reset();
    const v = makeViolation();
    const ok = mutations.setViolationField.call({}, v, 'descriptionList.enabled', true);
    assert.equal(ok, true);
    assert.equal(v.descriptionList.enabled, true);
    assert.deepEqual(previewCalls, [{ fn: 'updateBlock', type: 'violation', id: 'v1' }]);
});

test('setViolationField: consequences.enabled → updateBlock, responsible.content → typing', () => {
    reset();
    const v = makeViolation();
    mutations.setViolationField.call({}, v, 'consequences.enabled', true);
    assert.equal(v.consequences.enabled, true);
    assert.equal(previewCalls[0].fn, 'updateBlock');

    reset();
    mutations.setViolationField.call({}, v, 'responsible.content', 'ответственный');
    assert.equal(v.responsible.content, 'ответственный');
    assert.equal(previewCalls[0].fn, 'scheduleTypingBlock');
});

test('setViolationField пишет additionalContent.enabled → updateBlock', () => {
    reset();
    const v = makeViolation();
    mutations.setViolationField.call({}, v, 'additionalContent.enabled', true);
    assert.equal(v.additionalContent.enabled, true);
    assert.equal(previewCalls[0].fn, 'updateBlock');
});

// --- list-мутаторы descriptionList ---

test('addViolationListItem пушит пустой пункт и делает updateBlock', () => {
    reset();
    const v = makeViolation();
    const ok = mutations.addViolationListItem.call({}, v, 'descriptionList');
    assert.equal(ok, true);
    assert.deepEqual(v.descriptionList.items, ['']);
    assert.equal(previewCalls[0].fn, 'updateBlock');
});

test('setViolationListItem пишет пункт по индексу и делает typing-превью', () => {
    reset();
    const v = makeViolation();
    v.descriptionList.items = ['a', 'b'];
    const ok = mutations.setViolationListItem.call({}, v, 'descriptionList', 1, 'новый');
    assert.equal(ok, true);
    assert.deepEqual(v.descriptionList.items, ['a', 'новый']);
    assert.equal(previewCalls[0].fn, 'scheduleTypingBlock');
});

test('removeViolationListItem удаляет пункт и делает updateBlock', () => {
    reset();
    const v = makeViolation();
    v.descriptionList.items = ['a', 'b', 'c'];
    const ok = mutations.removeViolationListItem.call({}, v, 'descriptionList', 1);
    assert.equal(ok, true);
    assert.deepEqual(v.descriptionList.items, ['a', 'c']);
    assert.equal(previewCalls[0].fn, 'updateBlock');
});

// --- setContentItemField (элемент additionalContent.items[]) ---

test('setContentItemField пишет content → typing, caption → typing, width → updateBlock', () => {
    reset();
    const v = makeViolation();
    const item = { content: '', caption: '', width: 0 };

    let ok = mutations.setContentItemField.call({}, v, item, 'content', 'описание');
    assert.equal(ok, true);
    assert.equal(item.content, 'описание');
    assert.equal(previewCalls.at(-1).fn, 'scheduleTypingBlock');

    ok = mutations.setContentItemField.call({}, v, item, 'caption', 'подпись');
    assert.equal(item.caption, 'подпись');
    assert.equal(previewCalls.at(-1).fn, 'scheduleTypingBlock');

    ok = mutations.setContentItemField.call({}, v, item, 'width', 50);
    assert.equal(item.width, 50);
    assert.equal(previewCalls.at(-1).fn, 'updateBlock');
});

// --- read-only guard: запись НЕ происходит, возвращается false, превью не зовётся ---

test('read-only: setViolationField не пишет и возвращает false', () => {
    reset(true);
    const v = makeViolation();
    const ok = mutations.setViolationField.call({}, v, 'violated', 'нельзя');
    assert.equal(ok, false);
    assert.equal(v.violated, '');
    assert.deepEqual(previewCalls, []);
});

test('read-only: точечный путь reasons.content не пишет', () => {
    reset(true);
    const v = makeViolation();
    const ok = mutations.setViolationField.call({}, v, 'reasons.content', 'нельзя');
    assert.equal(ok, false);
    assert.equal(v.reasons.content, '');
    assert.deepEqual(previewCalls, []);
});

test('read-only: list-мутаторы ничего не меняют и возвращают false', () => {
    reset(true);
    const v = makeViolation();
    v.descriptionList.items = ['a'];
    assert.equal(mutations.addViolationListItem.call({}, v, 'descriptionList'), false);
    assert.equal(mutations.setViolationListItem.call({}, v, 'descriptionList', 0, 'x'), false);
    assert.equal(mutations.removeViolationListItem.call({}, v, 'descriptionList', 0), false);
    assert.deepEqual(v.descriptionList.items, ['a']);
    assert.deepEqual(previewCalls, []);
});

test('read-only: setContentItemField не пишет и возвращает false', () => {
    reset(true);
    const v = makeViolation();
    const item = { content: '', caption: '', width: 0 };
    const ok = mutations.setContentItemField.call({}, v, item, 'content', 'нельзя');
    assert.equal(ok, false);
    assert.equal(item.content, '');
    assert.deepEqual(previewCalls, []);
});
