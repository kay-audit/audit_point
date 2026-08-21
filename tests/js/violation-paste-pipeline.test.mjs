/**
 * Единый конвейер приёма картинок (paste/drop/upload) + bulk-вставка
 * (находки аудита #28/#29) на ссылочной модели картинок.
 *
 * #28 — Ctrl+V больше НЕ берёт только последнюю картинку буфера и не читает
 * своим инлайн-FileReader'ом: все image-элементы буфера собираются в File[],
 * прогоняются через filterAcceptedImageFiles и insertImageFilesInOrder — ТОТ
 * ЖЕ путь, что drop/upload.
 *
 * #29 — insertImageFilesInOrder вставляет пачку РАЗОМ: один renderBlocks на
 * всю пачку вместо O(N²) перерисовки на каждый файл. Блоки при этом пишутся
 * мутатором addBlock (единственный путь записи в модель), поэтому превью
 * планируется на каждый блок — схлопывает их RAF-дедуп PreviewManager.
 * Единая точка гейта — _insertBlocksBulk — сохраняет лимит #4 (теперь ПО
 * ПОЛЮ) и read-only-guard #1.
 *
 * Байты картинки уходят на сервер (POST /acts/{id}/images), в блок ложится
 * только image_id — поэтому стенд подменяет fetch и проверяет, что именно
 * ушло и что попало в модель. Отказ загрузки не должен ни ронять пачку, ни
 * заваливать пользователя пачкой одинаковых тостов.
 *
 * Реальные модули конструктора импортируются под node:test через
 * _browser-stub (см. конвенцию в violation-blocks-limit.test.mjs).
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppConfig } from '../../static/js/shared/app-config.js';
import { Notifications } from '../../static/js/shared/notifications.js';
import { PreviewManager } from '../../static/js/constructor/preview/preview.js';
import '../../static/js/constructor/violation/violation-init.js';
import { ViolationManager } from '../../static/js/constructor/violation/violation-core.js';
import { BLOCK_TYPES } from '../../static/js/constructor/violation/violation-block-types.js';
import {
    getImageLimits,
    resetImageLimitsForTests,
} from '../../static/js/constructor/violation/violation-image-validator.js';

// Шпионы: собираем вызовы вместо реальных side-эффектов (тосты/превью).
let warnings = [];
let successes = [];
let errors = [];
let stickyShown = [];
let stickyHidden = [];
let previewCalls = [];
let uploads = [];
let failUploads = new Set();
Notifications.warning = (msg) => warnings.push(msg);
Notifications.success = (msg) => successes.push(msg);
Notifications.error = (msg) => errors.push(msg);
Notifications.show = (msg, type, duration) => {
    stickyShown.push({ msg, type, duration });
    return `n${stickyShown.length}`;
};
Notifications.hide = (id) => stickyHidden.push(id);
PreviewManager.updateBlock = (type, id) => previewCalls.push({ type, id });

/** Тихий console.error: отказ загрузки логируется намеренно. */
const realConsoleError = console.error;

function reset(maxItemsPerViolation = 50) {
    warnings = [];
    successes = [];
    errors = [];
    stickyShown = [];
    stickyHidden = [];
    previewCalls = [];
    uploads = [];
    failUploads = new Set();
    AppConfig.readOnlyMode.isReadOnly = false;
    resetImageLimitsForTests();
    getImageLimits().maxItemsPerViolation = maxItemsPerViolation;
    document.activeElement = null;
    console.error = () => {};

    // Акт-контекст загрузки + база URL (в стабах window.location нет).
    globalThis.location = { origin: 'http://test', pathname: '/' };
    AppConfig.api._resetCache();
    window.currentActId = 7;

    globalThis.fetch = async (url, opts) => {
        const uploaded = opts.body.get('file');
        uploads.push({ url, filename: uploaded.name, type: uploaded.type });
        if (failUploads.has(uploaded.name)) {
            return {
                ok: false,
                status: 409,
                json: async () => ({
                    detail: 'Акт заблокирован другим пользователем',
                    code: 'act-locked',
                }),
            };
        }
        return { ok: true, json: async () => ({ image_id: `img-${uploaded.name}` }) };
    };
}

function restore() {
    console.error = realConsoleError;
}

/**
 * Ставит фокус внутри зоны: под focus-моделью (#19) целевая зона paste
 * берётся из document.activeElement.closest('.violation-blocks-wrapper').
 */
