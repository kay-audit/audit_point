/**
 * Дифф нарушений на блочной модели.
 *
 * Все 10 полей реестра — контейнеры {enabled, blocks}, поэтому под-дифф у них
 * ОДНОЙ формы (раньше их было три несовместимых: скаляры / descriptionList /
 * additionalContent). Проверяем:
 *   - блоки трёх типов: added/removed/modified/reordered по стабильному id;
 *   - text — word-diff по видимому тексту + formattingOnly;
 *   - image — атрибуты (url только фактом смены, caption — word-diff);
 *   - table — плоский список изменённых ячеек, без LCS по содержимому;
 *   - enabled поля и fieldOrder — отдельные классы изменений;
 *   - перф-гвард: крупный контент не идёт через _wordDiff;
 *   - повреждённые данные (нет поля / blocks не массив) не роняют дифф.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiffEngine } from '../../static/js/portal/acts-manager/diff-engine.js';
import { VIOLATION_FIELD_KEYS } from '../../static/js/constructor/violation/violation-fields.js';

/** Нарушение с дефолтными (пустыми выключенными) полями + переопределения. */
function makeViol(over = {}) {
    const viol = { id: 'v1', nodeId: 'n1', fieldOrder: null };
    for (const key of VIOLATION_FIELD_KEYS) {
        viol[key] = { enabled: false, blocks: [] };
    }
    viol.violated = { enabled: true, blocks: [] };
    viol.established = { enabled: true, blocks: [] };
    return { ...viol, ...over };
}

/** Поле с блоками (включённое). */
function field(...blocks) {
    return { enabled: true, blocks };
}

function textBlock(id, content) {
    return { id, type: 'text', content };
}

function imageBlock(id, over = {}) {
    return { id, type: 'image', url: 'u', caption: '', filename: 'p.png', width: 0, ...over };
}

function tableBlock(id, grid, colWidths = []) {
    return { id, type: 'table', table: { grid, colWidths } };
}

/** Сетка из строк-массивов текстов. */
function grid(rows) {
    return rows.map(row => row.map(content => ({ content, isHeader: false, colSpan: 1, rowSpan: 1 })));
}

function diffOne(oldV, newV) {
    return DiffEngine._diffViolations({ v1: oldV }, { v1: newV }).v1;
}

// --- единая форма под-диффа по всем полям реестра ---------------------------

test('под-дифф считается для КАЖДОГО поля реестра одинаково', () => {
    const oldV = makeViol();
    const newV = makeViol();
    for (const key of VIOLATION_FIELD_KEYS) {
        oldV[key] = field(textBlock(`${key}_b1`, 'старый'));
        newV[key] = field(textBlock(`${key}_b1`, 'новый'));
    }
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'modified');
    assert.deepEqual(Object.keys(d.fields).sort(), [...VIOLATION_FIELD_KEYS].sort());
    for (const key of VIOLATION_FIELD_KEYS) {
        assert.equal(d.fields[key].blocks.entries[0].status, 'modified', key);
    }
});

test('поля в дифе идут в порядке отображения новой версии (fieldOrder)', () => {
    const custom = [...VIOLATION_FIELD_KEYS].reverse();
    const oldV = makeViol({ fieldOrder: custom });
    const newV = makeViol({ fieldOrder: custom });
    oldV.reasons = field(textBlock('b1', 'a'));
    newV.reasons = field(textBlock('b1', 'b'));
    oldV.description = field(textBlock('b2', 'a'));
    newV.description = field(textBlock('b2', 'b'));
    const keys = Object.keys(diffOne(oldV, newV).fields);
    // В обратном порядке reasons (позиция 6) идёт ПОСЛЕ description (позиция 2).
    assert.deepEqual(keys, ['reasons', 'description']);
});

test('идентичные нарушения → unchanged, пустой fields, без fieldOrder', () => {
    const v = makeViol({ description: field(textBlock('b1', 'текст')) });
    const d = diffOne(v, JSON.parse(JSON.stringify(v)));
    assert.equal(d.status, 'unchanged');
    assert.deepEqual(d.fields, {});
    assert.equal(d.fieldOrder, undefined);
});

// --- text-блоки -------------------------------------------------------------

