/**
 * Валидатор приёма картинок нарушений (H6) — разнесён на тип (ДО чтения) и
 * размер (ПОСЛЕ сжатия, #2/#25).
 *
 * validateImageType: MIME, число элементов, абсурдный сырой потолок.
 * validateImageBytes: ТОЛЬКО per-file лимит по реальным байтам отправки —
 * суммарный бюджет акта считает сервер (байты живут в act_images, клиент их
 * не видит). Лимиты передаются явно — fetch /acts/limits в node-тестах не
 * дёргается.
 */
import './_browser-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ABSURD_RAW_MAX_BYTES,
    DEFAULT_IMAGE_LIMITS,
    validateImageType,
    validateImageBytes,
} from '../../static/js/constructor/violation/violation-image-validator.js';
import { AppConfig } from '../../static/js/shared/app-config.js';

const LIMITS = {
    maxFileSize: 1000,
    maxTotalSizePerAct: 3000,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
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

test('достигнут лимит блоков поля → отказ, текст из единой точки app-config.js (№14)', () => {
    const res = validateImageType(file(), { itemsCount: 3, limits: LIMITS });
    assert.equal(res.ok, false);
    assert.match(res.reason, /лимит блоков/);
    // №14: текст не хардкодится тут — берётся из AppConfig.content.errors.
    // contentItemsLimitReached, той же точки, что и paste/undo-гейт.
    assert.equal(res.reason, AppConfig.content.errors.contentItemsLimitReached(3));
});

test('отсутствующий файл → отказ без исключения', () => {
    assert.equal(validateImageType(null, { limits: LIMITS }).ok, false);
});

// --- validateImageBytes (ПОСЛЕ сжатия: только per-file) ---

test('ужатый файл больше per-file лимита отклоняется с причиной про размер', () => {
    const res = validateImageBytes(1001, { limits: LIMITS });
    assert.equal(res.ok, false);
    assert.match(res.reason, /слишком большой/);
});

test('причина отказа НЕ несёт имя файла — его подставляет группировщик отказов пачки', () => {
    const res = validateImageBytes(1001, { limits: LIMITS });
    assert.equal(res.reason.includes('«'), false);
});

test('ужатый файл ровно в per-file лимит проходит', () => {
    assert.equal(validateImageBytes(1000, { limits: LIMITS }).ok, true);
});

test('суммарный бюджет акта клиентом НЕ проверяется — это забота сервера', () => {
    // Файл вчетверо больше суммарного лимита акта, но в per-file укладывается:
    // клиент его пропускает, отказ (422) придёт с сервера при загрузке.
    const res = validateImageBytes(900, { limits: { ...LIMITS, maxTotalSizePerAct: 100 } });
    assert.equal(res.ok, true);
});

test('дефолтные лимиты зеркалят ACTS__IMAGES__* (10МБ/50МБ/50, webp разрешён)', () => {
    assert.equal(DEFAULT_IMAGE_LIMITS.maxFileSize, 10 * 1024 * 1024);
    assert.equal(DEFAULT_IMAGE_LIMITS.maxTotalSizePerAct, 50 * 1024 * 1024);
    assert.equal(DEFAULT_IMAGE_LIMITS.maxItemsPerViolation, 50);
    assert.equal(DEFAULT_IMAGE_LIMITS.imageMaxHeightPercent, 40);
    assert.deepEqual(
        DEFAULT_IMAGE_LIMITS.allowedMimeTypes,
        ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    );
});

test('перечень разрешённых форматов в отказе берётся из ЖИВОГО allowlist', () => {
    const res = validateImageType(
        { name: 'evil.svg', type: 'image/svg+xml', size: 10 },
        { limits: { ...LIMITS, allowedMimeTypes: ['image/png', 'image/webp'] } },
    );
    assert.equal(res.ok, false);
    assert.match(res.reason, /Разрешены: PNG, WEBP\./);
});
