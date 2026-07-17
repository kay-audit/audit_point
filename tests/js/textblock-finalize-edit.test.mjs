/**
 * Task 1: finalizeEdit(editor, opts) — единый сток завершения правки текстблока
 * (TB-5, CARET-5/7). Проверяем фиксированный порядок шагов, перф-гейт нормализации
 * по наличию капсул, перенумерацию по изменению числа сносок (кэш
 * __lastFootnoteCount) и форс opts.renumber, а также перенос changelog в общий
 * сток saveContent.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import { ChangelogTracker } from '../../static/js/constructor/changelog-tracker.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';

/**
 * Менеджер с записывающими стабами шагов стока: каждый шаг пишет свой маркер в
 * calls — так проверяем и факт вызова, и порядок.
 * @param {{hasCapsules?: boolean, footnoteCount?: number}} [cfg]
 */
function makeManager(cfg = {}) {
  const calls = [];
  const mgr = Object.create(TextBlockManager.prototype);
  const editor = {
    dataset: { textBlockId: 'tb1' },
    innerHTML: '<p>hi</p>',
    textContent: cfg.textContent || '',
    querySelector: () => (cfg.hasCapsules ? {} : null),
    querySelectorAll: () => new Array(cfg.footnoteCount || 0).fill({}),
  };
  mgr.normalizeMarkers = () => calls.push('normalize');
  // Task 7 (TREE-1): перенумерация теперь ГЛОБАЛЬНАЯ (весь лист), без аргумента.
  mgr.renumberAllFootnotes = () => calls.push('renumber');
  mgr._toggleEmptyClass = () => calls.push('toggleEmpty');
  mgr.saveContent = (id, html) => calls.push(`save:${id}:${html}`);
  return { mgr, editor, calls };
}

// ── Порядок шагов ────────────────────────────────────────────────────────────

test('finalizeEdit: порядок normalize → renumber → toggleEmpty → save (капсулы + смена счётчика)', () => {
  const { mgr, editor, calls } = makeManager({ hasCapsules: true, footnoteCount: 1 });
  mgr.finalizeEdit(editor);
  assert.deepEqual(calls, ['normalize', 'renumber', 'toggleEmpty', 'save:tb1:<p>hi</p>']);
});

// ── Перф-гейт нормализации по наличию капсул ─────────────────────────────────

test('finalizeEdit: без капсул normalize пропускается (перф)', () => {
  const { mgr, editor, calls } = makeManager({ hasCapsules: false, footnoteCount: 0 });
  editor.__lastFootnoteCount = 0; // счётчик примирён → renumber тоже не сработает
  mgr.finalizeEdit(editor);
  assert.deepEqual(calls, ['toggleEmpty', 'save:tb1:<p>hi</p>']);
});

test('finalizeEdit: при капсулах normalize вызывается', () => {
  const { mgr, editor, calls } = makeManager({ hasCapsules: true, footnoteCount: 0 });
  editor.__lastFootnoteCount = 0;
  mgr.finalizeEdit(editor);
  assert.ok(calls.includes('normalize'), 'normalize должен вызываться при наличии капсул');
});

test('finalizeEdit: без капсул, но с U+FEFF в DOM → normalize запускается (самоочистка, Fix 1)', () => {
  const { mgr, editor, calls } = makeManager({ hasCapsules: false, textContent: 'текст\uFEFF' });
  editor.__lastFootnoteCount = 0;
  mgr.finalizeEdit(editor);
  assert.ok(calls.includes('normalize'), 'normalize должен вычистить осиротевшие guard-символы');
});

// ── Перенумерация по изменению числа сносок (CARET-7) ────────────────────────

test('finalizeEdit: renumber только при изменении числа сносок (кэш __lastFootnoteCount)', () => {
  const { mgr, editor, calls } = makeManager({ footnoteCount: 2 });
  // 1-й сток: кэш пуст (undefined) → renumber, кэш ← 2.
  mgr.finalizeEdit(editor);
  assert.equal(calls.filter((c) => c === 'renumber').length, 1);
  assert.equal(editor.__lastFootnoteCount, 2, 'кэш числа сносок обновлён');
  // 2-й сток: счётчик тот же (2) → renumber НЕ вызывается.
  calls.length = 0;
  mgr.finalizeEdit(editor);
  assert.deepEqual(calls, ['toggleEmpty', 'save:tb1:<p>hi</p>'], 'renumber пропущен при неизменном счётчике');
});

