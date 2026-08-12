/**
 * Превью нарушений = полнота DOCX (H4/M.3/M.5) — блочная модель.
 *
 * Тестируем чистые части рендерера: collectViolationLines (поля в порядке
 * fieldOrder, метка + блоки, полные тексты без обрезки — семантика
 * docx/builders/violation.py), imagePresentationStyle (маппинг block.width /
 * image_max_height_percent → CSS, Б-1.4/Б-1.6) и splitTopLevelBlocks
 * (per-line align, паритет с split_block_segments).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    collectViolationLines,
    imagePresentationStyle,
    splitTopLevelBlocks,
    PreviewViolationRenderer,
} from '../../static/js/constructor/preview/preview-violation-renderer.js';
import { VIOLATION_FIELDS, VIOLATION_LABELS, VIOLATION_FIELD_KEYS } from '../../static/js/constructor/violation/violation-fields.js';
import { createDefaultViolationShape } from '../../static/js/constructor/violation/violation-normalize.js';

const LONG = 'Очень длинный текст нарушения, который раньше обрезался превью до пары десятков символов. '.repeat(20);

let _bid = 0;
const text = (content) => ({ id: `text_t_${++_bid}`, type: 'text', content });

function makeViolation(overrides = {}) {
    const v = { id: 'v1', nodeId: 'n1', ...createDefaultViolationShape() };
    v.violated.blocks = [text('Нарушено-текст')];
    v.established.blocks = [text('Установлено-текст')];
    return Object.assign(v, overrides);
}

/**
 * Рендерит нарушение с одним image-блоком и возвращает применённый
 * inline-стиль картинки. Перехватывает document.createElement, чтобы достать
 * созданный <img> (appendChild в стабе — no-op).
 */
function renderImageStyle(imageBlock) {
    const origCreate = document.createElement;
    let imgStyle = null;
    document.createElement = (tag) => {
        const el = origCreate(tag);
        if (tag === 'img') imgStyle = el.style;
        return el;
    };
    try {
        PreviewViolationRenderer.create(makeViolation({
            additionalContent: { enabled: true, blocks: [imageBlock] },
        }));
    } finally {
        document.createElement = origCreate;
    }
    return imgStyle || {};
}

// --- Полнота модели строк ---

test('violated/established выводятся полностью, без обрезки', () => {
    const v = makeViolation();
    v.violated.blocks = [text(LONG)];
    v.established.blocks = [text(LONG)];
    const lines = collectViolationLines(v);
    assert.equal(lines.find(l => l.label === 'Нарушено').text, LONG);
    assert.equal(lines.find(l => l.label === 'Установлено').text, LONG);
});

test('mandatory-поля с пустым контейнером → метка + пустое тело (#14, Q1)', () => {
    const v = makeViolation();
    v.violated.blocks = [];
    v.established.blocks = [];
    const lines = collectViolationLines(v);
    assert.equal(lines.find(l => l.label === 'Нарушено').text, '');
    assert.equal(lines.find(l => l.label === 'Установлено').text, '');
});

test('выключенное поле не выводится; включённое пустое — тоже', () => {
    const v = makeViolation({
        reasons: { enabled: false, blocks: [text('скрытая')] },
        measures: { enabled: true, blocks: [] },
    });
    const lines = collectViolationLines(v);
    assert.ok(!lines.some(l => (l.text || '').includes('скрытая')));
    assert.ok(!lines.some(l => l.label === VIOLATION_LABELS.measures));
});

test('несколько text-блоков: первый инлайнится с меткой, остальные — продолжения без метки', () => {
    const v = makeViolation({
        reasons: { enabled: true, blocks: [text('первый'), text('второй'), text('третий')] },
    });
    const lines = collectViolationLines(v);
    const idx = lines.findIndex(l => l.label === VIOLATION_LABELS.reasons);
    assert.equal(lines[idx].text, 'первый');
    assert.equal(lines[idx + 1].label, '');
    assert.equal(lines[idx + 1].text, 'второй');
    assert.equal(lines[idx + 2].text, 'третий');
});