function focusZone(container) {
    document.activeElement = {
        closest: (sel) => (sel === '.violation-blocks-wrapper' ? container : null),
    };
}

/** Поле, в которое ведётся вставка (зона paste адресуется ключом поля). */
const FIELD = 'additionalContent';

function makeViolation(blocks = []) {
    return { id: 'v1', [FIELD]: { enabled: true, blocks } };
}

/** Стаб контейнера с рабочим querySelector('.violation-blocks-items'). */
function makeContainer(violationId = 'v1', fieldKey = FIELD) {
    const itemsContainer = {
        innerHTML: '', appendChild() {}, dataset: { violationId, fieldKey },
    };
    return {
        querySelector: (sel) => (sel === '.violation-blocks-items' ? itemsContainer : null),
    };
}

/** Настоящий PNG-файл (сигнатура для magic-sniff #26 + рабочий slice/размер). */
function imgFile(name) {
    const bytes = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    ]);
    return new File([bytes], name, { type: 'image/png' });
}

/** Файл с картиночным MIME, но мусорным содержимым (magic-sniff отклонит). */
function fakeImgFile(name) {
    return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])],
        name, { type: 'image/png' });
}

/**
 * Синтетическое событие вставки: image-элементы + опциональный text/plain.
 * getAsFile у картинок возвращает File-стаб, у текста — null (как в браузере).
 */
function makeClipboardEvent(files, { text = null } = {}) {
    const items = files.map((f) => ({ type: f.type, getAsFile: () => f }));
    if (text !== null) {
        items.push({ type: 'text/plain', getAsFile: () => null });
    }
    return {
        target: { tagName: 'DIV' },
        clipboardData: { items, getData: () => text ?? '' },
        preventDefault() {},
    };
}

/** Ставит paste-обработчик и возвращает захваченный колбэк. */
function capturePasteHandler(vm) {
    let handler = null;
    const orig = document.addEventListener;
    document.addEventListener = (type, cb) => {
        if (type === 'paste') handler = cb;
    };
    vm.setupPasteHandler();
    document.addEventListener = orig;
    return handler;
}

// --- #28: Ctrl+V собирает ВСЕ картинки и гонит их через общий конвейер ---

test('#28 Ctrl+V с несколькими картинками: ВСЕ идут в единый конвейер, не только последняя', async (t) => {
    reset();
    t.after(restore);
    const vm = new ViolationManager();
    const violation = makeViolation();
    const container = makeContainer();
    focusZone(container);
    vm.activeViolations.set('v1', violation);

    // Спай конвейера: захватываем, что реально передали (после filterAcceptedImageFiles).
    // Единая точка входа из paste — promptQualityThenInsertImages (диалог Q3 → сжатие).
    let captured = null;
    vm.promptQualityThenInsertImages = (v, key, c, idx, files) => {
        captured = { v, key, c, idx, files };
    };

    const handler = capturePasteHandler(vm);
    await handler(makeClipboardEvent([imgFile('a.png'), imgFile('b.png'), imgFile('c.png')]));

    assert.ok(captured, 'конвейер promptQualityThenInsertImages вызван');
    assert.equal(captured.files.length, 3, 'переданы ВСЕ три картинки, не только последняя');
    assert.deepEqual(captured.files.map((f) => f.name), ['a.png', 'b.png', 'c.png'], 'порядок сохранён');
    assert.equal(captured.idx, 0, 'insertIndex = конец поля (пустое поле → 0)');
    assert.equal(captured.c, container, 'целевой контейнер = зона по фокусу');
    assert.equal(captured.key, FIELD, 'ключ поля взят из dataset контейнера зоны');
    assert.equal(captured.v, violation);
});

test('#1 read-only: Ctrl+V не запускает конвейер вставки', async (t) => {
    reset();
    t.after(restore);
    AppConfig.readOnlyMode.isReadOnly = true;
    const vm = new ViolationManager();
    const violation = makeViolation();
    const container = makeContainer();
    focusZone(container);
    vm.activeViolations.set('v1', violation);

    let called = false;
    vm.promptQualityThenInsertImages = () => {
        called = true;
    };

    const handler = capturePasteHandler(vm);
    await handler(makeClipboardEvent([imgFile('a.png'), imgFile('b.png')]));

    assert.equal(called, false, 'в режиме просмотра конвейер не вызывается');
});