test('text-блок: добавление → added', () => {
    const oldV = makeViol({ description: field() });
    const newV = makeViol({ description: field(textBlock('b1', 'новый текст')) });
    const d = diffOne(oldV, newV);
    const entry = d.fields.description.blocks.entries[0];
    assert.equal(entry.status, 'added');
    assert.equal(entry.type, 'text');
    assert.equal(entry.newBlock.id, 'b1');
});

test('text-блок: удаление → removed', () => {
    const oldV = makeViol({ description: field(textBlock('b1', 'был текст')) });
    const newV = makeViol({ description: field() });
    const entry = diffOne(oldV, newV).fields.description.blocks.entries[0];
    assert.equal(entry.status, 'removed');
    assert.equal(entry.oldBlock.id, 'b1');
});

test('text-блок: правка → modified + word-diff по видимому тексту', () => {
    const oldV = makeViol({ reasons: field(textBlock('b1', '<b>старый</b> текст')) });
    const newV = makeViol({ reasons: field(textBlock('b1', '<b>новый</b> текст')) });
    const entry = diffOne(oldV, newV).fields.reasons.blocks.entries[0];
    assert.equal(entry.status, 'modified');
    assert.equal(entry.formattingOnly, false);
    assert.ok(entry.wordDiff.some(p => p.type === 'insert' && p.text === 'новый'));
    assert.ok(entry.wordDiff.some(p => p.type === 'delete' && p.text === 'старый'));
    assert.ok(entry.wordDiff.every(p => !p.text.includes('<')), 'HTML-теги не должны попадать в слова');
});

test('text-блок: правка только формата → formattingOnly=true, wordDiff без вставок/удалений', () => {
    const oldV = makeViol({ reasons: field(textBlock('b1', 'важный текст')) });
    const newV = makeViol({ reasons: field(textBlock('b1', '<b>важный текст</b>')) });
    const entry = diffOne(oldV, newV).fields.reasons.blocks.entries[0];
    assert.equal(entry.status, 'modified');
    assert.equal(entry.formattingOnly, true);
    assert.ok(entry.wordDiff.every(p => p.type === 'equal'));
});

test('text-блоки: перестановка → reordered (и агрегат blocks.reordered)', () => {
    const a = textBlock('b1', 'A');
    const b = textBlock('b2', 'B');
    const oldV = makeViol({ measures: field(a, b) });
    const newV = makeViol({ measures: field(b, a) });
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'modified');
    assert.equal(d.fields.measures.blocks.reordered, true);
    assert.ok(d.fields.measures.blocks.entries.some(e => e.status === 'reordered'));
});

test('text-блоки: неизменившийся блок внутри изменённого поля → unchanged-запись', () => {
    const oldV = makeViol({ measures: field(textBlock('b1', 'A'), textBlock('b2', 'B')) });
    const newV = makeViol({ measures: field(textBlock('b1', 'A'), textBlock('b2', 'B изменён')) });
    const entries = diffOne(oldV, newV).fields.measures.blocks.entries;
    assert.equal(entries[0].status, 'unchanged');
    assert.equal(entries[1].status, 'modified');
});

// --- image-блоки ------------------------------------------------------------

test('image-блок: добавление/удаление по id', () => {
    const oldV = makeViol({ additionalContent: field(imageBlock('i1')) });
    const newV = makeViol({ additionalContent: field(imageBlock('i2')) });
    const entries = diffOne(oldV, newV).fields.additionalContent.blocks.entries;
    const added = entries.find(e => e.status === 'added');
    const removed = entries.find(e => e.status === 'removed');
    assert.equal(added.newBlock.id, 'i2');
    assert.equal(added.type, 'image');
    assert.equal(removed.oldBlock.id, 'i1');
});

test('image-блок: смена url → фиксируется фактом, БЕЗ word-diff', () => {
    const oldV = makeViol({ additionalContent: field(imageBlock('i1', { url: 'data:image/png;base64,AAAA' })) });
    const newV = makeViol({ additionalContent: field(imageBlock('i1', { url: 'data:image/png;base64,BBBB' })) });
    const entry = diffOne(oldV, newV).fields.additionalContent.blocks.entries[0];
    assert.equal(entry.status, 'modified');
    assert.equal(entry.fields.url.old, 'data:image/png;base64,AAAA');
    assert.equal(entry.fields.url.new, 'data:image/png;base64,BBBB');
    assert.equal(entry.fields.url.wordDiff, undefined, 'url не должен нести word-diff');
    assert.equal(entry.wordDiff, undefined, 'image-блок не несёт word-diff на верхнем уровне');
});

