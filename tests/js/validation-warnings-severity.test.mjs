/**
 * Тесты чистой функции collectTableWarnings (validation-table-core.js).
 *
 * Функция агрегирует контентные/структурные замечания по всем таблицам без
 * DOM/AppState. Ключевое — критичность по типу:
 *   - 'error' (красный) — структурный дефект уровня сервера (hasStructuralDefect:
 *     не прямоугольная сетка / span за границей; контентные проверки для такой
 *     таблицы пропускаются), а также проблемы шапки: нет шапки (E6) и пустые
 *     заголовки — паритет с сервером, который отдаёт `table_no_header` /
 *     `table_empty_header` с severity='error';
 *   - 'warning' (оранжевый) — неполнота: нет данных (E5).
 * Важный инвариант: инертный устаревший spanOrigin (после legacy-операций с
 * колонками) НЕ считается структурным дефектом и не красит таблицу красным.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCell } from './_setup.mjs';
import { collectTableWarnings, hasStructuralDefect } from '../../static/js/constructor/validation/validation-table-core.js';
import { groupTableWarnings } from '../../static/js/constructor/header/notifications-warnings-group.js';

/**
 * Строит строку из ячеек с заданными content/isHeader.
 * @param {Array<{content?:string, isHeader?:boolean}>} cells
 */
function row(cells) {
  return cells.map((opts) => makeCell(opts));
}

/** Резолвер имени таблицы по id (для проверки проброса). */
function nameById(id) {
  return 'Имя ' + id;
}

// ──────────────────────────────────────────────────────────────────────────
// Пустой/тривиальный вход
// ──────────────────────────────────────────────────────────────────────────

test('collectTableWarnings: пустой словарь таблиц → []', () => {
  assert.deepEqual(collectTableWarnings({}, nameById), []);
});

test('collectTableWarnings: null/undefined → []', () => {
  assert.deepEqual(collectTableWarnings(null, nameById), []);
  assert.deepEqual(collectTableWarnings(undefined, nameById), []);
});

test('collectTableWarnings: таблица без grid пропускается → []', () => {
  const tables = { t1: {}, t2: { grid: [] } };
  assert.deepEqual(collectTableWarnings(tables, nameById), []);
});

// ──────────────────────────────────────────────────────────────────────────
// Корректная таблица — нет замечаний
// ──────────────────────────────────────────────────────────────────────────

test('collectTableWarnings: валидная шапка + данные → нет замечаний для таблицы', () => {
  const tables = {
    t1: {
      grid: [
        row([{ content: 'A', isHeader: true }, { content: 'B', isHeader: true }]),
        row([{ content: '1' }, { content: '2' }]),
      ],
    },
  };
  assert.deepEqual(collectTableWarnings(tables, nameById), []);
});

// ──────────────────────────────────────────────────────────────────────────
// Проблемы шапки (severity: 'error' — паритет с сервером)
// ──────────────────────────────────────────────────────────────────────────

test('collectTableWarnings: нет строки заголовка → одно error «нет строки заголовка»', () => {
  // Сервер отдаёт `table_no_header` с severity='error' и красит по нему карточку
  // акта; клиент — единственная поверхность, которая это замечание показывает
  // (серверный источник колокольчика его подавляет), поэтому критичность обязана
  // совпадать.
  const tables = {
    t1: {
      grid: [
        row([{ content: '1' }, { content: '2' }]),
        row([{ content: '3' }, { content: '4' }]),
      ],
    },
  };
  const warnings = collectTableWarnings(tables, nameById);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].severity, 'error');
  assert.equal(warnings[0].issue, 'нет строки заголовка');
});

test('collectTableWarnings: пустая ячейка шапки → error «не заполнены заголовки»', () => {
  const tables = {
    t1: {
      grid: [
        row([{ content: 'A', isHeader: true }, { content: '', isHeader: true }]),
        row([{ content: '1' }, { content: '2' }]),
      ],
    },
  };
  const warnings = collectTableWarnings(tables, nameById);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].severity, 'error');
  assert.equal(warnings[0].issue, 'не заполнены заголовки');
});

// ──────────────────────────────────────────────────────────────────────────
// Неполнота (severity: 'warning')
// ──────────────────────────────────────────────────────────────────────────

test('collectTableWarnings: шапка есть, данных нет → warning «нет данных»', () => {
  const tables = {
    t1: {
      grid: [
        row([{ content: 'A', isHeader: true }, { content: 'B', isHeader: true }]),
      ],
    },
  };
  const warnings = collectTableWarnings(tables, nameById);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].severity, 'warning');
  assert.equal(warnings[0].issue, 'нет данных');
});

// ──────────────────────────────────────────────────────────────────────────
// Структурная поломка (severity: 'error') — контентные проверки пропускаются
// ──────────────────────────────────────────────────────────────────────────

