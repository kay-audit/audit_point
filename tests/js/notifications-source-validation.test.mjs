/**
 * Источник «validation» колокольчика конструктора (#8):
 * collectValidationItems читает validation_issues последнего сохранения
 * из window.AppState и нормализует в элементы уведомлений.
 *
 * Отдельный инвариант — дедупликация: табличные коды (`SUPPRESSED_CODES`)
 * источник НЕ показывает, их показывает живой сгруппированный источник «tables».
 */
import './_browser-stub.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectValidationItems,
  SUPPRESSED_CODES,
} from '../../static/js/constructor/header/notifications-source-validation.js';

beforeEach(() => {
  window.AppState = {};
});

test('нет замечаний → пустой список', () => {
  window.AppState.validationIssues = [];
  assert.deepEqual(collectValidationItems(), []);
});

test('отсутствующий AppState/issues → пустой список (без throw)', () => {
  window.AppState = {};
  assert.deepEqual(collectValidationItems(), []);
});

test('замечания нормализуются в элементы с severity и текстом', () => {
  window.AppState.validationIssues = [
    { code: 'missing_sections', severity: 'error', message: 'Базовая структура повреждена' },
    { code: 'violation_incomplete', severity: 'warning', ref: 'v2', message: 'Есть незаполненные поля' },
  ];
  const items = collectValidationItems();
  assert.equal(items.length, 2);
  assert.equal(items[0].severity, 'error');
  assert.equal(items[0].title, 'Структура акта');
  assert.match(items[0].body, /структура повреждена/);
  assert.equal(items[1].severity, 'warning');
  // id уникален в пределах снимка.
  assert.notEqual(items[0].id, items[1].id);
});

test('неизвестная severity трактуется как warning', () => {
  window.AppState.validationIssues = [{ code: 'x', message: 'm' }];
  assert.equal(collectValidationItems()[0].severity, 'warning');
});

// ──────────────────────────────────────────────────────────────────────────
// Дедупликация с живым источником «tables»
// ──────────────────────────────────────────────────────────────────────────

test('SUPPRESSED_CODES — ровно три табличных кода, пересекающихся с источником «tables»', () => {
  assert.deepEqual(
    [...SUPPRESSED_CODES].sort(),
    ['table_empty_header', 'table_no_data', 'table_no_header']
  );
});

test('табличные коды не показываются — их показывает сгруппированный источник «tables»', () => {
  window.AppState.validationIssues = [
    { code: 'table_no_header', severity: 'error', ref: 't1', message: 'Таблица без заголовка' },
    { code: 'table_empty_header', severity: 'error', ref: 't2', message: 'Не заполнены заголовки' },
    { code: 'table_no_data', severity: 'warning', ref: 't3', message: 'Таблица без данных' },
  ];
  assert.deepEqual(collectValidationItems(), []);
});

test('нетабличные коды показываются все четыре', () => {
  window.AppState.validationIssues = [
    { code: 'empty_structure', severity: 'error', message: 'Структура акта пуста' },
    { code: 'missing_sections', severity: 'error', message: 'Отсутствуют разделы 3' },
    { code: 'unprotected_sections', severity: 'error', message: 'Разделы не защищены' },
    { code: 'violation_incomplete', severity: 'warning', ref: 'v1', message: 'Незаполненные поля' },
  ];
  const codes = collectValidationItems().map((it) => it.id);
  assert.equal(codes.length, 4);
  assert.deepEqual(codes, [
    'validation:empty_structure:0',
    'validation:missing_sections:1',
    'validation:unprotected_sections:2',
    'validation:violation_incomplete:v1',
  ]);
});

test('смешанный набор: табличные отфильтрованы, остальные нумеруются после фильтрации', () => {
  window.AppState.validationIssues = [
    { code: 'table_no_data', severity: 'warning', ref: 't1', message: 'Таблица без данных' },
    { code: 'empty_structure', severity: 'error', message: 'Структура акта пуста' },
    { code: 'table_no_header', severity: 'error', ref: 't2', message: 'Таблица без заголовка' },
    { code: 'violation_incomplete', severity: 'warning', ref: 'v9', message: 'Незаполненные поля' },
  ];
  const items = collectValidationItems();
  assert.equal(items.length, 2);
  // id нетабличного замечания без ref строится по индексу в УЖЕ отфильтрованном
  // списке: это первый показанный элемент, значит индекс 0.
  assert.equal(items[0].id, 'validation:empty_structure:0');
  assert.equal(items[1].id, 'validation:violation_incomplete:v9');
});
