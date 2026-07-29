/**
 * Превью нарушений = полнота DOCX (H4/M.3/M.5).
 *
 * Тестируем чистые части рендерера: collectViolationLines (полные тексты,
 * полный descriptionList, нумерация кейсов со сбросом — семантика
 * docx/builders/violation.py) и imagePresentationStyle (маппинг
 * item.width / image_max_height_percent → CSS, Б-1.4/Б-1.6).
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

/**
 * Рендерит нарушение с одним image-элементом и возвращает применённый
 * inline-стиль картинки. Перехватывает document.createElement, чтобы достать
 * созданный <img> (appendChild в стабе — no-op).
 *
 * @param {Object} imageItem Элемент additionalContent типа image.
 * @returns {{width: (string|undefined), maxHeight: (string|undefined)}}
 */
function renderImageStyle(imageItem) {
    const origCreate = document.createElement;
    let imgStyle = null;
    document.createElement = (tag) => {
        const el = origCreate(tag);
        if (tag === 'img') imgStyle = el.style;
        return el;
    };
    try {
        PreviewViolationRenderer.create({
            violated: '—',
            established: '—',
            descriptionList: { enabled: false, items: [] },
            additionalContent: { enabled: true, items: [imageItem] },
            reasons: { enabled: false, content: '' },
            consequences: { enabled: false, content: '' },
            responsible: { enabled: false, content: '' },
        });
    } finally {
        document.createElement = origCreate;
    }
    return imgStyle || {};
}

const LONG = 'Очень длинный текст нарушения, который раньше обрезался превью до пары десятков символов. '.repeat(20);

function makeViolation(overrides = {}) {
    return Object.assign({
        id: 'v1',
        nodeId: 'n1',
        violated: 'Нарушено-текст',
        established: 'Установлено-текст',
        descriptionList: { enabled: false, items: [] },
        additionalContent: { enabled: false, items: [] },
        reasons: { enabled: false, content: '' },
        consequences: { enabled: false, content: '' },
        responsible: { enabled: false, content: '' },
    }, overrides);
}

test('violated/established выводятся полностью, без обрезки', () => {
    const lines = collectViolationLines(makeViolation({ violated: LONG, established: LONG }));
    const violated = lines.find(l => l.label === 'Нарушено');
    const established = lines.find(l => l.label === 'Установлено');
    assert.equal(violated.text, LONG);
    assert.equal(established.text, LONG);
});

test('violated/established пустые → метка + пустое тело, без «—» (#14, Q1)', () => {
    const lines = collectViolationLines(makeViolation({ violated: '', established: '' }));
    const violated = lines.find(l => l.label === 'Нарушено');
    const established = lines.find(l => l.label === 'Установлено');
    assert.equal(violated.text, '');
    assert.equal(established.text, '');
});

test('descriptionList — полный список пунктов, включая пустые, без заголовка «В том числе» (#12/#15/Q1)', () => {
    const items = ['Метрика один', 'Метрика два', 'Метрика три'];
    const lines = collectViolationLines(makeViolation({
        descriptionList: { enabled: true, items: [...items, ''] },
    }));
    const list = lines.find(l => l.type === 'list');
    assert.ok(list, 'нет list-строки');
    assert.deepEqual(list.items, [...items, '']); // ничего не отфильтровано, включая пустой пункт
    assert.equal(list.label, '', 'заголовок «В том числе» убран (#12)');
});

test('DOM: пустая метка descriptionList не рисует одинокую «:» (#12)', () => {
    const created = [];
    const origCreate = document.createElement;
    document.createElement = (tag) => {
        const el = origCreate(tag);
        created.push(el);
        return el;
    };
    try {
        PreviewViolationRenderer.create(makeViolation({
            descriptionList: { enabled: true, items: ['Пункт 1', ''] },
        }));
    } finally {
        document.createElement = origCreate;
    }
    const strayLabel = created.some(el => el.className === 'preview-violation-label' && el.textContent === ':');
    assert.ok(!strayLabel, '_addList не должен создавать labelEl при пустом label');
});

test('выключенный descriptionList не выводится', () => {
    const lines = collectViolationLines(makeViolation({
        descriptionList: { enabled: false, items: ['скрытая'] },
    }));
    assert.ok(!lines.some(l => l.type === 'list'));
});

test('кейсы — полные, без обрезки, свободный текст — без подписи (M.5/#10)', () => {
    const lines = collectViolationLines(makeViolation({
        additionalContent: {
            enabled: true,
            items: [
                { id: 'c1', type: 'case', content: LONG },
                { id: 'f1', type: 'freeText', content: LONG },
            ],
        },
    }));
    assert.equal(lines.find(l => l.label === 'Кейс 1').text, LONG);
    const freeTextLine = lines.find(l => l.type === 'line' && l.text === LONG && l.label === '');
    assert.ok(freeTextLine, 'свободный текст рендерится без подписи (#10)');
});

