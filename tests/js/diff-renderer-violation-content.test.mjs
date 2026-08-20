/**
 * Рендер диффа нарушения на блочной модели.
 *
 * Ключевой инвариант тех-долга (см. diff-renderer-textblock-profile.test.mjs):
 * word-diff-ветки оборачивают вставки/удаления в <ins>/<del> через
 * _escapeHtml — на ДЕФОЛТНОМ профиле SafeHTML.set, а не acts-allowlist
 * (тот срезал бы <ins>/<del>).
 *
 * DOM в node поднять нельзя, поэтому: (1) юнит-тесты чистой сборки html
 * (_wordDiffToHtml) с escape-aware createElement; (2) сбор созданных
 * элементов/текст-нод на стандартных стабах — проверяем, ЧТО отрисовано,
 * не разбирая дерево.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiffRenderer } from '../../static/js/portal/acts-manager/diff-renderer.js';
import { VIOLATION_FIELD_KEYS } from '../../static/js/constructor/violation/violation-fields.js';

/** Escape-aware элемент: textContent → innerHTML с базовым HTML-экранированием. */
function makeEscapeAwareEl() {
    let html = '';
    const el = {
        style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, appendChild() {}, setAttribute() {},
    };
    Object.defineProperty(el, 'innerHTML', { get() { return html; }, set(v) { html = String(v); } });
    Object.defineProperty(el, 'textContent', {
        get() { return html; },
        set(v) { html = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    });
    return el;
}

/** Собирает элементы и текст-ноды, созданные переданным рендером. */
function collecting(render) {
    const els = [];
    const textNodes = [];
    const origEl = document.createElement;
    const origText = document.createTextNode;
    document.createElement = (tag) => { const el = origEl(tag); els.push(el); return el; };
    document.createTextNode = (text) => { const node = origText(text); textNodes.push(node); return node; };
    try {
        render();
    } finally {
        document.createElement = origEl;
        document.createTextNode = origText;
    }
    return { els, textNodes };
}

/** Тексты всех созданных элементов и текст-нод (плоско). */
function allText(collected) {
    return [...collected.els, ...collected.textNodes].map(n => n.textContent || '');
}

function renderViolation(violDiff) {
    return collecting(() => DiffRenderer._renderDiffViolation({ appendChild() {} }, violDiff));
}

/** Дифф нарушения с одним изменившимся полем. */
function violDiff(fieldKey, fieldDiff, over = {}) {
    return { status: 'modified', fields: { [fieldKey]: fieldDiff }, ...over };
}

/** Секция поля с одним блоком-записью. */
function blocksField(entry, reordered = false) {
    return { changed: true, blocks: { entries: [entry], reordered } };
}

// --- сборка word-diff-разметки ----------------------------------------------

test('_wordDiffToHtml: вставки/удаления обёрнуты <ins>/<del>, payload экранирован', () => {
    const orig = document.createElement;
    document.createElement = () => makeEscapeAwareEl();
    try {
        const html = DiffRenderer._wordDiffToHtml([
            { type: 'equal', text: 'общий' },
            { type: 'insert', text: 'новое' },
            { type: 'delete', text: '<b>старое</b>' },
        ]);
        assert.ok(html.includes('<ins>новое</ins>'), 'insert должен быть в <ins>');
        assert.ok(html.includes('<del>&lt;b&gt;старое&lt;/b&gt;</del>'), 'delete-payload экранирован внутри <del>');
        assert.ok(!html.includes('<b>'), 'сырой HTML из payload не должен просачиваться');
    } finally {
        document.createElement = orig;
    }
});

// --- смоук полного диффа ----------------------------------------------------

test('_renderDiffViolation: полный дифф (3 типа блоков + enabled + fieldOrder) рендерится без исключений', () => {
    const diff = {
        status: 'modified',
        fieldOrder: { old: [...VIOLATION_FIELD_KEYS], new: [...VIOLATION_FIELD_KEYS].reverse() },
        fields: {
            violated: blocksField({
                status: 'modified', reordered: false, type: 'text',
                oldBlock: { id: 'b1', type: 'text', content: 'старое' },
                newBlock: { id: 'b1', type: 'text', content: 'новое' },
                formattingOnly: false,
                wordDiff: [{ type: 'delete', text: 'старое' }, { type: 'insert', text: 'новое' }],
            }),
            reasons: { changed: true, enabled: { old: false, new: true, changed: true } },
            additionalContent: {
                changed: true,
                blocks: {
                    reordered: true,
                    entries: [
                        {
                            status: 'modified', reordered: false, type: 'image',
                            oldBlock: { id: 'i1', type: 'image', image_id: 'a', caption: 'старая', filename: 'p.png', width: 0 },
                            newBlock: { id: 'i1', type: 'image', image_id: 'b', caption: 'новая', filename: 'p.png', width: 50 },
                            fields: {
                                image_id: { old: 'a', new: 'b' },
                                caption: {
                                    old: 'старая', new: 'новая', formattingOnly: false,
                                    wordDiff: [{ type: 'delete', text: 'старая' }, { type: 'insert', text: 'новая' }],
                                },
                                width: { old: 0, new: 50 },
                            },
                        },
                        {
                            status: 'modified', reordered: true, type: 'table',
                            oldBlock: { id: 't1', type: 'table', table: { grid: [[{ content: 'a' }]] } },
                            newBlock: { id: 't1', type: 'table', table: { grid: [[{ content: 'b' }]] } },
                            cells: [{ row: 0, col: 0, old: 'a', new: 'b' }],
                        },
                        { status: 'added', reordered: false, type: 'text', newBlock: { id: 'b2', type: 'text', content: 'новый блок' } },
                        { status: 'removed', reordered: false, type: 'image', oldBlock: { id: 'i2', type: 'image', image_id: '', caption: '', filename: 'q.png', width: 0 } },
                    ],
                },
            },
        },
    };
    assert.doesNotThrow(() => DiffRenderer._renderDiffViolation({ appendChild() {} }, diff));
});

// --- метки полей ------------------------------------------------------------

test('секция поля подписана меткой из VIOLATION_LABELS', () => {
    const collected = renderViolation(violDiff('codeMining', blocksField({
        status: 'added', reordered: false, type: 'text', newBlock: { id: 'b1', type: 'text', content: 'x' },
    })));
    assert.ok(allText(collected).includes('CodeMining: '), 'метка поля из реестра не отрисована');
});

test('поле без блоков и без enabled не рисуется', () => {
    const collected = renderViolation(violDiff('reasons', { changed: true }));
    assert.equal(allText(collected).some(t => t.startsWith('Причины')), false);
});

// --- text-блок --------------------------------------------------------------

test('text-блок added/removed: видимый текст (_stripHtml), не raw HTML', () => {
    const added = renderViolation(violDiff('description', blocksField({
        status: 'added', reordered: false, type: 'text',
        newBlock: { id: 'b1', type: 'text', content: '<b>жирный</b> текст' },
    })));
    assert.ok(allText(added).includes('жирный текст'));

    const removed = renderViolation(violDiff('description', blocksField({
        status: 'removed', reordered: false, type: 'text',
        oldBlock: { id: 'b1', type: 'text', content: '<i>курсив</i> удалён' },
    })));
    assert.ok(allText(removed).includes('курсив удалён'));
});

test('text-блок unchanged: видимый текст в теле блока', () => {
    const collected = renderViolation(violDiff('description', {
        changed: true,
        blocks: {
            reordered: false,
            entries: [
                { status: 'unchanged', reordered: false, type: 'text', oldBlock: { id: 'b1', type: 'text', content: '<b>без</b> изменений' }, newBlock: { id: 'b1', type: 'text', content: '<b>без</b> изменений' } },
                { status: 'added', reordered: false, type: 'text', newBlock: { id: 'b2', type: 'text', content: 'новый' } },
            ],
        },
    }));
    const body = collected.els.find(el => el.className === 'diff-violation-item-body' && el.textContent === 'без изменений');
    assert.ok(body, 'тело неизменившегося блока показывает видимый текст');
});

test('text-блок modified: рендер зовёт _wordDiffToHtml с полевым wordDiff', () => {
    const wordDiff = [{ type: 'delete', text: 'старое' }, { type: 'insert', text: 'новое' }];
    const calls = [];
    const orig = DiffRenderer._wordDiffToHtml;
    DiffRenderer._wordDiffToHtml = (wd) => { calls.push(wd); return orig.call(DiffRenderer, wd); };
    try {
        DiffRenderer._renderDiffViolation({ appendChild() {} }, violDiff('description', blocksField({
            status: 'modified', reordered: false, type: 'text', formattingOnly: false, wordDiff,
            oldBlock: { id: 'b1', type: 'text', content: 'старое' },
            newBlock: { id: 'b1', type: 'text', content: 'новое' },
        })));
    } finally {
        DiffRenderer._wordDiffToHtml = orig;
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], wordDiff);
});

