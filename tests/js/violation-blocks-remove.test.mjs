/**
 * Read-only guard для удаления блока поля нарушения (код-ревью #11).
 *
 * Раньше context-menu-violation.js сплайсил элементы доп.контента НАПРЯМУЮ без
 * вызова ValidationCore.requireWrite — безопасно было только потому, что пункт
 * меню «Удалить» не рендерится в read-only-режиме (внешняя защита). Теперь
 * удаление идёт через мутатор removeBlock (guard внутри), а
 * removeBlockFromField добавляет к нему снятие rich-контроллера и перерисовку
 * контейнера поля.
 *
 * Реальные модули конструктора импортируются под node:test через
 * _browser-stub (см. конвенцию в violation-blocks-limit.test.mjs).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import { BLOCK_TYPES } from '../../static/js/constructor/violation/violation-block-types.js';

// Шпион: собираем вызовы превью вместо реального side-эффекта.
let previewCalls = [];
PreviewManager.updateBlock = (type, id) => previewCalls.push({ type, id });

const FIELD = 'additionalContent';

function reset(readOnly = false) {
    previewCalls = [];
    AppConfig.readOnlyMode.isReadOnly = readOnly;
}

function makeViolation(blocks) {
    return { id: 'v1', [FIELD]: { enabled: true, blocks } };
}

function block(id) {
    return { id, type: BLOCK_TYPES.TEXT, content: '' };
}

/** Стаб контейнера с рабочим querySelector('.violation-blocks-items'). */
function makeContainer() {
    const itemsContainer = { innerHTML: '', appendChild() {} };
    return {
        querySelector: (sel) => (sel === '.violation-blocks-items' ? itemsContainer : null),
    };
}

/** VM со счётчиками перерисовки и снятия rich-контроллера. */
function makeVm() {
    const vm = new ViolationManager();
    vm._renderCalls = 0;
    vm._teardownCalls = 0;
    vm.renderBlocks = () => { vm._renderCalls += 1; };
    vm._teardownActiveRichField = () => { vm._teardownCalls += 1; };
    return vm;
}

const ids = (v) => v[FIELD].blocks.map((b) => b.id);

test('write-режим: removeBlockFromField удаляет блок по id, ре-рендерит и обновляет превью', () => {
    reset(false);
    const violation = makeViolation([block('a'), block('b'), block('c')]);
    const vm = makeVm();

    const result = vm.removeBlockFromField(violation, FIELD, 'b', makeContainer());

    assert.equal(result, true);
    assert.deepEqual(ids(violation), ['a', 'c']);
    assert.equal(vm._renderCalls, 1, 'ре-рендер вызван ровно один раз');
    assert.deepEqual(previewCalls, [{ type: 'violation', id: 'v1' }]);
});

test('rich-контроллер снимается ДО удаления блока из модели', () => {
    reset(false);
    const violation = makeViolation([block('a')]);
    const vm = makeVm();

    vm.removeBlockFromField(violation, FIELD, 'a', makeContainer());

    assert.equal(vm._teardownCalls, 1, 'unmount поверхности выполнен');
});

test('несуществующий blockId: blocks не меняются, превью не зовётся', () => {
    reset(false);
    const violation = makeViolation([block('a')]);
    const vm = makeVm();

    const result = vm.removeBlockFromField(violation, FIELD, 'missing', makeContainer());

    assert.equal(result, false);
    assert.equal(violation[FIELD].blocks.length, 1);
    assert.equal(vm._renderCalls, 0);
    assert.deepEqual(previewCalls, []);
});

test('read-only: removeBlockFromField не удаляет блок и возвращает false', () => {
    reset(true);
    const violation = makeViolation([block('a'), block('b')]);
    const vm = makeVm();

    const result = vm.removeBlockFromField(violation, FIELD, 'a', makeContainer());

    assert.equal(result, false);
    assert.deepEqual(ids(violation), ['a', 'b'], 'сплайс заблокирован read-only guard\'ом');
    assert.equal(vm._renderCalls, 0);
    assert.deepEqual(previewCalls, []);
});
