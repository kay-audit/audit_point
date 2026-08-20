/**
 * Единый фронт-гейт лимита блоков ПО ПОЛЮ нарушения (находка аудита #4,
 * блочная модель).
 *
 * Лимит `maxItemsPerViolation` применяется к каждому полю по отдельности
 * (зеркало бэкенда: ViolationFieldSchema.validate_blocks_count). Единая точка
 * — _insertBlocksBulk: через неё идут тулбар, ПКМ-меню, текст-паста и все три
 * пути приёма картинок. Переполнение пачки показывает ОДИН warning, а
 * addedCount не завышается.
 *
 * Реальные модули конструктора импортируются под node:test через
 * _browser-stub (см. конвенцию в violation-escape-zone.test.mjs).
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
let previewCalls = [];
Notifications.warning = (msg) => warnings.push(msg);
Notifications.success = (msg) => successes.push(msg);
Notifications.error = (msg) => errors.push(msg);
// Прогресс загрузки — sticky-тост через show/hide; в тестах он не интересен.
Notifications.show = () => 'n1';
Notifications.hide = () => {};
PreviewManager.updateBlock = (type, id) => previewCalls.push({ type, id });

const FIELD = 'additionalContent';

function reset(maxItemsPerViolation) {
    warnings = [];
    successes = [];
    errors = [];
    previewCalls = [];
    AppConfig.readOnlyMode.isReadOnly = false;
    resetImageLimitsForTests();
    getImageLimits().maxItemsPerViolation = maxItemsPerViolation;
}

/** Минимальный существующий блок (тип роли не играет для гейта). */
function existingBlock(id, type = BLOCK_TYPES.TEXT) {
    return { id, type, content: '' };
}

/** Нарушение с блоками в одном поле и пустым соседним полем. */
function makeViolation(blocks, fieldKey = FIELD) {
    return {
        id: 'v1',
        [fieldKey]: { enabled: true, blocks },
        reasons: { enabled: false, blocks: [] },
    };
}

/** Стаб контейнера с рабочим querySelector('.violation-blocks-items'). */
function makeContainer() {
    const itemsContainer = { innerHTML: '', appendChild() {} };
    return {
        querySelector: (sel) => (sel === '.violation-blocks-items' ? itemsContainer : null),
    };
}

/** Блоки поля по id — для компактных ассертов. */
const blocksOf = (v, fieldKey = FIELD) => v[fieldKey].blocks;

// --- Гейт лимита: отказ для любого типа блока ---

test('лимит достигнут: добавление текст-блока отклоняется, blocks не меняется', () => {
    reset(1);
    const violation = makeViolation([existingBlock('b0')]);
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};

    const result = vm.addBlockAtPosition(violation, FIELD, BLOCK_TYPES.TEXT, makeContainer(), 1, { content: 'новый' });

    assert.equal(result, false);
    assert.equal(blocksOf(violation).length, 1, 'блок не добавлен');
    assert.equal(warnings.length, 1, 'показан ровно один warning');
    assert.match(warnings[0], /лимит/i);
    assert.match(warnings[0], /1/, 'сообщение содержит число лимита');
    // №14: текст — из единой точки формирования (app-config.js), не хардкод.
    assert.equal(warnings[0], AppConfig.content.errors.contentItemsLimitReached(1));
    assert.deepEqual(previewCalls, [], 'превью не обновляется при отказе');
});

test('лимит достигнут: добавление таблицы отклоняется тем же единым гейтом', () => {
    reset(2);
    const violation = makeViolation([existingBlock('b0'), existingBlock('b1')]);
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};

    const result = vm.addBlockAtPosition(violation, FIELD, BLOCK_TYPES.TABLE, makeContainer(), 2);

    assert.equal(result, false);
    assert.equal(blocksOf(violation).length, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /лимит/i);
});

test('лимит считается ПО ПОЛЮ: переполненное поле не мешает соседнему', () => {
    reset(1);
    const violation = makeViolation([existingBlock('b0')]);
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};

    const blocked = vm.addBlockAtPosition(violation, FIELD, BLOCK_TYPES.TEXT, makeContainer(), 1);
    assert.equal(blocked, false, 'переполненное поле отказывает');

    const allowed = vm.addBlockAtPosition(violation, 'reasons', BLOCK_TYPES.TEXT, makeContainer(), 0);
    assert.equal(allowed, true, 'пустое соседнее поле принимает блок');
    assert.equal(blocksOf(violation, 'reasons').length, 1);
});

// --- Под лимитом: вставка проходит, возвращается true ---

