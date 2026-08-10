/**
 * Логика модалки «Порядок полей» нарушения.
 *
 * Тестируется чистая перестановка строк (reorderKeys) — та же поправка на
 * удаление исходной позиции, что и у moveBlock: позиция вставки считается в
 * ИСХОДНОМ списке, поэтому при движении вниз уменьшается на 1. Сам диалог
 * DOM-тяжёлый и, как у соседей, проверяется вручную.
 *
 * _browser-stub — потому что модуль диалога тянет DialogManager (а тот —
 * app-config с `window.AppConfig = ...` на module-level).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reorderKeys } from '../../static/js/constructor/violation/violation-field-order-dialog.js';
import { VIOLATION_FIELD_KEYS } from '../../static/js/constructor/violation/violation-fields.js';

const BASE = ['a', 'b', 'c', 'd'];

test('перестановка вниз: позиция вставки считается в исходном списке', () => {
    // «a» переносится за «c» (вставка перед индексом 3 исходного списка).
    assert.deepEqual(reorderKeys(BASE, 0, 3), ['b', 'c', 'a', 'd']);
});

test('перестановка вверх: индекс вставки берётся как есть', () => {
    assert.deepEqual(reorderKeys(BASE, 3, 1), ['a', 'd', 'b', 'c']);
});

test('перестановка в конец списка', () => {
    assert.deepEqual(reorderKeys(BASE, 0, 4), ['b', 'c', 'd', 'a']);
});

test('перестановка в начало списка', () => {
    assert.deepEqual(reorderKeys(BASE, 2, 0), ['c', 'a', 'b', 'd']);
});

test('обе половины строки на своём же месте — порядок не меняется', () => {
    assert.deepEqual(reorderKeys(BASE, 1, 1), ['a', 'b', 'c', 'd']);
    assert.deepEqual(reorderKeys(BASE, 1, 2), ['a', 'b', 'c', 'd']);
});

test('исходный массив не мутируется', () => {
    const source = [...BASE];
    reorderKeys(source, 0, 3);
    assert.deepEqual(source, BASE);
});

test('индекс вне границ — копия исходного порядка', () => {
    assert.deepEqual(reorderKeys(BASE, 9, 1), BASE);
    assert.deepEqual(reorderKeys(BASE, -1, 1), BASE);
});

test('не массив — пустой результат (без исключения)', () => {
    assert.deepEqual(reorderKeys(null, 0, 1), []);
    assert.deepEqual(reorderKeys(undefined, 0, 1), []);
});

test('перестановка сохраняет полный состав ключей реестра', () => {
    const order = [...VIOLATION_FIELD_KEYS];
    const moved = reorderKeys(order, 0, VIOLATION_FIELD_KEYS.length);

    assert.equal(moved.length, VIOLATION_FIELD_KEYS.length);
    assert.deepEqual([...moved].sort(), [...VIOLATION_FIELD_KEYS].sort());
    // Мутатор setFieldOrder принимает только полную перестановку реестра —
    // без этого инварианта модалка молча ломала бы порядок.
    assert.equal(new Set(moved).size, VIOLATION_FIELD_KEYS.length);
});
