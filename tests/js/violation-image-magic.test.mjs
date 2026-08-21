/**
 * Проверка содержимого картинки по магическим байтам (#26).
 *
 * detectImageMagic — чистый матчинг сигнатур PNG/JPEG/GIF/WebP по первым
 * байтам (у WebP сигнатура из двух кусков: RIFF + WEBP с 8-го байта).
 * sniffImageMagic — async-обёртка (file.slice(0,12).arrayBuffer()) с фильтром
 * по списку разрешённых типов. Отклоняет мусор и переименованные не-картинки
 * (напр. PDF/EXE с расширением .png).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    detectImageMagic,
    sniffImageMagic,
    DEFAULT_ALLOWED_IMAGE_MIME,
    RECOGNIZED_IMAGE_FORMATS,
} from '../../static/js/constructor/violation/violation-file-reading.js';

/** Файл-стаб с рабочим slice().arrayBuffer() поверх заданных байтов. */
function fileWith(bytes, type = 'image/png') {
    return { type, name: 'x', slice: () => new Blob([new Uint8Array(bytes)]) };
}

// --- detectImageMagic ---

/** RIFF <4 байта длины> WEBP — минимальная валидная сигнатура WebP. */
const WEBP_HEADER = [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

test('detectImageMagic: распознаёт WebP по паре RIFF + WEBP', () => {
    assert.equal(detectImageMagic(WEBP_HEADER), 'image/webp');
});

test('detectImageMagic: одного RIFF мало — WAV/AVI не проходят как картинка', () => {
    // RIFF....WAVE — тот же контейнер, но не картинка.
    const wav = [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45];
    assert.equal(detectImageMagic(wav), null);
});

test('detectImageMagic: распознаёт PNG / JPEG / GIF87a / GIF89a', () => {
    assert.equal(detectImageMagic([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]), 'image/png');
    assert.equal(detectImageMagic([0xFF, 0xD8, 0xFF, 0xE0]), 'image/jpeg');
    assert.equal(detectImageMagic([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), 'image/gif'); // GIF89a
    assert.equal(detectImageMagic([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]), 'image/gif'); // GIF87a
});

test('detectImageMagic: мусор и пустой буфер → null', () => {
    assert.equal(detectImageMagic([0x00, 0x01, 0x02, 0x03]), null);
    assert.equal(detectImageMagic([0x25, 0x50, 0x44, 0x46]), null); // %PDF
    assert.equal(detectImageMagic([]), null);
});

test('detectImageMagic: принимает и Uint8Array, и обычный массив', () => {
    assert.equal(detectImageMagic(new Uint8Array([0xFF, 0xD8, 0xFF])), 'image/jpeg');
});

// --- sniffImageMagic ---

test('sniffImageMagic: валидные PNG/JPEG/GIF/WebP принимаются', async () => {
    assert.equal(await sniffImageMagic(fileWith(WEBP_HEADER, 'image/webp')), true);
    assert.equal(await sniffImageMagic(fileWith([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0])), true);
    assert.equal(await sniffImageMagic(fileWith([0xFF, 0xD8, 0xFF, 0, 0, 0, 0, 0], 'image/jpeg')), true);
    assert.equal(await sniffImageMagic(fileWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0], 'image/gif')), true);
});

test('sniffImageMagic: переименованный не-картиночный файл (PDF в .png) отклоняется', async () => {
    assert.equal(await sniffImageMagic(fileWith([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0])), false);
});

test('sniffImageMagic: случайный мусор отклоняется', async () => {
    assert.equal(await sniffImageMagic(fileWith([0xDE, 0xAD, 0xBE, 0xEF, 0, 0, 0, 0])), false);
});

test('sniffImageMagic: тип не в allowed-списке отклоняется даже при валидной сигнатуре', async () => {
    const gif = fileWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0], 'image/gif');
    assert.equal(await sniffImageMagic(gif, ['image/jpeg', 'image/png']), false);
});

test('sniffImageMagic: сбой чтения (нет slice) → false, без исключения', async () => {
    assert.equal(await sniffImageMagic({ type: 'image/png' }), false);
});

// --- производные списки (4A: sniffer — единый источник истины) ---

test('DEFAULT_ALLOWED_IMAGE_MIME производен от сигнатур sniffer\'а (4 формата, включая webp)', () => {
    // Список allowed-типов и то, что sniffer умеет подтвердить, не могут разъехаться.
    assert.deepEqual(
        DEFAULT_ALLOWED_IMAGE_MIME,
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    );
    // Каждый allowed-тип реально распознаётся sniffer'ом (нет типа без сигнатуры).
    const sample = {
        'image/png': [0x89, 0x50, 0x4E, 0x47],
        'image/jpeg': [0xFF, 0xD8, 0xFF],
        'image/gif': [0x47, 0x49, 0x46, 0x38],
        'image/webp': WEBP_HEADER,
    };
    for (const mime of DEFAULT_ALLOWED_IMAGE_MIME) {
        assert.equal(detectImageMagic(sample[mime]), mime);
    }
});

test('RECOGNIZED_IMAGE_FORMATS — человекочитаемые ярлыки, производные от сигнатур', () => {
    assert.deepEqual(RECOGNIZED_IMAGE_FORMATS, ['PNG', 'JPEG', 'GIF', 'WEBP']);
});