test('blocks.length < лимита: текст-блок добавляется, превью обновляется', () => {
    reset(3);
    const violation = makeViolation([existingBlock('b0')]);
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};

    const result = vm.addBlockAtPosition(violation, FIELD, BLOCK_TYPES.TEXT, makeContainer(), 1, { content: 'второй' });

    assert.equal(result, true);
    assert.equal(blocksOf(violation).length, 2);
    assert.equal(blocksOf(violation)[1].type, BLOCK_TYPES.TEXT);
    assert.equal(blocksOf(violation)[1].content, 'второй');
    assert.equal(warnings.length, 0);
    assert.equal(previewCalls.length, 1, 'превью обновилось ровно один раз');
});

test('вставка в позицию сохраняет порядок блоков', () => {
    reset(5);
    const violation = makeViolation([existingBlock('b0'), existingBlock('b1')]);
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};

    vm.addBlockAtPosition(violation, FIELD, BLOCK_TYPES.TEXT, makeContainer(), 1, { content: 'середина' });

    assert.deepEqual(blocksOf(violation).map((b) => b.content), ['', 'середина', '']);
});

test('впритык (blocks.length === лимит - 1): вставка ещё проходит, следующая уже нет', () => {
    reset(2);
    const violation = makeViolation([existingBlock('b0')]);
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};
    const container = makeContainer();

    const first = vm.addBlockAtPosition(violation, FIELD, BLOCK_TYPES.TEXT, container, 1);
    assert.equal(first, true);
    assert.equal(blocksOf(violation).length, 2);

    const second = vm.addBlockAtPosition(violation, FIELD, BLOCK_TYPES.TEXT, container, 2);
    assert.equal(second, false);
    assert.equal(blocksOf(violation).length, 2, 'третий блок не добавлен');
    assert.equal(warnings.length, 1);
});

test('режим просмотра: вставка блока заблокирована requireWrite-гейтом', () => {
    reset(5);
    const violation = makeViolation([]);
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};

    AppConfig.readOnlyMode.isReadOnly = true;
    try {
        const result = vm.addBlockAtPosition(violation, FIELD, BLOCK_TYPES.TEXT, makeContainer(), 0);
        assert.equal(result, false);
    } finally {
        AppConfig.readOnlyMode.isReadOnly = false;
    }

    assert.equal(blocksOf(violation).length, 0);
});

// --- Батч-путь insertImageFilesInOrder: гейт не должен завышать addedCount ---

/**
 * Стенд загрузки: картинки уходят на сервер (POST /acts/{id}/images), в блок
 * ложится image_id. Стабим fetch, акт-контекст и базовый URL.
 */
function installUploadStub() {
    globalThis.location = { origin: 'http://test', pathname: '/' };
    AppConfig.api._resetCache();
    window.currentActId = 7;
    globalThis.fetch = async (_url, opts) => ({
        ok: true,
        json: async () => ({ image_id: `img-${opts.body.get('file').name}` }),
    });
}

/** Настоящий PNG-файл (сигнатура для magic-sniff #26). */
function imgFile(name) {
    const bytes = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    ]);
    return new File([bytes], name, { type: 'image/png' });
}

test('insertImageFilesInOrder: гейт срабатывает в середине пачки — цикл останавливается, addedCount не завышен', async () => {
    reset(2); // лимит: максимум 2 блока в поле
    installUploadStub();

    const violation = makeViolation([existingBlock('b0')]); // уже 1 блок, лимит 2 → влезет ровно 1 картинка
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};

    const files = [imgFile('a.png'), imgFile('b.png'), imgFile('c.png')];

    await vm.insertImageFilesInOrder(violation, FIELD, makeContainer(), 1, files);

    // Влезла только первая картинка (1 существующий + 1 новый = 2 = лимит).
    assert.equal(blocksOf(violation).length, 2);
    assert.equal(blocksOf(violation)[1].type, BLOCK_TYPES.IMAGE);
    assert.equal(blocksOf(violation)[1].filename, 'a.png');

    // Тост об успехе отражает РЕАЛЬНОЕ число добавленных (1), а не длину пачки (3).
    assert.deepEqual(successes, ['Изображение добавлено']);
    // Гейт лимита успел показать warning ровно один раз (не по разу на оставшиеся файлы).
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /лимит/i);
    // №14: тот же текст, что и у остальных гейтов лимита (app-config.js).
    assert.equal(warnings[0], AppConfig.content.errors.contentItemsLimitReached(2));
    assert.deepEqual(errors, [], 'ошибок загрузки не было');
});

test('insertImageFilesInOrder: лимит не достигнут — все файлы вставляются, addedCount корректен', async () => {
    reset(5);
    installUploadStub();

    const violation = makeViolation([]);
    const vm = new ViolationManager();
    vm.renderBlocks = () => {};

    const files = [imgFile('a.png'), imgFile('b.png')];

    await vm.insertImageFilesInOrder(violation, FIELD, makeContainer(), 0, files);

    assert.equal(blocksOf(violation).length, 2);
    assert.deepEqual(successes, ['Добавлено изображений: 2']);
    assert.equal(warnings.length, 0);
});
