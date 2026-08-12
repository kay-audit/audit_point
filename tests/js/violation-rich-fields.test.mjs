/**
 * Тесты rich-полей нарушения (Task 1.3.3) — логика, доступная под node-стабом:
 *  - _createRichFieldEditor: хост-контракт (класс .violation-field, contenteditable,
 *    наполнение из модели, focus→mount, read-only-ветка);
 *  - _teardownActiveRichField: снятие контроллера при пересоздании DOM нарушения;
 *  - createViolationElement: форма собирается циклом по полям реестра.
 *
 * Поверхность блока (ViolationBlockSurface: commit/setContent/persist →
 * setBlockField) проверяется в violation-rich-surface.test.mjs.
 *
 * РЕАЛЬНЫЙ contenteditable/сохранение формата/тулбар/тедаун-на-blur проверяются
 * ТОЛЬКО в Playwright (задача 1.6.3) — node-стаб без настоящего DOM/DOMPurify их
 * не воспроизводит. Здесь — маршрутизация, атрибуты фейкового элемента и вызовы.
 *
 * Реальные модули импортируются под node:test через _browser-stub.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../../static/js/shared/app-config.js';
// Входная точка графа нарушений — как в entries/constructor.js: violation-init
// мешает rich-хелперы (_createRichFieldEditor и пр.) в прототип ViolationManager.
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import { EditorController } from '../../static/js/constructor/textblock/editor-controller.js';
import { EditorRegistry } from '../../static/js/constructor/textblock/editor-registry.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';
import { VIOLATION_FIELD_KEYS } from '../../static/js/constructor/violation/violation-fields.js';
import { createDefaultViolationShape } from '../../static/js/constructor/violation/violation-normalize.js';

/**
 * Фейковый элемент, записывающий className/contentEditable/dataset/classList и
 * слушатели (стаб _browser-stub — no-op). Возвращается вместо document.createElement
 * в тестах хоста rich-поля, чтобы проверить его атрибуты и focus→mount.
 */
function recordingEl() {
    const listeners = {};
    const classes = new Set();
    return {
        className: '',
        contentEditable: '',
        dataset: {},
        textContent: '',
        innerHTML: '',
        style: {},
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            toggle: (c, f) => { const v = f === undefined ? !classes.has(c) : f; if (v) classes.add(c); else classes.delete(c); return v; },
            contains: (c) => classes.has(c),
        },
        addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
        _fire(t, ev) { (listeners[t] || []).forEach((fn) => fn(ev)); },
        _has(t) { return Array.isArray(listeners[t]) && listeners[t].length > 0; },
    };
}

/** Выполняет fn с document.createElement, отдающим один фиксированный элемент. */
function withCreateElement(el, fn) {
    const orig = document.createElement;
    document.createElement = () => el;
    try { return fn(); } finally { document.createElement = orig; }
}

/** Выполняет fn с застабленным EditorController.mount (спай), восстанавливает. */
function withMountSpy(fn) {
    const mounts = [];
    const orig = EditorController.mount;
    EditorController.mount = (s) => mounts.push(s);
    try { fn(mounts); } finally { EditorController.mount = orig; }
}

// ── _createRichFieldEditor: хост-контракт ─────────────────────────────────────

test('_createRichFieldEditor: contenteditable .violation-field, наполнен из модели, focus→mount', () => {
    const vm = new ViolationManager();
    const el = recordingEl();
    withMountSpy((mounts) => {
        const surface = { kind: 'violationField', element: null, getContent: () => '<b>x</b>', commit() {} };
        const out = withCreateElement(el, () => vm._createRichFieldEditor(surface, { placeholder: 'Опишите...', isReadOnly: false }));

        assert.equal(out, el);
        assert.ok(el.className.includes('violation-field'), 'класс violation-field (read-only-проход app.js + read-only.css)');
        assert.ok(el.className.includes('violation-textarea'), 'визуальный класс сохранён');
        assert.equal(el.contentEditable, 'true');
        assert.equal(el.dataset.placeholder, 'Опишите...');
        assert.equal(surface.element, el, 'хост привязан к поверхности до наполнения');
        // renderActContent под стабом (DOMPurify отсутствует) кладёт textContent-фолбэком.
        assert.equal(el.textContent, '<b>x</b>', 'наполнен из модели');

        el._fire('focus');
        assert.deepEqual(mounts, [surface], 'focus монтирует контроллер на переданную поверхность');
    });
});