test('#29 Ctrl+V текста: ровно один updateBlock (нет двойного апдейта превью)', async (t) => {
    reset();
    t.after(restore);
    const vm = new ViolationManager();
    const violation = makeViolation();
    const container = makeContainer();
    focusZone(container);
    vm.activeViolations.set('v1', violation);

    const handler = capturePasteHandler(vm);
    await handler(makeClipboardEvent([], { text: 'просто текст' }));

    assert.equal(violation[FIELD].blocks.length, 1, 'текст добавлен');
    assert.equal(violation[FIELD].blocks[0].type, BLOCK_TYPES.TEXT, 'текст стал текст-блоком');
    assert.equal(violation[FIELD].blocks[0].content, 'просто текст');
    assert.equal(previewCalls.length, 1, 'превью обновлено ровно один раз (нет двойного updateBlock)');
    assert.deepEqual(successes, ['Текст добавлен из буфера обмена']);
});

// --- #29: bulk-вставка insertImageFilesInOrder — один render, один updateBlock ---

test('#29 insertImageFilesInOrder: пачка → один renderBlocks на всю пачку', async (t) => {
    reset(50);
    t.after(restore);
    const vm = new ViolationManager();
    const violation = makeViolation();
    const container = makeContainer();

    let renderCalls = 0;
    vm.renderBlocks = () => {
        renderCalls += 1;
    };

    await vm.insertImageFilesInOrder(violation, FIELD, container, 0, [imgFile('a.png'), imgFile('b.png'), imgFile('c.png')]);

    assert.equal(violation[FIELD].blocks.length, 3, 'все три вставлены');
    assert.deepEqual(
        violation[FIELD].blocks.map((b) => b.filename),
        ['a.png', 'b.png', 'c.png'],
        'порядок пачки сохранён',
    );
    assert.ok(violation[FIELD].blocks.every((b) => b.type === BLOCK_TYPES.IMAGE));
    assert.equal(renderCalls, 1, 'ровно один render на всю пачку (не O(N))');
    assert.deepEqual(successes, ['Добавлено изображений: 3']);
    assert.equal(warnings.length, 0);
});

test('картинки уходят на сервер, в блок ложится только image_id', async (t) => {
    reset(50);
    t.after(restore);
    const vm = new ViolationManager();
    const violation = makeViolation();
    vm.renderBlocks = () => {};

    await vm.insertImageFilesInOrder(violation, FIELD, makeContainer(), 0, [imgFile('a.png')]);

    assert.deepEqual(uploads.map((u) => u.url), ['http://test/api/v1/acts/7/images']);
    assert.deepEqual(uploads.map((u) => u.filename), ['a.png']);
    const block = violation[FIELD].blocks[0];
    assert.equal(block.image_id, 'img-a.png');
    assert.equal(block.filename, 'a.png');
    assert.equal('url' in block, false, 'поля url в блоке больше нет — схема его отвергает');
});

test('на время загрузки висит ОДИН прогресс-тост, снимается по завершении', async (t) => {
    reset(50);
    t.after(restore);
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};

    await vm.insertImageFilesInOrder(
        makeViolation(), FIELD, makeContainer(), 0, [imgFile('a.png'), imgFile('b.png')]);

    assert.equal(stickyShown.length, 1, 'один тост на пачку, а не на файл');
    assert.equal(stickyShown[0].duration, 0, 'тост sticky — живёт, пока идёт загрузка');
    assert.match(stickyShown[0].msg, /Загрузка изображений: 2/);
    assert.deepEqual(stickyHidden, ['n1'], 'тост снят после завершения');
});

test('акт неизвестен → честная ошибка вместо пустых блоков', async (t) => {
    reset(50);
    t.after(restore);
    window.currentActId = null;
    const vm = new ViolationManager();
    const violation = makeViolation();

    await vm.insertImageFilesInOrder(violation, FIELD, makeContainer(), 0, [imgFile('a.png')]);

    assert.equal(violation[FIELD].blocks.length, 0);
    assert.equal(uploads.length, 0, 'без акта в сеть не ходим');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /акт/i);
});