test('text-блок modified: formattingOnly=true → бейдж «Изменено форматирование»', () => {
    const collected = renderViolation(violDiff('description', blocksField({
        status: 'modified', reordered: false, type: 'text', formattingOnly: true,
        wordDiff: [{ type: 'equal', text: 'важно' }],
        oldBlock: { id: 'b1', type: 'text', content: 'важно' },
        newBlock: { id: 'b1', type: 'text', content: '<b>важно</b>' },
    })));
    const badge = collected.els.find(el => el.className === 'diff-textblock-format-badge');
    assert.ok(badge, 'бейдж форматирования не создан');
    assert.equal(badge.textContent, 'Изменено форматирование');
});

test('text-блок modified: formattingOnly=false → бейджа форматирования нет', () => {
    const collected = renderViolation(violDiff('description', blocksField({
        status: 'modified', reordered: false, type: 'text', formattingOnly: false,
        wordDiff: [{ type: 'delete', text: 'старое' }, { type: 'insert', text: 'новое' }],
        oldBlock: { id: 'b1', type: 'text', content: 'старое' },
        newBlock: { id: 'b1', type: 'text', content: 'новое' },
    })));
    assert.ok(!collected.els.some(el => el.className === 'diff-textblock-format-badge'));
});

test('text-блок oversized: сводка вместо пословной подсветки, _wordDiffToHtml не зовётся', () => {
    const calls = [];
    const orig = DiffRenderer._wordDiffToHtml;
    DiffRenderer._wordDiffToHtml = (wd) => { calls.push(wd); return orig.call(DiffRenderer, wd); };
    let collected;
    try {
        collected = renderViolation(violDiff('description', blocksField({
            status: 'modified', reordered: false, type: 'text', oversized: true,
            wordDiff: null, formattingOnly: false,
            oldBlock: { id: 'b1', type: 'text', content: 'A' },
            newBlock: { id: 'b1', type: 'text', content: 'B' },
        })));
    } finally {
        DiffRenderer._wordDiffToHtml = orig;
    }
    assert.deepEqual(calls, [], 'крупный блок не должен идти через сборку word-diff');
    assert.ok(allText(collected).some(t => t.startsWith('Текст изменён')), 'нет текстовой сводки для крупного блока');
});

