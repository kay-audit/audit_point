/**
 * Тесты горизонтального выравнивания ячеек таблицы (header-align.js).
 *
 * Зеркало серверной логики _fill_cell (tables.py) и centered-набора styles.py.
 * Проверяем:
 *  - объединённые риск-шапки (налоговый/операционный риск) → 'left';
 *  - centered-набор остаётся 'center', в т.ч. при «грязных» пробелах;
 *  - одиночная ячейка (colSpan ≤ 1, undefined, 0) → 'center';
 *  - ДАННЫЕ считаются по тому же правилу, что и шапка: в билдере ветка одна
 *    на всех, is_header управляет только заливкой, жирностью и кеглем.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergedCellAlign,
  CENTERED_MERGED_HEADER_TEXTS,
} from '../../static/js/constructor/table/header-align.js';

test('объединённая шапка налогового риска → left', () => {
  assert.equal(mergedCellAlign('Выявлены налоговые риски', 6), 'left');
});

test('объединённая шапка операционного риска → left', () => {
  assert.equal(
    mergedCellAlign('Отклонения с признаками операционного риска (далее - ОР)', 5),
    'left',
  );
});

test('centered-набор остаётся по центру даже при colSpan>1', () => {
  assert.equal(
    mergedCellAlign('Количество клиентов / элементов, ед.', 2),
    'center',
  );
});

test('сопоставление с centered-набором нечувствительно к пробелам', () => {
  assert.equal(
    mergedCellAlign('Количество   клиентов / элементов, ед.', 2),
    'center',
  );
});

test('одиночная ячейка (colSpan=1) → center', () => {
  assert.equal(mergedCellAlign('Процесс', 1), 'center');
});

test('colSpan 0/undefined трактуется как одиночная → center', () => {
  assert.equal(mergedCellAlign('X', 1), 'center');
  assert.equal(mergedCellAlign('X', 0), 'center');
  assert.equal(mergedCellAlign('X', undefined), 'center');
});

test('данные считаются по тому же правилу, что и шапка', () => {
  // Раньше сигнатура принимала isHeader и отдавала null для данных — превью
  // прижимало их влево, тогда как Word центрирует их наравне с шапкой.
  assert.equal(mergedCellAlign('12 345', 1), 'center');
  assert.equal(mergedCellAlign('Выявлены налоговые риски', 6), 'left');
});

test('CENTERED_MERGED_HEADER_TEXTS содержит ровно одну формулировку-зеркало', () => {
  assert.equal(CENTERED_MERGED_HEADER_TEXTS.has('Количество клиентов / элементов, ед.'), true);
  assert.equal(CENTERED_MERGED_HEADER_TEXTS.size, 1);
});