test('поле, начинающееся с картинки, даёт метку отдельной строкой', () => {
    const image = { id: 'image_1', type: 'image', url: 'data:image/png;base64,AAAA', caption: '', filename: 'x.png', width: 0 };
    const v = makeViolation({
        reasons: { enabled: true, blocks: [image, text('после картинки')] },
    });
    const lines = collectViolationLines(v);
    const idx = lines.findIndex(l => l.label === VIOLATION_LABELS.reasons);
    assert.equal(lines[idx].text, '', 'метка без инлайн-текста');
    assert.equal(lines[idx + 1].type, 'image');
    assert.equal(lines[idx + 2].text, 'после картинки');
});

// --- labeled=false: CodeMining / ProcessMining / Дополнительный контент ---

test('labeled=false: поле выводит только контент, строки-метки нет', () => {
    const v = makeViolation({
        codeMining: { enabled: true, blocks: [text('CM-контент')] },
        processMining: { enabled: true, blocks: [text('PM-контент')] },
        additionalContent: { enabled: true, blocks: [text('Доп-контент')] },
    });
    const lines = collectViolationLines(v);
    for (const key of ['codeMining', 'processMining', 'additionalContent']) {
        assert.ok(
            !lines.some(l => l.label === VIOLATION_LABELS[key]),
            `метка «${VIOLATION_LABELS[key]}» не должна появляться в превью`
        );
    }
    for (const marker of ['CM-контент', 'PM-контент', 'Доп-контент']) {
        assert.ok(lines.some(l => l.text === marker), `контент «${marker}» потерян`);
    }
});

test('labeled=false: первый text-блок НЕ инлайнится — все блоки идут строками подряд', () => {
    const v = makeViolation({
        codeMining: { enabled: true, blocks: [text('первый'), text('второй')] },
    });
    const lines = collectViolationLines(v);
    const first = lines.findIndex(l => l.text === 'первый');
    assert.ok(first >= 0, 'первый блок потерян');
    assert.equal(lines[first].label, '', 'у поля без метки строка идёт без label');
    assert.equal(lines[first + 1].text, 'второй');
});

test('labeled=false: политика видимости прежняя — выключенное или пустое поле не выводится', () => {
    const v = makeViolation({
        codeMining: { enabled: false, blocks: [text('скрытый CM')] },
        processMining: { enabled: true, blocks: [] },
    });
    const lines = collectViolationLines(v);
    assert.ok(!lines.some(l => (l.text || '').includes('скрытый CM')));
});

test('labeled=false: поле, начинающееся с картинки, не даёт пустой строки-метки', () => {
    const image = { id: 'image_1', type: 'image', url: 'data:image/png;base64,AAAA', caption: '', filename: 'x.png', width: 0 };
    const v = makeViolation({
        additionalContent: { enabled: true, blocks: [image, text('после картинки')] },
    });
    const lines = collectViolationLines(v);
    const idx = lines.findIndex(l => l.type === 'image');
    assert.ok(idx >= 0, 'image-строка отсутствует');
    assert.ok(
        !lines.some(l => l.type === 'line' && l.label === VIOLATION_LABELS.additionalContent),
        'пустая строка-метка не должна создаваться'
    );
    assert.equal(lines[idx + 1].text, 'после картинки');
});

test('image-блок попадает в модель строк целиком', () => {
    const image = { id: 'image_1', type: 'image', url: 'data:image/png;base64,AAAA', caption: 'Подпись', filename: 'x.png', width: 50 };
    const v = makeViolation({
        additionalContent: { enabled: true, blocks: [text('t'), image] },
    });
    const line = collectViolationLines(v).find(l => l.type === 'image');
    assert.equal(line.item, image);
});