test('_createRichFieldEditor: не-RO — drop-слушатель навешан при СОЗДАНИИ и зовёт EditorController.handleSurfaceDrop(e, surface)', () => {
    // T7 (#6/#14b): drop навешивается на СОЗДАНИИ, не на mount — focus приходит
    // как default-action drop'а (ПОСЛЕ него), поэтому mount-time слушатель
    // опоздал бы на drop в несфокусированное поле. Захваченная поверхность
    // передаётся в handleSurfaceDrop (политика/commit читаются из неё).
    const vm = new ViolationManager();
    const el = recordingEl();
    const drops = [];
    const origDrop = EditorController.handleSurfaceDrop;
    EditorController.handleSurfaceDrop = (e, s) => drops.push([e, s]);
    try {
        withMountSpy(() => {
            const surface = { kind: 'violationField', element: null, getContent: () => '', commit() {} };
            withCreateElement(el, () => vm._createRichFieldEditor(surface, { isReadOnly: false }));

            assert.equal(el._has('drop'), true, 'drop-слушатель не навешан при создании поля');
            const ev = { type: 'drop' };
            el._fire('drop', ev);
            assert.deepEqual(drops, [[ev, surface]],
                'drop должен звать handleSurfaceDrop(e, захваченная поверхность)');
        });
    } finally {
        EditorController.handleSurfaceDrop = origDrop;
    }
});

test('_createRichFieldEditor: read-only — drop-слушатель НЕ навешан (поле нередактируемо)', () => {
    const vm = new ViolationManager();
    const el = recordingEl();
    const surface = { kind: 'violationField', element: null, getContent: () => '', commit() {} };
    withCreateElement(el, () => vm._createRichFieldEditor(surface, { isReadOnly: true }));

    assert.equal(el._has('drop'), false, 'RO-поле не должно принимать drop');
});

test('_createRichFieldEditor: read-only — contenteditable=false, класс read-only, focus НЕ монтирует', () => {
    const vm = new ViolationManager();
    const el = recordingEl();
    withMountSpy((mounts) => {
        const surface = { kind: 'violationField', element: null, getContent: () => '', commit() {} };
        withCreateElement(el, () => vm._createRichFieldEditor(surface, { isReadOnly: true }));

        assert.equal(el.contentEditable, 'false');
        assert.ok(el.classList.contains('read-only'));
        assert.equal(el._has('focus'), false, 'в режиме просмотра focus-слушатель не навешивается');
        el._fire('focus');
        assert.equal(mounts.length, 0, 'focus в RO не монтирует контроллер');
    });
});

test('_createRichFieldEditor: __lastFootnoteCount=0 при создании (Task 1.3.4-A — гейт finalizeEdit не триггерит renumber на поле без сносок)', () => {
    const vm = new ViolationManager();
    const el = recordingEl();
    const surface = { kind: 'violationField', element: null, getContent: () => '', commit() {} };
    const out = withCreateElement(el, () => vm._createRichFieldEditor(surface, {}));

    assert.equal(out.__lastFootnoteCount, 0);
});

// ── Task 1.3.4-B1: hardening капсул при загрузке (creation) ──────────────────

test('_createRichFieldEditor: не-RO — репак капсул (round-trip через _repairCapsulesReport) + normalizeMarkers + tooltip вызваны на field', () => {
    const vm = new ViolationManager();
    const el = recordingEl();
    // renderActContent под стабом (нет DOMPurify) правит только textContent —
    // field.innerHTML остаётся тем, что здесь заранее выставлено; читаем его
    // же в repair-раунд-трипе, поэтому предзаполняем осмысленной строкой.
    const seedHtml = '<span class="text-link" data-link-id="1" data-link-url="/x">x</span>';
    el.innerHTML = seedHtml;
    const reportCalls = [];
    const normalizeCalls = [];
    const tooltipCalls = [];
    const origStrip = textBlockManager._stripGuards;
    const origReport = textBlockManager._repairCapsulesReport;
    const origNormalize = textBlockManager.normalizeMarkers;
    const origTooltip = textBlockManager._attachInitialTooltipHandlers;
    textBlockManager._stripGuards = (html) => html;
    textBlockManager._repairCapsulesReport = (html) => { reportCalls.push(html); return { html, changed: false }; };
    textBlockManager.normalizeMarkers = (element) => normalizeCalls.push(element);
    textBlockManager._attachInitialTooltipHandlers = (element) => tooltipCalls.push(element);
    try {
        withMountSpy(() => {
            const surface = { kind: 'violationField', element: null, getContent: () => '<b>x</b>', commit() {} };
            const out = withCreateElement(el, () => vm._createRichFieldEditor(surface, { isReadOnly: false }));

            assert.deepEqual(reportCalls, [seedHtml],
                '_repairCapsulesReport вызван ровно раз с field.innerHTML (round-trip)');
            assert.deepEqual(normalizeCalls, [out], 'normalizeMarkers вызван на field');
            assert.deepEqual(tooltipCalls, [out], '_attachInitialTooltipHandlers вызван на field');
        });
    } finally {
        textBlockManager._stripGuards = origStrip;
        textBlockManager._repairCapsulesReport = origReport;
        textBlockManager.normalizeMarkers = origNormalize;
        textBlockManager._attachInitialTooltipHandlers = origTooltip;
    }
});