// --- маркеры added/removed/порядка ------------------------------------------

test('маркеры блока: (ДОБАВЛЕНО) / (УДАЛЕНО) / (порядок изменён)', () => {
    const added = allText(renderViolation(violDiff('description', blocksField({
        status: 'added', reordered: false, type: 'text', newBlock: { id: 'b1', type: 'text', content: 'x' },
    }))));
    assert.ok(added.includes('Текст (ДОБАВЛЕНО): '));

    const removed = allText(renderViolation(violDiff('description', blocksField({
        status: 'removed', reordered: false, type: 'image', oldBlock: { id: 'i1', type: 'image', image_id: '', filename: 'p.png' },
    }))));
    assert.ok(removed.includes('Картинка (УДАЛЕНО): '));

    const reordered = allText(renderViolation(violDiff('description', blocksField({
        status: 'reordered', reordered: true, type: 'table',
        oldBlock: { id: 't1', type: 'table', table: { grid: [[{ content: 'a' }]] } },
        newBlock: { id: 't1', type: 'table', table: { grid: [[{ content: 'a' }]] } },
    }, true))));
    assert.ok(reordered.includes('Таблица (порядок изменён): '));
});

test('перестановка блоков поля → бейдж «порядок блоков изменён»', () => {
    const collected = renderViolation(violDiff('description', blocksField({
        status: 'reordered', reordered: true, type: 'text',
        oldBlock: { id: 'b1', type: 'text', content: 'x' },
        newBlock: { id: 'b1', type: 'text', content: 'x' },
    }, true)));
    const badge = collected.els.find(el => el.className === 'diff-node-moved-badge');
    assert.ok(badge);
    assert.equal(badge.textContent, 'порядок блоков изменён');
});

// --- image-блок -------------------------------------------------------------