test('пустой свободный текст не рендерится — паритет с DOCX/MD/TXT (у freeText нет метки, ничего не пропущено)', () => {
    const lines = collectViolationLines(makeViolation({
        additionalContent: {
            enabled: true,
            items: [
                { id: 'f1', type: 'freeText', content: '' },
                { id: 'f2', type: 'freeText', content: '   ' },
            ],
        },
    }));
    assert.ok(!lines.some(l => l.type === 'line' && l.label === ''), 'пустой/whitespace-only freeText не должен давать строку (в отличие от пустых кейсов/пунктов списка, у которых есть метка/маркер)');
});

test('нумерация кейсов сбрасывается после не-кейса (паритет DOCX/MD/TXT)', () => {
    const lines = collectViolationLines(makeViolation({
        additionalContent: {
            enabled: true,
            items: [
                { id: 'c1', type: 'case', content: 'Первый' },
                { id: 'c2', type: 'case', content: 'Второй' },
                { id: 'i1', type: 'image', url: 'data:image/png;base64,AAAA', filename: 'x.png' },
                { id: 'c3', type: 'case', content: 'После картинки' },
            ],
        },
    }));
    const labels = lines.filter(l => /^Кейс/.test(l.label || '')).map(l => l.label);
    assert.deepEqual(labels, ['Кейс 1', 'Кейс 2', 'Кейс 1']);
});

test('пустой кейс рендерится (метка + пустое тело), нумерация не пропускает его (#9/Q1)', () => {
    const lines = collectViolationLines(makeViolation({
        additionalContent: {
            enabled: true,
            items: [
                { id: 'c1', type: 'case', content: '' },
                { id: 'c2', type: 'case', content: 'Единственный' },
            ],
        },
    }));
    const cases = lines.filter(l => /^Кейс/.test(l.label || ''));
    assert.equal(cases.length, 2, 'оба кейса рендерятся, включая пустой первый');
    assert.equal(cases[0].label, 'Кейс 1');
    assert.equal(cases[0].text, '');
    assert.equal(cases[1].label, 'Кейс 2', 'заполненный кейс получает номер 2, как в форме');
    assert.equal(cases[1].text, 'Единственный');
});

test('image-элемент попадает в модель строк целиком', () => {
    const item = { id: 'i1', type: 'image', url: 'data:image/png;base64,AAAA', caption: 'Подпись', filename: 'x.png', width: 50 };
    const lines = collectViolationLines(makeViolation({
        additionalContent: { enabled: true, items: [item] },
    }));
    const image = lines.find(l => l.type === 'image');
    assert.equal(image.item, item);
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

test('опциональные поля выводятся полностью при enabled', () => {
    const lines = collectViolationLines(makeViolation({
        reasons: { enabled: true, content: LONG },
        consequences: { enabled: false, content: 'скрытая' },
    }));
    assert.equal(lines.find(l => l.label === 'Причины').text, LONG);
    assert.ok(!lines.some(l => (l.text || '').includes('скрытая')));
});

test('#11: подпись поля responsible берётся из контракта VIOLATION_LABELS («Ответственные»)', () => {
    const lines = collectViolationLines(makeViolation({
        responsible: { enabled: true, content: 'Иванов И.И.' },
    }));
    const line = lines.find(l => l.text === 'Иванов И.И.');
    assert.ok(line, 'строка responsible не найдена');
    assert.equal(line.label, 'Ответственные');
});

// --- rich-рендер тела поля (renderActContent, Task 1.1.4) ---

test('rich-тело поля через renderActContent, не createTextNode', () => {
    const seen = [];
    const orig = document.createTextNode;
    document.createTextNode = (t) => { seen.push(String(t)); return orig(t); };
    try {
        PreviewViolationRenderer.create(makeViolation({ violated: 'до <b>x</b> после' }));
    } finally {
        document.createTextNode = orig;
    }
    assert.ok(!seen.some(t => t.includes('<b>')), 'сырой HTML не должен уйти в текст-ноду');
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

// --- F2/Пункт 1: text-align сегмента сохраняется в модели (паритет с DOCX
// BlockSegment.alignment, split_block_segments в inline.py) -----------------

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

// --- Ревью F2/Minor: align извлекается ТОЛЬКО из атрибута style, не из всего
// текста открывающего тега (паритет со скоупом бэкового _extract_text_align,
// inline.py: он ищет только в attrs['style']) — иначе `class="text-align:center"`
// (class — разрешённый атрибут без ограничений на содержимое) давал бы align в
// превью при отсутствии его в DOCX ------------------------------------------

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
            reasons: { enabled: true, content: '<div>первая</div><div>вторая</div>' },
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

// --- F2/Пункт 1: превью теряло per-line text-align многострочных полей -----
// (паритет с DOCX render_block_segments: align сегмента переопределяет
// default_alignment абзаца целиком, включая метку) ---------------------------

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
            reasons: { enabled: true, content: '<div style="text-align:center">первая</div><div style="text-align:right">вторая</div>' },
        }));
    } finally {
        document.createElement = origCreate;
    }

    // Стаб appendChild — no-op, textContent родителя не собирается из детей
    // (в отличие от реального DOM), поэтому строки различаем по порядку
    // создания: violated/established всегда рендерятся первыми (#14/Q1), reasons —
    // последним из optionalFields; _addLine создаёт line ДО body-span, затем
    // contLine — в цикле по остальным сегментам (гарантированный порядок).
    const lineDivs = created.filter((c) => c.tag === 'div'
        && c.el.className && c.el.className.includes('preview-violation-line'));
    assert.equal(lineDivs.length, 4, 'violated/established (по 1 строке) + reasons (строка с меткой + продолжение)');
    const [reasonsLine, reasonsCont] = lineDivs.slice(-2);
    assert.equal(reasonsLine.el.style.textAlign, 'center', 'align первого сегмента переносится на строку с меткой (DOCX выравнивает весь абзац, включая label-run)');
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
            reasons: { enabled: true, content: '<div>первая</div><div>вторая</div>' },
        }));
    } finally {
        document.createElement = origCreate;
    }
    const lines = created.filter((c) => c.tag === 'div'
        && c.el.className && c.el.className.includes('preview-violation-line'));
    assert.ok(lines.length >= 2, 'ожидались строки нарушения');
    assert.ok(lines.every((l) => !l.el.style.textAlign), 'без явного align инлайн text-align не задаётся');
});

