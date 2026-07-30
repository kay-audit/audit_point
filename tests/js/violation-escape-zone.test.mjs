/**
 * Тесты сброса активной зоны нарушений по ESC через EscapeStack
 * (находка аудита violation-5).
 *
 * Раньше ViolationManager вешал собственный document-listener на Escape в
 * обход EscapeStack — при открытом оверлее (диалог/меню) сброс зоны не
 * конфликтовал только за счёт stopImmediatePropagation стека. Теперь зона
 * регистрируется в стеке при активации (мышь в контейнере) и снимается при
 * деактивации/destroy — LIFO-семантика общая для всех ESC-слоёв.
 *
 * Реальные модули конструктора импортируются под node:test через
 * _browser-stub (см. конвенцию в _browser-stub.mjs).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EscapeStack } from '../../static/js/shared/escape-stack.js';
import { Notifications } from '../../static/js/shared/notifications.js';
// Входная точка графа нарушений — как в entries/constructor.js: violation-init
// разруливает циклические импорты (core ↔ расширения прототипа).
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';

// Notifications.info рисует toast с таймерами авто-скрытия — в тестах глушим.
Notifications.info = () => {};

function drainStack() {
    while (EscapeStack.size() > 0) {
        EscapeStack._stack.pop();
    }
}

test('активация зоны кладёт ровно один хэндлер в EscapeStack (идемпотентно)', () => {
    drainStack();
    const vm = new ViolationManager();
    const container = { id: 'zone' };

    vm._setActiveZone(container);
    assert.equal(EscapeStack.size(), 1);
    assert.equal(vm.currentActiveContainer, container);

    // Повторный mouseenter того же/другого контейнера не плодит хэндлеры.
    vm._setActiveZone(container);
    vm._setActiveZone({ id: 'zone2' });
    assert.equal(EscapeStack.size(), 1);
});

test('ESC (вызов верхнего хэндлера стека) сбрасывает зону и снимает хэндлер', () => {
    drainStack();
    const vm = new ViolationManager();
    vm._setActiveZone({ id: 'zone' });
    vm.cursorInsertPosition = 2;

    const top = EscapeStack._stack[EscapeStack._stack.length - 1];
    top({ key: 'Escape' });

    assert.equal(vm.currentActiveContainer, null);
    assert.equal(vm.cursorInsertPosition, null);
    assert.equal(EscapeStack.size(), 0);
});

test('деактивация зоны (mouseleave/чекбокс) снимает хэндлер со стека', () => {
    drainStack();
    const vm = new ViolationManager();
    vm._setActiveZone({ id: 'zone' });
    assert.equal(EscapeStack.size(), 1);

    vm._resetActiveZone();
    assert.equal(EscapeStack.size(), 0);
    assert.equal(vm.currentActiveContainer, null);

    // Повторный сброс идемпотентен.
    vm._resetActiveZone();
    assert.equal(EscapeStack.size(), 0);
});

test('destroy() снимает хэндлер зоны со стека', () => {
    drainStack();
    const vm = new ViolationManager();
    vm._setActiveZone({ id: 'zone' });

    vm.destroy();

    assert.equal(EscapeStack.size(), 0);
    assert.equal(vm.currentActiveContainer, null);
});

// ── removeViolation: сброс активной зоны при удалении нарушения (#23) ──────────

/** Контейнер с рабочим querySelector('.additional-content-items').dataset.violationId. */
function makeZone(violationId) {
    const itemsContainer = { dataset: { violationId } };
    return { querySelector: (s) => (s === '.additional-content-items' ? itemsContainer : null) };
}

test('#23: removeViolation сбрасывает активную зону, если она принадлежала удаляемому нарушению', () => {
    drainStack();
    const vm = new ViolationManager();
    vm._setActiveZone(makeZone('v1'));
    assert.equal(EscapeStack.size(), 1);

    vm.removeViolation('v1');

    assert.equal(vm.currentActiveContainer, null, 'активная зона сброшена');
    assert.equal(vm.cursorInsertPosition, null);
    assert.equal(EscapeStack.size(), 0, 'ESC-хэндлер снят со стека');
});

test('#23: removeViolation ЧУЖОГО нарушения не трогает активную зону текущего', () => {
    drainStack();
    const vm = new ViolationManager();
    const zone = makeZone('v1');
    vm._setActiveZone(zone);

    vm.removeViolation('v2');

    assert.equal(vm.currentActiveContainer, zone, 'зона другого нарушения не сброшена');
    assert.equal(EscapeStack.size(), 1);
});

test('#23: removeViolation без активной зоны не падает', () => {
    drainStack();
    const vm = new ViolationManager();

    assert.doesNotThrow(() => vm.removeViolation('v1'));
    assert.equal(vm.currentActiveContainer, null);
});

// ── §5.9: смысл ESC определяет фокус, а не положение мыши ────────────────────

/** Вызывает верхний хэндлер стека, собирая info-тосты и возвращая его вердикт. */
function fireTopHandler(activeElement) {
    const infos = [];
    const origInfo = Notifications.info;
    Notifications.info = (m) => infos.push(m);
    document.activeElement = activeElement;
    try {
        const top = EscapeStack._stack[EscapeStack._stack.length - 1];
        return { result: top({ key: 'Escape' }), infos };
    } finally {
        Notifications.info = origInfo;
        document.activeElement = null;
    }
}

test('§5.9: каретка в rich-поле → зона отдаёт ESC редактору (passthrough), зона цела', () => {
    drainStack();
    const vm = new ViolationManager();
    const zone = makeZone('v1');
    vm._setActiveZone(zone);

    const inEditor = { tagName: 'SPAN', closest: (s) => (s === '[contenteditable="true"]' ? {} : null) };
    const { result, infos } = fireTopHandler(inEditor);

    assert.equal(result, false, 'строго false — EscapeStack пропустит ESC дальше к редактору');
    assert.equal(vm.currentActiveContainer, zone, 'зона НЕ сброшена');
    assert.equal(EscapeStack.size(), 1, 'хэндлер зоны остался в стеке');
    assert.deepEqual(infos, [], 'тост о сбросе зоны не показан');
});

test('§5.9: каретка в textarea/input → тот же passthrough', () => {
    drainStack();
    const vm = new ViolationManager();
    vm._setActiveZone(makeZone('v1'));

    assert.equal(fireTopHandler({ tagName: 'TEXTAREA' }).result, false);
    assert.equal(fireTopHandler({ tagName: 'INPUT' }).result, false);
    assert.equal(EscapeStack.size(), 1);
});

test('§5.9: фокус вне полей → прежнее поведение (сброс зоны + тост)', () => {
    drainStack();
    const vm = new ViolationManager();
    vm._setActiveZone(makeZone('v1'));

    const plainDiv = { tagName: 'DIV', closest: () => null };
    const { result, infos } = fireTopHandler(plainDiv);

    assert.notEqual(result, false, 'событие съедено стеком');
    assert.equal(vm.currentActiveContainer, null, 'зона сброшена');
    assert.equal(EscapeStack.size(), 0);
    assert.deepEqual(infos, ['Активная зона сброшена']);
});
