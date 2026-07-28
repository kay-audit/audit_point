/**
 * Тесты ViolationFieldSurface — поверхности поля нарушения по контракту
 * EditableSurface (editable-surface.js), Task 1.3.2.
 *
 * Два режима записи в модель (см. EditorController, editor-controller.js):
 *  - setContent(html) — модель → element, С ре-рендером (внешняя запись:
 *    формализатор, корректор);
 *  - commit() — element → модель, БЕЗ ре-рендера (обычный ввод, каретка жива).
 * setViolationField замокан спаем на инстансе ViolationManager — интересует
 * ТОЛЬКО путь записи (какое поле, какое значение), не логика мутатора
 * (та проверена в violation-mutations.test.mjs).
 *
 * Реальные модули конструктора импортируются под node:test через
 * _browser-stub (см. конвенцию в _browser-stub.mjs).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Входная точка графа нарушений — как в entries/constructor.js: violation-init
// разруливает циклические импорты (core ↔ расширения прототипа) и мешает
// _makeViolationSurface в прототип ViolationManager.
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';

test('_makeViolationSurface: id/kind/rich контракта EditableSurface', () => {
  const vm = new ViolationManager();
  const violation = { id: 'v1', violated: '' };

  const s = vm._makeViolationSurface(violation, 'violated');

  assert.equal(s.id, 'viol:v1:violated');
  assert.equal(s.kind, 'violationField');
  assert.equal(s.rich, true);
});

test('_makeViolationSurface: id для вложенного пути (<key>.content)', () => {
  const vm = new ViolationManager();
  const violation = { id: 'v1', reasons: { enabled: true, content: '' } };

  const s = vm._makeViolationSurface(violation, 'reasons.content');

  assert.equal(s.id, 'viol:v1:reasons.content');
});

test('getContent: читает модель по плоскому и точечному пути', () => {
  const vm = new ViolationManager();
  const violation = { id: 'v1', violated: 'текст', reasons: { enabled: true, content: 'причина' } };

  assert.equal(vm._makeViolationSurface(violation, 'violated').getContent(), 'текст');
  assert.equal(vm._makeViolationSurface(violation, 'reasons.content').getContent(), 'причина');
});

test('setContent → setViolationField (плоский путь и *.content)', () => {
  const vm = new ViolationManager();
  const calls = [];
  vm.setViolationField = (v, p, val) => { calls.push({ p, val }); return true; };
  const violation = { id: 'v1', violated: '', reasons: { enabled: true, content: '' } };

  vm._makeViolationSurface(violation, 'violated').setContent('<b>x</b>');
  vm._makeViolationSurface(violation, 'reasons.content').setContent('<i>y</i>');

  assert.deepEqual(calls, [{ p: 'violated', val: '<b>x</b>' }, { p: 'reasons.content', val: '<i>y</i>' }]);
});

test('commit → element.innerHTML в модель БЕЗ ре-рендера', () => {
  const vm = new ViolationManager();
  const calls = [];
  vm.setViolationField = (v, p, val) => { calls.push({ p, val }); return true; };
  const s = vm._makeViolationSurface({ id: 'v1', violated: '' }, 'violated');

  s.element = { innerHTML: '<b>исправлено</b>' };
  s.commit();

  assert.deepEqual(calls, [{ p: 'violated', val: '<b>исправлено</b>' }]);
});

test('persist → делегирует в commit (element.innerHTML в модель через setViolationField)', () => {
  const vm = new ViolationManager();
  const calls = [];
  vm.setViolationField = (v, p, val) => { calls.push({ p, val }); return true; };
  const s = vm._makeViolationSurface({ id: 'v1', violated: '' }, 'violated');

  s.element = { innerHTML: '<b>x</b>' };
  s.persist();

  assert.deepEqual(calls, [{ p: 'violated', val: '<b>x</b>' }]);
});

// ── Task 1.3.4-A: guard-strip + repair перед записью в модель ─────────────────

test('commit: снимает caret-guard\'ы (U+FEFF) из element.innerHTML перед записью в модель', () => {
  const vm = new ViolationManager();
  const calls = [];
  vm.setViolationField = (v, p, val) => { calls.push({ p, val }); return true; };
  const s = vm._makeViolationSurface({ id: 'v1', violated: '' }, 'violated');
  const guard = String.fromCharCode(0xFEFF);

  const origStrip = textBlockManager._stripGuards;
  textBlockManager._stripGuards = (html) => html.split(guard).join('');
  try {
    s.element = { innerHTML: `${guard}<b>x</b>${guard}` };
    s.commit();
    assert.deepEqual(calls, [{ p: 'violated', val: '<b>x</b>' }], 'guard-символы вычищены до записи в модель');
  } finally {
    textBlockManager._stripGuards = origStrip;
  }
});

test('setContent: чистый html (без guard\'ов) — ровно ОДНА запись в модель (repair — identity)', () => {
  const vm = new ViolationManager();
  const calls = [];
  vm.setViolationField = (v, p, val) => { calls.push({ p, val }); return true; };
  const s = vm._makeViolationSurface({ id: 'v1', violated: '' }, 'violated');

  s.setContent('<b>чистый текст</b>');

  assert.deepEqual(calls, [{ p: 'violated', val: '<b>чистый текст</b>' }]);
});

// ── Task 1.3.4-B1: hardening капсул при внешней записи (setContent) ──────────

test('setContent: normalizeMarkers + tooltip вызваны на element', () => {
  const vm = new ViolationManager();
  vm.setViolationField = () => true;
  const s = vm._makeViolationSurface({ id: 'v1', violated: '' }, 'violated');
  s.element = { textContent: '' };

  const normalizeCalls = [];
  const tooltipCalls = [];
  const origNormalize = textBlockManager.normalizeMarkers;
  const origTooltip = textBlockManager._attachInitialTooltipHandlers;
  textBlockManager.normalizeMarkers = (element) => normalizeCalls.push(element);
  textBlockManager._attachInitialTooltipHandlers = (element) => tooltipCalls.push(element);
  try {
    s.setContent('<b>x</b>');
    assert.deepEqual(normalizeCalls, [s.element], 'normalizeMarkers вызван на element');
    assert.deepEqual(tooltipCalls, [s.element], '_attachInitialTooltipHandlers вызван на element');
  } finally {
    textBlockManager.normalizeMarkers = origNormalize;
    textBlockManager._attachInitialTooltipHandlers = origTooltip;
  }
});

// changed=false (косметика: guard-стрип/снятие contenteditable) НЕ означает
// «строка не изменилась» — _repairCapsulesInRoot меняет строку всегда при
// наличии капсулы, но changed взводит только на структурной починке
// (textblock-capsule-integrity.js:78-89). Сравнивать repaired!==html как
// повод для записи в модель НЕЛЬЗЯ (см. докстринг _repairCapsuleHtml) — модель
// обязана получать report.html БЕЗУСЛОВНО, независимо от changed.
test('setContent: changed=false (только косметика) — модель ВСЕ РАВНО получает report.html, ОДНИМ вызовом', () => {
  const vm = new ViolationManager();
  const calls = [];
  vm.setViolationField = (v, p, val) => { calls.push({ p, val }); return true; };
  const s = vm._makeViolationSurface({ id: 'v1', violated: '' }, 'violated');

  const origReport = textBlockManager._repairCapsulesReport;
  // Косметика: строка отличается от входа (guard'ы вычищены), но changed=false.
  textBlockManager._repairCapsulesReport = () => ({ html: '<span class="text-link">x</span>', changed: false });
  try {
    const guard = String.fromCharCode(0xFEFF);
    s.setContent(`${guard}<span class="text-link" contenteditable="true">x</span>${guard}`);
    assert.deepEqual(calls, [{ p: 'violated', val: '<span class="text-link">x</span>' }],
      'модель получает report.html ОДНИМ вызовом независимо от changed');
  } finally {
    textBlockManager._repairCapsulesReport = origReport;
  }
});

test('setContent: changed=false — DOM без повторного ре-рендера (первый рендер — переданным html)', () => {
  const vm = new ViolationManager();
  vm.setViolationField = () => true;
  const s = vm._makeViolationSurface({ id: 'v1', violated: '' }, 'violated');
  s.element = { textContent: '' };

  const origReport = textBlockManager._repairCapsulesReport;
  textBlockManager._repairCapsulesReport = () => ({ html: '<b>чисто</b>', changed: false });
  try {
    s.setContent('<b>исходный</b>');
    assert.equal(s.element.textContent, '<b>исходный</b>', 'без структурной починки повторный рендер избыточен');
  } finally {
    textBlockManager._repairCapsulesReport = origReport;
  }
});

// ── #12 (основа): нормализация пустого коммита ────────────────────────────

test('commit: элемент содержит только \'<br>\' (пустой contenteditable) — в модель пишется \'\'', () => {
  const vm = new ViolationManager();
  const calls = [];
  vm.setViolationField = (v, p, val) => { calls.push({ p, val }); return true; };
  const s = vm._makeViolationSurface({ id: 'v1', violated: 'было' }, 'violated');

  s.element = { innerHTML: '<br>' };
  s.commit();

  assert.deepEqual(calls, [{ p: 'violated', val: '' }], 'визуально пустой <br>-остаток нормализован в \'\'');
});

test('commit: элемент содержит только \'<div><br></div>\' — в модель пишется \'\'', () => {
  const vm = new ViolationManager();
  const calls = [];
  vm.setViolationField = (v, p, val) => { calls.push({ p, val }); return true; };
  const s = vm._makeViolationSurface({ id: 'v1', violated: 'было' }, 'violated');

  s.element = { innerHTML: '<div><br></div>' };
  s.commit();

  assert.deepEqual(calls, [{ p: 'violated', val: '' }]);
});

test('commit: непустой текст — в модель пишется исходный HTML (без нормализации)', () => {
  const vm = new ViolationManager();
  const calls = [];
  vm.setViolationField = (v, p, val) => { calls.push({ p, val }); return true; };
  const s = vm._makeViolationSurface({ id: 'v1', violated: '' }, 'violated');

  s.element = { innerHTML: '<b>текст</b>' };
  s.commit();

  assert.deepEqual(calls, [{ p: 'violated', val: '<b>текст</b>' }]);
});

test('setContent: changed=true — DOM получает повторный ре-рендер репаренным значением', () => {
  const vm = new ViolationManager();
  vm.setViolationField = () => true;
  const s = vm._makeViolationSurface({ id: 'v1', violated: '' }, 'violated');
  s.element = { textContent: '' };

  const origReport = textBlockManager._repairCapsulesReport;
  textBlockManager._repairCapsulesReport = () => ({ html: '<b>исправлено</b>', changed: true });
  try {
    s.setContent('<b>битая капсула</b>');
    assert.equal(s.element.textContent, '<b>исправлено</b>', 'структурная починка отражается в DOM повторным рендером');
  } finally {
    textBlockManager._repairCapsulesReport = origReport;
  }
});
