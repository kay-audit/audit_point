/**
 * Тесты контракта полей нарушения (violation-fields.js, блочная модель).
 *
 * По образцу block-types.test.mjs:
 *  - VIOLATION_FIELDS и каждое описание поля заморожены;
 *  - набор ключей/меток/флагов закреплён точными строками — ручная
 *    синхронизация с бэкенд-контрактом app/domains/acts/violation_fields.py;
 *  - VIOLATION_LABELS не подвержен prototype pollution;
 *  - getOrderedFieldKeys: fieldOrder-перестановка либо стандартный порядок;
 *  - BLOCK_TYPES и фабрики блоков (violation-block-types.js).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIOLATION_FIELDS,
  VIOLATION_LABELS,
  VIOLATION_FIELD_KEYS,
  MANDATORY_FIELD_KEYS,
  getOrderedFieldKeys,
} from '../../static/js/constructor/violation/violation-fields.js';
import {
  BLOCK_TYPES,
  createTextBlock,
  createImageBlock,
  createTableBlock,
} from '../../static/js/constructor/violation/violation-block-types.js';

const EXPECTED_FIELDS = [
  { key: 'violated', label: 'Нарушено', defaultOrder: 0, mandatory: true, small: true, labeled: true },
  { key: 'established', label: 'Установлено', defaultOrder: 1, mandatory: true, small: true, labeled: true },
  { key: 'description', label: 'Описание', defaultOrder: 2, mandatory: false, small: false, labeled: true },
  { key: 'codeMining', label: 'CodeMining', defaultOrder: 3, mandatory: false, small: false, labeled: false },
  { key: 'processMining', label: 'ProcessMining', defaultOrder: 4, mandatory: false, small: false, labeled: false },
  { key: 'additionalContent', label: 'Дополнительный контент', defaultOrder: 5, mandatory: false, small: false, labeled: false },
  { key: 'reasons', label: 'Причины', defaultOrder: 6, mandatory: false, small: false, labeled: true },
  { key: 'measures', label: 'Принятые меры', defaultOrder: 7, mandatory: false, small: false, labeled: true },
  { key: 'consequences', label: 'Последствия', defaultOrder: 8, mandatory: false, small: false, labeled: true },
  { key: 'responsible', label: 'Ответственные', defaultOrder: 9, mandatory: false, small: false, labeled: true },
];

test('VIOLATION_FIELDS заморожен: и сам массив, и каждое описание поля', () => {
  assert.equal(Object.isFrozen(VIOLATION_FIELDS), true, 'VIOLATION_FIELDS должен быть frozen');
  for (const field of VIOLATION_FIELDS) {
    assert.equal(Object.isFrozen(field), true, `описание поля '${field.key}' должно быть frozen`);
  }
});

test('VIOLATION_LABELS, VIOLATION_FIELD_KEYS и MANDATORY_FIELD_KEYS заморожены', () => {
  assert.equal(Object.isFrozen(VIOLATION_LABELS), true);
  assert.equal(Object.isFrozen(VIOLATION_FIELD_KEYS), true);
  assert.equal(Object.isFrozen(MANDATORY_FIELD_KEYS), true);
});

test('набор полей и их значения закреплены точным литералом (ручная синхронизация с violation_fields.py)', () => {
  assert.deepEqual(
    VIOLATION_FIELDS.map(f => ({
      key: f.key,
      label: f.label,
      defaultOrder: f.defaultOrder,
      mandatory: f.mandatory,
      small: f.small,
      labeled: f.labeled,
    })),
    EXPECTED_FIELDS,
    'VIOLATION_FIELDS обязан совпадать с контрактом бэкенда app/domains/acts/violation_fields.py'
  );
});

test('labeled: без метки в рендерах — ровно CodeMining/ProcessMining/Дополнительный контент', () => {
  const unlabeled = VIOLATION_FIELDS.filter(f => !f.labeled).map(f => f.key);
  assert.deepEqual(unlabeled, ['codeMining', 'processMining', 'additionalContent']);
});

test('small: 9pt-курсив — ровно Нарушено/Установлено (доп. контент выведен из группы)', () => {
  const smallKeys = VIOLATION_FIELDS.filter(f => f.small).map(f => f.key);
  assert.deepEqual(smallKeys, ['violated', 'established']);
});

test('defaultOrder — позиция поля в реестре', () => {
  VIOLATION_FIELDS.forEach((f, i) => assert.equal(f.defaultOrder, i));
});

test('VIOLATION_LABELS собран из VIOLATION_FIELDS в том же порядке', () => {
  assert.deepEqual(Object.keys(VIOLATION_LABELS), EXPECTED_FIELDS.map(f => f.key));
  assert.equal(VIOLATION_LABELS.responsible, 'Ответственные');
  assert.equal(VIOLATION_LABELS.codeMining, 'CodeMining');
});

test('MANDATORY_FIELD_KEYS — ровно violated и established', () => {
  assert.deepEqual([...MANDATORY_FIELD_KEYS], ['violated', 'established']);
});

test('getOrderedFieldKeys: null/отсутствие → стандартный порядок', () => {
  assert.deepEqual(getOrderedFieldKeys(null), [...VIOLATION_FIELD_KEYS]);
  assert.deepEqual(getOrderedFieldKeys({}), [...VIOLATION_FIELD_KEYS]);
  assert.deepEqual(getOrderedFieldKeys({ fieldOrder: null }), [...VIOLATION_FIELD_KEYS]);
});

test('getOrderedFieldKeys: валидная перестановка возвращается как есть', () => {
  const order = [...VIOLATION_FIELD_KEYS].reverse();
  assert.deepEqual(getOrderedFieldKeys({ fieldOrder: order }), order);
});

test('getOrderedFieldKeys: неполный, дублирующий или чужой ключ → стандартный порядок', () => {
  assert.deepEqual(
    getOrderedFieldKeys({ fieldOrder: VIOLATION_FIELD_KEYS.slice(1) }),
    [...VIOLATION_FIELD_KEYS],
    'неполный порядок игнорируется'
  );
  const withDup = [...VIOLATION_FIELD_KEYS.slice(0, 9), 'violated'];
  assert.deepEqual(getOrderedFieldKeys({ fieldOrder: withDup }), [...VIOLATION_FIELD_KEYS], 'дубль игнорируется');
  const withAlien = [...VIOLATION_FIELD_KEYS.slice(0, 9), 'unknownField'];
  assert.deepEqual(getOrderedFieldKeys({ fieldOrder: withAlien }), [...VIOLATION_FIELD_KEYS], 'чужой ключ игнорируется');
});

test('BLOCK_TYPES: ровно text/image/table (синхрон с Literal-типами бэка)', () => {
  assert.equal(Object.isFrozen(BLOCK_TYPES), true);
  assert.deepEqual(BLOCK_TYPES, { TEXT: 'text', IMAGE: 'image', TABLE: 'table' });
});

test('фабрики блоков создают релевантные типу поля с уникальными id', () => {
  const text = createTextBlock('<p>x</p>');
  assert.equal(text.type, 'text');
  assert.equal(text.content, '<p>x</p>');
  assert.ok(text.id.startsWith('text_'));

  const image = createImageBlock({ url: 'data:image/png;base64,AAA', filename: 'a.png', width: 50 });
  assert.equal(image.type, 'image');
  assert.equal(image.url, 'data:image/png;base64,AAA');
  assert.equal(image.caption, '');
  assert.equal(image.filename, 'a.png');
  assert.equal(image.width, 50);

  const table = createTableBlock();
  assert.equal(table.type, 'table');
  // Стартовая сетка 2×2: первая строка — шапка (isHeader), веса колонок поровну.
  assert.equal(table.table.grid.length, 2);
  assert.deepEqual(table.table.colWidths, [100, 100]);
  assert.deepEqual(table.table.grid.map(row => row.map(c => c.isHeader)),
    [[true, true], [false, false]]);
  assert.ok(table.table.grid.flat().every(c => c.content === ''));

  const ids = new Set([text.id, image.id, table.id, createTextBlock().id]);
  assert.equal(ids.size, 4, 'id блоков уникальны');
});

test('защита от prototype-pollution: ключи Object.prototype не входят в VIOLATION_LABELS', () => {
  for (const protoKey of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(VIOLATION_LABELS, protoKey),
      false,
      `'${protoKey}' — ключ прототипа, не поле нарушения`
    );
  }
  assert.deepEqual(Object.keys(VIOLATION_LABELS).sort(), EXPECTED_FIELDS.map(f => f.key).sort());
});
