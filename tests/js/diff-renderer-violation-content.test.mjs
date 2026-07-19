/**
 * Рендер расширенного диффа нарушения (#8, вариант А): список описаний и
 * доп.контент.
 *
 * Ключевой инвариант тех-долга (см. diff-renderer-textblock-profile.test.mjs):
 * НОВЫЕ word-diff-ветки (пункт descriptionList, кейс/свободный текст) должны
 * оборачивать вставки/удаления в <ins>/<del> через _escapeHtml — на ДЕФОЛТНОМ
 * профиле SafeHTML.set, а не acts-allowlist (тот срезал бы <ins>/<del>).
 *
 * DOM в node поднять нельзя, поэтому: (1) юнит-тест чистой сборки html
 * _wordDiffToHtml с escape-aware createElement; (2) smoke-тест полного
 * _renderDiffViolation на стандартных стабах (без исключений).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiffRenderer } from '../../static/js/portal/acts-manager/diff-renderer.js';

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

test('_renderDiffViolation: полный дифф (списки + кейс + картинка) рендерится без исключений', () => {
    const violDiff = {
        status: 'modified',
        fieldDiffs: {
            // ОСОЗНАННЫЙ апдейт (задача 1.1.5): fieldDiffs теперь несёт
            // wordDiff/formattingOnly (word-diff по видимому тексту) — раньше
            // рендер читал только old/new и рисовал del/ins.textContent=raw.
            reasons: {
                old: 'старое', new: 'новое', changed: true, formattingOnly: false,
                wordDiff: [{ type: 'delete', text: 'старое' }, { type: 'insert', text: 'новое' }],
            },
            descriptionList: {
                kind: 'list', changed: true, enabled: true, oldEnabled: true,
                items: [
                    { status: 'modified', old: 'a', new: 'b', wordDiff: [{ type: 'delete', text: 'a' }, { type: 'insert', text: 'b' }] },
                    { status: 'added', new: 'c' },
                    { status: 'removed', old: 'd' },
                    { status: 'unchanged', old: 'e', new: 'e' },
                ],
            },
            additionalContent: {
                kind: 'additional', changed: true, enabled: true, oldEnabled: true,
                entries: [
                    // formattingOnly: false — та же осознанная фикстура-актуализация, что и у reasons выше (Review Round 2).
                    { status: 'modified', reordered: false, formattingOnly: false, oldItem: { id: 'c1', type: 'case', content: 'x' }, newItem: { id: 'c1', type: 'case', content: 'y' }, wordDiff: [{ type: 'delete', text: 'x' }, { type: 'insert', text: 'y' }] },
                    { status: 'added', newItem: { id: 'f1', type: 'freeText', content: 'новый текст' } },
                    // caption несёт wordDiff/formattingOnly (Task 6, rich-поле) — та же
                    // осознанная фикстура-актуализация, что у reasons/case выше.
                    { status: 'modified', reordered: false, oldItem: { id: 'i1', type: 'image', url: 'a', caption: 'старая', filename: 'p.png', width: 0 }, newItem: { id: 'i1', type: 'image', url: 'b', caption: 'новая', filename: 'p.png', width: 50 }, fields: { url: { old: 'a', new: 'b' }, caption: { old: 'старая', new: 'новая', wordDiff: [{ type: 'delete', text: 'старая' }, { type: 'insert', text: 'новая' }], formattingOnly: false }, width: { old: 0, new: 50 } } },
                    { status: 'removed', oldItem: { id: 'i2', type: 'image', url: '', caption: '', filename: 'q.png', width: 0 } },
                ],
            },
        },
        oldData: { additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case' }, { id: 'i1', type: 'image' }, { id: 'i2', type: 'image' }] } },
        newData: { additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case' }, { id: 'f1', type: 'freeText' }, { id: 'i1', type: 'image' }] }, reasons: { enabled: true, content: 'новое' } },
    };

    assert.doesNotThrow(() => {
        DiffRenderer._renderDiffViolation({ appendChild() {} }, violDiff);
    });
});

// --- #1.1.5: word-diff по видимому тексту для изменённых rich-полей --------
// ОСОЗНАННОЕ изменение семантики: раньше изменённое скалярное поле нарушения
// рендерилось как <del>{old}</del> → <ins>{new}</ins> прямым присвоением
// textContent = fieldDiffs[field].old/new (сырой HTML лёг бы в textContent
// буквально). Теперь — word-diff-разметка (_wordDiffToHtml + SafeHTML.set,
// зеркало _renderDiffTextBlock) и бейдж «Изменено форматирование» при
// formattingOnly. Фикстура `reasons` в смоук-тесте выше — тот же осознанный
// апдейт (несёт wordDiff/formattingOnly).

/** Собирает все созданные элементы при рендере диффа нарушения (зеркало renderCollecting из diff-engine-textblock-format.test.mjs). */
function renderViolationCollecting(violDiff) {
    const created = [];
    const orig = document.createElement;
    document.createElement = (tag) => {
        const el = orig(tag);
        created.push(el);
        return el;
    };
    try {
        DiffRenderer._renderDiffViolation({ appendChild() {} }, violDiff);
    } finally {
        document.createElement = orig;
    }
    return created;
}

