/**
 * Тесты контракта EscapeStack: отказ от события (PASS) и каскад по слоям (§5.9).
 *
 * История. Сначала listener стека звал `stopImmediatePropagation()` ДО хэндлера:
 * верхний слой съедал ESC безусловно, отказаться было нельзя — один и тот же ESC
 * при каретке в rich-поле означал разное в зависимости от положения мыши (зона
 * нарушений забирала событие по hover). Отказ сделали возвратом строго `false`,
 * но вылезли два дефекта: (1) пропущенное событие не доходило до НИЖНИХ слоёв
 * стека — вызывался только верхний, и ESC был мёртв для панели поиска/корректора/
 * формализатора, пока мышь висела над зоной; (2) «голый false» — хрупкий контракт
 * при доминирующем идиоме `push(() => this.close())`: первый же close(),
 * вернувший boolean, молча превратил бы слой в пропускающий.
 *
 * Текущий контракт:
 *  - `EscapeStack.PASS` — слой отказался, обход продолжается СЛЕДУЮЩИМ слоем вниз;
 *  - любое другое значение (undefined, false, 0, …) и исключение — «съедено»:
 *    обход останавливается, событие глушится;
 *  - отказались все слои — событие уходит в DOM нетронутым.
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

// ── Контракт возвращаемого значения ──────────────────────────────────────────

test('хэндлер вернул PASS → событие НЕ остановлено и доходит до следующего listener', () => {
    drainStack();
    let handled = 0;
    EscapeStack.push(() => { handled += 1; return EscapeStack.PASS; });

    const { stopped, seenByNext } = dispatchEscape([() => {}]);

    assert.equal(handled, 1, 'единственный хэндлер всё равно вызван');
    assert.equal(stopped, false, 'stopImmediatePropagation не вызван');
    assert.equal(seenByNext, 1, 'событие доступно следующему listener');
});

test('хэндлер вернул undefined → событие остановлено (доминирующий идиом)', () => {
    drainStack();
    let handled = 0;
    EscapeStack.push(() => { handled += 1; });

    const { stopped, seenByNext } = dispatchEscape([() => {}]);

    assert.equal(handled, 1);
    assert.equal(stopped, true, 'stopImmediatePropagation вызван после хэндлера');
    assert.equal(seenByNext, 0, 'следующий listener не получил событие');
});

test('хэндлер вернул false → событие СЪЕДЕНО (пропуском считается только сентинел)', () => {
    drainStack();
    let lower = 0;
    EscapeStack.push(() => { lower += 1; });
    EscapeStack.push(() => false);

    const { stopped, seenByNext } = dispatchEscape([() => {}]);

    assert.equal(stopped, true, 'false — это не отказ: close(), вернувший boolean, не должен пропускать ESC');
    assert.equal(seenByNext, 0);
    assert.equal(lower, 0, 'каскад к нижнему слою не запущен');
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

test('никакое значение кроме сентинела событие НЕ пропускает', () => {
    for (const value of [0, '', null, NaN, false, true, Symbol('PASS'), 'PASS']) {
        drainStack();
        EscapeStack.push(() => value);
        assert.equal(dispatchEscape().stopped, true, `значение ${String(value)} не должно давать пропуск`);
    }
});

test('PASS — символ из глобального реестра (переживает задвоенный ESM-граф)', () => {
    assert.equal(typeof EscapeStack.PASS, 'symbol');
    assert.equal(EscapeStack.PASS, Symbol.for('EscapeStack.PASS'));
});

// ── Каскад по стеку ──────────────────────────────────────────────────────────

test('верхний слой отказался → ESC получает следующий слой вниз и съедает его', () => {
    drainStack();
    const calls = [];
    EscapeStack.push(() => { calls.push('bottom'); });                       // панель поиска
    EscapeStack.push(() => { calls.push('zone'); return EscapeStack.PASS; }); // зона нарушений

    const { stopped, seenByNext } = dispatchEscape([() => {}]);

    assert.deepEqual(calls, ['zone', 'bottom'], 'обход сверху вниз');
    assert.equal(stopped, true, 'нижний слой съел событие');
    assert.equal(seenByNext, 0, 'до обычных listener-ов не дошло');
});

test('слой, съевший событие, останавливает каскад (нижние не вызываются)', () => {
    drainStack();
    const calls = [];
    EscapeStack.push(() => { calls.push('bottom'); });
    EscapeStack.push(() => { calls.push('middle'); });
    EscapeStack.push(() => { calls.push('top'); return EscapeStack.PASS; });

    dispatchEscape();

    assert.deepEqual(calls, ['top', 'middle'], 'ниже съевшего слоя обход не идёт');
});

test('отказались ВСЕ слои → событие не глушится и уходит в DOM', () => {
    drainStack();
    const calls = [];
    EscapeStack.push(() => { calls.push('bottom'); return EscapeStack.PASS; });
    EscapeStack.push(() => { calls.push('top'); return EscapeStack.PASS; });

    const { stopped, seenByNext } = dispatchEscape([() => {}, () => {}]);

    assert.deepEqual(calls, ['top', 'bottom'], 'опрошены все слои');
    assert.equal(stopped, false, 'событие принадлежит редактору — стек его не трогает');
    assert.equal(seenByNext, 2, 'обычные listener-ы получили ESC');
});

test('слой, снявший себя со стека при обработке, не ломает обход (снимок стека)', () => {
    drainStack();
    let bottom = 0;
    EscapeStack.push(() => { bottom += 1; });
    const unsubTop = EscapeStack.push(() => { unsubTop(); });  // close() → unsub, как в проде

    const { stopped } = dispatchEscape();

    assert.equal(stopped, true);
    assert.equal(bottom, 0, 'съевший слой остановил каскад, несмотря на мутацию стека');
    assert.equal(EscapeStack.size(), 1, 'верхний слой снят');
});

test('LIFO сохранён: пока верхний слой съедает ESC, нижний молчит', () => {
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

// ── isActive: признак «ESC принадлежит стеку» для legacy-обработчиков ─────────

test('isActive(): true при непустом стеке, false после снятия всех слоёв', () => {
    drainStack();
    assert.equal(EscapeStack.isActive(), false, 'пустой стек');

    const unsub = EscapeStack.push(() => EscapeStack.PASS);
    assert.equal(EscapeStack.isActive(), true, 'отказавшийся слой всё равно активен');

    unsub();
    assert.equal(EscapeStack.isActive(), false);
});
