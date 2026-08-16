/**
 * Task 5 (A1): ToolbarDropdown — общая обёртка над паттерном
 * button[aria-haspopup=listbox] + div[role=listbox], который раньше был
 * реализован только для дропдауна размера шрифта (textblock-toolbar.js,
 * BUG-3). Три потребителя: размер шрифта (мигрирует), выравнивание, списки.
 *
 * Тестируем БЕЗ реального DOM — свой минимальный EventTarget-стаб
 * (makeFakeElement), т.к. document.addEventListener у _browser-stub.mjs —
 * no-op и не эмулирует диспатч событий (общий стаб рассчитан на модули,
 * которым реальные DOM-события не нужны). Тот же приём (перехват listener'а
 * через подмену document.addEventListener), что уже используют
 * escape-stack-passthrough.test.mjs и violation-escape-zone.test.mjs.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EscapeStack } from '../../static/js/shared/escape-stack.js';
import { ToolbarDropdown } from '../../static/js/constructor/textblock/toolbar-dropdown.js';

function drainEscapeStack() {
    while (EscapeStack.size() > 0) EscapeStack._stack.pop();
}

/** Минимальный EventTarget-стаб для триггера/меню/пунктов дропдауна. */
function makeFakeElement() {
    const listeners = {};
    const classes = new Set();
    const attrs = {};
    return {
        dataset: {},
        addEventListener(type, fn) {
            (listeners[type] ??= []).push(fn);
        },
        removeEventListener(type, fn) {
            if (!listeners[type]) return;
            listeners[type] = listeners[type].filter((f) => f !== fn);
        },
        /** Синхронно зовёт все listener'ы типа type, возвращает флаги preventDefault/stopPropagation. */
        dispatch(type, evt = {}) {
            const flags = { preventDefaultCalled: false, stopPropagationCalled: false };
            const e = {
                type,
                target: evt.target ?? this,
                preventDefault() { flags.preventDefaultCalled = true; },
                stopPropagation() { flags.stopPropagationCalled = true; },
                ...evt,
            };
            (listeners[type] || []).slice().forEach((fn) => fn(e));
            return flags;
        },
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
        },
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return attrs[k] ?? null; },
        contains(el) { return el === this; },
    };
}

/** Фейковый пункт меню: closest() отдаёт себя, если селектор совпал с классом. */
function makeFakeItem(className, data = {}) {
    const el = makeFakeElement();
    el.dataset = data;
    el.closest = (selector) => (selector === `.${className}` ? el : null);
    return el;
}

function makeDropdown(overrides = {}) {
    const picker = makeFakeElement();
    const trigger = makeFakeElement();
    const menu = makeFakeElement();
    // Реальный DOM: picker — родитель trigger/menu, contains() true для обоих.
    picker.contains = (el) => el === trigger || el === menu || el === picker;

    const calls = { onSelect: [], onOpen: 0 };
    const dropdown = new ToolbarDropdown({
        picker, trigger, menu,
        itemSelector: '.opt',
        onSelect: (item, e) => calls.onSelect.push({ item, e }),
        onOpen: () => { calls.onOpen += 1; },
        ...overrides,
    });
    return { picker, trigger, menu, dropdown, calls };
}

test('конструктор требует picker/trigger/menu', () => {
    assert.throws(() => new ToolbarDropdown({}), /picker\/trigger\/menu/);
});

