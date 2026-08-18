/**
 * Тесты focus-модели вставки в контейнер блоков поля и contenteditable-guard
 * (находка аудита #19).
 *
 * Раньше целевая зона paste бралась из hover-состояния (currentActiveContainer):
 * Ctrl+V в текстблоке, когда мышь висела над зоной нарушения, уходил в
 * дополнительный контент. Теперь:
 *  - вставку в поля ввода и contenteditable-редактор не перехватываем
 *    (isEditableTarget);
 *  - целевую зону определяем по фокусу (document.activeElement.closest(
 *    '.violation-blocks-wrapper')); ключ поля берём из dataset контейнера блоков;
 *  - позицию вставки — тоже по фокусу (insertIndexFromFocus): каретка внутри
 *    блока кладёт новый блок сразу ЗА ним, фокус в зоне без блока — в конец
 *    поля. К hover-позиции курсора возврата нет.
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
    shouldInterceptImagesFromEditable,
    classifyClipboardPayload,
    clipboardHasText,
} from '../../static/js/constructor/violation/violation-paste.js';
import { BLOCK_TYPES } from '../../static/js/constructor/violation/violation-block-types.js';
import { DialogManager } from '../../static/js/shared/dialog/dialog-confirm.js';
import { textBlockManager } from '../../static/js/constructor/textblock/textblock-core.js';

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

/**
 * Каретка в rich-поле: contenteditable + (опционально) внутри зоны.
 * `blockId` — id блока, в обёртке которого стоит каретка (null — вне блоков).
 */
function editableTarget(
    { inZone, zone = { id: 'zone' }, field = {}, blockId = null } = { inZone: false },
) {
    return {
        tagName: 'SPAN',
        closest: (s) => {
            if (s === '[contenteditable="true"]') return field;
            if (s === '.violation-blocks-wrapper') return inZone ? zone : null;
            if (s === '.content-item-wrapper') return blockId ? { dataset: { blockId } } : null;
            return null;
        },
    };
}

/** Фокус в зоне: внутри обёртки блока blockId либо (null) на самой зоне. */
function focusInZone(zone, blockId = null) {
    return {
        closest: (s) => {
            if (s === '.violation-blocks-wrapper') return zone;
            if (s === '.content-item-wrapper') return blockId ? { dataset: { blockId } } : null;
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

/** Поле, в которое ведётся вставка (зона paste адресуется ключом поля). */
const FIELD = 'additionalContent';

function makeViolation(count) {
    const blocks = [];
    for (let i = 0; i < count; i++) blocks.push({ id: `x${i}`, type: BLOCK_TYPES.TEXT, content: '' });
    return { id: 'v1', [FIELD]: { enabled: true, blocks } };
}

function capturePasteHandler(vm) {
    let handler = null;
    const orig = document.addEventListener;
    document.addEventListener = (type, cb) => { if (type === 'paste') handler = cb; };
    vm.setupPasteHandler();
    document.addEventListener = orig;
    return handler;
}

function makeZone(violationId = 'v1', fieldKey = FIELD) {
    const itemsContainer = { dataset: { violationId, fieldKey } };
    return { querySelector: (s) => (s === '.violation-blocks-items' ? itemsContainer : null) };
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

/** Перехватывает addBlockAtPosition и отдаёт снимок аргументов вставки. */
function captureBlockInsert(vm) {
    const captured = {};
    vm.addBlockAtPosition = (v, fieldKey, type, container, insertIndex, extra) => {
        Object.assign(captured, { fieldKey, type, container, insertIndex, content: extra.content });
        captured.called = true;
        return true;
    };
    return captured;
}

test('#19: зона берётся по фокусу, текст вставляется текст-блоком', async () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(2); // уже 2 блока
    vm.activeViolations.set('v1', violation);

    const zone = makeZone('v1');
    // Фокус в зоне, но не в блоке (клик по самому контейнеру).
    document.activeElement = focusInZone(zone);

    const captured = captureBlockInsert(vm);

    const handler = capturePasteHandler(vm);
    await handler(textPasteEvent('Кейс 3. описание'));

    assert.ok(captured.called, 'вставка выполнена по фокусу');
    assert.equal(captured.fieldKey, FIELD, 'ключ поля взят из dataset зоны');
    assert.equal(captured.type, BLOCK_TYPES.TEXT, 'любой текст буфера — текст-блок');
    assert.equal(captured.content, 'Кейс 3. описание',
        'префикс «Кейс N» больше не разбирается — текст уходит как есть');
    assert.equal(captured.insertIndex, 2, 'фокус вне блоков — вставка в конец поля');
    assert.equal(captured.container, zone, 'контейнер = зона по фокусу');
});

test('фокус внутри блока — новый блок ложится СРАЗУ ЗА ним, а не в конец', async () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(3); // блоки x0, x1, x2
    vm.activeViolations.set('v1', violation);

    const zone = makeZone('v1');
    document.activeElement = focusInZone(zone, 'x0');

    const captured = captureBlockInsert(vm);

    const handler = capturePasteHandler(vm);
    await handler(textPasteEvent('второй абзац'));

    assert.equal(captured.insertIndex, 1, 'после блока x0, а не в конец (было бы 3)');
});

test('фокус в блоке, которого уже нет в модели — вставка в конец', async () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(2);
    vm.activeViolations.set('v1', violation);

    const zone = makeZone('v1');
    // Обёртка пережила блок (stale DOM между мутацией и ререндером).
    document.activeElement = focusInZone(zone, 'ghost');

    const captured = captureBlockInsert(vm);

    const handler = capturePasteHandler(vm);
    await handler(textPasteEvent('текст'));

    assert.equal(captured.insertIndex, 2, 'неизвестный блок — падаем на конец поля');
});

test('#19-Б: Ctrl+V в contenteditable не перехватывается даже при фокусе на зоне', async () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(1);
    vm.activeViolations.set('v1', violation);

    const zone = makeZone('v1');
    document.activeElement = { closest: (s) => (s === '.violation-blocks-wrapper' ? zone : null) };

    let called = false;
    vm.addBlockAtPosition = () => { called = true; return true; };

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
    vm.addBlockAtPosition = () => { called = true; return true; };

    const e = textPasteEvent('hello');
    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.equal(called, false);
    assert.equal(e._prevented(), false, 'стандартная вставка не тронута');
});

