/**
 * Тесты обработчиков клавиш текстовых полей нарушения (#18).
 *
 * #18-В: Escape откатывает значение и зовёт onUpdate ТОЛЬКО если значение
 * реально менялось — иначе Escape в нетронутом поле поднимал ложный
 * markAsUnsaved и ложную запись аудита. stopPropagation на Escape гасит
 * всплытие (активная зона вставки не сбрасывается, посторонний тост не уходит).
 *
 * #18-А (обновлено Task 1.3.3, Task 6): кейс, свободный текст И подпись
 * картинки — rich-поля (contenteditable через _createRichFieldEditor +
 * content-item поверхность), setupTextareaHandlers для них больше НЕ
 * используется — правка идёт write-through контроллера (commit →
 * setContentItemField). setupTextareaHandlers остаётся actual только для
 * пунктов descriptionList (плоский plain-текст, не item additionalContent).
 *
 * Реальные модули конструктора импортируются под node:test через _browser-stub;
 * поля моделируются фейком, записывающим слушателей, чтобы дёргать их вручную.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';

/** Фейковое поле: копит слушателей, даёт дёрнуть их вручную. */
function makeField(initial = '') {
    const listeners = {};
    return {
        value: initial,
        blurred: false,
        addEventListener(type, fn) { listeners[type] = fn; },
        blur() { this.blurred = true; },
        fire(type, evt = {}) { if (listeners[type]) listeners[type](evt); },
        has(type) { return typeof listeners[type] === 'function'; },
    };
}

function keyEvent(key, shiftKey = false) {
    return {
        key,
        shiftKey,
        prevented: false,
        stopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
    };
}

/** Вызов метода прототипа без опоры на this. */
function setup(field, onUpdate, multiline) {
    return ViolationManager.prototype.setupTextareaHandlers.call({}, field, onUpdate, multiline);
}

// ── #18-В: Escape без ложного шума ─────────────────────────────────────────────

test('input вызывает onUpdate с текущим значением', () => {
    const ta = makeField('');
    const calls = [];
    setup(ta, v => calls.push(v));
    ta.value = 'abc';
    ta.fire('input');
    assert.deepEqual(calls, ['abc']);
});

test('Escape без изменения: onUpdate НЕ зовётся, но blur и stopPropagation есть', () => {
    const ta = makeField('исходное');
    const calls = [];
    setup(ta, v => calls.push(v));
    ta.fire('focus'); // фиксируем originalValue

    const e = keyEvent('Escape');
    ta.fire('keydown', e);

    assert.equal(calls.length, 0, 'нет ложного onUpdate → нет ложного markAsUnsaved и записи аудита');
    assert.equal(ta.blurred, true, 'фокус снят');
    assert.equal(e.prevented, true);
    assert.equal(e.stopped, true, 'stopPropagation → активная зона не гаснет, посторонний тост не уходит');
});

test('Escape с изменением: откат к originalValue и один onUpdate(original)', () => {
    const ta = makeField('исходное');
    const calls = [];
    setup(ta, v => calls.push(v));
    ta.fire('focus');
    ta.value = 'изменённое';

    const e = keyEvent('Escape');
    ta.fire('keydown', e);

    assert.equal(ta.value, 'исходное', 'значение откатано');
    assert.deepEqual(calls, ['исходное'], 'onUpdate(original) ровно один раз');
    assert.equal(ta.blurred, true);
});

test('focus фиксирует новую точку отката', () => {
    const ta = makeField('a');
    const calls = [];
    setup(ta, v => calls.push(v));
    ta.value = 'b';
    ta.fire('focus'); // теперь originalValue = 'b'
    ta.value = 'c';

    ta.fire('keydown', keyEvent('Escape'));

    assert.equal(ta.value, 'b');
    assert.deepEqual(calls, ['b']);
});

// ── Enter / Shift+Enter: textarea (multiline) vs input ─────────────────────────

test('Enter без Shift в textarea: сохранить+blur (preventDefault, без onUpdate)', () => {
    const ta = makeField('x');
    const calls = [];
    setup(ta, v => calls.push(v));

    const e = keyEvent('Enter', false);
    ta.fire('keydown', e);

    assert.equal(e.prevented, true);
    assert.equal(ta.blurred, true);
    assert.equal(calls.length, 0, 'Enter не дублирует запись — значение уже писалось через input');
});

test('Shift+Enter в textarea: новая строка (stopPropagation, без blur/preventDefault)', () => {
    const ta = makeField('x');
    setup(ta, () => {});

    const e = keyEvent('Enter', true);
    ta.fire('keydown', e);

    assert.equal(e.stopped, true);
    assert.equal(e.prevented, false);
    assert.equal(ta.blurred, false);
});

test('input (multiline=false): любой Enter сохраняет+blur, Shift+Enter не даёт перевод строки', () => {
    const inp = makeField('x');
    setup(inp, () => {}, false);
    const e1 = keyEvent('Enter', false);
    inp.fire('keydown', e1);
    assert.equal(inp.blurred, true);
    assert.equal(e1.prevented, true);

    const inp2 = makeField('y');
    setup(inp2, () => {}, false);
    const e2 = keyEvent('Enter', true); // Shift+Enter
    inp2.fire('keydown', e2);
    assert.equal(inp2.blurred, true, 'Shift+Enter в однострочном input тоже blur');
    assert.equal(e2.prevented, true);
});

