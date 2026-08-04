/**
 * Тесты перестановки элементов дополнительного контента drag-and-drop'ом
 * (находка аудита #6).
 *
 * Раньше handleDragOver физически двигал элемент в DOM (insertBefore), а
 * handleDrop реконструировал массив ИЗ порядка DOM. При Esc/промахе фантомный
 * сдвиг оставался. Теперь:
 *  - порядок вычисляется index-based splice'ом (перенос item.id к целевому
 *    индексу с поправкой на удаление исходной позиции при движении вниз);
 *  - handleDragEnd без коммита восстанавливает DOM из данных (renderContentItems).
 *
 * Реальные модули импортируются под node:test через _browser-stub; DOM-эффекты
 * (renderContentItems / PreviewManager.updateBlock) застабены.
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

/** Нарушение с items из массива id (тип неважен для перестановки). */
function makeViolation(ids) {
    return {
        id: 'v1',
        additionalContent: {
            items: ids.map((id) => ({ id, type: 'freeText', content: id })),
        },
    };
}

/** Ставит фейковый перетаскиваемый элемент с нужным itemId. */
function setDragging(itemId) {
    document.querySelector = (sel) => (sel === '.dragging' ? { dataset: { itemId } } : null);
}

/** VM с застабленным render (без DOM) и контейнер-заглушка. */
function makeVm() {
    const vm = new ViolationManager();
    let renderCount = 0;
    vm.renderContentItems = () => { renderCount += 1; };
    vm._renderCount = () => renderCount;
    return vm;
}

const noopEvent = () => ({ preventDefault() {}, stopPropagation() {} });
const container = { querySelectorAll: () => [] };

test('drop переставляет элемент вниз (поправка на удаление исходной позиции)', () => {
    previewCalls = 0;
    setDragging('A');
    const vm = makeVm();
    const v = makeViolation(['A', 'B', 'C', 'D']);
    vm.lastDragOverIndex = 3; // вставка после C

    vm.handleDrop(noopEvent(), v, 2, container);

    assert.deepEqual(v.additionalContent.items.map((i) => i.id), ['B', 'C', 'A', 'D']);
    assert.equal(vm._renderCount(), 1, 'один renderContentItems');
    assert.equal(previewCalls, 1, 'один updateBlock');
    assert.equal(vm._dropCommitted, true, 'коммит зафиксирован');
});

test('drop переставляет элемент вверх', () => {
    setDragging('D');
    const vm = makeVm();
    const v = makeViolation(['A', 'B', 'C', 'D']);
    vm.lastDragOverIndex = 1; // перед B

    vm.handleDrop(noopEvent(), v, 1, container);

    assert.deepEqual(v.additionalContent.items.map((i) => i.id), ['A', 'D', 'B', 'C']);
});

test('drop на исходную позицию — массив не меняется (no-op обе половины)', () => {
    setDragging('A');
    const vmTop = makeVm();
    const vTop = makeViolation(['A', 'B', 'C']);
    vmTop.lastDragOverIndex = 0; // перед собой
    vmTop.handleDrop(noopEvent(), vTop, 0, container);
    assert.deepEqual(vTop.additionalContent.items.map((i) => i.id), ['A', 'B', 'C']);

    const vmBottom = makeVm();
    const vBottom = makeViolation(['A', 'B', 'C']);
    vmBottom.lastDragOverIndex = 1; // после себя
    vmBottom.handleDrop(noopEvent(), vBottom, 0, container);
    assert.deepEqual(vBottom.additionalContent.items.map((i) => i.id), ['A', 'B', 'C']);
});

test('drop без lastDragOverIndex использует targetIndex элемента под курсором', () => {
    setDragging('A');
    const vm = makeVm();
    const v = makeViolation(['A', 'B', 'C']);
    vm.lastDragOverIndex = null; // dragover не отработал

    // Курсор на элементе с индексом 2 (C) → вставка на его позицию.
    vm.handleDrop(noopEvent(), v, 2, container);

    // A удалён (from=0), to=2, поправка from<to → to=1 → [B,A,C].
    assert.deepEqual(v.additionalContent.items.map((i) => i.id), ['B', 'A', 'C']);
});

test('§5.10a: в режиме просмотра drop не переставляет и не коммитит (гейт мутатора)', () => {
    previewCalls = 0;
    setDragging('A');
    const vm = makeVm();
    const v = makeViolation(['A', 'B', 'C']);
    vm.lastDragOverIndex = 2;
    vm._dropCommitted = false; // как после handleDragStart

    AppConfig.readOnlyMode.isReadOnly = true;
    try {
        vm.handleDrop(noopEvent(), v, 2, container);
    } finally {
        AppConfig.readOnlyMode.isReadOnly = false;
    }

    assert.deepEqual(v.additionalContent.items.map((i) => i.id), ['A', 'B', 'C'], 'порядок не тронут');
    assert.equal(vm._renderCount(), 0, 'перерисовки нет');
    assert.equal(previewCalls, 0, 'превью не планируется');
    assert.equal(vm._dropCommitted, false, 'коммит не фиксируется — dragEnd восстановит DOM');
});

test('dragEnd без коммита восстанавливает порядок из данных (renderContentItems)', () => {
    const vm = makeVm();
    const v = makeViolation(['A', 'B']);
    vm._dropCommitted = false;

    vm.handleDragEnd(
        { target: { classList: { remove() {} } } },
        v,
        container,
    );

    assert.equal(vm._renderCount(), 1, 'восстановление из данных выполнено');
    assert.equal(vm._dropCommitted, false, 'флаг сброшен');
    assert.equal(vm.lastDragOverIndex, null);
});

test('dragEnd после коммита не перерисовывает повторно', () => {
    const vm = makeVm();
    const v = makeViolation(['A', 'B']);
    vm._dropCommitted = true; // handleDrop уже отрисовал

    vm.handleDragEnd(
        { target: { classList: { remove() {} } } },
        v,
        container,
    );

    assert.equal(vm._renderCount(), 0, 'повторного render нет');
    assert.equal(vm._dropCommitted, false, 'флаг сброшен для следующего drag');
});
