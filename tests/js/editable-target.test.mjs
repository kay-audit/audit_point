/**
 * Тесты общего предиката isEditableTarget (shared/editable-target.js).
 *
 * До этого предикат жил тремя разошедшимися копиями: у глобальных хоткеев
 * Ctrl+Z (undo-delete.js) и Ctrl+C/Ctrl+V (node-clipboard.js) —
 * `isContentEditable` + TEXTAREA/INPUT/SELECT, у зоны нарушений
 * (violation-core.js) — TEXTAREA/INPUT + `closest('[contenteditable="true"]')`.
 * Версия нарушений матчила ЛЮБОЙ `<input>`, включая чекбокс «Дополнительный
 * контент» и скрытый `input[type=file]` загрузки: с фокусом на них Escape
 * считался принадлежащим редактору и уходил в никуда вместо сброса зоны.
 *
 * Общая семантика — объединение копий с сужением по типам input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEditableTarget } from '../../static/js/shared/editable-target.js';

test('пустая цель — не редактируемая', () => {
    assert.equal(isEditableTarget(null), false);
    assert.equal(isEditableTarget(undefined), false);
});

test('textarea и select — редактируемые', () => {
    assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
    assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
});

test('input текстовых типов — редактируемый (в т.ч. без явного type)', () => {
    for (const type of ['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'date', 'time']) {
        assert.equal(isEditableTarget({ tagName: 'INPUT', type }), true, `input[type=${type}]`);
    }
    assert.equal(isEditableTarget({ tagName: 'INPUT' }), true, 'без type браузер даёт text');
    assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'TEXT' }), true, 'регистр type не важен');
});

test('input-кнопки и переключатели — НЕ редактируемые (#9)', () => {
    for (const type of ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'range', 'image']) {
        assert.equal(isEditableTarget({ tagName: 'INPUT', type }), false, `input[type=${type}]`);
    }
});

test('contenteditable: и по свойству isContentEditable, и по ближайшему хосту', () => {
    // Реальный DOM: свойство истинно и у потомков редактируемого хоста.
    assert.equal(isEditableTarget({ tagName: 'SPAN', isContentEditable: true }), true);

    // Detached-узлы и тест-стабы без isContentEditable — путь closest.
    const inEditor = { tagName: 'SPAN', closest: (s) => (s === '[contenteditable="true"]' ? {} : null) };
    assert.equal(isEditableTarget(inEditor), true);
});

test('обычные элементы — не редактируемые, цель без closest не роняет предикат', () => {
    assert.equal(isEditableTarget({ tagName: 'DIV', closest: () => null }), false);
    assert.equal(isEditableTarget({ tagName: 'DIV' }), false, 'нет closest (document/window, стабы)');
    assert.equal(isEditableTarget({ tagName: 'BUTTON', closest: () => null }), false);
});
