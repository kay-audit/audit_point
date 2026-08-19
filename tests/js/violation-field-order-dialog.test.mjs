/**
 * Логика модалки «Порядок полей» нарушения.
 *
 * Тестируется чистая перестановка строк (reorderKeys) — та же поправка на
 * удаление исходной позиции, что и у moveBlocks: позиция вставки считается в
 * ИСХОДНОМ списке, поэтому при движении вниз уменьшается на 1. Сам диалог
 * DOM-тяжёлый и, как у соседей, проверяется вручную.
 *
 * _browser-stub — потому что модуль диалога тянет DialogManager (а тот —
 * app-config с `window.AppConfig = ...` на module-level).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reorderKeys, insertionIndexByPointer } from '../../static/js/constructor/violation/violation-field-order-dialog.js';
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

test('insertionIndexByPointer: курсор в верхней половине строки-цели — вставка перед ней', () => {
    // Строка top=100, height=40 → середина на 120. Курсор на 110 — выше середины.
    assert.equal(insertionIndexByPointer(100, 40, 110, 2), 2);
});

test('insertionIndexByPointer: курсор в нижней половине строки-цели — вставка после неё', () => {
    assert.equal(insertionIndexByPointer(100, 40, 130, 2), 3);
});

test('insertionIndexByPointer: курсор точно на середине — граница относится к верхней половине', () => {
    // clientY > mid, а не >=, поэтому ровно середина ещё не «после».
    assert.equal(insertionIndexByPointer(100, 40, 120, 2), 2);
});
