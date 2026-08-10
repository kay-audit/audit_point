/**
 * Смоук панели-формализатора: цепочка импортов резолвится под браузер-стабом,
 * объект экспортирован с ключевыми методами и в window. DOM-heavy поток
 * (formalize → превью → применить) покрывается вручную/e2e в браузере.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FormalizerPopover } from '../../static/js/constructor/text-actions/formalizer-popover.js';

test('FormalizerPopover: экспортирован объект с ключевыми методами', () => {
  for (const m of ['open', 'close', '_build', '_run', '_renderPreview', '_renderRecommendations', '_accept', '_enterRecommendationsView', '_gatherSource']) {
    assert.equal(typeof FormalizerPopover[m], 'function', `метод ${m}`);
  }
});

test('FormalizerPopover: продублирован в window для inline-скриптов', () => {
  assert.equal(globalThis.window.FormalizerPopover, FormalizerPopover);
});

// --- _gatherSource: сбор свободного текста из заполненных полей карточки ---
//
// Блочная модель: _gatherSource обходит поля в порядке getOrderedFieldKeys,
// берёт только включённые контейнеры и внутри — text.content / image.caption
// через this._richToPlain, table — через tableToMarkdown. Тесты проверяют
// структуру сбора (порядок/enabled-фильтр/типы блоков/join), а не адаптер
// rich→plain (тот покрыт в formalizer-rich-adapters.test.mjs) — ОСОЗНАННО
// подменяют _richToPlain на identity.

import { tableToMarkdown } from '../../static/js/constructor/text-actions/formalizer-popover.js';
import { VIOLATION_FIELD_KEYS } from '../../static/js/constructor/violation/violation-fields.js';

let _tb = 0;
const textBlock = (content) => ({ id: `text_${++_tb}`, type: 'text', content });
const field = (enabled, ...blocks) => ({ enabled, blocks });

function blockViolation(overrides = {}) {
  const v = { id: 'v1', fieldOrder: null };
  for (const key of VIOLATION_FIELD_KEYS) v[key] = { enabled: false, blocks: [] };
  v.violated = field(true, textBlock('Нарушен регламент'));
  v.established = field(true, textBlock('Выявлено 5 случаев'));
  return Object.assign(v, overrides);
}

test('_gatherSource: собирает блоки включённых полей в порядке карточки через пустую строку', () => {
  const original = FormalizerPopover._richToPlain;
  FormalizerPopover._richToPlain = (s) => s;
  try {
    const violation = blockViolation({
      reasons: field(true, textBlock('Отсутствие контроля'), textBlock('И вторая причина')),
      responsible: field(true, textBlock('Иванов И.И.')),
    });
    assert.equal(
      FormalizerPopover._gatherSource(violation),
      'Нарушен регламент\n\nВыявлено 5 случаев\n\nОтсутствие контроля\n\nИ вторая причина\n\nИванов И.И.',
    );
  } finally {
    FormalizerPopover._richToPlain = original;
  }
});

test('_gatherSource: уважает fieldOrder нарушения', () => {
  const original = FormalizerPopover._richToPlain;
  FormalizerPopover._richToPlain = (s) => s;
  try {
    const order = [...VIOLATION_FIELD_KEYS].filter(k => k !== 'responsible');
    order.unshift('responsible');
    const violation = blockViolation({
      fieldOrder: order,
      responsible: field(true, textBlock('Иванов И.И.')),
    });
    assert.ok(FormalizerPopover._gatherSource(violation).startsWith('Иванов И.И.'));
  } finally {
    FormalizerPopover._richToPlain = original;
  }
});

test('_gatherSource: выключенные поля пропускаются даже с блоками', () => {
  const original = FormalizerPopover._richToPlain;
  FormalizerPopover._richToPlain = (s) => s;
  try {
    const violation = blockViolation({
      established: field(true),
      reasons: field(false, textBlock('скрытая причина')),
      measures: field(true, textBlock('Меры приняты')),
    });
    assert.equal(FormalizerPopover._gatherSource(violation), 'Нарушен регламент\n\nМеры приняты');
  } finally {
    FormalizerPopover._richToPlain = original;
  }
});

test('_gatherSource: image-блок отдаёт caption, table-блок — markdown-сетку', () => {
  const original = FormalizerPopover._richToPlain;
  FormalizerPopover._richToPlain = (s) => s;
  try {
    const violation = blockViolation({
      violated: field(true, textBlock('Текст')),
      established: field(true),
      additionalContent: field(
        true,
        { id: 'img1', type: 'image', url: 'data:image/png;base64,AAAA', caption: 'Подпись скриншота', filename: 'a.png', width: 0 },
        { id: 'tbl1', type: 'table', table: { grid: [[{ content: 'Запрос' }], [{ content: 'SELECT 1' }]], colWidths: [100] } },
      ),
    });
    const out = FormalizerPopover._gatherSource(violation);
    assert.ok(out.includes('Подпись скриншота'), 'caption картинки собран');
    assert.ok(out.includes('| Запрос |'), 'таблица сериализована markdown-сеткой');
    assert.ok(out.includes('| SELECT 1 |'));
    assert.ok(!out.includes('base64'), 'base64-байты картинки в LLM не идут');
  } finally {
    FormalizerPopover._richToPlain = original;
  }
});

test('_gatherSource: пустые/пробельные блоки и пустое нарушение → пустая строка', () => {
  const original = FormalizerPopover._richToPlain;
  FormalizerPopover._richToPlain = (s) => s;
  try {
    assert.equal(FormalizerPopover._gatherSource(null), '');
    assert.equal(FormalizerPopover._gatherSource(undefined), '');
    const violation = blockViolation({
      violated: field(true, textBlock('   ')),
      established: field(true, textBlock('')),
      reasons: field(true),
    });
    assert.equal(FormalizerPopover._gatherSource(violation), '');
  } finally {
    FormalizerPopover._richToPlain = original;
  }
});

// --- tableToMarkdown: чистая сериализация сетки для LLM ---

test('tableToMarkdown: шапка + разделитель + строки, pipe экранируется', () => {
  const md = tableToMarkdown({
    grid: [
      [{ content: 'Колонка A' }, { content: 'B|C' }],
      [{ content: 'знач 1' }, { content: 'знач 2' }],
    ],
    colWidths: [100, 100],
  });
  assert.equal(md.split('\n')[0], '| Колонка A | B\\|C |');
  assert.equal(md.split('\n')[1], '| --- | --- |');
  assert.equal(md.split('\n')[2], '| знач 1 | знач 2 |');
});

test('tableToMarkdown: пустая/вырожденная/бесконтентная сетка → пустая строка', () => {
  assert.equal(tableToMarkdown(null), '');
  assert.equal(tableToMarkdown({ grid: [] }), '');
  assert.equal(tableToMarkdown({ grid: [[{ content: '' }], [{ content: '  ' }]] }), '');
});
