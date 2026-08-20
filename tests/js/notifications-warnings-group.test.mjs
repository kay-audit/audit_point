/**
 * Тесты чистой группировки замечаний по таблицам (notifications-warnings-group.js).
 *
 * `collectTableWarnings` отдаёт по одному замечанию на пару «таблица × проблема»,
 * из-за чего колокольчик показывал десяток одинаковых строк «нет данных».
 * Здесь пинится свёртка в группы: ключ, порядок, счётчик и склонение.
 *
 * Модуль без DOM (как соседний notifications-warnings-cache.js), поэтому
 * тестируется напрямую под node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupTableWarnings,
  formatTablesCount,
} from '../../static/js/constructor/header/notifications-warnings-group.js';

/** Короткий конструктор замечания. */
function w(tableId, tableName, issue, severity = 'warning') {
  return { tableId, tableName, issue, severity };
}

test('однотипные замечания сворачиваются в одну группу с перечнем таблиц', () => {
  const groups = groupTableWarnings([
    w(1, 'Таблица А', 'нет данных'),
    w(2, 'Таблица Б', 'нет данных'),
    w(3, 'Таблица В', 'нет данных'),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].issue, 'нет данных');
  assert.equal(groups[0].severity, 'warning');
  assert.deepEqual(groups[0].tables.map((t) => t.tableName), ['Таблица А', 'Таблица Б', 'Таблица В']);
});

test('заголовок группы — замечание с заглавной, тело — счётчик со склонением', () => {
  const [group] = groupTableWarnings([
    w(1, 'А', 'не заполнены заголовки'),
    w(2, 'Б', 'не заполнены заголовки'),
  ]);

  assert.equal(group.title, 'Не заполнены заголовки');
  assert.equal(group.body, '2 таблицы');
});

test('разные виды замечаний в одну группу не сливаются', () => {
  const groups = groupTableWarnings([
    w(1, 'А', 'нет данных'),
    w(2, 'Б', 'не заполнены заголовки'),
    w(3, 'В', 'нет данных'),
  ]);

  assert.deepEqual(groups.map((g) => g.issue), ['нет данных', 'не заполнены заголовки']);
  assert.deepEqual(groups.map((g) => g.tables.length), [2, 1]);
});

test('одинаковый текст с разной критичностью — разные группы', () => {
  // Иначе строка получила бы цвет первой попавшейся критичности.
  const groups = groupTableWarnings([
    w(1, 'А', 'нарушена структура таблицы', 'error'),
    w(2, 'Б', 'нарушена структура таблицы', 'warning'),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.severity), ['error', 'warning']);
});

test('порядок групп — по первому появлению, порядок таблиц — по обходу', () => {
  // Детерминированность важна: список перерисовывается на каждое изменение
  // документа, и строки не должны прыгать местами.
  const groups = groupTableWarnings([
    w(5, 'Пятая', 'нет данных'),
    w(1, 'Первая', 'нет строки заголовка'),
    w(3, 'Третья', 'нет данных'),
  ]);

  assert.deepEqual(groups.map((g) => g.issue), ['нет данных', 'нет строки заголовка']);
  assert.deepEqual(groups[0].tables.map((t) => t.tableId), [5, 3]);
});

test('одна таблица не дублируется внутри группы', () => {
  const [group] = groupTableWarnings([
    w(7, 'Седьмая', 'нет данных'),
    w(7, 'Седьмая', 'нет данных'),
  ]);

  assert.equal(group.tables.length, 1);
  assert.equal(group.body, '1 таблица');
});

test('неизвестная критичность приравнивается к warning', () => {
  const [group] = groupTableWarnings([w(1, 'А', 'нет данных', 'info')]);
  assert.equal(group.severity, 'warning');
});

test('пустой/невалидный вход → []', () => {
  assert.deepEqual(groupTableWarnings([]), []);
  assert.deepEqual(groupTableWarnings(null), []);
  assert.deepEqual(groupTableWarnings(undefined), []);
});

test('falsy-элементы пропускаются', () => {
  const groups = groupTableWarnings([null, w(1, 'А', 'нет данных'), undefined]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].tables.length, 1);
});

test('formatTablesCount: русские правила склонения', () => {
  assert.equal(formatTablesCount(1), '1 таблица');
  assert.equal(formatTablesCount(2), '2 таблицы');
  assert.equal(formatTablesCount(4), '4 таблицы');
  assert.equal(formatTablesCount(5), '5 таблиц');
  assert.equal(formatTablesCount(11), '11 таблиц');
  assert.equal(formatTablesCount(12), '12 таблиц');
  assert.equal(formatTablesCount(14), '14 таблиц');
  assert.equal(formatTablesCount(21), '21 таблица');
  assert.equal(formatTablesCount(22), '22 таблицы');
  assert.equal(formatTablesCount(25), '25 таблиц');
  assert.equal(formatTablesCount(101), '101 таблица');
  assert.equal(formatTablesCount(111), '111 таблиц');
});

test('formatTablesCount: мусор и отрицательные → «0 таблиц»', () => {
  assert.equal(formatTablesCount(0), '0 таблиц');
  assert.equal(formatTablesCount(-3), '0 таблиц');
  assert.equal(formatTablesCount(NaN), '0 таблиц');
  assert.equal(formatTablesCount(undefined), '0 таблиц');
});