// --- imagePresentationStyle (Б-1.4 / Б-1.6) ---

test('width=50 → width:50%, дефолтный лимит высоты 40% полезной высоты листа = 110.8mm', () => {
    const style = imagePresentationStyle({ width: 50 }, 40);
    assert.equal(style.width, '50%');
    assert.equal(style.maxHeight, '110.8mm');
});

test('width=0 (Авто) → width не задаётся', () => {
    const style = imagePresentationStyle({ width: 0 }, 40);
    assert.equal(style.width, '');
});

test('width отсутствует у старых актов → авто', () => {
    const style = imagePresentationStyle({}, 40);
    assert.equal(style.width, '');
});

test('кастомный image_max_height_percent учитывается', () => {
    const style = imagePresentationStyle({ width: 25 }, 50);
    assert.equal(style.width, '25%');
    assert.equal(style.maxHeight, '138.5mm');
});

test('#13: база потолка высоты — полезная высота листа (277мм), не полная A4 (297мм)', () => {
    // Паритет с DOCX _USABLE_HEIGHT_TWIPS (Page.height_twips - Margins.top - Margins.bottom
    // = 16838-567-567=15704 твип ≈ 277мм, docx/builders/violation.py): тот же
    // image_max_height_percent должен давать ту же физическую высоту в превью и в Word.
    const style = imagePresentationStyle({ width: 0 }, 100);
    assert.equal(style.maxHeight, '277mm', 'при 100% потолок равен полезной высоте, а не полной высоте листа A4');
});

test('нулевой/отсутствующий процент высоты → дефолт 40', () => {
    assert.equal(imagePresentationStyle({}, 0).maxHeight, '110.8mm');
    assert.equal(imagePresentationStyle({}, undefined).maxHeight, '110.8mm');
});

// --- применённый стиль <img> (FINDING 6 / Б-1.6, #13): паритет с DOCX ---

test('явная ширина → задаётся И width, И потолок высоты (#13, паритет с DOCX _scale_picture)', () => {
    const style = renderImageStyle({ type: 'image', url: 'data:image/png;base64,AAAA', width: 50, filename: 'x.png' });
    assert.equal(style.width, '50%');
    assert.equal(style.maxHeight, '110.8mm', 'explicit-width картинка тоже ограничена по высоте, как в DOCX');
});

test('авторазмер (width=0) → задаётся maxHeight, ширина не фиксируется', () => {
    const style = renderImageStyle({ type: 'image', url: 'data:image/png;base64,AAAA', width: 0, filename: 'x.png' });
    assert.equal(style.width, undefined, 'auto-size картинка не должна получать width');
    assert.equal(style.maxHeight, '110.8mm', 'auto-size картинка ограничивает высоту (защита скролла, Б-1.6)');
});

test('width отсутствует (старые акты) → авторазмер с maxHeight', () => {
    const style = renderImageStyle({ type: 'image', url: 'data:image/png;base64,AAAA', filename: 'x.png' });
    assert.equal(style.width, undefined);
    assert.equal(style.maxHeight, '110.8mm');
});