test('#4 insertImageFilesInOrder: пачка сверх лимита → вставлено до лимита, один warning, один render', async (t) => {
    reset(2);
    t.after(restore);
    const vm = new ViolationManager();
    const violation = makeViolation([
        { id: 'x0', type: BLOCK_TYPES.IMAGE, image_id: 'img-x0', filename: 'x0.png' },
    ]);
    const container = makeContainer();

    let renderCalls = 0;
    vm.renderBlocks = () => {
        renderCalls += 1;
    };

    await vm.insertImageFilesInOrder(violation, FIELD, container, 1, [imgFile('a.png'), imgFile('b.png'), imgFile('c.png')]);

    assert.equal(violation[FIELD].blocks.length, 2, 'вставлено ровно до лимита');
    assert.equal(violation[FIELD].blocks[1].filename, 'a.png', 'влезла первая из пачки');
    assert.equal(renderCalls, 1, 'один render даже при обрезке по лимиту');
    assert.equal(previewCalls.length, 1, 'один updateBlock на единственный вставленный блок');
    assert.equal(warnings.length, 1, 'один warning на всю пачку, не по разу на файл');
    assert.match(warnings[0], /лимит/i);
    assert.match(warnings[0], /2/, 'сообщение содержит число лимита');
    assert.deepEqual(successes, ['Изображение добавлено'], 'тост отражает РЕАЛЬНОЕ число (1)');
});

test('#1 insertImageFilesInOrder: read-only bulk-guard — ничего не вставлено, render не вызван', async (t) => {
    reset(50);
    t.after(restore);
    AppConfig.readOnlyMode.isReadOnly = true;
    const vm = new ViolationManager();
    const violation = makeViolation();
    const container = makeContainer();

    let renderCalls = 0;
    vm.renderBlocks = () => {
        renderCalls += 1;
    };

    await vm.insertImageFilesInOrder(violation, FIELD, container, 0, [imgFile('a.png'), imgFile('b.png')]);

    assert.equal(violation[FIELD].blocks.length, 0, 'в режиме просмотра bulk ничего не вставляет');
    assert.equal(renderCalls, 0, 'render не вызывается');
    assert.equal(previewCalls.length, 0);
    assert.deepEqual(successes, [], 'нет ложного success-тоста');
});

test('#29 файл, не прошедший magic-sniff, пропущен — остальные вставлены одним render', async (t) => {
    reset(50);
    t.after(restore);
    const vm = new ViolationManager();
    const violation = makeViolation();

    let renderCalls = 0;
    vm.renderBlocks = () => {
        renderCalls += 1;
    };

    await vm.insertImageFilesInOrder(violation, FIELD, makeContainer(), 0, [
        imgFile('a.png'),
        fakeImgFile('fake.png'),
        imgFile('c.png'),
    ]);

    assert.deepEqual(
        violation[FIELD].blocks.map((b) => b.filename),
        ['a.png', 'c.png'],
        'мусорный файл пропущен, порядок остальных сохранён',
    );
    assert.equal(uploads.length, 2, 'на сервер ушли только распознанные');
    assert.equal(renderCalls, 1, 'один render на успешные');
    assert.equal(warnings.length, 1, 'отказ показан один раз');
    assert.match(warnings[0], /fake\.png/);
    assert.deepEqual(successes, ['Добавлено изображений: 2']);
});

test('отказ сервера показывается его текстом; одинаковая причина — ОДИН тост на всю пачку', async (t) => {
    reset(50);
    t.after(restore);
    failUploads = new Set(['a.png', 'b.png', 'c.png', 'd.png']);
    const vm = new ViolationManager();
    const violation = makeViolation();
    vm.renderBlocks = () => {};

    await vm.insertImageFilesInOrder(violation, FIELD, makeContainer(), 0, [
        imgFile('a.png'), imgFile('b.png'), imgFile('c.png'), imgFile('d.png'),
    ]);

    assert.equal(violation[FIELD].blocks.length, 0, 'блоков без картинки не создаём');
    assert.equal(warnings.length, 1, 'четыре одинаковых отказа — один тост');
    assert.match(warnings[0], /Акт заблокирован другим пользователем/, 'текст сервера как есть');
    assert.match(warnings[0], /«a\.png», «b\.png», «c\.png» и ещё 1/, 'список имён с усечением');
    assert.deepEqual(successes, [], 'ложного success нет');
});

test('часть пачки упала — успешные вставлены, отказ объяснён', async (t) => {
    reset(50);
    t.after(restore);
    failUploads = new Set(['b.png']);
    const vm = new ViolationManager();
    const violation = makeViolation();
    vm.renderBlocks = () => {};

    await vm.insertImageFilesInOrder(violation, FIELD, makeContainer(), 0, [
        imgFile('a.png'), imgFile('b.png'), imgFile('c.png'),
    ]);

    assert.deepEqual(violation[FIELD].blocks.map((b) => b.image_id), ['img-a.png', 'img-c.png']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /«b\.png»/);
    assert.deepEqual(successes, ['Добавлено изображений: 2']);
});