// --- §5.8: интеграция ветки картинок при каретке в rich-поле зоны ---

/**
 * Событие вставки с произвольным набором items. html по умолчанию совпадает с
 * text — комбинированный буфер (разные text/html и text/plain) задаётся явно.
 */
function pasteEvent(items, target, text = '', html = text) {
    let prevented = false;
    let stopped = false;
    return {
        target,
        clipboardData: { items, getData: (type) => (type === 'text/html' ? html : text) },
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; },
        _prevented: () => prevented,
        _stopped: () => stopped,
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
    vm.promptQualityThenInsertImages = (v, fieldKey, container, insertIndex, files) => {
        captured = { v, fieldKey, container, insertIndex, files };
    };

    const file = { name: 'a.png', type: 'image/png', size: 100 };
    const e = pasteEvent([{ type: 'image/png', getAsFile: () => file }], target);

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.ok(captured, 'конвейер картинок запущен из rich-поля зоны');
    assert.equal(captured.container, zone, 'контейнер = зона от каретки (e.target)');
    assert.equal(captured.fieldKey, FIELD, 'ключ поля взят из dataset зоны');
    assert.equal(captured.insertIndex, 2, 'каретка вне блоков — вставка в конец поля');
    assert.deepEqual(captured.files, [file]);
    assert.equal(e._prevented(), true, 'вставку картинки перехватили');
});

test('§5.8: каретка в rich-поле блока — картинка встаёт сразу за этим блоком', async () => {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(3); // блоки x0, x1, x2
    vm.activeViolations.set('v1', violation);

    const zone = makeZone('v1');
    document.activeElement = null;
    const target = editableTarget({ inZone: true, zone, blockId: 'x1' });

    let captured = null;
    vm.promptQualityThenInsertImages = (v, fieldKey, container, insertIndex) => {
        captured = { insertIndex };
    };

    const file = { name: 'a.png', type: 'image/png', size: 100 };
    const e = pasteEvent([{ type: 'image/png', getAsFile: () => file }], target);

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.equal(captured.insertIndex, 2, 'после блока x1, а не в конец (было бы 3)');
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
    vm.addBlockAtPosition = () => { added = true; return true; };
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
    document.activeElement = { closest: (s) => (s === '.violation-blocks-wrapper' ? zone : null) };

    let called = false;
    vm.promptQualityThenInsertImages = () => { called = true; };

    const target = editableTarget({ inZone: false });
    const e = pasteEvent([{ type: 'image/png', getAsFile: () => ({ name: 'a.png', type: 'image/png', size: 1 }) }], target);

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.equal(called, false, 'картинка не уходит в зону из поля вне неё');
    assert.equal(e._prevented(), false, 'вставка редактора не перехвачена');
});

