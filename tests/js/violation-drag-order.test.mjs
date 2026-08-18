/**
 * Тесты перестановки блоков поля нарушения drag-and-drop'ом (находка аудита #6).
 *
 * Порядок вычисляется index-based splice'ом в мутаторе moveBlock (перенос
 * блока по id к целевому индексу с поправкой на удаление исходной позиции при
 * движении вниз); handleDragEnd без коммита восстанавливает DOM из данных
 * (renderBlocks). Блочная модель добавила гейт поля: полезная нагрузка несёт
 * {violationId, fieldKey, blockId}, и drop в контейнер ДРУГОГО поля
 * игнорируется — перенос между полями не поддержан (спека §7).
 *
 * Реальные модули импортируются под node:test через _browser-stub; DOM-эффекты
 * (renderBlocks / PreviewManager.updateBlock) застабены.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';

// Превью не рисуем — считаем вызовы.
let previewCalls = 0;
PreviewManager.updateBlock = () => { previewCalls += 1; };

const FIELD = 'additionalContent';

/** Нарушение с блоками из массива id (тип неважен для перестановки). */
function makeViolation(ids, fieldKey = FIELD) {
    return {
        id: 'v1',
        [fieldKey]: {
            enabled: true,
            blocks: ids.map((id) => ({ id, type: 'text', content: id })),
        },
    };
}

/** Событие drop с полезной нагрузкой перетаскивания. */
function dropEvent(payload) {
    return {
        preventDefault() {},
        stopPropagation() {},
        dataTransfer: {
            getData: (type) => (type === 'application/x-violation-block' ? JSON.stringify(payload) : ''),
        },
    };
}

/** VM с застабленным render (без DOM). */
function makeVm() {
    const vm = new ViolationManager();
    let renderCount = 0;
    vm.renderBlocks = () => { renderCount += 1; };
    vm._renderCount = () => renderCount;
    return vm;
}

const container = { querySelectorAll: () => [] };
const blockIds = (v, fieldKey = FIELD) => v[fieldKey].blocks.map((b) => b.id);

test('drop переставляет блок вниз (поправка на удаление исходной позиции)', () => {
    previewCalls = 0;
    const vm = makeVm();
    const v = makeViolation(['A', 'B', 'C', 'D']);
    vm.lastDragOverIndex = 3; // вставка после C

    vm.handleDrop(dropEvent({ violationId: 'v1', fieldKey: FIELD, blockId: 'A' }), v, FIELD, container);

    assert.deepEqual(blockIds(v), ['B', 'C', 'A', 'D']);
    assert.equal(vm._renderCount(), 1, 'один renderBlocks');
    assert.equal(previewCalls, 1, 'один updateBlock');
    assert.equal(vm._dropCommitted, true, 'коммит зафиксирован');
});

test('drop переставляет блок вверх', () => {
    const vm = makeVm();
    const v = makeViolation(['A', 'B', 'C', 'D']);
    vm.lastDragOverIndex = 1; // перед B

    vm.handleDrop(dropEvent({ violationId: 'v1', fieldKey: FIELD, blockId: 'D' }), v, FIELD, container);

    assert.deepEqual(blockIds(v), ['A', 'D', 'B', 'C']);
});

test('drop на исходную позицию — массив не меняется (no-op обе половины)', () => {
    const vmTop = makeVm();
    const vTop = makeViolation(['A', 'B', 'C']);
    vmTop.lastDragOverIndex = 0; // перед собой
    vmTop.handleDrop(dropEvent({ violationId: 'v1', fieldKey: FIELD, blockId: 'A' }), vTop, FIELD, container);
    assert.deepEqual(blockIds(vTop), ['A', 'B', 'C']);

    const vmBottom = makeVm();
    const vBottom = makeViolation(['A', 'B', 'C']);
    vmBottom.lastDragOverIndex = 1; // после себя
    vmBottom.handleDrop(dropEvent({ violationId: 'v1', fieldKey: FIELD, blockId: 'A' }), vBottom, FIELD, container);
    assert.deepEqual(blockIds(vBottom), ['A', 'B', 'C']);
});

