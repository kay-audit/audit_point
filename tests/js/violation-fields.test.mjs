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
  FIELD_BY_KEY,
  getOrderedFieldKeys,
  isValidFieldOrder,
} from '../../static/js/constructor/violation/violation-fields.js';
import {
  BLOCK_TYPES,
  BLOCK_TYPE_META,
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

test('FIELD_BY_KEY: заморожен, покрывает весь реестр и отдаёт те же дескрипторы', () => {
  assert.equal(Object.isFrozen(FIELD_BY_KEY), true);
  assert.deepEqual(Object.keys(FIELD_BY_KEY), [...VIOLATION_FIELD_KEYS]);
  for (const field of VIOLATION_FIELDS) {
    assert.equal(FIELD_BY_KEY[field.key], field, `FIELD_BY_KEY['${field.key}'] — тот же объект реестра`);
  }
});

test('isValidFieldOrder: перестановка всех ключей — единственный валидный вход', () => {
  assert.equal(isValidFieldOrder([...VIOLATION_FIELD_KEYS]), true, 'стандартный порядок валиден');
  assert.equal(isValidFieldOrder([...VIOLATION_FIELD_KEYS].reverse()), true, 'любая перестановка валидна');

  assert.equal(isValidFieldOrder(null), false);
  assert.equal(isValidFieldOrder(undefined), false);
  assert.equal(isValidFieldOrder('violated'), false, 'не массив');
  assert.equal(isValidFieldOrder(VIOLATION_FIELD_KEYS.slice(1)), false, 'неполный');
  assert.equal(
    isValidFieldOrder([...VIOLATION_FIELD_KEYS, 'violated']),
    false,
    'лишний элемент'
  );
  assert.equal(
    isValidFieldOrder([...VIOLATION_FIELD_KEYS.slice(0, 9), 'violated']),
    false,
    'дубль вместо пропущенного ключа'
  );
  assert.equal(
    isValidFieldOrder([...VIOLATION_FIELD_KEYS.slice(0, 9), 'unknownField']),
    false,
    'чужой ключ'
  );
});

test('getOrderedFieldKeys и isValidFieldOrder судят по одному критерию', () => {
  const cases = [
    null,
    [...VIOLATION_FIELD_KEYS].reverse(),
    VIOLATION_FIELD_KEYS.slice(1),
    [...VIOLATION_FIELD_KEYS.slice(0, 9), 'violated'],
    [...VIOLATION_FIELD_KEYS.slice(0, 9), 'unknownField'],
  ];
  for (const fieldOrder of cases) {
    const usedCustomOrder = getOrderedFieldKeys({ fieldOrder }) !== VIOLATION_FIELD_KEYS;
    assert.equal(
      usedCustomOrder,
      isValidFieldOrder(fieldOrder),
      `порядок ${JSON.stringify(fieldOrder)}: читатель и предикат обязаны совпадать`
    );
  }
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

test('BLOCK_TYPE_META: дескриптор на КАЖДЫЙ тип блока, все поля заполнены', () => {
  // Страж ревью №17: новый тип в BLOCK_TYPES без записи в реестре метаданных
  // валит тест — иначе он молча остался бы без подписи в тулбаре, меню,
  // миниатюре перетаскивания и заголовке диффа.
  assert.equal(Object.isFrozen(BLOCK_TYPE_META), true);
  assert.deepEqual(
    Object.keys(BLOCK_TYPE_META).sort(),
    Object.values(BLOCK_TYPES).sort(),
    'реестр метаданных обязан покрывать все типы блоков'
  );

  for (const [type, meta] of Object.entries(BLOCK_TYPE_META)) {
    assert.equal(Object.isFrozen(meta), true, `дескриптор '${type}' должен быть frozen`);
    assert.equal(meta.type, type, `meta.type '${type}' совпадает с ключом реестра`);
    for (const prop of ['label', 'shortLabel', 'menuLabel', 'icon', 'dragIcon']) {
      assert.equal(typeof meta[prop], 'string', `'${type}'.${prop} — строка`);
      assert.ok(meta[prop].length > 0, `'${type}'.${prop} не пустой`);
    }
    assert.equal(typeof meta.create, 'function', `'${type}'.create — фабрика`);
    assert.equal(meta.create({}).type, type, `'${type}'.create() создаёт блок своего типа`);
  }
});

test('BLOCK_TYPE_META: подписи и порядок типов в UI закреплены литералом', () => {
  // Порядок ключей реестра = порядок кнопок тулбара и пунктов контекст-меню.
  assert.deepEqual(Object.keys(BLOCK_TYPE_META), ['text', 'table', 'image']);
  assert.deepEqual(
    Object.values(BLOCK_TYPE_META).map(m => [m.label, m.shortLabel, m.menuLabel, m.icon, m.dragIcon]),
    [
      ['Текст', 'Текст', 'Добавить текст', '📄', '📝'],
      ['Таблица', 'Таблица', 'Добавить таблицу', '📊', '📊'],
      ['Изображение', 'Картинка', 'Добавить изображение', '🖼️', '🖼️'],
    ]
  );
});

test('BLOCK_TYPE_META.create: единая сигнатура create(extraData) для всех типов', () => {
  const text = BLOCK_TYPE_META[BLOCK_TYPES.TEXT].create({ content: '<p>x</p>' });
  assert.equal(text.content, '<p>x</p>');
  assert.equal(BLOCK_TYPE_META[BLOCK_TYPES.TEXT].create().content, '', 'без extraData — пустой текст');

  const image = BLOCK_TYPE_META[BLOCK_TYPES.IMAGE].create({ url: 'data:image/png;base64,AAA', filename: 'a.png' });
  assert.equal(image.url, 'data:image/png;base64,AAA');
  assert.equal(image.filename, 'a.png');

  const table = BLOCK_TYPE_META[BLOCK_TYPES.TABLE].create();
  assert.equal(table.table.grid.length, 2, 'таблица создаётся стартовой сеткой 2×2');
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