test('_createRichFieldEditor: RO — normalizeMarkers + tooltip вызваны, репак капсул НЕ вызван', () => {
    const vm = new ViolationManager();
    const el = recordingEl();
    const reportCalls = [];
    const normalizeCalls = [];
    const tooltipCalls = [];
    const origReport = textBlockManager._repairCapsulesReport;
    const origNormalize = textBlockManager.normalizeMarkers;
    const origTooltip = textBlockManager._attachInitialTooltipHandlers;
    textBlockManager._repairCapsulesReport = (html) => { reportCalls.push(html); return { html, changed: false }; };
    textBlockManager.normalizeMarkers = (element) => normalizeCalls.push(element);
    textBlockManager._attachInitialTooltipHandlers = (element) => tooltipCalls.push(element);
    try {
        const surface = { kind: 'violationField', element: null, getContent: () => '<b>x</b>', commit() {} };
        const out = withCreateElement(el, () => vm._createRichFieldEditor(surface, { isReadOnly: true }));

        assert.equal(reportCalls.length, 0, 'RO ничего не пишет обратно в модель — чинить незачем');
        assert.deepEqual(normalizeCalls, [out], 'normalizeMarkers вызван на field даже в RO (ce=false атом)');
        assert.deepEqual(tooltipCalls, [out], '_attachInitialTooltipHandlers вызван на field даже в RO (иначе капсула немая)');
    } finally {
        textBlockManager._repairCapsulesReport = origReport;
        textBlockManager.normalizeMarkers = origNormalize;
        textBlockManager._attachInitialTooltipHandlers = origTooltip;
    }
});

// ── V27: гейт повторного рендера — только при реальной структурной починке ──

test('V27: unchanged-санитизация (changed=false) — второй renderActContent НЕ происходит (единственная запись — начальная из модели)', () => {
    const vm = new ViolationManager();
    const el = recordingEl();
    const textContentSets = [];
    Object.defineProperty(el, 'textContent', {
        get() { return el._tc || ''; },
        set(v) { el._tc = v; textContentSets.push(v); },
    });
    const origStrip = textBlockManager._stripGuards;
    const origReport = textBlockManager._repairCapsulesReport;
    textBlockManager._stripGuards = (html) => html;
    textBlockManager._repairCapsulesReport = (html) => ({ html, changed: false });
    try {
        const surface = { kind: 'violationField', element: null, getContent: () => '<b>x</b>', commit() {} };
        withCreateElement(el, () => vm._createRichFieldEditor(surface, { isReadOnly: false }));

        assert.equal(textContentSets.length, 1, 'ровно один рендер — unchanged-санитизация не даёт второй (≥8 фабрик на карточку)');
        assert.equal(textContentSets[0], '<b>x</b>');
    } finally {
        textBlockManager._stripGuards = origStrip;
        textBlockManager._repairCapsulesReport = origReport;
    }
});

test('V27: структурная починка (changed=true) — второй renderActContent происходит, репаренным html', () => {
    const vm = new ViolationManager();
    const el = recordingEl();
    const textContentSets = [];
    Object.defineProperty(el, 'textContent', {
        get() { return el._tc || ''; },
        set(v) { el._tc = v; textContentSets.push(v); },
    });
    const origStrip = textBlockManager._stripGuards;
    const origReport = textBlockManager._repairCapsulesReport;
    textBlockManager._stripGuards = (html) => html;
    textBlockManager._repairCapsulesReport = () => ({ html: '<b>починено</b>', changed: true });
    try {
        const surface = { kind: 'violationField', element: null, getContent: () => '<b>x</b>', commit() {} };
        withCreateElement(el, () => vm._createRichFieldEditor(surface, { isReadOnly: false }));

        assert.equal(textContentSets.length, 2, 'структурная починка → второй рендер репаренным html');
        assert.equal(textContentSets[1], '<b>починено</b>');
    } finally {
        textBlockManager._stripGuards = origStrip;
        textBlockManager._repairCapsulesReport = origReport;
    }
});

