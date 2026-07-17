/**
 * Тесты rich-полей нарушения (Task 1.3.3) — логика, доступная под node-стабом:
 *  - _createRichFieldEditor: хост-контракт (класс .violation-field, contenteditable,
 *    наполнение из модели, focus→mount, read-only-ветка);
 *  - ViolationContentItemSurface: поверхность кейса/свободного текста
 *    (commit/setContent → setContentItemField);
 *  - _teardownActiveRichField: снятие контроллера при пересоздании DOM нарушения;
 *  - createViolationElement: 6 текстовых полей карточки идут через rich-поле с
 *    корректными путями поверхности.
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
        _fire(t) { (listeners[t] || []).forEach((fn) => fn()); },
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

// ── ViolationContentItemSurface (кейс/свободный текст) ────────────────────────

test('_makeContentItemSurface: id/kind/rich, getContent из item.content', () => {
    const vm = new ViolationManager();
    const s = vm._makeContentItemSurface({ id: 'v1' }, { id: 'c1', content: 'кейс' });

    assert.equal(s.id, 'viol:v1:item:c1');
    assert.equal(s.kind, 'violationField');
    assert.equal(s.rich, true);
    assert.equal(s.getContent(), 'кейс');
});

test('ViolationContentItemSurface: commit (element→модель) и setContent (модель→element) → setContentItemField', () => {
    const vm = new ViolationManager();
    const calls = [];
    vm.setContentItemField = (v, item, field, val) => { calls.push({ field, val }); return true; };
    const violation = { id: 'v1' };
    const item = { id: 'c1', content: '' };
    const s = vm._makeContentItemSurface(violation, item);

    s.element = { innerHTML: '<i>новое</i>', textContent: '' };
    s.commit();
    assert.deepEqual(calls, [{ field: 'content', val: '<i>новое</i>' }], 'commit пишет element.innerHTML');

    calls.length = 0;
    s.setContent('<u>внешнее</u>');
    assert.deepEqual(calls, [{ field: 'content', val: '<u>внешнее</u>' }], 'setContent пишет переданный html');
});

test('ViolationContentItemSurface: commit снимает caret-guard\'ы (U+FEFF) перед записью (Task 1.3.4-A)', () => {
    const vm = new ViolationManager();
    const calls = [];
    vm.setContentItemField = (v, item, field, val) => { calls.push({ field, val }); return true; };
    const violation = { id: 'v1' };
    const item = { id: 'c1', content: '' };
    const s = vm._makeContentItemSurface(violation, item);
    const guard = String.fromCharCode(0xFEFF);

    const origStrip = textBlockManager._stripGuards;
    textBlockManager._stripGuards = (html) => html.split(guard).join('');
    try {
        s.element = { innerHTML: `${guard}<i>новое</i>${guard}`, textContent: '' };
        s.commit();
        assert.deepEqual(calls, [{ field: 'content', val: '<i>новое</i>' }], 'guard-символы вычищены до записи в модель');
    } finally {
        textBlockManager._stripGuards = origStrip;
    }
});

// changed=false (косметика) НЕ означает «нечего чистить» — см. докстринг
// _repairCapsuleHtml (violation-field-surface.js). Модель обязана получать
// report.html БЕЗУСЛОВНО, независимо от changed (зеркало теста в
// violation-rich-surface.test.mjs для ViolationFieldSurface).
test('ViolationContentItemSurface: setContent — модель получает report.html ОДНИМ вызовом даже при changed=false (Task 1.3.4-A)', () => {
    const vm = new ViolationManager();
    const calls = [];
    vm.setContentItemField = (v, item, field, val) => { calls.push({ field, val }); return true; };
    const violation = { id: 'v1' };
    const item = { id: 'c1', content: '' };
    const s = vm._makeContentItemSurface(violation, item);
    const guard = String.fromCharCode(0xFEFF);

    const origReport = textBlockManager._repairCapsulesReport;
    textBlockManager._repairCapsulesReport = () => ({ html: '<i>чисто</i>', changed: false });
    try {
        s.setContent(`${guard}<i contenteditable="true">чисто</i>${guard}`);
        assert.deepEqual(calls, [{ field: 'content', val: '<i>чисто</i>' }],
            'модель получает report.html ОДНИМ вызовом независимо от changed');
    } finally {
        textBlockManager._repairCapsulesReport = origReport;
    }
});

test('ViolationContentItemSurface: persist делегирует в commit (element→модель через setContentItemField)', () => {
    const vm = new ViolationManager();
    const calls = [];
    vm.setContentItemField = (v, item, field, val) => { calls.push({ field, val }); return true; };
    const violation = { id: 'v1' };
    const item = { id: 'c1', content: '' };
    const s = vm._makeContentItemSurface(violation, item);

    s.element = { innerHTML: '<b>x</b>', textContent: '' };
    s.persist();

    assert.deepEqual(calls, [{ field: 'content', val: '<b>x</b>' }], 'persist пишет element.innerHTML как commit');
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

// ── createViolationElement: маршрутизация 6 текстовых полей карточки ──────────

test('createViolationElement: 6 текстовых полей карточки идут через rich-поле с корректными путями', () => {
    const prev = AppConfig.readOnlyMode;
    // Режим просмотра пропускает _addFormalizeButton (его insertBefore не покрыт
    // стабом); набор создаваемых полей от режима не зависит.
    AppConfig.readOnlyMode = { isReadOnly: true };
    try {
        const vm = new ViolationManager();
        const surfaces = [];
        vm._createRichFieldEditor = (surface, opts) => { surfaces.push({ id: surface.id, kind: surface.kind, ro: opts.isReadOnly }); return {}; };
        vm.createAdditionalContentField = () => ({}); // не предмет теста

        const violation = {
            id: 'v1', violated: '', established: '',
            descriptionList: { enabled: false, items: [] },
            additionalContent: { enabled: false, items: [] },
            reasons: { enabled: false, content: '' },
            measures: { enabled: false, content: '' },
            consequences: { enabled: false, content: '' },
            responsible: { enabled: false, content: '' },
        };
        vm.createViolationElement(violation, { id: 'n1' });

        assert.deepEqual(surfaces.map((s) => s.id), [
            'viol:v1:violated', 'viol:v1:established',
            'viol:v1:reasons.content', 'viol:v1:measures.content',
            'viol:v1:consequences.content', 'viol:v1:responsible.content',
        ], 'violated/established + 4 опциональных текстовых поля (descriptionList — список, не rich)');
        assert.ok(surfaces.every((s) => s.kind === 'violationField' && s.ro === true));
    } finally {
        AppConfig.readOnlyMode = prev;
    }
});