test('collectTableWarnings: рваная сетка → error «нарушена структура» и без контентных warning', () => {
  const grid = [
    [makeCell({ content: 'A', isHeader: true })],
    [makeCell({ content: '1' }), makeCell({ content: '2' })],
  ];
  // Убеждаемся, что такая сетка действительно структурно дефектна.
  assert.equal(hasStructuralDefect(grid), true);

  const warnings = collectTableWarnings({ t1: { grid } }, nameById);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].severity, 'error');
  assert.equal(warnings[0].issue, 'нарушена структура таблицы');
});

test('collectTableWarnings: рассинхрон colWidths НЕ дефект (сервер молча нормализует, паритет)', () => {
  // Сервер больше не отклоняет несовпадение длины colWidths с числом колонок —
  // он ОЧИЩАЕТ веса (DOCX делит ширину поровну). Клиент не должен быть строже:
  // состояние, которое сервер сам чинит, не помечается дефектом/предупреждением.
  const grid = [
    row([{ content: 'A', isHeader: true }, { content: 'B', isHeader: true }]),
    row([{ content: '1' }, { content: '2' }]),
  ];
  assert.equal(hasStructuralDefect(grid, [1, 1, 1]), false);

  const warnings = collectTableWarnings({ t1: { grid, colWidths: [1, 1, 1] } }, nameById);
  // Таблица корректна по содержимому → ни error, ни warning по этому поводу.
  assert.equal(warnings.length, 0);
});

test('collectTableWarnings: пустой colWidths НЕ структурный дефект (паритет с сервером)', () => {
  // Сервер допускает пустой colWidths (`if self.colWidths and ...`, DOCX делит
  // ширину поровну); insert_table(col_widths=[]) даёт ровно такой случай.
  // Клиент не должен быть строже сервера — красить такую таблицу красным нельзя.
  const grid = [
    row([{ content: 'A', isHeader: true }, { content: 'B', isHeader: true }]),
    row([{ content: '1' }, { content: '2' }]),
  ];
  assert.equal(hasStructuralDefect(grid, []), false);

  const warnings = collectTableWarnings({ t1: { grid, colWidths: [] } }, nameById);
  assert.equal(warnings.some((w) => w.severity === 'error'), false);
});

test('collectTableWarnings: инертный устаревший spanOrigin НЕ красит красным (инвариант)', () => {
  // Сетка прямоугольна, span в границах, но у поглощённой ячейки spanOrigin
  // указывает «не туда» (как после legacy-операции с колонками). validateGrid
  // забраковал бы это, а сервер и рендер — нет. Значит: НЕ error.
  const grid = [
    [
      makeCell({ content: 'Шапка', isHeader: true, colSpan: 2 }),
      makeCell({ content: '', isHeader: true, isSpanned: true, spanOrigin: { row: 9, col: 9 } }),
    ],
    row([{ content: '1' }, { content: '2' }]),
  ];
  assert.equal(hasStructuralDefect(grid), false);

  const warnings = collectTableWarnings({ t1: { grid } }, nameById);
  // Никаких 'error'; таблица корректна по содержимому → замечаний нет.
  assert.equal(warnings.some((w) => w.severity === 'error'), false);
});

// ──────────────────────────────────────────────────────────────────────────
// Проброс tableId / tableName
// ──────────────────────────────────────────────────────────────────────────

test('collectTableWarnings: tableId и tableName пробрасываются', () => {
  const tables = {
    tbl42: {
      grid: [
        row([{ content: '1' }, { content: '2' }]),
      ],
    },
  };
  const warnings = collectTableWarnings(tables, nameById);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].tableId, 'tbl42');
  assert.equal(warnings[0].tableName, 'Имя tbl42');
});

// ──────────────────────────────────────────────────────────────────────────
// Несколько таблиц — плоский список с корректными записями по каждой
// ──────────────────────────────────────────────────────────────────────────

test('collectTableWarnings: несколько таблиц → плоский список с верными записями', () => {
  const tables = {
    ok: {
      grid: [
        row([{ content: 'A', isHeader: true }]),
        row([{ content: '1' }]),
      ],
    },
    noHeader: {
      grid: [
        row([{ content: '1' }]),
      ],
    },
    noData: {
      grid: [
        row([{ content: 'A', isHeader: true }]),
      ],
    },
    broken: {
      grid: [
        [makeCell({ content: 'A', isHeader: true })],
        [makeCell({ content: '1' }), makeCell({ content: '2' })],
      ],
    },
  };

  const warnings = collectTableWarnings(tables, nameById);
  // ok — без замечаний; остальные три — по одному.
  assert.equal(warnings.length, 3);

  const byId = new Map(warnings.map((w) => [w.tableId, w]));
  assert.equal(byId.get('noHeader').severity, 'error');
  assert.equal(byId.get('noHeader').issue, 'нет строки заголовка');
  assert.equal(byId.get('noData').severity, 'warning');
  assert.equal(byId.get('noData').issue, 'нет данных');
  assert.equal(byId.get('broken').severity, 'error');
  assert.equal(byId.get('broken').issue, 'нарушена структура таблицы');
  assert.equal(byId.has('ok'), false);
});

