/**
 * Валидатор приёма картинок нарушений (H6) — разнесён на тип (ДО чтения) и
 * размер (ПОСЛЕ ресайза, #2/#25).
 *
 * validateImageType: MIME, число элементов, абсурдный сырой потолок.
 * validateImageBytes: per-file и суммарный лимит акта по УЖАТЫМ байтам.
 * Плюс оценка байтов по data-URL. Лимиты передаются явно — fetch /acts/limits
 * в node-тестах не дёргается.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ABSURD_RAW_MAX_BYTES,
    DEFAULT_IMAGE_LIMITS,
    estimateActImageBytes,
    estimateDataUrlBytes,
    validateImageType,
    validateImageBytes,
} from '../../static/js/constructor/violation/violation-image-validator.js';
import { AppConfig } from '../../static/js/shared/app-config.js';

const LIMITS = {
    maxFileSize: 1000,
    maxTotalSizePerAct: 3000,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
    maxItemsPerViolation: 3,
    imageMaxHeightPercent: 40,
};

function file(overrides = {}) {
    return Object.assign({ name: 'img.png', type: 'image/png', size: 500 }, overrides);
}

// --- validateImageType (ДО чтения: тип + число + абсурдный потолок) ---

test('валидный тип проходит', () => {
    const res = validateImageType(file(), { itemsCount: 0, limits: LIMITS });
    assert.equal(res.ok, true);
    assert.equal(res.reason, '');
});

test('SVG отклоняется (XSS-вектор, нет в whitelist)', () => {
    const res = validateImageType(file({ type: 'image/svg+xml', name: 'evil.svg' }), { limits: LIMITS });
    assert.equal(res.ok, false);
    assert.match(res.reason, /Недопустимый тип/);
});

test('не-картинка (pdf) и пустой MIME отклоняются', () => {
    assert.equal(validateImageType(file({ type: 'application/pdf' }), { limits: LIMITS }).ok, false);
    assert.equal(validateImageType(file({ type: '' }), { limits: LIMITS }).ok, false);
});

test('validateImageType НЕ проверяет обычный размер — крупный сырой файл проходит по типу', () => {
    // 10 МБ сырого JPEG проходит тип-гейт: реальный размерный гейт — после ресайза.
    const res = validateImageType(file({ type: 'image/jpeg', size: 10 * 1024 * 1024 }), { limits: LIMITS });
    assert.equal(res.ok, true);
});

test('абсурдный сырой потолок отсекает гигантский файл до чтения', () => {
    const res = validateImageType(file({ size: ABSURD_RAW_MAX_BYTES + 1 }), { limits: LIMITS });
    assert.equal(res.ok, false);
    assert.match(res.reason, /для обработки/);
});

test('достигнут лимит элементов на нарушение → отказ, текст из единой точки app-config.js (№14)', () => {
    const res = validateImageType(file(), { itemsCount: 3, limits: LIMITS });
    assert.equal(res.ok, false);
    assert.match(res.reason, /лимит элементов/);
    // №14: текст не хардкодится тут — берётся из AppConfig.content.errors.
    // contentItemsLimitReached, той же точки, что и paste/undo-гейт.
    assert.equal(res.reason, AppConfig.content.errors.contentItemsLimitReached(3));
});

test('отсутствующий файл → отказ без исключения', () => {
    assert.equal(validateImageType(null, { limits: LIMITS }).ok, false);
});

// --- validateImageBytes (ПОСЛЕ ресайза: per-file + суммарный по акту) ---

test('ужатый файл больше per-file лимита отклоняется с причиной про размер', () => {
    const res = validateImageBytes(1001, { name: 'a.jpg', limits: LIMITS });
    assert.equal(res.ok, false);
    assert.match(res.reason, /слишком большой/);
});

test('ужатый файл ровно в per-file лимит проходит', () => {
    assert.equal(validateImageBytes(1000, { limits: LIMITS }).ok, true);
});

test('превышение суммарного лимита акта отклоняется', () => {
    const res = validateImageBytes(600, { existingTotalBytes: 2500, name: 'a.jpg', limits: LIMITS });
    assert.equal(res.ok, false);
    assert.match(res.reason, /Суммарный размер/);
});

test('суммарный лимит впритык проходит', () => {
    const res = validateImageBytes(500, { existingTotalBytes: 2500, limits: LIMITS });
    assert.equal(res.ok, true);
});

test('интеграция: existingTotalBytes (estimateActImageBytes) и ужатые байты — одна единица', () => {
    // base64-payload длиной 2667 символов оценивается в ~2000 сырых байт
    // (2667 * 0.75 = 2000.25 → округление до 2000). existingTotalBytes и байты
    // нового файла — обе величины в сырых байтах, единица одна.
    const url = `data:image/png;base64,${'A'.repeat(2667)}`;
    const violations = { v1: { additionalContent: { blocks: [{ type: 'image', url }] } } };
    const existingTotalBytes = estimateActImageBytes(violations);
    assert.equal(existingTotalBytes, 2000);

    const res = validateImageBytes(900, { existingTotalBytes, limits: LIMITS });
    assert.equal(res.ok, true);
});

test('дефолтные лимиты зеркалят ACTS__IMAGES__* (4МБ/5МБ/50)', () => {
    assert.equal(DEFAULT_IMAGE_LIMITS.maxFileSize, 4 * 1024 * 1024);
    assert.equal(DEFAULT_IMAGE_LIMITS.maxTotalSizePerAct, 5 * 1024 * 1024);
    assert.equal(DEFAULT_IMAGE_LIMITS.maxItemsPerViolation, 50);
    assert.equal(DEFAULT_IMAGE_LIMITS.imageMaxHeightPercent, 40);
    assert.deepEqual(
        DEFAULT_IMAGE_LIMITS.allowedMimeTypes,
        ['image/jpeg', 'image/png', 'image/gif'],
    );
});

// --- Оценка байтов ---

test('estimateDataUrlBytes: 4 символа base64 ≈ 3 байта, префикс не считается', () => {
    const url = `data:image/png;base64,${'A'.repeat(4000)}`;
    assert.equal(estimateDataUrlBytes(url), 3000);
});

test('estimateDataUrlBytes: не-data строка → 0', () => {
    assert.equal(estimateDataUrlBytes('https://x/y.png'), 0);
    assert.equal(estimateDataUrlBytes(''), 0);
    assert.equal(estimateDataUrlBytes(null), 0);
});

test('estimateActImageBytes суммирует image-блоки ВСЕХ полей всех нарушений', () => {
    const url1k = `data:image/png;base64,${'A'.repeat(1000)}`;
    const violations = {
        v1: {
            additionalContent: {
                enabled: true,
                blocks: [
                    { type: 'image', url: url1k },
                    { type: 'text', content: 'не считается' },
                ],
            },
            // Блочная модель: картинка может лежать в любом поле реестра.
            codeMining: { enabled: true, blocks: [{ type: 'image', url: url1k }] },
        },
        v2: { additionalContent: { enabled: false, blocks: [{ type: 'image', url: url1k }] } },
        v3: {},
    };
    assert.equal(estimateActImageBytes(violations), 2250);
});

test('estimateActImageBytes на пустом/отсутствующем словаре → 0', () => {
    assert.equal(estimateActImageBytes({}), 0);
    assert.equal(estimateActImageBytes(null), 0);
});