test('finalizeEdit: рост/спад числа сносок (нативное удаление/paste) → renumber (CARET-7)', () => {
  let fc = 2;
  const calls = [];
  const mgr = Object.create(TextBlockManager.prototype);
  const editor = {
    dataset: { textBlockId: 'tb1' },
    innerHTML: 'x',
    querySelector: () => null,
    querySelectorAll: () => new Array(fc).fill({}),
  };
  mgr.renumberAllFootnotes = () => calls.push('renumber');
  mgr._toggleEmptyClass = () => {};
  mgr.saveContent = () => {};

  mgr.finalizeEdit(editor); // fc=2, кэш undefined → renumber, кэш ← 2
  calls.length = 0;
  fc = 1;                   // сноску удалило нативно (мимо create/remove-потоков)
  mgr.finalizeEdit(editor); // 1 !== 2 → renumber
  assert.deepEqual(calls, ['renumber']);
});

// ── Форс перенумерации (правка текста сноски, счётчик не меняется) ────────────

test('finalizeEdit: opts.renumber=true форсит перенумерацию при неизменном счётчике', () => {
  const { mgr, editor, calls } = makeManager({ footnoteCount: 1 });
  editor.__lastFootnoteCount = 1; // счётчик уже примирён
  mgr.finalizeEdit(editor, { renumber: true });
  assert.ok(calls.includes('renumber'), 'renumber должен вызываться при opts.renumber без смены счётчика');
});

test('finalizeEdit: без opts.renumber и без смены счётчика — renumber НЕ вызывается', () => {
  const { mgr, editor, calls } = makeManager({ footnoteCount: 1 });
  editor.__lastFootnoteCount = 1;
  mgr.finalizeEdit(editor);
  assert.ok(!calls.includes('renumber'));
});

test('finalizeEdit: перенумерация ГЛОБАЛЬНАЯ (renumberAllFootnotes), кэш переданного editor примирён (Task 7)', () => {
  const captured = [];
  const mgr = Object.create(TextBlockManager.prototype);
  const passed = {
    dataset: { textBlockId: 'tbX' }, innerHTML: 'x', textContent: '',
    querySelector: () => null, querySelectorAll: () => [{}],
  };
  mgr.activeEditor = { dataset: { textBlockId: 'OTHER' } }; // не участвует
  mgr._toggleEmptyClass = () => {};
  mgr.saveContent = () => {};
  // Глобальный проход не принимает editor — считает весь лист (TREE-1).
  mgr.renumberAllFootnotes = () => captured.push('all');
  mgr.finalizeEdit(passed, { renumber: true });
  assert.deepEqual(captured, ['all'], 'сток зовёт глобальную перенумерацию');
  assert.equal(passed.__lastFootnoteCount, 1, 'кэш числа сносок переданного editor примирён');
});

// ── Task 1.3.4-A: мост персистентности (finalizeEdit → активная поверхность) ─

test('finalizeEdit: НЕ-textblock editor (getTextBlock вернул null) + активная поверхность владеет им → surface.commit() вызван', () => {
  const { mgr, editor } = makeManager({ footnoteCount: 0 });
  editor.__lastFootnoteCount = 0;
  mgr.getTextBlock = () => null; // блок не найден в state — не текстблок
  const commits = [];
  EditorRegistry.setActive({ element: editor, commit: () => commits.push('commit') });
  try {
    mgr.finalizeEdit(editor);
    assert.deepEqual(commits, ['commit'], 'мост коммитит активную поверхность');
  } finally {
    EditorRegistry.clear();
  }
});