function makeReasonsViolDiff(fieldDiff) {
    return {
        status: 'modified',
        fieldDiffs: { reasons: fieldDiff },
        newData: { reasons: { enabled: true, content: fieldDiff.new || '' } },
    };
}

test('изменённое rich-поле: рендер зовёт _wordDiffToHtml с полевым wordDiff (не raw del/ins.textContent)', () => {
    const wordDiff = [{ type: 'delete', text: 'старое' }, { type: 'insert', text: 'новое' }];
    const violDiff = makeReasonsViolDiff({ old: 'старое', new: 'новое', changed: true, formattingOnly: false, wordDiff });
    const calls = [];
    const orig = DiffRenderer._wordDiffToHtml;
    DiffRenderer._wordDiffToHtml = (wd) => { calls.push(wd); return orig.call(DiffRenderer, wd); };
    try {
        DiffRenderer._renderDiffViolation({ appendChild() {} }, violDiff);
    } finally {
        DiffRenderer._wordDiffToHtml = orig;
    }
    assert.equal(calls.length, 1, '_wordDiffToHtml должен вызываться для изменённого поля');
    assert.deepEqual(calls[0], wordDiff);
});

test('formattingOnly=true у поля нарушения → бейдж «Изменено форматирование»', () => {
    const created = renderViolationCollecting(makeReasonsViolDiff({
        old: 'важный текст', new: 'важный текст', changed: true, formattingOnly: true,
        wordDiff: [{ type: 'equal', text: 'важный текст' }],
    }));
    const badge = created.find(el => el.className === 'diff-textblock-format-badge');
    assert.ok(badge, 'бейдж форматирования не создан');
    assert.equal(badge.textContent, 'Изменено форматирование');
});

test('formattingOnly=false у поля нарушения → бейджа форматирования нет', () => {
    const created = renderViolationCollecting(makeReasonsViolDiff({
        old: 'старое', new: 'новое', changed: true, formattingOnly: false,
        wordDiff: [{ type: 'delete', text: 'старое' }, { type: 'insert', text: 'новое' }],
    }));
    assert.ok(!created.some(el => el.className === 'diff-textblock-format-badge'));
});

// --- _renderContentEntry: added/removed/unchanged показывают видимый текст -

test('_renderContentEntry (added): видимый текст (_stripHtml), не raw HTML', () => {
    const created = [];
    const orig = document.createElement;
    document.createElement = (tag) => { const el = orig(tag); created.push(el); return el; };
    try {
        DiffRenderer._renderContentEntry({ appendChild() {} }, {
            status: 'added', newItem: { id: 'f1', type: 'freeText', content: '<b>жирный</b> текст' },
        }, null);
    } finally {
        document.createElement = orig;
    }
    assert.ok(created.some(el => el.textContent === 'жирный текст'));
});

test('_renderContentEntry (removed): видимый текст (_stripHtml), не raw HTML', () => {
    const created = [];
    const orig = document.createElement;
    document.createElement = (tag) => { const el = orig(tag); created.push(el); return el; };
    try {
        DiffRenderer._renderContentEntry({ appendChild() {} }, {
            status: 'removed', oldItem: { id: 'f1', type: 'freeText', content: '<i>курсив</i> удалён' },
        }, null);
    } finally {
        document.createElement = orig;
    }
    assert.ok(created.some(el => el.textContent === 'курсив удалён'));
});

test('_renderContentEntry (unchanged): видимый текст (_stripHtml), не raw HTML', () => {
    const created = [];
    const orig = document.createElement;
    document.createElement = (tag) => { const el = orig(tag); created.push(el); return el; };
    try {
        DiffRenderer._renderContentEntry({ appendChild() {} }, {
            status: 'unchanged',
            oldItem: { id: 'c1', type: 'case', content: '<b>кейс</b> без изменений' },
            newItem: { id: 'c1', type: 'case', content: '<b>кейс</b> без изменений' },
        }, 1);
    } finally {
        document.createElement = orig;
    }
    const body = created.find(el => el.className === 'diff-violation-item-body');
    assert.ok(body, 'тело элемента не создано');
    assert.equal(body.textContent, 'кейс без изменений');
});

// --- Review Round 2: formattingOnly-бейдж для case/freeText (паритет со
// скалярными полями нарушения выше) --------------------------------------