test('table-блок попадает в модель строк с сеткой и флагом small поля', () => {
    const tableBlock = {
        id: 'table_1', type: 'table',
        table: { grid: [[{ content: 'A' }]], colWidths: [100] },
    };
    const v = makeViolation({
        codeMining: { enabled: true, blocks: [tableBlock] },
    });
    const line = collectViolationLines(v).find(l => l.type === 'table');
    assert.ok(line, 'table-строка отсутствует');
    assert.equal(line.table, tableBlock.table);
});

test('fieldOrder меняет порядок строк модели', () => {
    const order = [...VIOLATION_FIELD_KEYS].filter(k => k !== 'responsible');
    order.unshift('responsible');
    const v = makeViolation({
        fieldOrder: order,
        responsible: { enabled: true, blocks: [text('Иванов И.И.')] },
    });
    const lines = collectViolationLines(v);
    assert.equal(lines[0].label, VIOLATION_LABELS.responsible);
});

test('№10/#11: ВСЕ подписи полей превью берутся из реестра VIOLATION_LABELS', () => {
    const v = makeViolation();
    for (const key of VIOLATION_FIELD_KEYS) {
        v[key] = { enabled: true, blocks: [text(`значение-${key}`)] };
    }
    const lines = collectViolationLines(v);
    for (const field of VIOLATION_FIELDS) {
        const line = lines.find(l => l.text === `значение-${field.key}`);
        assert.ok(line, `строка поля ${field.key} не найдена`);
        // labeled=false → подписи нет вовсе; иначе — ровно строка реестра.
        assert.equal(line.label, field.labeled ? VIOLATION_LABELS[field.key] : '');
    }
});

test('small-флаг реестра доходит до строк (9pt-группа vs 12pt)', () => {
    const v = makeViolation({
        additionalContent: { enabled: true, blocks: [text('доп')] },
        reasons: { enabled: true, blocks: [text('причина')] },
    });
    const lines = collectViolationLines(v);
    // Решение владельца: additionalContent выведен из 9pt-группы.
    assert.equal(lines.find(l => l.text === 'доп').small, false, 'additionalContent — обычный 12pt');
    assert.equal(lines.find(l => l.text === 'причина').small, false, 'reasons — обычный 12pt');
    assert.equal(lines.find(l => l.label === VIOLATION_LABELS.violated).small, true, 'violated — 9pt-группа');
});

// --- Task 6: подпись — rich-HTML, рендерится через renderActContent -------

test('_appendCaption: рендерит caption через renderActContent (innerHTML), не textContent буквально с тегами', () => {
    const origDOMPurify = window.DOMPurify;
    // Идентити-фейк: достаточно отличить innerHTML (renderActContent) от
    // textContent (старое поведение) — сами правила allowlist'а проверены
    // в sanitize-render-act-content.test.mjs/sanitize-profiles.test.mjs.
    window.DOMPurify = { sanitize: (html) => String(html) };
    try {
        let appended = null;
        const container = { appendChild: (el) => { appended = el; } };
        PreviewViolationRenderer._appendCaption(container, { caption: '<b>важно</b>' });

        assert.ok(appended, 'подпись добавлена в контейнер');
        assert.equal(appended.className, 'preview-violation-caption');
        assert.equal(appended.innerHTML, '<b>важно</b>', 'renderActContent пишет innerHTML — форматирование не превращается в буквальный текст тегов');
    } finally {
        window.DOMPurify = origDOMPurify;
    }
});

test('_appendCaption: пустая/отсутствующая caption — ничего не добавляется', () => {
    let appended = null;
    const container = { appendChild: (el) => { appended = el; } };
    PreviewViolationRenderer._appendCaption(container, { caption: '' });
    assert.equal(appended, null);
});

// --- rich-рендер тела поля (renderActContent) ---

