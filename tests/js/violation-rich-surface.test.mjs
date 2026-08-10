/**
 * Тесты ViolationBlockSurface — поверхности rich-текста блока нарушения
 * (блочная модель) по контракту EditableSurface (editable-surface.js).
 *
 * Два режима записи в модель (см. EditorController, editor-controller.js):
 *  - setContent(html) — модель → element, С ре-рендером (внешняя запись:
 *    формализатор, корректор);
 *  - commit() — element → модель, БЕЗ ре-рендера (обычный ввод, каретка жива).
 * setBlockField замокан спаем на инстансе ViolationManager — интересует
 * ТОЛЬКО путь записи (какое поле/блок/атрибут, какое значение), не логика
 * мутатора (та проверена в violation-mutations.test.mjs).
 *
 * Реальные модули конструктора импортируются под node:test через
 * _browser-stub (см. конвенцию в _browser-stub.mjs).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Входная точка графа нарушений — как в entries/constructor.js: violation-init
// разруливает циклические импорты (core ↔ расширения прототипа) и мешает
// _makeBlockSurface в прототип ViolationManager.
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';

function makeContext() {
    const vm = new ViolationManager();
    const block = { id: 'text_1_a', type: 'text', content: '' };
    const image = { id: 'image_1_b', type: 'image', url: '', caption: '', filename: '', width: 0 };
    const violation = {
        id: 'v1',
        violated: { enabled: true, blocks: [block] },
        additionalContent: { enabled: true, blocks: [image] },
    };
    return { vm, violation, block, image };
}

test('_makeBlockSurface: id/kind/rich контракта EditableSurface', () => {
    const { vm, violation, block } = makeContext();

    const s = vm._makeBlockSurface(violation, 'violated', block);

    assert.equal(s.id, 'viol:v1:violated:block:text_1_a');
    assert.equal(s.kind, 'violationField');
    assert.equal(s.rich, true);
});

test('_makeBlockSurface: id для подписи картинки несёт суффикс :caption', () => {
    const { vm, violation, image } = makeContext();

    const s = vm._makeBlockSurface(violation, 'additionalContent', image, 'caption');

    assert.equal(s.id, 'viol:v1:additionalContent:block:image_1_b:caption');
});

test('getContent: читает content текст-блока и caption картинки', () => {
    const { vm, violation, block, image } = makeContext();
    block.content = 'текст';
    image.caption = 'подпись';

    assert.equal(vm._makeBlockSurface(violation, 'violated', block).getContent(), 'текст');
    assert.equal(
        vm._makeBlockSurface(violation, 'additionalContent', image, 'caption').getContent(),
        'подпись',
    );
});

test('запись через реальный мутатор: setBlockField пишет в правильный блок', () => {
    const { vm, violation, block } = makeContext();

    vm.setBlockField(violation, 'violated', block.id, 'content', '<b>x</b>');

    assert.equal(block.content, '<b>x</b>', 'запись ушла в блок по стабильному id');
    assert.equal(
        vm._makeBlockSurface(violation, 'violated', block).getContent(), '<b>x</b>',
        'чтение через ту же адресацию видит записанное значение',
    );
});

test('setContent → setBlockField (content текст-блока и caption картинки)', () => {
    const { vm, violation, block, image } = makeContext();
    const calls = [];
    vm.setBlockField = (v, key, blockId, attr, val) => { calls.push({ key, blockId, attr, val }); return true; };

    vm._makeBlockSurface(violation, 'violated', block).setContent('<b>x</b>');
    vm._makeBlockSurface(violation, 'additionalContent', image, 'caption').setContent('<i>y</i>');

    assert.deepEqual(calls, [
        { key: 'violated', blockId: 'text_1_a', attr: 'content', val: '<b>x</b>' },
        { key: 'additionalContent', blockId: 'image_1_b', attr: 'caption', val: '<i>y</i>' },
    ]);
});

test('commit → element.innerHTML в модель БЕЗ ре-рендера', () => {
    const { vm, violation, block } = makeContext();
    const calls = [];
    vm.setBlockField = (v, key, blockId, attr, val) => { calls.push({ attr, val }); return true; };
    const s = vm._makeBlockSurface(violation, 'violated', block);

    s.element = { innerHTML: '<b>исправлено</b>' };
    s.commit();

    assert.deepEqual(calls, [{ attr: 'content', val: '<b>исправлено</b>' }]);
});

test('persist → делегирует в commit', () => {
    const { vm, violation, block } = makeContext();
    const calls = [];
    vm.setBlockField = (v, key, blockId, attr, val) => { calls.push(val); return true; };
    const s = vm._makeBlockSurface(violation, 'violated', block);

    s.element = { innerHTML: '<b>x</b>' };
    s.persist();

    assert.deepEqual(calls, ['<b>x</b>']);
});

// ── Guard-strip + repair перед записью в модель ───────────────────────────────

test('commit: снимает caret-guard\'ы (U+FEFF) из element.innerHTML перед записью в модель', () => {
    const { vm, violation, block } = makeContext();
    const calls = [];
    vm.setBlockField = (v, key, blockId, attr, val) => { calls.push(val); return true; };
    const s = vm._makeBlockSurface(violation, 'violated', block);
    const guard = String.fromCharCode(0xFEFF);

    const origStrip = textBlockManager._stripGuards;
    textBlockManager._stripGuards = (html) => html.split(guard).join('');
    try {
        s.element = { innerHTML: `${guard}<b>x</b>${guard}` };
        s.commit();
        assert.deepEqual(calls, ['<b>x</b>'], 'guard-символы вычищены до записи в модель');
    } finally {
        textBlockManager._stripGuards = origStrip;
    }
});

test('setContent: чистый html (без guard\'ов) — ровно ОДНА запись в модель (repair — identity)', () => {
    const { vm, violation, block } = makeContext();
    const calls = [];
    vm.setBlockField = (v, key, blockId, attr, val) => { calls.push(val); return true; };
    const s = vm._makeBlockSurface(violation, 'violated', block);

    s.setContent('<b>чистый текст</b>');

    assert.deepEqual(calls, ['<b>чистый текст</b>']);
});

// ── Hardening капсул при внешней записи (setContent) ──────────────────────────

test('setContent: normalizeMarkers + tooltip вызваны на element', () => {
    const { vm, violation, block } = makeContext();
    vm.setBlockField = () => true;
    const s = vm._makeBlockSurface(violation, 'violated', block);
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
// «строка не изменилась» — модель обязана получать report.html БЕЗУСЛОВНО,
// независимо от changed (см. докстринг _repairCapsuleHtml).
test('setContent: changed=false (только косметика) — модель ВСЕ РАВНО получает report.html, ОДНИМ вызовом', () => {
    const { vm, violation, block } = makeContext();
    const calls = [];
    vm.setBlockField = (v, key, blockId, attr, val) => { calls.push(val); return true; };
    const s = vm._makeBlockSurface(violation, 'violated', block);

    const origReport = textBlockManager._repairCapsulesReport;
    textBlockManager._repairCapsulesReport = () => ({ html: '<span class="text-link">x</span>', changed: false });
    try {
        const guard = String.fromCharCode(0xFEFF);
        s.setContent(`${guard}<span class="text-link" contenteditable="true">x</span>${guard}`);
        assert.deepEqual(calls, ['<span class="text-link">x</span>'],
            'модель получает report.html ОДНИМ вызовом независимо от changed');
    } finally {
        textBlockManager._repairCapsulesReport = origReport;
    }
});

test('setContent: changed=false — DOM без повторного ре-рендера (первый рендер — переданным html)', () => {
    const { vm, violation, block } = makeContext();
    vm.setBlockField = () => true;
    const s = vm._makeBlockSurface(violation, 'violated', block);
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

test('setContent: changed=true — DOM получает повторный ре-рендер репаренным значением', () => {
    const { vm, violation, block } = makeContext();
    vm.setBlockField = () => true;
    const s = vm._makeBlockSurface(violation, 'violated', block);
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

// ── #12 (основа): нормализация пустого коммита ────────────────────────────────

test('commit: элемент содержит только \'<br>\' (пустой contenteditable) — в модель пишется \'\'', () => {
    const { vm, violation, block } = makeContext();
    const calls = [];
    vm.setBlockField = (v, key, blockId, attr, val) => { calls.push(val); return true; };
    block.content = 'было';
    const s = vm._makeBlockSurface(violation, 'violated', block);

    s.element = { innerHTML: '<br>' };
    s.commit();

    assert.deepEqual(calls, [''], 'визуально пустой <br>-остаток нормализован в \'\'');
});

test('commit: элемент содержит только \'<div><br></div>\' — в модель пишется \'\'', () => {
    const { vm, violation, block } = makeContext();
    const calls = [];
    vm.setBlockField = (v, key, blockId, attr, val) => { calls.push(val); return true; };
    const s = vm._makeBlockSurface(violation, 'violated', block);

    s.element = { innerHTML: '<div><br></div>' };
    s.commit();

    assert.deepEqual(calls, ['']);
});

test('commit: непустой текст — в модель пишется исходный HTML (без нормализации)', () => {
    const { vm, violation, block } = makeContext();
    const calls = [];
    vm.setBlockField = (v, key, blockId, attr, val) => { calls.push(val); return true; };
    const s = vm._makeBlockSurface(violation, 'violated', block);

    s.element = { innerHTML: '<b>текст</b>' };
    s.commit();

    assert.deepEqual(calls, ['<b>текст</b>']);
});
