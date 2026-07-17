/**
 * Тесты контракта полей нарушения (violation-fields.js, #31A).
 *
 * По образцу block-types.test.mjs:
 *  - VIOLATION_FIELDS и каждое описание поля заморожены;
 *  - набор ключей/меток закреплён точными строками — ручная синхронизация
 *    с бэкенд-контрактом app/domains/acts/violation_fields.py;
 *  - VIOLATION_LABELS не подвержен prototype pollution;
 *  - CASE_LABEL_TEMPLATE / FREE_TEXT_LABEL — точные значения.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIOLATION_FIELDS,
  VIOLATION_LABELS,
  CASE_LABEL_TEMPLATE,
  FREE_TEXT_LABEL,
} from '../../static/js/constructor/violation/violation-fields.js';

const EXPECTED_FIELDS = [
  { key: 'violated', label: 'Нарушено', order: 0, kind: 'pair', small: true, showLabelInPreview: true },
  { key: 'established', label: 'Установлено', order: 1, kind: 'pair', small: true, showLabelInPreview: true },
  { key: 'descriptionList', label: '', order: 2, kind: 'list', small: true, showLabelInPreview: false },
  { key: 'additionalContent', label: '', order: 3, kind: 'additional', small: true, showLabelInPreview: false },
  { key: 'reasons', label: 'Причины', order: 4, kind: 'optional_text', small: false, showLabelInPreview: true },
  { key: 'measures', label: 'Принятые меры', order: 5, kind: 'optional_text', small: false, showLabelInPreview: true },
  { key: 'consequences', label: 'Последствия', order: 6, kind: 'optional_text', small: false, showLabelInPreview: true },
  { key: 'responsible', label: 'Ответственные', order: 7, kind: 'optional_text', small: false, showLabelInPreview: true },
];

test('VIOLATION_FIELDS заморожен: и сам массив, и каждое описание поля', () => {
  assert.equal(Object.isFrozen(VIOLATION_FIELDS), true, 'VIOLATION_FIELDS должен быть frozen');
  for (const field of VIOLATION_FIELDS) {
    assert.equal(Object.isFrozen(field), true, `описание поля '${field.key}' должно быть frozen`);
  }
});

test('VIOLATION_LABELS заморожен', () => {
  assert.equal(Object.isFrozen(VIOLATION_LABELS), true, 'VIOLATION_LABELS должен быть frozen');
});

test('набор полей и их значения закреплены точным литералом (ручная синхронизация с violation_fields.py)', () => {
  assert.deepEqual(
    VIOLATION_FIELDS.map(f => ({
      key: f.key,
      label: f.label,
      order: f.order,
      kind: f.kind,
      small: f.small,
      showLabelInPreview: f.showLabelInPreview,
    })),
    EXPECTED_FIELDS,
    'VIOLATION_FIELDS обязан совпадать с контрактом бэкенда app/domains/acts/violation_fields.py'
  );
});

test('VIOLATION_LABELS собран из VIOLATION_FIELDS в том же порядке', () => {
  assert.deepEqual(
    Object.keys(VIOLATION_LABELS),
    EXPECTED_FIELDS.map(f => f.key)
  );
  assert.equal(VIOLATION_LABELS.responsible, 'Ответственные');
  assert.equal(VIOLATION_LABELS.descriptionList, '');
});

test('CASE_LABEL_TEMPLATE и FREE_TEXT_LABEL — точные значения', () => {
  assert.equal(CASE_LABEL_TEMPLATE, 'Кейс {n}');
  assert.equal(FREE_TEXT_LABEL, '');
});

test('rich-флаг ровно на 6 текстовых полях (синхрон с бэком violation_fields.py)', () => {
  assert.deepEqual(
    VIOLATION_FIELDS.filter(f => f.rich).map(f => f.key),
    ['violated', 'established', 'reasons', 'measures', 'consequences', 'responsible']
  );
  assert.equal(VIOLATION_FIELDS.find(f => f.key === 'descriptionList').rich, undefined);
  assert.equal(VIOLATION_FIELDS.find(f => f.key === 'additionalContent').rich, undefined);
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