test('image-блок: смена ширины и имени файла', () => {
    const oldV = makeViol({ additionalContent: field(imageBlock('i1', { width: 0, filename: 'a.png' })) });
    const newV = makeViol({ additionalContent: field(imageBlock('i1', { width: 60, filename: 'b.png' })) });
    const entry = diffOne(oldV, newV).fields.additionalContent.blocks.entries[0];
    assert.equal(String(entry.fields.width.new), '60');
    assert.equal(entry.fields.filename.new, 'b.png');
    assert.equal(entry.fields.url, undefined, 'url не менялся — поля нет');
});

test('image-блок: смена подписи → word-diff по видимому тексту + formattingOnly', () => {
    const oldV = makeViol({ additionalContent: field(imageBlock('i1', { caption: '<b>старая</b> подпись' })) });
    const newV = makeViol({ additionalContent: field(imageBlock('i1', { caption: '<b>новая</b> подпись' })) });
    const caption = diffOne(oldV, newV).fields.additionalContent.blocks.entries[0].fields.caption;
    assert.equal(caption.old, '<b>старая</b> подпись');
    assert.equal(caption.new, '<b>новая</b> подпись');
    assert.equal(caption.formattingOnly, false);
    assert.ok(caption.wordDiff.some(p => p.type === 'insert' && p.text === 'новая'));
    assert.ok(caption.wordDiff.every(p => !p.text.includes('<')));
});

test('image-блок: правка только формата подписи → formattingOnly=true', () => {
    const oldV = makeViol({ additionalContent: field(imageBlock('i1', { caption: 'подпись' })) });
    const newV = makeViol({ additionalContent: field(imageBlock('i1', { caption: '<b>подпись</b>' })) });
    const caption = diffOne(oldV, newV).fields.additionalContent.blocks.entries[0].fields.caption;
    assert.equal(caption.formattingOnly, true);
    assert.ok(caption.wordDiff.every(p => p.type === 'equal'));
});

// --- table-блоки ------------------------------------------------------------

test('table-блок: изменение ячейки → список изменённых ячеек (row/col/old/new)', () => {
    const oldV = makeViol({ description: field(tableBlock('t1', grid([['a', 'b'], ['c', 'd']]))) });
    const newV = makeViol({ description: field(tableBlock('t1', grid([['a', 'b'], ['c', 'D!']]))) });
    const entry = diffOne(oldV, newV).fields.description.blocks.entries[0];
    assert.equal(entry.status, 'modified');
    assert.equal(entry.type, 'table');
    assert.deepEqual(entry.cells, [{ row: 1, col: 1, old: 'd', new: 'D!' }]);
    assert.equal(entry.gridResized, undefined);
    assert.equal(entry.wordDiff, undefined, 'содержимое ячеек не гоняется через word-diff');
});

test('table-блок: добавление пустой строки → gridResized (изменённых ячеек нет)', () => {
    const oldV = makeViol({ description: field(tableBlock('t1', grid([['a', 'b']]))) });
    const newV = makeViol({ description: field(tableBlock('t1', grid([['a', 'b'], ['', '']]))) });
    const entry = diffOne(oldV, newV).fields.description.blocks.entries[0];
    assert.equal(entry.status, 'modified', 'смена размера сетки — изменение, даже если ячейки пустые');
    assert.deepEqual(entry.cells, []);
    assert.deepEqual(entry.gridResized, { oldRows: 1, oldCols: 2, newRows: 2, newCols: 2 });
});

test('table-блок: одинаковые сетки → unchanged', () => {
    const oldV = makeViol({ description: field(tableBlock('t1', grid([['a']]))) });
    const newV = makeViol({ description: field(tableBlock('t1', grid([['a']]))) });
    assert.equal(diffOne(oldV, newV).status, 'unchanged');
});