// ── _teardownActiveRichField: снятие контроллера при пересоздании DOM ─────────

test('_teardownActiveRichField: снимает контроллер, если активна поверхность этого нарушения', () => {
    const vm = new ViolationManager();
    const unmounts = [];
    const orig = EditorController.unmount;
    EditorController.unmount = () => unmounts.push(true);
    try {
        EditorRegistry.setActive({ id: 'viol:v1:violated' });
        vm._teardownActiveRichField('v1');
        assert.equal(unmounts.length, 1, 'контроллер снят для активного поля нарушения v1');
    } finally { EditorController.unmount = orig; EditorRegistry.clear(); }
});

test('_teardownActiveRichField: чужое нарушение / чужой kind / пусто — no-op (без коллизии v1↔v12)', () => {
    const vm = new ViolationManager();
    const unmounts = [];
    const orig = EditorController.unmount;
    EditorController.unmount = () => unmounts.push(true);
    try {
        EditorRegistry.clear();
        vm._teardownActiveRichField('v1');                       // нет активной
        EditorRegistry.setActive({ id: 'viol:v12:violated' });   // префикс v12 ≠ v1 (ведущее ':')
        vm._teardownActiveRichField('v1');
        EditorRegistry.setActive({ id: 'textblock-abc' });       // чужой источник
        vm._teardownActiveRichField('v1');
        assert.equal(unmounts.length, 0, 'ни одного снятия');
    } finally { EditorController.unmount = orig; EditorRegistry.clear(); }
});

// ── createViolationElement: форма собирается по реестру полей ────────────────

test('createViolationElement: секция на КАЖДОЕ поле реестра, в порядке fieldOrder', () => {
    const prev = AppConfig.readOnlyMode;
    // Режим просмотра пропускает бар действий (его insertBefore не покрыт
    // стабом); набор секций от режима не зависит.
    AppConfig.readOnlyMode = { isReadOnly: true };
    try {
        const vm = new ViolationManager();
        const fields = [];
        vm.createBlocksField = (v, descriptor, ro) => {
            fields.push({ key: descriptor.key, label: descriptor.label, ro });
            return {};
        };

        const violation = { id: 'v1', nodeId: 'n1', ...createDefaultViolationShape() };
        vm.createViolationElement(violation, { id: 'n1' });

        assert.deepEqual(fields.map((f) => f.key), [...VIOLATION_FIELD_KEYS],
            'все десять полей реестра — по секции на каждое, в стандартном порядке');
        assert.ok(fields.every((f) => f.ro === true), 'режим просмотра прокинут в каждую секцию');
    } finally {
        AppConfig.readOnlyMode = prev;
    }
});

test('createViolationElement: пользовательский fieldOrder меняет порядок секций', () => {
    const prev = AppConfig.readOnlyMode;
    AppConfig.readOnlyMode = { isReadOnly: true };
    try {
        const vm = new ViolationManager();
        const keys = [];
        vm.createBlocksField = (v, descriptor) => { keys.push(descriptor.key); return {}; };

        const custom = [...VIOLATION_FIELD_KEYS].reverse();
        const violation = { id: 'v1', nodeId: 'n1', ...createDefaultViolationShape(), fieldOrder: custom };
        vm.createViolationElement(violation, { id: 'n1' });

        assert.deepEqual(keys, custom, 'порядок секций взят из fieldOrder нарушения');
    } finally {
        AppConfig.readOnlyMode = prev;
    }
});

test('createViolationElement: нарушение попадает в реестр активных (адресат paste по фокусу)', () => {
    const prev = AppConfig.readOnlyMode;
    AppConfig.readOnlyMode = { isReadOnly: true };
    try {
        const vm = new ViolationManager();
        vm.createBlocksField = () => ({});
        const violation = { id: 'v1', nodeId: 'n1', ...createDefaultViolationShape() };

        vm.createViolationElement(violation, { id: 'n1' });

        assert.equal(vm.activeViolations.get('v1'), violation);
    } finally {
        AppConfig.readOnlyMode = prev;
    }
});