test('image-блок: caption с wordDiff → рендер зовёт _wordDiffToHtml (не raw old/new)', () => {
    const wordDiff = [{ type: 'delete', text: 'старая' }, { type: 'insert', text: 'новая' }];
    const calls = [];
    const orig = DiffRenderer._wordDiffToHtml;
    DiffRenderer._wordDiffToHtml = (wd) => { calls.push(wd); return orig.call(DiffRenderer, wd); };
    try {
        DiffRenderer._renderImageEntry({ appendChild() {} }, {
            status: 'modified', reordered: false, type: 'image',
            oldBlock: { id: 'i1', type: 'image', image_id: 'u', caption: '<b>старая</b>', filename: 'p.png', width: 0 },
            newBlock: { id: 'i1', type: 'image', image_id: 'u', caption: '<b>новая</b>', filename: 'p.png', width: 0 },
            fields: { caption: { old: '<b>старая</b>', new: '<b>новая</b>', wordDiff, formattingOnly: false } },
        });
    } finally {
        DiffRenderer._wordDiffToHtml = orig;
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], wordDiff);
});

test('image-блок: caption formattingOnly=true → бейдж, false → без бейджа', () => {
    const withBadge = collecting(() => DiffRenderer._renderImageEntry({ appendChild() {} }, {
        status: 'modified', type: 'image',
        oldBlock: { id: 'i1', type: 'image', image_id: 'u', caption: 'важно', filename: 'p.png' },
        newBlock: { id: 'i1', type: 'image', image_id: 'u', caption: '<b>важно</b>', filename: 'p.png' },
        fields: { caption: { old: 'важно', new: '<b>важно</b>', wordDiff: [{ type: 'equal', text: 'важно' }], formattingOnly: true } },
    }));
    assert.ok(withBadge.els.some(el => el.className === 'diff-textblock-format-badge'));

    const noBadge = collecting(() => DiffRenderer._renderImageEntry({ appendChild() {} }, {
        status: 'modified', type: 'image',
        oldBlock: { id: 'i1', type: 'image', image_id: 'u', caption: 'старая', filename: 'p.png' },
        newBlock: { id: 'i1', type: 'image', image_id: 'u', caption: 'новая', filename: 'p.png' },
        fields: { caption: { old: 'старая', new: 'новая', wordDiff: [{ type: 'delete', text: 'старая' }, { type: 'insert', text: 'новая' }], formattingOnly: false } },
    }));
    assert.ok(!noBadge.els.some(el => el.className === 'diff-textblock-format-badge'));
});

test('image-блок: смена картинки → два превью «Было/Стало»', () => {
    const collected = collecting(() => DiffRenderer._renderImageEntry({ appendChild() {} }, {
        status: 'modified', type: 'image',
        oldBlock: { id: 'i1', type: 'image', image_id: '', caption: '', filename: 'a.png' },
        newBlock: { id: 'i1', type: 'image', image_id: '', caption: '', filename: 'b.png' },
        fields: { image_id: { old: 'img-a', new: 'img-b' } },
    }));
    const texts = allText(collected);
    assert.ok(texts.includes('Было:'));
    assert.ok(texts.includes('Стало:'));
});

test('image-блок: атрибуты подписаны (Подпись/Файл/Ширина)', () => {
    const texts = allText(collecting(() => DiffRenderer._renderImageEntry({ appendChild() {} }, {
        status: 'modified', type: 'image',
        oldBlock: { id: 'i1', type: 'image', image_id: 'u', caption: '', filename: 'a.png', width: 0 },
        newBlock: { id: 'i1', type: 'image', image_id: 'u', caption: '', filename: 'b.png', width: 60 },
        fields: { filename: { old: 'a.png', new: 'b.png' }, width: { old: 0, new: 60 } },
    })));
    assert.ok(texts.includes('Файл: '));
    assert.ok(texts.includes('Ширина: '));
});

test('_appendImagePreview: подпись — видимый текст (_stripHtml), не сырой HTML', () => {
    const collected = collecting(() => DiffRenderer._appendImagePreview(
        { appendChild() {} },
        { id: 'i1', type: 'image', image_id: '', caption: '<b>важно</b>', filename: 'p.png' },
    ));
    const cap = collected.els.find(el => el.className === 'diff-violation-caption');
    assert.ok(cap, 'подпись не создана');
    assert.equal(cap.textContent, 'важно');
});

// --- table-блок -------------------------------------------------------------

