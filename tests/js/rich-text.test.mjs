/**
 * shared/rich-text.js — канонический экстрактор видимого plain-текста
 * из rich DOM-фрагмента (вынесен из corrector-popover.js:_serializeWithBreaks,
 * см. tests/js/corrector-popover.test.mjs — тот страж остаётся зелёным
 * без правок ассертов).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeVisibleText } from '../../static/js/shared/rich-text.js';

// Фейковые DOM-узлы для проверки чистой сериализации без реального DOM.
const el = (tag, children) => ({ nodeType: 1, tagName: tag, childNodes: children || [] });
const txt = (t) => ({ nodeType: 3, textContent: t });

test('serializeVisibleText: границы блочных элементов дают перевод строки', () => {
    // Две Enter-строки в редакторе = два нативных <div>.
    const root = el('DIV', [el('DIV', [txt('a')]), el('DIV', [txt('b')])]);
    assert.equal(serializeVisibleText(root), 'a\nb\n');
});

test('serializeVisibleText: <br> даёт перевод строки, инлайн-капсула — видимым текстом', () => {
    const root = el('DIV', [txt('a'), el('BR'), txt('b')]);
    assert.equal(serializeVisibleText(root), 'a\nb');
    const inline = el('DIV', [
        txt('до '), el('SPAN', [txt('link')]), el('BR'), txt('после'),
    ]);
    assert.equal(serializeVisibleText(inline), 'до link\nпосле');
});

test('serializeVisibleText: мультистрочный div-блок', () => {
    const root = el('DIV', [
        el('DIV', [txt('строка1')]),
        el('DIV', [txt('строка2')]),
        el('DIV', [txt('строка3')]),
    ]);
    assert.equal(serializeVisibleText(root), 'строка1\nстрока2\nстрока3\n');
});

test('serializeVisibleText: пустой элемент — пустая строка', () => {
    const root = el('DIV', []);
    assert.equal(serializeVisibleText(root), '');
});