test('drop без единой позиции от dragover ничего не переставляет', () => {
    const vm = makeVm();
    const v = makeViolation(['A', 'B', 'C']);
    vm.lastDragOverIndex = null; // dragover не отработал

    // dragover/drop висят на КОНТЕЙНЕРЕ, и индекса блока под курсором у drop'а
    // больше нет: позицию считает только dragover. Браузер без preventDefault'а
    // в dragover drop и не вызовет, поэтому досчитывать нечего — молчим.
    vm.handleDrop(dropEvent({ violationId: 'v1', fieldKey: FIELD, blockId: 'A' }), v, FIELD, container);

    assert.deepEqual(blockIds(v), ['A', 'B', 'C'], 'порядок не тронут');
    assert.equal(vm._renderCount(), 0, 'перерисовки нет');
});

test('drop блока ЧУЖОГО поля игнорируется (перенос между полями — non-goal)', () => {
    previewCalls = 0;
    const vm = makeVm();
    const v = makeViolation(['A', 'B', 'C']);
    v.reasons = { enabled: true, blocks: [{ id: 'R1', type: 'text', content: '' }] };
    vm.lastDragOverIndex = 0;

    vm.handleDrop(
        dropEvent({ violationId: 'v1', fieldKey: 'reasons', blockId: 'R1' }),
        v, FIELD, container,
    );

    assert.deepEqual(blockIds(v), ['A', 'B', 'C'], 'целевое поле не тронуто');
    assert.deepEqual(blockIds(v, 'reasons'), ['R1'], 'исходное поле не тронуто');
    assert.equal(vm._renderCount(), 0, 'перерисовки нет');
    assert.equal(previewCalls, 0, 'превью не планируется');
});

test('drop блока ДРУГОГО нарушения игнорируется', () => {
    const vm = makeVm();
    const v = makeViolation(['A', 'B']);

    vm.handleDrop(
        dropEvent({ violationId: 'v2', fieldKey: FIELD, blockId: 'A' }),
        v, FIELD, container,
    );

    assert.deepEqual(blockIds(v), ['A', 'B']);
    assert.equal(vm._renderCount(), 0);
});

test('§5.10a: в режиме просмотра drop не переставляет и не коммитит (гейт мутатора)', () => {
    previewCalls = 0;
    const vm = makeVm();
    const v = makeViolation(['A', 'B', 'C']);
    vm.lastDragOverIndex = 2;
    vm._dropCommitted = false; // как после handleDragStart

    AppConfig.readOnlyMode.isReadOnly = true;
    try {
        vm.handleDrop(dropEvent({ violationId: 'v1', fieldKey: FIELD, blockId: 'A' }), v, FIELD, container);
    } finally {
        AppConfig.readOnlyMode.isReadOnly = false;
    }

    assert.deepEqual(blockIds(v), ['A', 'B', 'C'], 'порядок не тронут');
    assert.equal(vm._renderCount(), 0, 'перерисовки нет');
    assert.equal(previewCalls, 0, 'превью не планируется');
    assert.equal(vm._dropCommitted, false, 'коммит не фиксируется — dragEnd восстановит DOM');
});

test('dragEnd без коммита восстанавливает порядок из данных (renderBlocks)', () => {
    const vm = makeVm();
    const v = makeViolation(['A', 'B']);
    vm._dropCommitted = false;
    vm._dragPayload = { violationId: 'v1', fieldKey: FIELD, blockId: 'A' };

    vm.handleDragEnd(
        { target: { classList: { remove() {} } } },
        v,
        FIELD,
        container,
    );

    assert.equal(vm._renderCount(), 1, 'восстановление из данных выполнено');
    assert.equal(vm._dropCommitted, false, 'флаг сброшен');
    assert.equal(vm.lastDragOverIndex, null);
    assert.equal(vm._dragPayload, null, 'снимок перетаскивания снят');
});

test('dragEnd после коммита не перерисовывает повторно', () => {
    const vm = makeVm();
    const v = makeViolation(['A', 'B']);
    vm._dropCommitted = true; // handleDrop уже отрисовал

    vm.handleDragEnd(
        { target: { classList: { remove() {} } } },
        v,
        FIELD,
        container,
    );

    assert.equal(vm._renderCount(), 0, 'повторного render нет');
    assert.equal(vm._dropCommitted, false, 'флаг сброшен для следующего drag');
});