test('rich-тело поля через renderActContent, не createTextNode', () => {
    const seen = [];
    const orig = document.createTextNode;
    document.createTextNode = (t) => { seen.push(String(t)); return orig(t); };
    try {
        const v = makeViolation();
        v.violated.blocks = [text('до <b>x</b> после')];
        PreviewViolationRenderer.create(v);
    } finally {
        document.createTextNode = orig;
    }
    assert.ok(!seen.some(t => t.includes('<b>')), 'сырой HTML не должен уйти в текст-ноду');
});

// --- imagePresentationStyle (Б-1.4/Б-1.6) ---

test('width=50 → CSS width:50%; width=0 → авто (width не задаётся)', () => {
    const style50 = imagePresentationStyle({ width: 50 }, 40);
    assert.equal(style50.width, '50%');
    const styleAuto = imagePresentationStyle({ width: 0 }, 40);
    assert.equal(styleAuto.width, '');
    assert.ok(style50.maxHeight.endsWith('mm'));
});

test('DOM: инлайн-стиль картинки применяет width и maxHeight', () => {
    const style = renderImageStyle({
        id: 'image_1', type: 'image', url: 'data:image/png;base64,AAAA',
        caption: '', filename: 'x.png', width: 50,
    });
    assert.equal(style.width, '50%');
    assert.ok(String(style.maxHeight).endsWith('mm'));
});

// --- #13: splitTopLevelBlocks (паритет с split_block_segments, inline.py) ---

test('splitTopLevelBlocks: без верхнеуровневых <div>/<p> — один сегмент с исходным html, без align', () => {
    assert.deepEqual(splitTopLevelBlocks('до <b>x</b> после'), [{ html: 'до <b>x</b> после', align: null }]);
});

test('splitTopLevelBlocks: пустая строка — пустой массив', () => {
    assert.deepEqual(splitTopLevelBlocks(''), []);
});

test('splitTopLevelBlocks: два верхнеуровневых <div> — два сегмента, теги-обёртки отброшены', () => {
    assert.deepEqual(splitTopLevelBlocks('<div>первая</div><div>вторая</div>'), [
        { html: 'первая', align: null },
        { html: 'вторая', align: null },
    ]);
});

test('splitTopLevelBlocks: вложенный <div> остаётся внутри родительского сегмента', () => {
    assert.deepEqual(splitTopLevelBlocks('<div>внешний<div>внутренний</div></div>'), [
        { html: 'внешний<div>внутренний</div>', align: null },
    ]);
});

// --- F2/Пункт 1: text-align сегмента сохраняется в модели ---

test('splitTopLevelBlocks: text-align верхнеуровневого <div> попадает в align сегмента', () => {
    assert.deepEqual(splitTopLevelBlocks('<div style="text-align:center">центр</div>'), [
        { html: 'центр', align: 'center' },
    ]);
});

test('splitTopLevelBlocks: разные align у соседних сегментов не путаются', () => {
    const html = '<div style="text-align:center">первая</div><div style="text-align:right">вторая</div>';
    assert.deepEqual(splitTopLevelBlocks(html), [
        { html: 'первая', align: 'center' },
        { html: 'вторая', align: 'right' },
    ]);
});

test('splitTopLevelBlocks: <div> без style — align: null (нераспознанные значения тоже игнорируются)', () => {
    assert.deepEqual(splitTopLevelBlocks('<div>обычная</div>'), [{ html: 'обычная', align: null }]);
    assert.deepEqual(splitTopLevelBlocks('<div style="text-align:start">старт</div>'), [{ html: 'старт', align: null }]);
});

test('splitTopLevelBlocks: "text-align:center" в class (не в style) — align: null, не подделка', () => {
    assert.deepEqual(splitTopLevelBlocks('<div class="text-align:center">текст</div>'), [
        { html: 'текст', align: null },
    ]);
});

test('splitTopLevelBlocks: class с "text-align" И реальный style — align берётся только из style', () => {
    assert.deepEqual(splitTopLevelBlocks('<div class="text-align:left" style="text-align:right">текст</div>'), [
        { html: 'текст', align: 'right' },
    ]);
});