// ──────────────────────────────────────────────────────────────────────────
// Ленивое разрешение имени таблицы (#13): резолвер вызывается максимум один раз
// на проблемную таблицу и НОЛЬ раз на валидную.
// ──────────────────────────────────────────────────────────────────────────

/** Резолвер имени со счётчиком вызовов для проверки ленивости. */
function countingResolver() {
  let calls = 0;
  const fn = (id) => {
    calls += 1;
    return 'Имя ' + id;
  };
  return { fn, calls: () => calls };
}

test('collectTableWarnings: валидная таблица → резолвер имени НЕ вызывается (счётчик 0)', () => {
  const tables = {
    t1: {
      grid: [
        row([{ content: 'A', isHeader: true }, { content: 'B', isHeader: true }]),
        row([{ content: '1' }, { content: '2' }]),
      ],
    },
  };
  const resolver = countingResolver();
  const warnings = collectTableWarnings(tables, resolver.fn);
  assert.deepEqual(warnings, []);
  assert.equal(resolver.calls(), 0);
});

test('collectTableWarnings: одна проблемная таблица → резолвер вызван ровно 1 раз', () => {
  const tables = {
    t1: {
      grid: [
        row([{ content: '1' }, { content: '2' }]), // нет шапки
      ],
    },
  };
  const resolver = countingResolver();
  const warnings = collectTableWarnings(tables, resolver.fn);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].tableName, 'Имя t1');
  assert.equal(resolver.calls(), 1);
});

test('collectTableWarnings: пустой заголовок И нет данных (две ветки) → резолвер вызван 1 раз (мемо)', () => {
  // Шапка есть (одна строка), но в ней пустая ячейка → ветка hasEmptyHeaders.
  // Под шапкой нет ни одной заполненной строки данных → ветка !hasDataRows.
  // Обе ветки срабатывают для одной таблицы (без continue), но ленивый мемо
  // гарантирует ровно один DFS-резолв имени.
  const tables = {
    t1: {
      grid: [
        row([{ content: 'A', isHeader: true }, { content: '', isHeader: true }]),
      ],
    },
  };
  const resolver = countingResolver();
  const warnings = collectTableWarnings(tables, resolver.fn);
  // Два замечания: error «не заполнены заголовки» и warning «нет данных».
  assert.equal(warnings.length, 2);
  const byIssue = new Map(warnings.map((w) => [w.issue, w]));
  assert.equal(byIssue.get('не заполнены заголовки')?.severity, 'error');
  assert.equal(byIssue.get('нет данных')?.severity, 'warning');
  // Резолвер вызван один раз, несмотря на два push-сайта.
  assert.equal(resolver.calls(), 1);
});

// ──────────────────────────────────────────────────────────────────────────
// Свёртка в группы после смены критичности шапки на 'error'.
// Ключ группы — «severity + текст замечания», поэтому смена severity меняет
// раскладку групп: проверяем, что однотипные замечания по-прежнему сворачиваются
// в одну строку и несут ту критичность, которую отдало ядро.
// ──────────────────────────────────────────────────────────────────────────

test('collectTableWarnings + groupTableWarnings: заголовочные группы красные, «нет данных» — жёлтая', () => {
  const tables = {
    // Две таблицы без шапки → одна error-группа на две таблицы.
    a: { grid: [row([{ content: '1' }])] },
    b: { grid: [row([{ content: '2' }])] },
    // Пустая ячейка шапки + нет данных → error-группа и warning-группа.
    c: { grid: [row([{ content: 'X', isHeader: true }, { content: '', isHeader: true }])] },
    // Только нет данных → попадает в ту же warning-группу, что и «c».
    d: { grid: [row([{ content: 'Y', isHeader: true }])] },
  };

  const groups = groupTableWarnings(collectTableWarnings(tables, nameById));
  const byKey = new Map(groups.map((g) => [g.key, g]));

  assert.equal(groups.length, 3, 'три вида замечаний → три группы');
  assert.equal(byKey.get('error:нет строки заголовка').tables.length, 2);
  assert.equal(byKey.get('error:нет строки заголовка').body, '2 таблицы');
  assert.equal(byKey.get('error:не заполнены заголовки').tables.length, 1);
  assert.deepEqual(
    byKey.get('warning:нет данных').tables.map((t) => t.tableId),
    ['c', 'd']
  );
  // Заголовочные замечания больше не сваливаются в один warning-«котёл» с
  // «нет данных»: ключи различаются и критичностью, и текстом.
  assert.equal(byKey.has('warning:нет строки заголовка'), false);
  assert.equal(byKey.has('warning:не заполнены заголовки'), false);
});
