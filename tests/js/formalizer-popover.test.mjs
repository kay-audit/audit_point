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

// --- _renderPreview / _accept: показ результата и объявление успеха (ревью №3) ---
//
// Значения ответа — готовый HTML (контракт FormalizeResponse), превью рендерит их
// санитизированной разметкой, а не строкой с тегами. Пустой ответ «Применить» не
// разблокирует. Успех объявляется только по факту записи в карточку.
//
// Стаб _browser-stub не хранит состояние элементов — ниже свой фейк-элемент с
// отслеживаемыми детьми; DOMPurify в node не поднимается, фейк пропускает
// разрешённые профилем теги.

import { Notifications } from '../../static/js/shared/notifications.js';

function makeEl() {
  const classes = new Set();
  return {
    className: '', textContent: '', innerHTML: '', disabled: false, value: '',
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    appendChild(child) { this.children.push(child); return child; },
  };
}

globalThis.window.DOMPurify = {
  sanitize: (html, cfg) => String(html).replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (m, tag) => (
    cfg && Array.isArray(cfg.ALLOWED_TAGS) && cfg.ALLOWED_TAGS.includes(tag.toLowerCase()) ? m : ''
  )),
};

/** Подставляет фейковые _el/_els и makeEl-фабрику на время fn. */
function withFakeDom(fn) {
  const orig = {
    el: FormalizerPopover._el,
    els: FormalizerPopover._els,
    create: globalThis.document.createElement,
    success: Notifications.success,
    info: Notifications.info,
  };
  const notes = [];
  globalThis.document.createElement = () => makeEl();
  Notifications.success = (m) => notes.push({ kind: 'success', m });
  Notifications.info = (m) => notes.push({ kind: 'info', m });
  FormalizerPopover._el = makeEl();
  FormalizerPopover._els = {
    preview: makeEl(), recs: makeEl(), accept: makeEl(),
    reject: makeEl(), source: makeEl(),
  };
  FormalizerPopover._els.recs.classList.add('hidden');
  try {
    return fn(notes);
  } finally {
    FormalizerPopover._el = orig.el;
    FormalizerPopover._els = orig.els;
    globalThis.document.createElement = orig.create;
    Notifications.success = orig.success;
    Notifications.info = orig.info;
  }
}

test('_renderPreview: все поля пусты → один статус, ничего не извлечено', () => {
  withFakeDom(() => {
    const filled = FormalizerPopover._renderPreview({ recommendations: [] });
    const preview = FormalizerPopover._els.preview;

    assert.equal(filled, 0, 'непустых полей нет');
    assert.equal(preview.children.length, 1, 'один статус вместо шести «— не извлечено»');
    assert.equal(preview.children[0].textContent, 'Модель ничего не извлекла из текста');
  });
});

test('_renderPreview: непустое значение рендерится разметкой, пустое — плашкой', () => {
  withFakeDom(() => {
    const filled = FormalizerPopover._renderPreview({
      violated: 'П. 3.1 Регламента',
      reasons: '<ul><li>отсутствие контроля</li></ul>',
    });
    const rows = FormalizerPopover._els.preview.children;

    assert.equal(filled, 2);
    assert.equal(rows.length, 7, 'строка на каждое поле карточки');
    // Порядок _PREVIEW_FIELDS: violated, established, description, reasons, …
    assert.equal(rows[0].children[1].innerHTML, 'П. 3.1 Регламента');
    assert.equal(
      rows[3].children[1].innerHTML,
      '<ul><li>отсутствие контроля</li></ul>',
      'список остался списком, а не текстом с тегами',
    );
    assert.equal(rows[1].children[1].textContent, '— не извлечено', 'established пуст');
  });
});

test('_renderPreview: разметка вне профиля acts вырезается', () => {
  withFakeDom(() => {
    FormalizerPopover._renderPreview({
      violated: '<img src="http://evil.example/p.gif" onerror="alert(1)">текст',
    });
    const value = FormalizerPopover._els.preview.children[0].children[1].innerHTML;

    assert.ok(!value.includes('<img'), 'img не в allowlist профиля acts');
    assert.ok(value.includes('текст'));
  });
});

test('_accept: применено 0 полей → info, окно не закрывается, success нет', () => {
  withFakeDom((notes) => {
    FormalizerPopover._fields = { violated: 'н' };
    FormalizerPopover._apply = () => 0;

    FormalizerPopover._accept();

    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, 'info', 'успех не объявляется');
    assert.ok(!FormalizerPopover._el.classList.contains('hidden'), 'окно осталось открытым');
    assert.ok(FormalizerPopover._fields, 'результат не сброшен — он ещё перед глазами');
  });
});

test('_accept: применены поля → success и закрытие (рекомендаций нет)', () => {
  withFakeDom((notes) => {
    FormalizerPopover._fields = { violated: 'н', reasons: 'п' };
    FormalizerPopover._apply = () => 2;
    const closed = FormalizerPopover._el;

    FormalizerPopover._accept();

    assert.deepEqual(notes.map((n) => n.kind), ['success']);
    assert.ok(closed.classList.contains('hidden'), 'окно закрыто');
  });
});

test('_accept: применены поля + есть рекомендации → окно остаётся в режиме подсказок', () => {
  withFakeDom((notes) => {
    FormalizerPopover._els.recs.classList.remove('hidden');
    FormalizerPopover._fields = { violated: 'н' };
    FormalizerPopover._apply = () => 1;

    FormalizerPopover._accept();

    assert.deepEqual(notes.map((n) => n.kind), ['success']);
    assert.ok(!FormalizerPopover._el.classList.contains('hidden'), 'окно не закрыто');
    assert.ok(FormalizerPopover._el.classList.contains('formalizer-applied'));
    assert.equal(FormalizerPopover._els.reject.textContent, 'Закрыть');
  });
});

test('_renderPreview: «Описание» — единственное поле со списком метрик', () => {
  withFakeDom(() => {
    FormalizerPopover._renderPreview({
      established: 'Допущена выдача кредита без проверки',
      description: '<ul><li>сумма 5 млн руб.</li><li>дата 01.02.2025</li></ul>',
      reasons: 'Отсутствие проверки и контроля лимитов',
    });
    const rows = FormalizerPopover._els.preview.children;
    assert.equal(rows.length, 7);
    assert.equal(rows[2].children[0].textContent, 'Описание');
    assert.equal(
      rows[2].children[1].innerHTML,
      '<ul><li>сумма 5 млн руб.</li><li>дата 01.02.2025</li></ul>',
      'метрики остались списком',
    );
    // Остальные поля — связный текст, маркеров быть не должно.
    assert.equal(rows[1].children[1].innerHTML.includes('<ul>'), false);
    assert.equal(rows[3].children[1].innerHTML.includes('<ul>'), false);
  });
});