test('splitTopLevelBlocks: style в одинарных кавычках — align распознаётся', () => {
    assert.deepEqual(splitTopLevelBlocks("<div style='text-align:center'>текст</div>"), [
        { html: 'текст', align: 'center' },
    ]);
});

// --- #13: превью не разрывает многострочное rich-поле под меткой -----------

test('#13: _addLine режет верхнеуровневые <div>-абзацы — первый инлайнится с меткой, остальные — отдельными блоками (паритет с DOCX _labeled_paragraph)', () => {
    const created = [];
    const origCreate = document.createElement;
    document.createElement = (tag) => {
        const el = origCreate(tag);
        created.push({ tag, el });
        return el;
    };
    try {
        PreviewViolationRenderer.create(makeViolation({
            reasons: { enabled: true, blocks: [text('<div>первая</div><div>вторая</div>')] },
        }));
    } finally {
        document.createElement = origCreate;
    }

    const reasonsSpan = created.find((c) => c.tag === 'span' && c.el.textContent === 'первая');
    assert.ok(reasonsSpan, 'первый абзац рендерится в span рядом с меткой');
    assert.ok(!/div/i.test(reasonsSpan.el.textContent), 'нет div внутри span (нет невалидного block-in-inline)');

    const secondLine = created.find((c) => c.tag === 'div'
        && c.el.className && c.el.className.includes('preview-violation-line')
        && c.el.textContent === 'вторая');
    assert.ok(secondLine, 'второй абзац рендерится отдельным блоком ниже');
});

test('F2-1: _addLine переносит text-align первого сегмента на строку с меткой, второго — на строку-продолжение', () => {
    const created = [];
    const origCreate = document.createElement;
    document.createElement = (tag) => {
        const el = origCreate(tag);
        created.push({ tag, el });
        return el;
    };
    try {
        PreviewViolationRenderer.create(makeViolation({
            reasons: { enabled: true, blocks: [text('<div style="text-align:center">первая</div><div style="text-align:right">вторая</div>')] },
        }));
    } finally {
        document.createElement = origCreate;
    }

    // Стаб appendChild — no-op, textContent родителя не собирается из детей,
    // поэтому строки различаем по порядку создания: violated/established
    // рендерятся первыми (#14/Q1), reasons — последним включённым; _addLine
    // создаёт line ДО body-span, затем contLine — в цикле по сегментам.
    const lineDivs = created.filter((c) => c.tag === 'div'
        && c.el.className && c.el.className.includes('preview-violation-line'));
    assert.equal(lineDivs.length, 4, 'violated/established (по 1 строке) + reasons (строка с меткой + продолжение)');
    const [reasonsLine, reasonsCont] = lineDivs.slice(-2);
    assert.equal(reasonsLine.el.style.textAlign, 'center', 'align первого сегмента переносится на строку с меткой');
    assert.equal(reasonsCont.el.style.textAlign, 'right', 'align продолжения переносится на его строку');
});

test('F2-1: поле без text-align — раскладка прежняя, инлайн-style не проставляется (default через CSS)', () => {
    const created = [];
    const origCreate = document.createElement;
    document.createElement = (tag) => {
        const el = origCreate(tag);
        created.push({ tag, el });
        return el;
    };
    try {
        PreviewViolationRenderer.create(makeViolation({
            reasons: { enabled: true, blocks: [text('<div>первая</div><div>вторая</div>')] },
        }));
    } finally {
        document.createElement = origCreate;
    }
    const lines = created.filter((c) => c.tag === 'div'
        && c.el.className && c.el.className.includes('preview-violation-line'));
    assert.ok(lines.length >= 2, 'ожидались строки нарушения');
    assert.ok(lines.every((l) => !l.el.style.textAlign), 'без явного align инлайн text-align не задаётся');
});
