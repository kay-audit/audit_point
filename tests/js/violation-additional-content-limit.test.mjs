/**
 * Единый фронт-гейт лимита 50 доп.элементов на нарушение (находка аудита #4).
 *
 * Раньше лимит проверялся на фронте ТОЛЬКО для картинок (validateImageFile);
 * кейсы и произвольный текст добавлялись без счёта, и бэкенд резал >50
 * элементов разом на весь акт (HTTP 422). Теперь addContentItemAtPosition —
 * единая точка вставки (меню / paste / DnD) — сверяет
 * violation.additionalContent.items.length с getImageLimits().maxItemsPerViolation
 * для ЛЮБОГО типа элемента и отказывает единообразно.
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
import {
    CONTENT_TYPE_CASE,
    CONTENT_TYPE_FREE_TEXT,
    CONTENT_TYPE_IMAGE,
} from '../../static/js/constructor/violation/violation-content-item.js';
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
PreviewManager.updateBlock = (type, id) => previewCalls.push({ type, id });

function reset(maxItemsPerViolation) {
    warnings = [];
    successes = [];
    errors = [];
    previewCalls = [];
    AppConfig.readOnlyMode.isReadOnly = false;
    resetImageLimitsForTests();
    getImageLimits().maxItemsPerViolation = maxItemsPerViolation;
}

/** Минимальный существующий элемент (тип роли не играет для гейта). */
function existingItem(id, type = CONTENT_TYPE_CASE) {
    return { id, type, content: '' };
}

function makeViolation(items) {
    return { id: 'v1', additionalContent: { enabled: true, items } };
}

/** Стаб контейнера с рабочим querySelector('.additional-content-items'). */
function makeContainer() {
    const itemsContainer = { innerHTML: '', appendChild() {} };
    return {
        querySelector: (sel) => (sel === '.additional-content-items' ? itemsContainer : null),
    };
}

// --- Гейт лимита: отказ для кейса и текста (не только картинки) ---

test('лимит достигнут: добавление кейса отклоняется, items не меняется', () => {
    reset(1);
    const violation = makeViolation([existingItem('c0')]);
    const vm = new ViolationManager();

    const result = vm.addContentItemAtPosition(violation, CONTENT_TYPE_CASE, {}, 1, { content: 'новый кейс' });

    assert.equal(result, false);
    assert.equal(violation.additionalContent.items.length, 1, 'элемент не добавлен');
    assert.equal(warnings.length, 1, 'показан ровно один warning');
    assert.match(warnings[0], /лимит/i);
    assert.match(warnings[0], /1/, 'сообщение содержит число лимита');
    // №14: текст — из единой точки формирования (app-config.js), не хардкод.
    assert.equal(warnings[0], AppConfig.content.errors.contentItemsLimitReached(1));
    assert.deepEqual(previewCalls, [], 'превью не обновляется при отказе');
});

test('лимит достигнут: добавление произвольного текста отклоняется, items не меняется', () => {
    reset(2);
    const violation = makeViolation([existingItem('c0'), existingItem('c1', CONTENT_TYPE_FREE_TEXT)]);
    const vm = new ViolationManager();

    const result = vm.addContentItemAtPosition(violation, CONTENT_TYPE_FREE_TEXT, {}, 2, { content: 'текст' });

    assert.equal(result, false);
    assert.equal(violation.additionalContent.items.length, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /лимит/i);
});

test('лимит достигнут: добавление картинки отклоняется тем же единым гейтом', () => {
    reset(1);
    const violation = makeViolation([existingItem('c0', CONTENT_TYPE_IMAGE)]);
    const vm = new ViolationManager();

    const result = vm.addContentItemAtPosition(violation, CONTENT_TYPE_IMAGE, {}, 1, { url: 'data:x', filename: 'a.png' });

    assert.equal(result, false);
    assert.equal(violation.additionalContent.items.length, 1);
    assert.equal(warnings.length, 1);
});

// --- Под лимитом: вставка проходит, возвращается true ---

test('items.length < лимита: кейс добавляется, возвращается true, превью обновляется', () => {
    reset(3);
    const violation = makeViolation([existingItem('c0')]);
    const vm = new ViolationManager();
    const container = makeContainer();

    const result = vm.addContentItemAtPosition(violation, CONTENT_TYPE_CASE, container, 1, { content: 'второй кейс' });

    assert.equal(result, true);
    assert.equal(violation.additionalContent.items.length, 2);
    assert.equal(violation.additionalContent.items[1].type, CONTENT_TYPE_CASE);
    assert.equal(violation.additionalContent.items[1].content, 'второй кейс');
    assert.equal(warnings.length, 0);
    assert.equal(previewCalls.length, 1, 'превью обновилось ровно один раз');
});