test('table-блок: добавление/перестановка работают тем же матчингом по id', () => {
    const t1 = tableBlock('t1', grid([['a']]));
    const t2 = tableBlock('t2', grid([['b']]));
    const oldV = makeViol({ description: field(t1) });
    const newV = makeViol({ description: field(t2, t1) });
    const entries = diffOne(oldV, newV).fields.description.blocks.entries;
    assert.equal(entries[0].status, 'added');
    assert.equal(entries[0].newBlock.id, 't2');
    assert.equal(entries[1].status, 'unchanged', 't1 один в общей последовательности — перестановки нет');
});

// --- enabled поля -----------------------------------------------------------

test('enabled: включение поля → диффа поля с enabled {old:false,new:true}', () => {
    const oldV = makeViol({ reasons: { enabled: false, blocks: [] } });
    const newV = makeViol({ reasons: { enabled: true, blocks: [] } });
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'modified');
    assert.deepEqual(d.fields.reasons.enabled, { old: false, new: true, changed: true });
    assert.equal(d.fields.reasons.blocks, undefined, 'блоков нет — секции blocks тоже нет');
});

test('enabled: выключение поля при тех же блоках → блоки removed + enabled', () => {
    const blocks = [textBlock('b1', 'причина')];
    const oldV = makeViol({ reasons: { enabled: true, blocks } });
    const newV = makeViol({ reasons: { enabled: false, blocks } });
    const d = diffOne(oldV, newV);
    assert.equal(d.fields.reasons.enabled.new, false);
    assert.ok(d.fields.reasons.blocks.entries.every(e => e.status === 'removed'));
});

test('enabled: выключено в обеих версиях при тех же блоках → без изменений', () => {
    const blocks = [textBlock('b1', 'скрытая причина')];
    const oldV = makeViol({ reasons: { enabled: false, blocks } });
    const newV = makeViol({ reasons: { enabled: false, blocks: [...blocks, textBlock('b2', 'ещё')] } });
    assert.equal(diffOne(oldV, newV).status, 'unchanged');
});

// --- fieldOrder -------------------------------------------------------------

test('fieldOrder: смена порядка → {old, new} массивами ключей', () => {
    const custom = [...VIOLATION_FIELD_KEYS].reverse();
    const oldV = makeViol();
    const newV = makeViol({ fieldOrder: custom });
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'modified');
    assert.deepEqual(d.fieldOrder.old, [...VIOLATION_FIELD_KEYS]);
    assert.deepEqual(d.fieldOrder.new, custom);
});

test('fieldOrder: null и явный стандартный порядок — один и тот же вид, не изменение', () => {
    const oldV = makeViol({ fieldOrder: null });
    const newV = makeViol({ fieldOrder: [...VIOLATION_FIELD_KEYS] });
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'unchanged');
    assert.equal(d.fieldOrder, undefined);
});

test('fieldOrder: невалидный порядок игнорируется (разворачивается в стандартный)', () => {
    const oldV = makeViol({ fieldOrder: ['reasons', 'reasons'] });
    const newV = makeViol({ fieldOrder: null });
    assert.equal(diffOne(oldV, newV).status, 'unchanged');
});

// --- added / removed нарушение целиком --------------------------------------

test('добавленное нарушение → все блоки включённых полей как added', () => {
    const newV = makeViol({
        violated: field(textBlock('b1', 'нарушено')),
        additionalContent: field(imageBlock('i1', { caption: 'фото' })),
    });
    const d = diffOne(undefined, newV);
    assert.equal(d.status, 'added');
    assert.equal(d.newData, newV);
    assert.equal(d.fields.violated.blocks.entries[0].status, 'added');
    assert.equal(d.fields.additionalContent.blocks.entries[0].status, 'added');
    assert.equal(d.fields.additionalContent.blocks.entries[0].type, 'image');
});

test('удалённое нарушение → все блоки как removed', () => {
    const oldV = makeViol({ established: field(tableBlock('t1', grid([['x']]))) });
    const d = diffOne(oldV, undefined);
    assert.equal(d.status, 'removed');
    assert.equal(d.oldData, oldV);
    assert.equal(d.fields.established.blocks.entries[0].status, 'removed');
    assert.equal(d.fields.established.blocks.entries[0].type, 'table');
});