test('table-блок: сводка «Изменено ячеек: N» + строки «Строка r, колонка c»', () => {
    const texts = allText(renderViolation(violDiff('description', blocksField({
        status: 'modified', reordered: false, type: 'table',
        oldBlock: { id: 't1', type: 'table', table: { grid: [[{ content: 'a' }, { content: 'b' }]] } },
        newBlock: { id: 't1', type: 'table', table: { grid: [[{ content: 'a' }, { content: 'B!' }]] } },
        cells: [{ row: 0, col: 1, old: 'b', new: 'B!' }],
    }))));
    assert.ok(texts.includes('Изменено ячеек: 1'));
    assert.ok(texts.includes('Строка 1, колонка 2: '), 'индексы ячеек человеческие (с единицы)');
    assert.ok(texts.includes('b'), 'старое значение ячейки');
    assert.ok(texts.includes('B!'), 'новое значение ячейки');
});

test('table-блок: длинное содержимое ячейки обрезается', () => {
    const long = 'x'.repeat(500);
    const texts = allText(renderViolation(violDiff('description', blocksField({
        status: 'modified', reordered: false, type: 'table',
        oldBlock: { id: 't1', type: 'table', table: { grid: [[{ content: '' }]] } },
        newBlock: { id: 't1', type: 'table', table: { grid: [[{ content: long }]] } },
        cells: [{ row: 0, col: 0, old: '', new: long }],
    }))));
    assert.ok(!texts.some(t => t.length > 200), 'длинное значение ячейки должно быть обрезано');
    assert.ok(texts.some(t => t.startsWith('xxx') && t.endsWith('…')));
});

test('table-блок: смена размера сетки → строка «Размер сетки: A×B → C×D»', () => {
    const texts = allText(renderViolation(violDiff('description', blocksField({
        status: 'modified', reordered: false, type: 'table',
        oldBlock: { id: 't1', type: 'table', table: { grid: [[{ content: 'a' }, { content: 'b' }]] } },
        newBlock: { id: 't1', type: 'table', table: { grid: [[{ content: 'a' }, { content: 'b' }], [{ content: '' }, { content: '' }]] } },
        cells: [],
        gridResized: { oldRows: 1, oldCols: 2, newRows: 2, newCols: 2 },
    }))));
    assert.ok(texts.includes('Размер сетки: 1×2 → 2×2'));
});

test('table-блок added: компактная сводка размера сетки', () => {
    const texts = allText(renderViolation(violDiff('description', blocksField({
        status: 'added', reordered: false, type: 'table',
        newBlock: { id: 't1', type: 'table', table: { grid: [[{ content: 'a' }, { content: 'b' }], [{ content: 'c' }, { content: 'd' }]] } },
    }))));
    assert.ok(texts.includes('Таблица (ДОБАВЛЕНО): '));
    assert.ok(texts.includes('Сетка: 2×2'));
});

// --- enabled и fieldOrder ---------------------------------------------------

test('enabled: включение/выключение поля подписывается словами', () => {
    const on = allText(renderViolation(violDiff('reasons', { changed: true, enabled: { old: false, new: true, changed: true } })));
    assert.ok(on.includes('Причины: '));
    assert.ok(on.includes('Поле включено'));

    const off = allText(renderViolation(violDiff('reasons', { changed: true, enabled: { old: true, new: false, changed: true } })));
    assert.ok(off.includes('Поле выключено'));
});

test('fieldOrder: строка «Порядок полей изменён» с МЕТКАМИ полей, не ключами', () => {
    const texts = allText(renderViolation({
        status: 'modified',
        fields: {},
        fieldOrder: { old: ['violated', 'established'], new: ['established', 'violated'] },
    }));
    assert.ok(texts.includes('Порядок полей изменён: '));
    assert.ok(texts.includes('Нарушено, Установлено'), 'старый порядок метками');
    assert.ok(texts.includes('Установлено, Нарушено'), 'новый порядок метками');
});

// --- added/removed нарушение: служебные изменения не детализируем -----------

test('добавленное нарушение: блоки рисуются, «Поле включено»/порядок — нет', () => {
    const texts = allText(renderViolation({
        status: 'added',
        fieldOrder: { old: ['violated', 'established'], new: ['established', 'violated'] },
        fields: {
            violated: {
                changed: true,
                enabled: { old: false, new: true, changed: true },
                blocks: { reordered: false, entries: [{ status: 'added', reordered: false, type: 'text', newBlock: { id: 'b1', type: 'text', content: 'нарушено' } }] },
            },
        },
    }));
    assert.ok(texts.includes('нарушено'), 'содержимое блока отрисовано');
    assert.ok(!texts.includes('Поле включено'), 'у целиком добавленного нарушения enabled не детализируем');
    assert.ok(!texts.some(t => t.startsWith('Порядок полей изменён')), 'порядок полей тоже не детализируем');
});

