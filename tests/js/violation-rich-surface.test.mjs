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