test('добавленное нарушение без содержимого → секций blocks нет', () => {
    const d = diffOne(undefined, makeViol());
    assert.equal(d.status, 'added');
    for (const fieldDiff of Object.values(d.fields)) {
        assert.equal(fieldDiff.blocks, undefined);
    }
});

// --- перф-гвард -------------------------------------------------------------

test('перф-гвард: text-блок с 3 МБ base64-подобной строкой НЕ идёт через _wordDiff', () => {
    const bigA = 'data:image/png;base64,' + 'A'.repeat(3_000_000);
    const bigB = 'data:image/png;base64,' + 'B'.repeat(3_000_000);
    const oldV = makeViol({ description: field(textBlock('b1', bigA)) });
    const newV = makeViol({ description: field(textBlock('b1', bigB)) });

    const orig = DiffEngine._wordDiff;
    DiffEngine._wordDiff = () => { throw new Error('_wordDiff вызван на крупном блоке'); };
    try {
        const start = Date.now();
        const entry = diffOne(oldV, newV).fields.description.blocks.entries[0];
        assert.equal(entry.status, 'modified');
        assert.equal(entry.oversized, true, 'крупный блок помечен oversized');
        assert.equal(entry.wordDiff, null);
        assert.ok(Date.now() - start < 1000, 'сравнение должно быть мгновенным');
    } finally {
        DiffEngine._wordDiff = orig;
    }
});

test('перф-гвард: огромный base64-url картинки НЕ идёт через _wordDiff', () => {
    const bigA = 'data:image/png;base64,' + 'A'.repeat(3_000_000);
    const bigB = 'data:image/png;base64,' + 'B'.repeat(3_000_000);
    const oldV = makeViol({ additionalContent: field(imageBlock('i1', { url: bigA })) });
    const newV = makeViol({ additionalContent: field(imageBlock('i1', { url: bigB })) });

    const orig = DiffEngine._wordDiff;
    DiffEngine._wordDiff = () => { throw new Error('_wordDiff вызван на url картинки'); };
    try {
        const start = Date.now();
        const entry = diffOne(oldV, newV).fields.additionalContent.blocks.entries[0];
        assert.equal(entry.status, 'modified');
        assert.ok(entry.fields.url, 'url помечен как изменённый');
        assert.ok(Date.now() - start < 1000, 'сравнение url должно быть мгновенным');
    } finally {
        DiffEngine._wordDiff = orig;
    }
});

// --- устойчивость к повреждённым данным -------------------------------------

test('поля нет в старой версии → блоки новой версии как added, без исключений', () => {
    const oldV = makeViol();
    delete oldV.reasons;
    const newV = makeViol({ reasons: field(textBlock('b1', 'причина')) });
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'modified');
    assert.equal(d.fields.reasons.blocks.entries[0].status, 'added');
});

test('поле не объект / blocks не массив → дифф не падает', () => {
    const oldV = makeViol({ reasons: 'легаси-строка' });
    const newV = makeViol({ reasons: { enabled: true, blocks: null } });
    assert.doesNotThrow(() => diffOne(oldV, newV));
    const d = diffOne(oldV, newV);
    assert.equal(d.fields.reasons.enabled.new, true);
    assert.equal(d.fields.reasons.blocks, undefined);
});

test('блок без id → всегда added/removed (матчить нечем)', () => {
    const oldV = makeViol({ description: field({ type: 'text', content: 'без id' }) });
    const newV = makeViol({ description: field({ type: 'text', content: 'без id' }) });
    const entries = diffOne(oldV, newV).fields.description.blocks.entries;
    assert.deepEqual(entries.map(e => e.status), ['added', 'removed']);
});

test('смена типа блока при том же id → modified с typeChanged', () => {
    const oldV = makeViol({ description: field(textBlock('b1', 'текст')) });
    const newV = makeViol({ description: field(imageBlock('b1')) });
    const entry = diffOne(oldV, newV).fields.description.blocks.entries[0];
    assert.equal(entry.status, 'modified');
    assert.equal(entry.typeChanged, true);
    assert.equal(entry.type, 'image');
});