test('удалённое нарушение: поле только с enabled не рисуется вовсе', () => {
    const texts = allText(renderViolation({
        status: 'removed',
        fields: { reasons: { changed: true, enabled: { old: true, new: false, changed: true } } },
    }));
    assert.ok(!texts.some(t => t.startsWith('Причины')));
});

// --- неизменённое нарушение в режиме «показать всё» (ревью №7) --------------
//
// diff-engine не кладёт неизменившиеся поля в violDiff.fields (fields = {} у
// unchanged-нарушения) — ветка достижима только при onlyChanges=false
// (см. условие вызова в diff-renderer._renderDiffNode), поэтому содержимое
// строится напрямую из newData/oldData через _renderUnchangedViolationContent.

function unchangedViolation(fields) {
    const base = {};
    for (const key of VIOLATION_FIELD_KEYS) base[key] = { enabled: false, blocks: [] };
    return { ...base, ...fields };
}

test('неизменённое нарушение: полное содержимое включённых полей с блоками', () => {
    const violation = unchangedViolation({
        violated: { enabled: true, blocks: [{ id: 'b1', type: 'text', content: '<b>нарушено</b>' }] },
        codeMining: { enabled: true, blocks: [{ id: 'b2', type: 'text', content: 'SELECT 1' }] },
    });
    const collected = renderViolation({ status: 'unchanged', fields: {}, oldData: violation, newData: violation });
    const texts = allText(collected);

    assert.ok(texts.includes('Нарушено: '), 'метка обязательного поля рисуется');
    assert.ok(texts.includes('нарушено'), 'содержимое блока показано целиком (видимый текст)');
    // codeMining в экспортах labeled=false (см. violation-fields.js), но в
    // диффе метка — навигационная подпись, а не экспортный вывод: оставляем
    // её ВСЕМ полям (осознанное решение, зеркалит _renderViolationField).
    assert.ok(texts.includes('CodeMining: '), 'метка codeMining показана и в диффе (в отличие от экспортов)');
    assert.ok(texts.includes('SELECT 1'), 'содержимое codeMining показано');
});

test('неизменённое нарушение: выключенные и пустые поля не рисуются', () => {
    const violation = unchangedViolation({
        violated: { enabled: true, blocks: [{ id: 'b1', type: 'text', content: 'x' }] },
        established: { enabled: false, blocks: [{ id: 'b2', type: 'text', content: 'выключено' }] },
        reasons: { enabled: true, blocks: [] },
    });
    const texts = allText(renderViolation({ status: 'unchanged', fields: {}, oldData: violation, newData: violation }));
    assert.ok(!texts.some(t => t.startsWith('Установлено')), 'выключенное поле не рисуется, даже если в нём остались блоки');
    assert.ok(!texts.some(t => t.startsWith('Причины')), 'включённое поле без блоков не рисуется');
});

test('неизменённое нарушение: без амбер-подсветки diff-field-changed (нарушение целиком не изменилось)', () => {
    const violation = unchangedViolation({
        violated: { enabled: true, blocks: [{ id: 'b1', type: 'text', content: 'x' }] },
    });
    const collected = renderViolation({ status: 'unchanged', fields: {}, oldData: violation, newData: violation });
    assert.ok(
        !collected.els.some(el => (el.className || '').includes('diff-field-changed')),
        'diff-field-changed сигнализирует изменение — для полностью неизменного нарушения его быть не должно',
    );
});

test('неизменённое нарушение: порядок полей — violation.fieldOrder, иначе стандартный', () => {
    const violation = unchangedViolation({
        violated: { enabled: true, blocks: [{ id: 'b1', type: 'text', content: 'первое' }] },
        established: { enabled: true, blocks: [{ id: 'b2', type: 'text', content: 'второе' }] },
        fieldOrder: [...VIOLATION_FIELD_KEYS].map(k => (k === 'violated' ? 'established' : k === 'established' ? 'violated' : k)),
    });
    const texts = allText(renderViolation({ status: 'unchanged', fields: {}, oldData: violation, newData: violation }));
    const iEstablished = texts.indexOf('Установлено: ');
    const iViolated = texts.indexOf('Нарушено: ');
    assert.ok(iEstablished !== -1 && iViolated !== -1);
    assert.ok(iEstablished < iViolated, 'fieldOrder на нарушении переставляет порядок отображения полей');
});
