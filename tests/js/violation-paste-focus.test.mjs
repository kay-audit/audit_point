/**
 * Тесты focus-модели вставки в дополнительный контент и contenteditable-guard
 * (находка аудита #19).
 *
 * Раньше целевая зона paste бралась из hover-состояния (currentActiveContainer):
 * Ctrl+V в текстблоке, когда мышь висела над зоной нарушения, уходил в
 * дополнительный контент. Теперь:
 *  - вставку в поля ввода и contenteditable-редактор не перехватываем
 *    (isEditableTarget);
 *  - целевую зону определяем по фокусу (document.activeElement.closest(
 *    '.additional-content-wrapper')), вставляем в КОНЕЦ зоны.
 *
 * Плюс §5.8: узкое исключение из contenteditable-guard'а — картинки при каретке
 * в rich-поле САМОЙ зоны (shouldInterceptImagesFromEditable).
 *
 * Реальные модули импортируются под node:test через _browser-stub.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifications } from '../../static/js/shared/notifications.js';
import { AppConfig } from '../../static/js/shared/app-config.js';
import '../../static/js/constructor/violation/violation-init.js';
import {
    ViolationManager,
    isEditableTarget,
} from '../../static/js/constructor/violation/violation-core.js';
import {
    parseClipboardText,
    shouldInterceptImagesFromEditable,
} from '../../static/js/constructor/violation/violation-paste.js';

Notifications.success = () => {};

// --- isEditableTarget: чистая проверка target ---

test('isEditableTarget: textarea/input/contenteditable → true, прочее → false', () => {
    assert.equal(isEditableTarget(null), false);
    assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true);
    assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);

    const inEditor = { tagName: 'SPAN', closest: (s) => (s === '[contenteditable="true"]' ? {} : null) };
    assert.equal(isEditableTarget(inEditor), true);

    const plainDiv = { tagName: 'DIV', closest: () => null };
    assert.equal(isEditableTarget(plainDiv), false);

    // target без метода closest (например, из старых стабов) не падает.
    assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
});

// --- §5.8: shouldInterceptImagesFromEditable — узкое исключение из guard'а ---

/** Каретка в rich-поле: contenteditable + (опционально) внутри зоны. */
function editableTarget({ inZone, zone = { id: 'zone' } } = { inZone: false }) {
    return {
        tagName: 'SPAN',
        closest: (s) => {
            if (s === '[contenteditable="true"]') return {};
            if (s === '.additional-content-wrapper') return inZone ? zone : null;
            return null;
        },
    };
}

const IMAGE_ITEMS = [{ type: 'image/png', getAsFile: () => ({ name: 'a.png' }) }];
const TEXT_ITEMS = [{ type: 'text/plain', getAsFile: () => null }];

test('§5.8: editable ВНЕ зоны (текстблок, поля нарушения) — не перехватываем даже картинки', () => {
    assert.equal(shouldInterceptImagesFromEditable(editableTarget({ inZone: false }), IMAGE_ITEMS), false);
});

test('§5.8: editable В зоне + картинки в буфере — перехватываем', () => {
    assert.equal(shouldInterceptImagesFromEditable(editableTarget({ inZone: true }), IMAGE_ITEMS), true);
});

test('§5.8: editable В зоне без картинок — не перехватываем (текст вставит редактор)', () => {
    assert.equal(shouldInterceptImagesFromEditable(editableTarget({ inZone: true }), TEXT_ITEMS), false);
    assert.equal(shouldInterceptImagesFromEditable(editableTarget({ inZone: true }), null), false);
});

test('§5.8: не-editable target — не путь этого предиката (решает общая ветка по фокусу)', () => {
    const plainDiv = { tagName: 'DIV', closest: () => null };
    assert.equal(shouldInterceptImagesFromEditable(plainDiv, IMAGE_ITEMS), false);
    assert.equal(shouldInterceptImagesFromEditable(null, IMAGE_ITEMS), false);
});

// --- Интеграция через захваченный paste-обработчик ---

function makeViolation(count) {
    const items = [];
    for (let i = 0; i < count; i++) items.push({ id: `x${i}`, type: 'freeText', content: '' });
    return { id: 'v1', additionalContent: { enabled: true, items } };
}

function capturePasteHandler(vm) {
    let handler = null;
    const orig = document.addEventListener;
    document.addEventListener = (type, cb) => { if (type === 'paste') handler = cb; };
    vm.setupPasteHandler();
    document.addEventListener = orig;
    return handler;
}

function makeZone(violationId = 'v1') {
    const itemsContainer = { dataset: { violationId } };
    return { querySelector: (s) => (s === '.additional-content-items' ? itemsContainer : null) };
}

function textPasteEvent(text, target) {
    let prevented = false;
    return {
        target: target ?? { tagName: 'DIV', closest: () => null },
        clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }], getData: () => text },
        preventDefault() { prevented = true; },
        _prevented: () => prevented,
    };
}