test('formattingOnly=true у case/freeText → бейдж «Изменено форматирование»', () => {
    const created = [];
    const orig = document.createElement;
    document.createElement = (tag) => { const el = orig(tag); created.push(el); return el; };
    try {
        DiffRenderer._renderContentEntry({ appendChild() {} }, {
            status: 'modified', formattingOnly: true,
            oldItem: { id: 'c1', type: 'case', content: 'кейс' },
            newItem: { id: 'c1', type: 'case', content: '<b>кейс</b>' },
            wordDiff: [{ type: 'equal', text: 'кейс' }],
        }, 1);
    } finally {
        document.createElement = orig;
    }
    const badge = created.find(el => el.className === 'diff-textblock-format-badge');
    assert.ok(badge, 'бейдж форматирования не создан');
    assert.equal(badge.textContent, 'Изменено форматирование');
});

test('formattingOnly=false у case/freeText → бейджа форматирования нет', () => {
    const created = [];
    const orig = document.createElement;
    document.createElement = (tag) => { const el = orig(tag); created.push(el); return el; };
    try {
        DiffRenderer._renderContentEntry({ appendChild() {} }, {
            status: 'modified', formattingOnly: false,
            oldItem: { id: 'c1', type: 'case', content: '<b>старый</b> кейс' },
            newItem: { id: 'c1', type: 'case', content: '<b>новый</b> кейс' },
            wordDiff: [{ type: 'delete', text: 'старый' }, { type: 'insert', text: 'новый' }],
        }, 1);
    } finally {
        document.createElement = orig;
    }
    assert.ok(!created.some(el => el.className === 'diff-textblock-format-badge'));
});

// --- Task 6: caption картинки — word-diff вместо сырых old/new строк -------
// (зеркало formattingOnly-блока выше для case/freeText/скалярных полей).

function makeCaptionImageEntry(fieldDiff) {
    return {
        status: 'modified',
        oldItem: { id: 'i1', type: 'image', url: 'u', caption: fieldDiff.old, filename: 'p.png', width: 0 },
        newItem: { id: 'i1', type: 'image', url: 'u', caption: fieldDiff.new, filename: 'p.png', width: 0 },
        fields: { caption: fieldDiff },
    };
}

/** Собирает все созданные элементы при рендере _renderImageEntry. */
function renderImageEntryCollecting(entry) {
    const created = [];
    const orig = document.createElement;
    document.createElement = (tag) => { const el = orig(tag); created.push(el); return el; };
    try {
        DiffRenderer._renderImageEntry({ appendChild() {} }, entry);
    } finally {
        document.createElement = orig;
    }
    return created;
}

test('_renderImageEntry: caption с wordDiff → рендер зовёт _wordDiffToHtml с полевым wordDiff (не raw old/new)', () => {
    const wordDiff = [{ type: 'delete', text: 'старая' }, { type: 'insert', text: 'новая' }];
    const entry = makeCaptionImageEntry({ old: '<b>старая</b>', new: '<b>новая</b>', wordDiff, formattingOnly: false });
    const calls = [];
    const orig = DiffRenderer._wordDiffToHtml;
    DiffRenderer._wordDiffToHtml = (wd) => { calls.push(wd); return orig.call(DiffRenderer, wd); };
    try {
        DiffRenderer._renderImageEntry({ appendChild() {} }, entry);
    } finally {
        DiffRenderer._wordDiffToHtml = orig;
    }
    assert.equal(calls.length, 1, '_wordDiffToHtml должен вызываться для caption с wordDiff');
    assert.deepEqual(calls[0], wordDiff);
});

test('_renderImageEntry: caption formattingOnly=true → бейдж «Изменено форматирование»', () => {
    const created = renderImageEntryCollecting(makeCaptionImageEntry({
        old: 'важно', new: '<b>важно</b>', wordDiff: [{ type: 'equal', text: 'важно' }], formattingOnly: true,
    }));
    const badge = created.find(el => el.className === 'diff-textblock-format-badge');
    assert.ok(badge, 'бейдж форматирования не создан');
    assert.equal(badge.textContent, 'Изменено форматирование');
});

test('_renderImageEntry: caption formattingOnly=false → бейджа форматирования нет', () => {
    const created = renderImageEntryCollecting(makeCaptionImageEntry({
        old: '<b>старая</b>', new: '<b>новая</b>',
        wordDiff: [{ type: 'delete', text: 'старая' }, { type: 'insert', text: 'новая' }],
        formattingOnly: false,
    }));
    assert.ok(!created.some(el => el.className === 'diff-textblock-format-badge'));
});

test('_appendImagePreview: caption — видимый текст (_stripHtml), не сырой HTML буквально', () => {
    const collected = [];
    const orig = document.createElement;
    document.createElement = (tag) => { const el = orig(tag); collected.push(el); return el; };
    try {
        DiffRenderer._appendImagePreview({ appendChild() {} }, { url: '', caption: '<b>важно</b>', filename: 'p.png' });
    } finally {
        document.createElement = orig;
    }
    const cap = collected.find(el => el.className === 'diff-violation-caption');
    assert.ok(cap, 'подпись не создана');
    assert.equal(cap.textContent, 'важно', 'видимый текст без тегов');
});