test('finalizeEdit: textblock (getTextBlock находит блок) → мост НЕ трогает активную поверхность (старый путь цел)', () => {
  const { mgr, editor, calls } = makeManager({ footnoteCount: 0 });
  editor.__lastFootnoteCount = 0;
  mgr.getTextBlock = () => ({ id: 'tb1', content: '' }); // блок найден — это текстблок
  const commits = [];
  EditorRegistry.setActive({ element: editor, commit: () => commits.push('commit') });
  try {
    mgr.finalizeEdit(editor);
    assert.deepEqual(commits, [], 'мост не зовёт поверхность у настоящего текстблока');
    assert.deepEqual(calls, ['toggleEmpty', 'save:tb1:<p>hi</p>'], 'обычный сток не задет мостом');
  } finally {
    EditorRegistry.clear();
  }
});

test('finalizeEdit: НЕ-textblock editor, активной поверхности нет — no-op без исключения', () => {
  const { mgr, editor } = makeManager({ footnoteCount: 0 });
  editor.__lastFootnoteCount = 0;
  mgr.getTextBlock = () => null;
  EditorRegistry.clear();
  assert.doesNotThrow(() => mgr.finalizeEdit(editor));
});

test('finalizeEdit: НЕ-textblock editor, активная поверхность принадлежит ДРУГОМУ editor (ownership-guard) → commit не вызван', () => {
  const { mgr, editor } = makeManager({ footnoteCount: 0 });
  editor.__lastFootnoteCount = 0;
  mgr.getTextBlock = () => null;
  const commits = [];
  EditorRegistry.setActive({ element: {}, commit: () => commits.push('commit') }); // другой element
  try {
    mgr.finalizeEdit(editor);
    assert.deepEqual(commits, [], 'чужая поверхность не коммитится');
  } finally {
    EditorRegistry.clear();
  }
});

// ── Защитный no-op ───────────────────────────────────────────────────────────

test('finalizeEdit: null/без dataset редактор → no-op без исключения', () => {
  const mgr = Object.create(TextBlockManager.prototype);
  let touched = false;
  mgr.saveContent = () => { touched = true; };
  mgr._toggleEmptyClass = () => { touched = true; };
  assert.doesNotThrow(() => mgr.finalizeEdit(null));
  assert.doesNotThrow(() => mgr.finalizeEdit({})); // нет dataset
  assert.equal(touched, false, 'сток ничего не делает без валидного редактора');
});

// ── TB-5: changelog в общем стоке saveContent ────────────────────────────────

test('saveContent: пишет changelog modify_textblock (правка мимо input-события, TB-5)', () => {
  const rec = [];
  const origRec = ChangelogTracker._recordDebounced;
  const origUpd = PreviewManager.updateBlock;
  ChangelogTracker._recordDebounced = (...a) => rec.push(a);
  PreviewManager.updateBlock = () => {};
  try {
    const mgr = Object.create(TextBlockManager.prototype);
    const tb = { id: 'tb1', content: 'старое' };
    mgr.getTextBlock = () => tb;
    mgr.saveContent('tb1', '<p>новое</p>');
    assert.equal(tb.content, '<p>новое</p>', 'content записан');
    assert.equal(rec.length, 1, 'ровно одна запись changelog');
    assert.deepEqual(rec[0], ['modify_textblock', 'tb1', '', { field: 'content' }, 5000]);
  } finally {
    ChangelogTracker._recordDebounced = origRec;
    PreviewManager.updateBlock = origUpd;
  }
});

test('saveContent: нет текстблока в state → ни changelog, ни превью (guard if(textBlock))', () => {
  const rec = [];
  const origRec = ChangelogTracker._recordDebounced;
  const origUpd = PreviewManager.updateBlock;
  let updated = false;
  ChangelogTracker._recordDebounced = (...a) => rec.push(a);
  PreviewManager.updateBlock = () => { updated = true; };
  try {
    const mgr = Object.create(TextBlockManager.prototype);
    mgr.getTextBlock = () => null;
    mgr.saveContent('missing', '<p>x</p>');
    assert.equal(rec.length, 0);
    assert.equal(updated, false);
  } finally {
    ChangelogTracker._recordDebounced = origRec;
    PreviewManager.updateBlock = origUpd;
  }
});