test('#19: зона берётся по фокусу, текст вставляется в КОНЕЦ зоны', async () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(2); // уже 2 элемента
    vm.activeViolations.set('v1', violation);

    const zone = makeZone('v1');
    document.activeElement = { closest: (s) => (s === '.additional-content-wrapper' ? zone : null) };

    let captured = null;
    vm.addContentItemAtPosition = (v, type, container, insertIndex, extra) => {
        captured = { type, container, insertIndex, content: extra.content };
        return true;
    };

    const handler = capturePasteHandler(vm);
    await handler(textPasteEvent('Кейс 3. описание'));

    assert.ok(captured, 'вставка выполнена по фокусу');
    assert.equal(captured.type, 'case');
    assert.equal(captured.content, 'описание', 'парсер #5 применён');
    assert.equal(captured.insertIndex, 2, 'вставка в конец зоны (после 2 существующих)');
    assert.equal(captured.container, zone, 'контейнер = зона по фокусу');
});

test('#19-Б: Ctrl+V в contenteditable не перехватывается даже при фокусе на зоне', async () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(1);
    vm.activeViolations.set('v1', violation);

    const zone = makeZone('v1');
    document.activeElement = { closest: (s) => (s === '.additional-content-wrapper' ? zone : null) };

    let called = false;
    vm.addContentItemAtPosition = () => { called = true; return true; };

    const target = { tagName: 'DIV', closest: (s) => (s === '[contenteditable="true"]' ? {} : null) };
    const e = textPasteEvent('hello', target);

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.equal(called, false, 'вставка в дополнительный контент не запущена');
    assert.equal(e._prevented(), false, 'стандартная вставка в редактор не перехвачена');
});

test('#19: без сфокусированной зоны вставка не перехватывается', async () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(1);
    vm.activeViolations.set('v1', violation);

    // Фокус вне зоны — closest возвращает null.
    document.activeElement = { closest: () => null };

    let called = false;
    vm.addContentItemAtPosition = () => { called = true; return true; };

    const e = textPasteEvent('hello');
    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.equal(called, false);
    assert.equal(e._prevented(), false, 'стандартная вставка не тронута');
});

// --- §5.8: интеграция ветки картинок при каретке в rich-поле зоны ---

/** Событие вставки с произвольным набором items. */
function pasteEvent(items, target, text = '') {
    let prevented = false;
    return {
        target,
        clipboardData: { items, getData: () => text },
        preventDefault() { prevented = true; },
        _prevented: () => prevented,
    };
}

test('§5.8: Ctrl+V картинкой при каретке в rich-поле зоны запускает конвейер картинок', async () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(2);
    vm.activeViolations.set('v1', violation);

    const zone = makeZone('v1');
    // Фокус в rich-поле зоны: зону берём от e.target (activeElement намеренно
    // пуст — путь §5.8 не должен зависеть от стаба activeElement).
    document.activeElement = null;
    const target = editableTarget({ inZone: true, zone });

    let captured = null;
    vm.promptQualityThenInsertImages = (v, container, insertIndex, files) => {
        captured = { v, container, insertIndex, files };
    };

    const file = { name: 'a.png', type: 'image/png', size: 100 };
    const e = pasteEvent([{ type: 'image/png', getAsFile: () => file }], target);

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.ok(captured, 'конвейер картинок запущен из rich-поля зоны');
    assert.equal(captured.container, zone, 'контейнер = зона от каретки (e.target)');
    assert.equal(captured.insertIndex, 2, 'вставка в конец зоны');
    assert.deepEqual(captured.files, [file]);
    assert.equal(e._prevented(), true, 'вставку картинки перехватили');
});

test('§5.8: текстовая ветка НЕ исполняется для каретки в rich-поле (дубль текста)', async () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(0);
    vm.activeViolations.set('v1', violation);

    const zone = makeZone('v1');
    document.activeElement = null;
    const target = editableTarget({ inZone: true, zone });

    let added = false;
    vm.addContentItemAtPosition = () => { added = true; return true; };
    vm.promptQualityThenInsertImages = () => {};

    // Картинка в буфере есть (перехват включён), но getAsFile отдаёт null —
    // после фильтра файлов не остаётся, и текстовая ветка НЕ должна подхватить
    // text/plain: его уже вставил редактор поверхности.
    const e = pasteEvent([
        { type: 'image/png', getAsFile: () => null },
        { type: 'text/plain', getAsFile: () => null },
    ], target, 'текст из буфера');

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.equal(added, false, 'дубль текста в зону не добавлен');
});

test('§5.8: rich-поле нарушения ВНЕ зоны (нарушено/причины) — поведение прежнее', async () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(1);
    vm.activeViolations.set('v1', violation);

    // Мышь/фокус рядом с зоной, но каретка — в поле вне неё (#19).
    const zone = makeZone('v1');
    document.activeElement = { closest: (s) => (s === '.additional-content-wrapper' ? zone : null) };

    let called = false;
    vm.promptQualityThenInsertImages = () => { called = true; };

    const target = editableTarget({ inZone: false });
    const e = pasteEvent([{ type: 'image/png', getAsFile: () => ({ name: 'a.png', type: 'image/png', size: 1 }) }], target);

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.equal(called, false, 'картинка не уходит в зону из поля вне неё');
    assert.equal(e._prevented(), false, 'вставка редактора не перехвачена');
});

// parseClipboardText задействован в интеграционном тесте выше — здесь просто
// фиксируем экспорт как публичный контракт модуля.
test('parseClipboardText экспортируется из модуля вставки', () => {
    assert.equal(typeof parseClipboardText, 'function');
});
