/**
 * Тесты расширенного диффа нарушений (#8, вариант А): список описаний
 * (descriptionList), доп.контент (additionalContent) и флаги enabled
 * опциональных текстовых полей.
 *
 * Раньше `_diffViolations` перебирал только 6 скалярных полей, а
 * descriptionList/additionalContent проходили бесследно («без изменений»).
 * Теперь движок строит структурные под-диффы:
 *   - descriptionList — пер-элементный diff по позиции (added/removed/modified,
 *     modified → word-diff);
 *   - additionalContent — матчинг по item.id (added/removed/modified/reordered),
 *     case/freeText → word-diff по content, image → строковое сравнение
 *     url/caption/filename/width (base64-url НЕ гоняется через word-diff);
 *   - enabled опц.поля канонизируется как '' → выключение поля при том же
 *     content видно как изменение.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiffEngine } from '../../static/js/portal/acts-manager/diff-engine.js';
import { VIOLATION_SCALAR_RICH_KEYS } from '../../static/js/constructor/violation/violation-fields.js';

function makeViol(over = {}) {
    return {
        id: 'v1',
        violated: '',
        established: '',
        descriptionList: { enabled: false, items: [] },
        additionalContent: { enabled: false, items: [] },
        reasons: { enabled: false, content: '' },
        consequences: { enabled: false, content: '' },
        responsible: { enabled: false, content: '' },
        measures: { enabled: false, content: '' },
        ...over,
    };
}

function diffOne(oldV, newV) {
    return DiffEngine._diffViolations({ v1: oldV }, { v1: newV }).v1;
}

// --- §5.7: dedup списка полей — движок использует общий реестр ---------------
// Раньше _diffViolations хранил свою копию списка из 6 ключей, зеркалом
// diff-renderer._renderDiffViolation держал вторую. По образцу
// invoice-diff-fields.test.mjs — движок обязан перебирать именно
// VIOLATION_SCALAR_RICH_KEYS, а не литерал.

test('DiffEngine._diffViolations перебирает скалярные поля именно из VIOLATION_SCALAR_RICH_KEYS', () => {
    const oldV = makeViol();
    const newV = makeViol();
    for (const key of VIOLATION_SCALAR_RICH_KEYS) {
        oldV[key] = { enabled: true, content: 'old' };
        newV[key] = { enabled: true, content: 'new' };
    }
    const d = diffOne(oldV, newV);
    const changedFields = Object.keys(d.fieldDiffs).filter(k => VIOLATION_SCALAR_RICH_KEYS.includes(k));
    assert.deepEqual(changedFields.sort(), [...VIOLATION_SCALAR_RICH_KEYS].sort());
});

// --- descriptionList --------------------------------------------------------

test('descriptionList: изменение пункта → modified + word-diff по позиции', () => {
    const oldV = makeViol({ descriptionList: { enabled: true, items: ['первый пункт', 'второй пункт'] } });
    const newV = makeViol({ descriptionList: { enabled: true, items: ['первый пункт изменён', 'второй пункт'] } });
    const d = diffOne(oldV, newV);

    assert.equal(d.status, 'modified');
    const dl = d.fieldDiffs.descriptionList;
    assert.equal(dl.kind, 'list');
    assert.equal(dl.changed, true);
    assert.equal(dl.items[0].status, 'modified');
    assert.ok(Array.isArray(dl.items[0].wordDiff));
    assert.equal(dl.items[1].status, 'unchanged');
});

test('descriptionList: добавление пункта → added', () => {
    const oldV = makeViol({ descriptionList: { enabled: true, items: ['a'] } });
    const newV = makeViol({ descriptionList: { enabled: true, items: ['a', 'b'] } });
    const dl = diffOne(oldV, newV).fieldDiffs.descriptionList;
    assert.equal(dl.items[0].status, 'unchanged');
    assert.equal(dl.items[1].status, 'added');
    assert.equal(dl.items[1].new, 'b');
});

test('descriptionList: удаление пункта → removed', () => {
    const oldV = makeViol({ descriptionList: { enabled: true, items: ['a', 'b'] } });
    const newV = makeViol({ descriptionList: { enabled: true, items: ['a'] } });
    const dl = diffOne(oldV, newV).fieldDiffs.descriptionList;
    assert.equal(dl.items[0].status, 'unchanged');
    assert.equal(dl.items[1].status, 'removed');
    assert.equal(dl.items[1].old, 'b');
});

test('descriptionList: выключение списка при тех же items → items removed', () => {
    const oldV = makeViol({ descriptionList: { enabled: true, items: ['a', 'b'] } });
    const newV = makeViol({ descriptionList: { enabled: false, items: ['a', 'b'] } });
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'modified');
    const dl = d.fieldDiffs.descriptionList;
    assert.equal(dl.changed, true);
    assert.ok(dl.items.every(it => it.status === 'removed'));
});

test('descriptionList: выключенный список в обеих версиях → без изменений', () => {
    const oldV = makeViol({ descriptionList: { enabled: false, items: ['a'] } });
    const newV = makeViol({ descriptionList: { enabled: false, items: ['a', 'b', 'c'] } });
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'unchanged');
    assert.equal(d.fieldDiffs.descriptionList, undefined);
});

// --- Task 7: пункт descriptionList — rich-поле, word-diff по видимому тексту
// (зеркало case/freeText выше), а не по сырому HTML.

test('descriptionList: изменение пункта — word-diff по видимому тексту (HTML-теги не попадают в слова)', () => {
    const oldV = makeViol({ descriptionList: { enabled: true, items: ['<b>старый</b> пункт'] } });
    const newV = makeViol({ descriptionList: { enabled: true, items: ['<b>новый</b> пункт'] } });
    const item = diffOne(oldV, newV).fieldDiffs.descriptionList.items[0];
    assert.equal(item.status, 'modified');
    assert.ok(item.wordDiff.some(p => p.type === 'insert' && p.text === 'новый'));
    assert.ok(item.wordDiff.some(p => p.type === 'delete' && p.text === 'старый'));
    assert.ok(item.wordDiff.every(p => !p.text.includes('<')), 'HTML-теги не должны попадать в текст word-diff частей');
    // old/new сохранены сырыми (рендерер решает, показывать их напрямую или нет).
    assert.equal(item.old, '<b>старый</b> пункт');
    assert.equal(item.new, '<b>новый</b> пункт');
});

test('descriptionList: правка только формата пункта → formattingOnly=true, wordDiff без вставок/удалений', () => {
    const oldV = makeViol({ descriptionList: { enabled: true, items: ['пункт'] } });
    const newV = makeViol({ descriptionList: { enabled: true, items: ['<b>пункт</b>'] } });
    const item = diffOne(oldV, newV).fieldDiffs.descriptionList.items[0];
    assert.equal(item.formattingOnly, true);
    assert.ok(item.wordDiff.every(p => p.type === 'equal'));
});

test('descriptionList: правка текста пункта → formattingOnly=false', () => {
    const oldV = makeViol({ descriptionList: { enabled: true, items: ['<b>старый</b> пункт'] } });
    const newV = makeViol({ descriptionList: { enabled: true, items: ['<b>новый</b> пункт'] } });
    const item = diffOne(oldV, newV).fieldDiffs.descriptionList.items[0];
    assert.equal(item.formattingOnly, false);
});

// --- additionalContent: case / freeText -------------------------------------

test('additionalContent: изменение кейса → modified + word-diff', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case', content: 'старый кейс' }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case', content: 'новый кейс' }] } });
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'modified');
    const ac = d.fieldDiffs.additionalContent;
    assert.equal(ac.kind, 'additional');
    assert.equal(ac.entries[0].status, 'modified');
    assert.ok(Array.isArray(ac.entries[0].wordDiff));
});

test('additionalContent: добавление кейса → added, удаление → removed', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case', content: 'A' }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'c2', type: 'case', content: 'B' }] } });
    const ac = diffOne(oldV, newV).fieldDiffs.additionalContent;
    const added = ac.entries.find(e => e.status === 'added');
    const removed = ac.entries.find(e => e.status === 'removed');
    assert.equal(added.newItem.id, 'c2');
    assert.equal(removed.oldItem.id, 'c1');
});

test('additionalContent: перестановка кейсов → reordered', () => {
    const items = [
        { id: 'c1', type: 'case', content: 'A' },
        { id: 'c2', type: 'case', content: 'B' },
    ];
    const oldV = makeViol({ additionalContent: { enabled: true, items } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [items[1], items[0]] } });
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'modified');
    const ac = d.fieldDiffs.additionalContent;
    assert.ok(ac.entries.some(e => e.status === 'reordered'));
});

// --- additionalContent: image -----------------------------------------------

test('additionalContent: добавление картинки → added', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'data:image/png;base64,AAAA', caption: 'подпись', filename: 'p.png', width: 50 }] } });
    const ac = diffOne(oldV, newV).fieldDiffs.additionalContent;
    assert.equal(ac.entries[0].status, 'added');
    assert.equal(ac.entries[0].newItem.id, 'i1');
});

test('additionalContent: смена url картинки → modified, поле url в fields, БЕЗ word-diff', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'data:image/png;base64,AAAA', caption: 'c', filename: 'p.png', width: 0 }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'data:image/png;base64,BBBB', caption: 'c', filename: 'p.png', width: 0 }] } });
    const ac = diffOne(oldV, newV).fieldDiffs.additionalContent;
    const e = ac.entries[0];
    assert.equal(e.status, 'modified');
    assert.ok(e.fields.url);
    assert.equal(e.fields.url.old, 'data:image/png;base64,AAAA');
    assert.equal(e.fields.url.new, 'data:image/png;base64,BBBB');
    assert.equal(e.wordDiff, undefined, 'image-diff НЕ должен нести word-diff');
});

test('additionalContent: смена подписи/ширины картинки → соответствующие fields', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'u', caption: 'старая', filename: 'p.png', width: 0 }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'u', caption: 'новая', filename: 'p.png', width: 60 }] } });
    const e = diffOne(oldV, newV).fieldDiffs.additionalContent.entries[0];
    assert.equal(e.status, 'modified');
    assert.equal(e.fields.caption.old, 'старая');
    assert.equal(e.fields.caption.new, 'новая');
    assert.equal(String(e.fields.width.new), '60');
    assert.equal(e.fields.url, undefined);
});

// --- Task 6: caption картинки — rich-поле, word-diff по видимому тексту
// (зеркало case/freeText выше), а не строковое сравнение как у filename/width.

test('additionalContent: caption картинки — word-diff по видимому тексту (HTML-теги не попадают в слова)', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'u', caption: '<b>старая</b> подпись', filename: 'p.png', width: 0 }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'u', caption: '<b>новая</b> подпись', filename: 'p.png', width: 0 }] } });
    const e = diffOne(oldV, newV).fieldDiffs.additionalContent.entries[0];
    assert.equal(e.status, 'modified');
    const wd = e.fields.caption.wordDiff;
    assert.ok(wd.some(p => p.type === 'insert' && p.text === 'новая'));
    assert.ok(wd.some(p => p.type === 'delete' && p.text === 'старая'));
    assert.ok(wd.every(p => !p.text.includes('<')), 'HTML-теги не должны попадать в текст word-diff частей');
    // old/new сохранены сырыми (рендерер решает, показывать их напрямую или нет).
    assert.equal(e.fields.caption.old, '<b>старая</b> подпись');
    assert.equal(e.fields.caption.new, '<b>новая</b> подпись');
});

test('additionalContent: caption картинки — правка только формата → formattingOnly=true, wordDiff без вставок/удалений', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'u', caption: 'подпись', filename: 'p.png', width: 0 }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'u', caption: '<b>подпись</b>', filename: 'p.png', width: 0 }] } });
    const e = diffOne(oldV, newV).fieldDiffs.additionalContent.entries[0];
    assert.equal(e.status, 'modified');
    assert.equal(e.fields.caption.formattingOnly, true);
    assert.ok(e.fields.caption.wordDiff.every(p => p.type === 'equal'));
});

test('additionalContent: caption картинки — правка текста → formattingOnly=false', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'u', caption: '<b>старая</b>', filename: 'p.png', width: 0 }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'u', caption: '<b>новая</b>', filename: 'p.png', width: 0 }] } });
    const e = diffOne(oldV, newV).fieldDiffs.additionalContent.entries[0];
    assert.equal(e.fields.caption.formattingOnly, false);
});

test('additionalContent: caption картинки без изменений — fields.caption не выставляется', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'u', caption: 'та же', filename: 'p.png', width: 0 }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'u', caption: 'та же', filename: 'p.png', width: 60 }] } });
    const e = diffOne(oldV, newV).fieldDiffs.additionalContent.entries[0];
    assert.equal(e.status, 'modified', 'width изменился — элемент изменён');
    assert.equal(e.fields.caption, undefined, 'caption не менялась — поля caption в fields нет');
});

test('additionalContent: огромный base64-url НЕ гоняется через _wordDiff (строковое сравнение, без зависания)', () => {
    const bigA = 'data:image/png;base64,' + 'A'.repeat(3_000_000);
    const bigB = 'data:image/png;base64,' + 'B'.repeat(3_000_000);
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: bigA, caption: '', filename: 'p.png', width: 0 }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: bigB, caption: '', filename: 'p.png', width: 0 }] } });

    const orig = DiffEngine._wordDiff;
    DiffEngine._wordDiff = () => { throw new Error('_wordDiff вызван на url картинки'); };
    try {
        const start = Date.now();
        const e = diffOne(oldV, newV).fieldDiffs.additionalContent.entries[0];
        assert.equal(e.status, 'modified');
        assert.ok(e.fields.url, 'url помечен как изменённый');
        assert.ok(Date.now() - start < 1000, 'сравнение url должно быть мгновенным');
    } finally {
        DiffEngine._wordDiff = orig;
    }
});

// --- enabled опц.полей ------------------------------------------------------

test('опц.поле: выключение при том же content → изменение (канонизация в пустое)', () => {
    const oldV = makeViol({ reasons: { enabled: true, content: 'причина' } });
    const newV = makeViol({ reasons: { enabled: false, content: 'причина' } });
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'modified');
    assert.equal(d.fieldDiffs.reasons.changed, true);
    assert.equal(d.fieldDiffs.reasons.old, 'причина');
    assert.equal(d.fieldDiffs.reasons.new, '');
});

test('опц.поле: включение поля → изменение', () => {
    const oldV = makeViol({ consequences: { enabled: false, content: 'текст' } });
    const newV = makeViol({ consequences: { enabled: true, content: 'текст' } });
    const d = diffOne(oldV, newV);
    assert.equal(d.fieldDiffs.consequences.old, '');
    assert.equal(d.fieldDiffs.consequences.new, 'текст');
});

test('опц.поле: выключено в обеих версиях при том же content → без изменений', () => {
    const oldV = makeViol({ responsible: { enabled: false, content: 'кто-то' } });
    const newV = makeViol({ responsible: { enabled: false, content: 'кто-то' } });
    assert.equal(diffOne(oldV, newV).status, 'unchanged');
});

// --- нет изменений ----------------------------------------------------------

test('идентичные нарушения → unchanged, пустой fieldDiffs', () => {
    const v = makeViol({
        violated: 'x',
        descriptionList: { enabled: true, items: ['a'] },
        additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case', content: 'k' }] },
    });
    const d = diffOne(v, JSON.parse(JSON.stringify(v)));
    assert.equal(d.status, 'unchanged');
    assert.deepEqual(d.fieldDiffs, {});
});

// --- #6: целиком добавленное/удалённое нарушение несёт descriptionList/additionalContent ---
// Раньше added/removed-ветки возвращали только {status, newData}/{status, oldData}
// без fieldDiffs — рендер (гейт по fieldDiffs?.descriptionList/.additionalContent)
// не показывал список описаний и доп.контент целиком нового/удалённого нарушения.

test('добавленное нарушение с descriptionList и additionalContent → fieldDiffs несёт оба под-диффа', () => {
    const newV = makeViol({
        descriptionList: { enabled: true, items: ['пункт а', 'пункт б'] },
        additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case', content: 'кейс' }] },
    });
    const d = diffOne(undefined, newV);
    assert.equal(d.status, 'added');
    assert.equal(d.newData, newV);

    const dl = d.fieldDiffs.descriptionList;
    assert.ok(dl, 'descriptionList должен присутствовать в fieldDiffs добавленного нарушения');
    assert.equal(dl.changed, true);
    assert.equal(dl.items[0].status, 'added');
    assert.equal(dl.items[0].new, 'пункт а');

    const ac = d.fieldDiffs.additionalContent;
    assert.ok(ac, 'additionalContent должен присутствовать в fieldDiffs добавленного нарушения');
    assert.equal(ac.changed, true);
    assert.equal(ac.entries[0].status, 'added');
    assert.equal(ac.entries[0].newItem.id, 'c1');
});

test('удалённое нарушение с descriptionList и additionalContent → fieldDiffs несёт оба под-диффа', () => {
    const oldV = makeViol({
        descriptionList: { enabled: true, items: ['пункт а'] },
        additionalContent: { enabled: true, items: [{ id: 'i1', type: 'image', url: 'u', caption: '', filename: 'p.png', width: 0 }] },
    });
    const d = diffOne(oldV, undefined);
    assert.equal(d.status, 'removed');
    assert.equal(d.oldData, oldV);

    const dl = d.fieldDiffs.descriptionList;
    assert.ok(dl, 'descriptionList должен присутствовать в fieldDiffs удалённого нарушения');
    assert.equal(dl.changed, true);
    assert.equal(dl.items[0].status, 'removed');
    assert.equal(dl.items[0].old, 'пункт а');

    const ac = d.fieldDiffs.additionalContent;
    assert.ok(ac, 'additionalContent должен присутствовать в fieldDiffs удалённого нарушения');
    assert.equal(ac.changed, true);
    assert.equal(ac.entries[0].status, 'removed');
    assert.equal(ac.entries[0].oldItem.id, 'i1');
});

test('добавленное нарушение с выключенными descriptionList/additionalContent → fieldDiffs их не несёт (changed=false)', () => {
    const newV = makeViol();
    const d = diffOne(undefined, newV);
    assert.equal(d.status, 'added');
    assert.equal(d.fieldDiffs.descriptionList, undefined);
    assert.equal(d.fieldDiffs.additionalContent, undefined);
});

// --- #1.1.5: word-diff по видимому тексту для скалярных rich-полей ---------
// Rich-поля нарушения (violated/established/reasons/measures/consequences/
// responsible) со временем станут rich-HTML (rich-редактор — в планах). Раньше
// fieldDiffs[field] нёс только {old, new, changed} — сырой HTML/текст без
// word-diff. Теперь, зеркало _diffTextBlocks (:281-291): при различии считаем
// wordDiff/formattingOnly по _stripHtml, сохраняя old/new/changed как раньше.

test('rich-поле: правка только форматирования → formattingOnly=true, wordDiff без вставок/удалений', () => {
    // Адаптация примера из брифа: _wordDiff на РАВНЫХ (после _stripHtml) строках
    // возвращает не пустой массив, а один сгруппированный op {type:'equal'}
    // (см. diff-engine-textblock-format.test.mjs) — проверяем отсутствие
    // insert/delete-частей, а не пустоту массива.
    const oldV = makeViol({ reasons: { enabled: true, content: 'важный текст' } });
    const newV = makeViol({ reasons: { enabled: true, content: '<b>важный текст</b>' } });
    const d = diffOne(oldV, newV);
    assert.equal(d.status, 'modified');
    assert.equal(d.fieldDiffs.reasons.formattingOnly, true);
    assert.ok(d.fieldDiffs.reasons.wordDiff.every(p => p.type === 'equal'));
});

test('rich-поле: правка текста → word-diff по видимому тексту, formattingOnly=false', () => {
    const oldV = makeViol({ reasons: { enabled: true, content: '<b>старый</b> текст' } });
    const newV = makeViol({ reasons: { enabled: true, content: '<b>новый</b> текст' } });
    const d = diffOne(oldV, newV);
    assert.equal(d.fieldDiffs.reasons.formattingOnly, false);
    assert.ok(d.fieldDiffs.reasons.wordDiff.some(p => p.type === 'insert' && p.text.includes('новый')));
});

test('rich-поле: old/new/changed сохраняются нетронутыми (сырой HTML), wordDiff/formattingOnly — новые поля', () => {
    const oldV = makeViol({ violated: 'старый <i>текст</i>' });
    const newV = makeViol({ violated: 'новый <i>текст</i>' });
    const fd = diffOne(oldV, newV).fieldDiffs.violated;
    assert.equal(fd.old, 'старый <i>текст</i>');
    assert.equal(fd.new, 'новый <i>текст</i>');
    assert.equal(fd.changed, true);
});

test('additionalContent case/freeText: word-diff по видимому тексту (HTML-теги не попадают в слова)', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case', content: '<b>старый</b> кейс' }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case', content: '<b>новый</b> кейс' }] } });
    const wd = diffOne(oldV, newV).fieldDiffs.additionalContent.entries[0].wordDiff;
    assert.ok(wd.some(p => p.type === 'insert' && p.text === 'новый'));
    assert.ok(wd.some(p => p.type === 'delete' && p.text === 'старый'));
    assert.ok(wd.every(p => !p.text.includes('<')), 'HTML-теги не должны попадать в текст word-diff частей');
});

// --- Review Round 2: formattingOnly для case/freeText (паритет со скалярными
// полями). Раньше правка ТОЛЬКО форматирования кейса/свободного текста дала бы
// modified с all-equal word-diff и без явного сигнала — несогласованно с
// формализмом скалярных полей выше. По образцу тестов rich-поля.

test('additionalContent case/freeText: правка только формата → formattingOnly=true, wordDiff без вставок/удалений', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case', content: 'кейс' }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case', content: '<b>кейс</b>' }] } });
    const entry = diffOne(oldV, newV).fieldDiffs.additionalContent.entries[0];
    assert.equal(entry.formattingOnly, true);
    assert.ok(entry.wordDiff.every(p => p.type === 'equal'));
});

test('additionalContent case/freeText: правка текста → formattingOnly=false', () => {
    const oldV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case', content: '<b>старый</b> кейс' }] } });
    const newV = makeViol({ additionalContent: { enabled: true, items: [{ id: 'c1', type: 'case', content: '<b>новый</b> кейс' }] } });
    const entry = diffOne(oldV, newV).fieldDiffs.additionalContent.entries[0];
    assert.equal(entry.formattingOnly, false);
});