test('items.length < лимита: свободный текст добавляется, возвращается true', () => {
    reset(5);
    const violation = makeViolation([]);
    const vm = new ViolationManager();
    const container = makeContainer();

    const result = vm.addContentItemAtPosition(violation, CONTENT_TYPE_FREE_TEXT, container, 0, { content: 'первый текст' });

    assert.equal(result, true);
    assert.equal(violation.additionalContent.items.length, 1);
    assert.equal(violation.additionalContent.items[0].type, CONTENT_TYPE_FREE_TEXT);
});

test('впритык (items.length === лимит - 1): вставка ещё проходит, следующая уже нет', () => {
    reset(2);
    const violation = makeViolation([existingItem('c0')]);
    const vm = new ViolationManager();
    const container = makeContainer();

    const first = vm.addContentItemAtPosition(violation, CONTENT_TYPE_CASE, container, 1, { content: 'второй' });
    assert.equal(first, true);
    assert.equal(violation.additionalContent.items.length, 2);

    const second = vm.addContentItemAtPosition(violation, CONTENT_TYPE_CASE, container, 2, { content: 'третий' });
    assert.equal(second, false);
    assert.equal(violation.additionalContent.items.length, 2, 'третий элемент не добавлен');
    assert.equal(warnings.length, 1);
});

// --- Батч-путь insertImageFilesInOrder: гейт не должен завышать addedCount ---

/** Мини-стаб FileReader — возвращает детерминированный data-URL на файл. */
class FakeFileReader {
    readAsDataURL(file) {
        Promise.resolve().then(() => {
            if (this.onload) this.onload({ target: { result: `data:image/png;base64,${file.name}` } });
        });
    }
}

/** Файл-стаб картинки с рабочим slice() (для magic-sniff #26). PNG → ресайз пропускается. */
function imgFile(name, size = 100) {
    return {
        name,
        type: 'image/png',
        size,
        slice: () => new Blob([new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])]),
    };
}

test('insertImageFilesInOrder: гейт срабатывает в середине пачки — цикл останавливается, addedCount не завышен', async () => {
    reset(2); // лимит: максимум 2 элемента на нарушение
    globalThis.FileReader = FakeFileReader;

    const violation = makeViolation([existingItem('c0')]); // уже 1 элемент, лимит 2 → влезет ровно 1 картинка
    const vm = new ViolationManager();
    const container = makeContainer();

    const files = [imgFile('a.png'), imgFile('b.png'), imgFile('c.png')];

    await vm.insertImageFilesInOrder(violation, container, 1, files);

    // Влезла только первая картинка (1 существующий + 1 новый = 2 = лимит).
    assert.equal(violation.additionalContent.items.length, 2);
    assert.equal(violation.additionalContent.items[1].type, CONTENT_TYPE_IMAGE);
    assert.equal(violation.additionalContent.items[1].filename, 'a.png');

    // Тост об успехе отражает РЕАЛЬНОЕ число добавленных (1), а не длину пачки (3).
    assert.deepEqual(successes, ['Изображение добавлено']);
    // Гейт лимита успел показать warning ровно один раз (не по разу на оставшиеся файлы).
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /лимит/i);
    // №14: тот же текст, что и у остальных гейтов лимита (app-config.js).
    assert.equal(warnings[0], AppConfig.content.errors.contentItemsLimitReached(2));
    assert.deepEqual(errors, [], 'ошибок чтения файлов не было');
});

test('insertImageFilesInOrder: лимит не достигнут — все файлы вставляются, addedCount корректен', async () => {
    reset(5);
    globalThis.FileReader = FakeFileReader;

    const violation = makeViolation([]);
    const vm = new ViolationManager();
    const container = makeContainer();

    const files = [imgFile('a.png'), imgFile('b.png')];

    await vm.insertImageFilesInOrder(violation, container, 0, files);

    assert.equal(violation.additionalContent.items.length, 2);
    assert.deepEqual(successes, ['Добавлено изображений: 2']);
    assert.equal(warnings.length, 0);
});
