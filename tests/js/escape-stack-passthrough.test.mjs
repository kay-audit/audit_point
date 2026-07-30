/**
 * Тесты протокола passthrough в EscapeStack (§5.9).
 *
 * Раньше listener стека звал `stopImmediatePropagation()` ДО хэндлера: верхний
 * слой съедал ESC безусловно, и отказаться от события было нельзя. Из-за этого
 * один и тот же ESC при каретке в rich-поле означал разное в зависимости от
 * положения мыши (зона нарушений забирала событие по hover). Теперь остановка
 * идёт ПОСЛЕ вызова: хэндлер, вернувший строго `false`, пропускает событие
 * дальше к обычным listener'ам.
 *
 * Обратная совместимость: любое другое возвращаемое значение (undefined у всех
 * существующих хэндлеров) и исключение в хэндлере означают «событие съедено».
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EscapeStack } from '../../static/js/shared/escape-stack.js';

// Перехватываем document-listener, который EscapeStack ставит при первом push.
let stackListener = null;
const origAddEventListener = document.addEventListener;
document.addEventListener = (type, cb) => { if (type === 'keydown') stackListener = cb; };
EscapeStack.push(() => {})();
document.addEventListener = origAddEventListener;

function drainStack() {
    while (EscapeStack.size() > 0) EscapeStack._stack.pop();
}

/**
 * Прогоняет ESC через listener стека и — если событие не остановлено —
 * через «обычные» listener'ы ниже по цепочке (модель stopImmediatePropagation).
 * @param {Array<Function>} nextListeners - Слушатели после стека
 * @returns {{stopped: boolean, seenByNext: number}}
 */
function dispatchEscape(nextListeners = []) {
    let stopped = false;
    let seenByNext = 0;
    const e = { key: 'Escape', stopImmediatePropagation() { stopped = true; } };
    stackListener(e);
    if (!stopped) nextListeners.forEach((l) => { seenByNext += 1; l(e); });
    return { stopped, seenByNext };
}

test('хэндлер вернул false → событие НЕ остановлено и доходит до следующего listener', () => {
    drainStack();
    let handled = 0;
    EscapeStack.push(() => { handled += 1; return false; });

    const { stopped, seenByNext } = dispatchEscape([() => {}]);

    assert.equal(handled, 1, 'верхний хэндлер всё равно вызван');
    assert.equal(stopped, false, 'stopImmediatePropagation не вызван');
    assert.equal(seenByNext, 1, 'событие доступно следующему listener');
});

test('хэндлер вернул undefined → событие остановлено (прежнее поведение)', () => {
    drainStack();
    let handled = 0;
    EscapeStack.push(() => { handled += 1; });

    const { stopped, seenByNext } = dispatchEscape([() => {}]);

    assert.equal(handled, 1);
    assert.equal(stopped, true, 'stopImmediatePropagation вызван после хэндлера');
    assert.equal(seenByNext, 0, 'следующий listener не получил событие');
});

test('хэндлер бросил исключение → событие остановлено (семантика «съедено»)', () => {
    drainStack();
    EscapeStack.push(() => { throw new Error('boom'); });

    const origError = console.error;
    console.error = () => {};
    let result;
    try {
        result = dispatchEscape([() => {}]);
    } finally {
        console.error = origError;
    }

    assert.equal(result.stopped, true);
    assert.equal(result.seenByNext, 0);
});

test('falsy-возвраты кроме строгого false событие НЕ пропускают', () => {
    for (const value of [0, '', null, NaN]) {
        drainStack();
        EscapeStack.push(() => value);
        assert.equal(dispatchEscape().stopped, true, `значение ${String(value)} не должно давать passthrough`);
    }
});

test('LIFO сохранён: вызывается только верхний хэндлер', () => {
    drainStack();
    let bottom = 0;
    let top = 0;
    EscapeStack.push(() => { bottom += 1; });
    const unsubTop = EscapeStack.push(() => { top += 1; });

    dispatchEscape();
    assert.deepEqual([bottom, top], [0, 1], 'сработал только верхний слой');

    unsubTop();
    dispatchEscape();
    assert.deepEqual([bottom, top], [1, 1], 'после снятия верхнего — нижний');
});