// --- №5: классификация буфера (чисто картинка / комбо / чисто текст) ---

test('№5: картинка без текста → images (прежний конвейер зоны)', () => {
    assert.equal(classifyClipboardPayload({ hasImages: true, html: '', plain: '' }), 'images');
});

test('№5: картинка + текст → combo (спрашиваем пользователя)', () => {
    assert.equal(
        classifyClipboardPayload({ hasImages: true, html: '<table><tr><td>42</td></tr></table>', plain: '42' }),
        'combo',
    );
});

test('№5: пустые строки — это НЕ текст (image + пустая text/plain → images)', () => {
    assert.equal(classifyClipboardPayload({ hasImages: true, html: '', plain: '' }), 'images');
    assert.equal(classifyClipboardPayload({ hasImages: true, html: '', plain: '   \n\t' }), 'images');
});

test('№5: «Копировать изображение» браузера (html из одного <img>) → images, не combo', () => {
    const html = '<meta charset=\'utf-8\'><img src="https://example.com/a.png">';
    assert.equal(classifyClipboardPayload({ hasImages: true, html, plain: '' }), 'images');
});

test('№5: служебная обвязка Excel/Word текстом не считается', () => {
    // <style> и условные комментарии Word есть даже у пустого диапазона.
    const junk = '<!--[if gte mso 9]><xml><o:p/></xml><![endif]-->'
        + '<style>td { mso-number-format:General; }</style><table><tr><td></td></tr></table>';
    assert.equal(clipboardHasText(junk, ''), false);
    assert.equal(classifyClipboardPayload({ hasImages: true, html: junk, plain: '' }), 'images');

    // Тот же диапазон, но с содержимым ячейки — уже текст.
    const withCell = junk.replace('<td></td>', '<td>Итого</td>');
    assert.equal(clipboardHasText(withCell, ''), true);
    assert.equal(classifyClipboardPayload({ hasImages: true, html: withCell, plain: '' }), 'combo');
});

test('№5: без картинок → text / none', () => {
    assert.equal(classifyClipboardPayload({ hasImages: false, html: '', plain: 'привет' }), 'text');
    assert.equal(classifyClipboardPayload({ hasImages: false, html: '<p>привет</p>', plain: '' }), 'text');
    assert.equal(classifyClipboardPayload({ hasImages: false, html: '', plain: '' }), 'none');
    assert.equal(classifyClipboardPayload({ hasImages: false, html: '<br>', plain: '  ' }), 'none');
});

test('№5: &nbsp; без букв текстом не считается', () => {
    assert.equal(clipboardHasText('<p>&nbsp;&nbsp;</p>', ''), false);
    assert.equal(clipboardHasText('<p>&nbsp;текст</p>', ''), true);
});

// --- №5: интеграция комбинированного буфера через захваченный обработчик ---

const COMBO_HTML = '<table><tr><td>Выручка</td><td>42</td></tr></table>';
const COMBO_PLAIN = 'Выручка\t42';

/** Окружение комбо-вставки: зона, нарушение, rich-поле-хост и событие. */
function comboFixture({ imageFile = { name: 'a.png', type: 'image/png', size: 100 } } = {}) {
    AppConfig.readOnlyMode.isReadOnly = false;
    const vm = new ViolationManager();
    const violation = makeViolation(2);
    vm.activeViolations.set('v1', violation);

    const zone = makeZone('v1');
    document.activeElement = null;

    const field = { __focused: false, focus() { this.__focused = true; }, contains: () => false };
    const target = editableTarget({ inZone: true, zone, field });
    const e = pasteEvent(
        [{ type: 'image/png', getAsFile: () => imageFile }, { type: 'text/plain', getAsFile: () => null }],
        target, COMBO_PLAIN, COMBO_HTML,
    );

    return { vm, violation, zone, field, e, imageFile };
}