test('изначально закрыт: hidden на меню, aria-expanded=false на триггере', () => {
    const { menu, trigger, dropdown } = makeDropdown();
    assert.equal(dropdown.isOpen, false);
    assert.equal(menu.classList.contains('hidden'), true);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('BUG-3: mousedown/pointerdown триггера вызывают preventDefault (иначе contenteditable теряет выделение)', () => {
    const { trigger } = makeDropdown();
    assert.equal(trigger.dispatch('mousedown').preventDefaultCalled, true);
    assert.equal(trigger.dispatch('pointerdown').preventDefaultCalled, true);
});

test('клик по триггеру открывает меню, снимает hidden, зовёт onOpen', () => {
    const { trigger, menu, dropdown, calls } = makeDropdown();
    const res = trigger.dispatch('click');
    assert.equal(res.preventDefaultCalled, true);
    assert.equal(res.stopPropagationCalled, true);
    assert.equal(dropdown.isOpen, true);
    assert.equal(menu.classList.contains('hidden'), false);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(calls.onOpen, 1);
});

test('повторный клик по триггеру закрывает меню (toggle)', () => {
    const { trigger, menu, dropdown } = makeDropdown();
    trigger.dispatch('click');
    trigger.dispatch('click');
    assert.equal(dropdown.isOpen, false);
    assert.equal(menu.classList.contains('hidden'), true);
});

test('BUG-3: mousedown/pointerdown ПО ПУНКТУ меню вызывают preventDefault', () => {
    const { menu, dropdown } = makeDropdown();
    dropdown.open();
    const item = makeFakeItem('opt');
    assert.equal(menu.dispatch('mousedown', { target: item }).preventDefaultCalled, true);
    assert.equal(menu.dispatch('pointerdown', { target: item }).preventDefaultCalled, true);
});

test('mousedown по НЕ-пункту меню (например, разделителю) preventDefault не зовётся', () => {
    const { menu, dropdown } = makeDropdown();
    dropdown.open();
    const separator = makeFakeElement();
    separator.closest = () => null;
    assert.equal(menu.dispatch('mousedown', { target: separator }).preventDefaultCalled, false);
});

test('клик по пункту меню: закрывает меню и зовёт onSelect(item)', () => {
    const { menu, dropdown, calls } = makeDropdown();
    dropdown.open();
    const item = makeFakeItem('opt', { command: 'justifyLeft' });
    const res = menu.dispatch('click', { target: item });
    assert.equal(res.preventDefaultCalled, true);
    assert.equal(dropdown.isOpen, false, 'меню закрывается ПОСЛЕ выбора');
    assert.equal(calls.onSelect.length, 1);
    assert.equal(calls.onSelect[0].item, item);
});

test('клик по меню мимо пункта (например, фону меню) не закрывает и не зовёт onSelect', () => {
    const { menu, dropdown, calls } = makeDropdown();
    dropdown.open();
    const bg = makeFakeElement();
    bg.closest = () => null;
    menu.dispatch('click', { target: bg });
    assert.equal(dropdown.isOpen, true);
    assert.equal(calls.onSelect.length, 0);
});

test('клик по пункту с aria-disabled="true" (например, indent/outdent вне списка): меню НЕ закрывается, onSelect НЕ зовётся', () => {
    const { menu, dropdown, calls } = makeDropdown();
    dropdown.open();
    const item = makeFakeItem('opt', { command: 'indent' });
    item.setAttribute('aria-disabled', 'true');
    const res = menu.dispatch('click', { target: item });
    assert.equal(res.preventDefaultCalled, true, 'preventDefault всё равно защищает фокус/выделение редактора');
    assert.equal(dropdown.isOpen, true, 'меню остаётся открытым');
    assert.equal(calls.onSelect.length, 0, '_onSelect не вызван для disabled-пункта');
});

test('клик по пункту с aria-disabled="false" — обычный выбор (регресс: строка "false" не должна читаться как истина)', () => {
    const { menu, dropdown, calls } = makeDropdown();
    dropdown.open();
    const item = makeFakeItem('opt', { command: 'indent' });
    item.setAttribute('aria-disabled', 'false');
    menu.dispatch('click', { target: item });
    assert.equal(dropdown.isOpen, false);
    assert.equal(calls.onSelect.length, 1);
});

test('открытие регистрирует РОВНО один слой в EscapeStack; повторный open не плодит слои', () => {
    drainEscapeStack();
    const { dropdown } = makeDropdown();
    dropdown.open();
    assert.equal(EscapeStack.size(), 1);
    dropdown.open();
    assert.equal(EscapeStack.size(), 1);
});

test('Escape (верхний хэндлер стека) закрывает дропдаун и снимает слой', () => {
    drainEscapeStack();
    const { dropdown, menu } = makeDropdown();
    dropdown.open();
    const top = EscapeStack._stack[EscapeStack._stack.length - 1];
    top({ key: 'Escape' });
    assert.equal(dropdown.isOpen, false);
    assert.equal(menu.classList.contains('hidden'), true);
    assert.equal(EscapeStack.size(), 0);
});

test('close() без open() — идемпотентно, не падает', () => {
    drainEscapeStack();
    const { dropdown } = makeDropdown();
    assert.doesNotThrow(() => dropdown.close());
    assert.equal(EscapeStack.size(), 0);
});

test('клик вне picker закрывает открытый дропдаун (document mousedown)', () => {
    drainEscapeStack();
    let outsideHandler = null;
    const origAdd = document.addEventListener;
    document.addEventListener = (type, cb) => { if (type === 'mousedown') outsideHandler = cb; };
    const { dropdown, menu } = makeDropdown();
    dropdown.open();
    document.addEventListener = origAdd;

    assert.ok(outsideHandler, 'document mousedown listener должен быть навешан при open()');
    outsideHandler({ target: makeFakeElement() });
    assert.equal(dropdown.isOpen, false);
    assert.equal(menu.classList.contains('hidden'), true);
});

test('клик ВНУТРИ picker (например, по триггеру) не закрывает через document-listener', () => {
    drainEscapeStack();
    let outsideHandler = null;
    const origAdd = document.addEventListener;
    document.addEventListener = (type, cb) => { if (type === 'mousedown') outsideHandler = cb; };
    const { dropdown, trigger } = makeDropdown();
    dropdown.open();
    document.addEventListener = origAdd;

    outsideHandler({ target: trigger });
    assert.equal(dropdown.isOpen, true);
});

test('close() снимает document-listener: клик вне picker ПОСЛЕ close ничего не делает', () => {
    drainEscapeStack();
    let outsideHandler = null;
    let removed = false;
    const origAdd = document.addEventListener;
    const origRemove = document.removeEventListener;
    document.addEventListener = (type, cb) => { if (type === 'mousedown') outsideHandler = cb; };
    document.removeEventListener = (type) => { if (type === 'mousedown') removed = true; };
    const { dropdown } = makeDropdown();
    dropdown.open();
    dropdown.close();
    document.addEventListener = origAdd;
    document.removeEventListener = origRemove;

    assert.equal(removed, true, 'close() должен снимать document mousedown listener');
});