// ── #18-А: маршрутизация case/freeText/caption через rich-поле ────────────────

test('#18-А (Task 1.3.3): createCaseElement идёт через rich-поле (content-item поверхность), commit→setContentItemField, БЕЗ setupTextareaHandlers', () => {
    const vm = new ViolationManager();
    const captured = [];
    // Спай хоста rich-поля: перехватываем поверхность/опции без создания DOM.
    vm._createRichFieldEditor = (surface, opts) => { captured.push({ surface, opts }); return { addEventListener() {} }; };
    let taCalled = 0;
    vm.setupTextareaHandlers = () => { taCalled++; };

    const violation = { id: 'v1' };
    const item = { id: 'c1', type: 'case', content: 'старое' };
    vm.createCaseElement(violation, item, 0, 1, false);

    assert.equal(taCalled, 0, 'кейс больше НЕ использует setupTextareaHandlers');
    assert.equal(captured.length, 1, 'кейс создан через rich-поле');
    assert.equal(captured[0].surface.id, 'viol:v1:item:c1', 'content-item поверхность по item.id');
    assert.equal(captured[0].surface.kind, 'violationField');
    assert.equal(captured[0].opts.isReadOnly, false);

    // Запись в модель — через commit поверхности (element.innerHTML → setContentItemField).
    const setCalls = [];
    vm.setContentItemField = (v, item2, field, val) => setCalls.push({ field, val });
    captured[0].surface.element = { innerHTML: 'новое описание' };
    captured[0].surface.commit();
    assert.deepEqual(setCalls, [{ field: 'content', val: 'новое описание' }]);
});

test('#18-А (Task 1.3.3): createFreeTextElement идёт через rich-поле (content-item поверхность), commit→setContentItemField', () => {
    const vm = new ViolationManager();
    const captured = [];
    vm._createRichFieldEditor = (surface, opts) => { captured.push({ surface, opts }); return { addEventListener() {} }; };
    let taCalled = 0;
    vm.setupTextareaHandlers = () => { taCalled++; };

    const violation = { id: 'v1' };
    const item = { id: 't1', type: 'freeText', content: 'старое' };
    vm.createFreeTextElement(violation, item, 0, 1, false);

    assert.equal(taCalled, 0, 'свободный текст больше НЕ использует setupTextareaHandlers');
    assert.equal(captured.length, 1, 'свободный текст создан через rich-поле');
    assert.equal(captured[0].surface.id, 'viol:v1:item:t1');

    const setCalls = [];
    vm.setContentItemField = (v, item2, field, val) => setCalls.push({ field, val });
    captured[0].surface.element = { innerHTML: 'новый текст' };
    captured[0].surface.commit();
    assert.deepEqual(setCalls, [{ field: 'content', val: 'новый текст' }]);
});

test('Task 6: createImageElement маршрутизирует подпись через rich-поле (content-item поверхность, field=caption), commit→setContentItemField, БЕЗ setupTextareaHandlers', () => {
    const vm = new ViolationManager();
    const captured = [];
    vm._createRichFieldEditor = (surface, opts) => { captured.push({ surface, opts }); return { classList: { add() {} } }; };
    let taCalled = 0;
    vm.setupTextareaHandlers = () => { taCalled++; };

    const violation = { id: 'v1' };
    const item = { id: 'img1', type: 'image', url: '', caption: 'подпись', filename: 'f.png', width: 0 };
    vm.createImageElement(violation, item, 0, 1, false);

    assert.equal(taCalled, 0, 'подпись картинки больше НЕ использует setupTextareaHandlers');
    assert.equal(captured.length, 1, 'подпись создана через rich-поле');
    assert.equal(captured[0].surface.id, 'viol:v1:item:img1:caption', 'content-item поверхность с суффиксом :caption');
    assert.equal(captured[0].surface.kind, 'violationField');
    assert.equal(captured[0].opts.placeholder, 'Подпись к изображению');
    assert.equal(captured[0].opts.isReadOnly, false);

    // Запись в модель — через commit поверхности (element.innerHTML → setContentItemField(..., 'caption', ...)).
    const setCalls = [];
    vm.setContentItemField = (v, item2, field, val) => setCalls.push({ field, val });
    captured[0].surface.element = { innerHTML: 'новая подпись' };
    captured[0].surface.commit();
    assert.deepEqual(setCalls, [{ field: 'caption', val: 'новая подпись' }]);
});

test('#18-А read-only: case/freeText/image НЕ вешают setupTextareaHandlers', () => {
    const vm = new ViolationManager();
    let called = 0;
    vm.setupTextareaHandlers = () => { called++; };
    const violation = { id: 'v1' };

    vm.createCaseElement(violation, { id: 'c1', type: 'case', content: '' }, 0, 1, true);
    vm.createFreeTextElement(violation, { id: 't1', type: 'freeText', content: '' }, 0, 1, true);
    vm.createImageElement(violation, { id: 'img1', type: 'image', url: '', caption: '', filename: 'f.png', width: 0 }, 0, 1, true);

    assert.equal(called, 0, 'в режиме просмотра обработчики правок не навешиваются');
});