/** Подменяет диалог выбора и конвейеры, куда он разводит буфер. */
function stubPasteRoutes(vm, choice) {
    const calls = [];
    DialogManager.show = async () => choice;
    textBlockManager.pasteClipboardPayload = (editor, html, plain) => {
        calls.push({ route: 'text', editor, html, plain });
    };
    vm.promptQualityThenInsertImages = (v, fieldKey, container, insertIndex, files) => {
        calls.push({ route: 'image', fieldKey, container, insertIndex, files });
    };
    return calls;
}

test('№5: комбинированный буфер в rich-поле гасит событие и спрашивает пользователя', async () => {
    const { vm, e } = comboFixture();
    let asked = false;
    DialogManager.show = async () => { asked = true; return false; };
    vm.promptQualityThenInsertImages = () => assert.fail('картинки не должны вставляться без выбора');

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.equal(asked, true, 'показан диалог выбора');
    assert.equal(e._prevented(), true, 'нативная вставка отменена');
    assert.equal(e._stopped(), true, 'событие не доходит до обработчика поля (иначе дубль текста)');
});

test('№5: «Только текст» — конвейер редактора со снятым буфером, картинки не вставляются', async () => {
    const { vm, e, field } = comboFixture();
    const calls = stubPasteRoutes(vm, 'text');

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.deepEqual(calls.map(c => c.route), ['text']);
    assert.equal(calls[0].editor, field, 'вставка в поле, породившее событие');
    assert.equal(calls[0].html, COMBO_HTML, 'html снят синхронно и дожил до вставки');
    assert.equal(calls[0].plain, COMBO_PLAIN);
    assert.equal(field.__focused, true, 'фокус возвращён в поле после диалога');
});

test('№5: «Только изображение» — конвейер зоны, текст в поле не вставляется', async () => {
    const { vm, e, zone, imageFile } = comboFixture();
    const calls = stubPasteRoutes(vm, 'image');

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.deepEqual(calls.map(c => c.route), ['image']);
    assert.equal(calls[0].container, zone);
    assert.equal(calls[0].fieldKey, FIELD);
    assert.equal(calls[0].insertIndex, 2, 'каретка вне блоков — вставка в конец поля');
    assert.deepEqual(calls[0].files, [imageFile]);
});

test('№5: «Текст и изображение» — сначала текст в поле, затем картинки в зону', async () => {
    const { vm, e } = comboFixture();
    const calls = stubPasteRoutes(vm, 'both');

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.deepEqual(calls.map(c => c.route), ['text', 'image'],
        'порядок важен: вставка картинок перерисовывает блоки поля');
});

test('№5: отмена диалога (Escape/крестик) не вставляет ничего', async () => {
    const { vm, e } = comboFixture();
    // Закрытие без кнопки резолвит служебным true (hideCancel) — это не выбор.
    const calls = stubPasteRoutes(vm, true);

    const handler = capturePasteHandler(vm);
    await handler(e);

    assert.deepEqual(calls, []);
});

test('№5: чисто картиночный буфер в rich-поле идёт прежним путём, без нового диалога', async () => {
    const { vm, e, zone, imageFile } = comboFixture();
    // Тот же фикстур, но буфер без текста: html/plain пустые.
    const clean = pasteEvent(
        [{ type: 'image/png', getAsFile: () => imageFile }],
        e.target, '', '',
    );
    DialogManager.show = async () => assert.fail('диалог выбора не нужен: текста в буфере нет');
    let inserted = null;
    vm.promptQualityThenInsertImages = (v, fieldKey, container, insertIndex, files) => {
        inserted = { container, insertIndex, files };
    };

    const handler = capturePasteHandler(vm);
    await handler(clean);

    assert.ok(inserted, 'диалог качества картинок как раньше');
    assert.equal(inserted.container, zone);
    assert.deepEqual(inserted.files, [imageFile]);
    assert.equal(clean._stopped(), false, 'событие не гасим — гасить нечего');
});
