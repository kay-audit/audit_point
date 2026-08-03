/**
 * Клиентский даунскейл картинок перед вставкой (#25).
 *
 * Тестируется ЧИСТАЯ логика: выбор maxDim/quality по режиму, предикат
 * пережатия (JPEG/PNG — да; GIF/original — нет), пересчёт размеров с
 * сохранением аспекта, детекция альфы по RGBA-буферу (hasTransparentPixels),
 * и skip/degrade-ветки downscaleImage (original/GIF → оригинал по типу; PNG в
 * node без canvas → оригинал через catch-деградацию). Сам canvas-конвейер
 * (createImageBitmap/toBlob/getImageData) в node без DOM не исполняется — это
 * LIVE-проверка (см. task-13-report).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    RESIZE_PRESETS,
    resolveResizeMode,
    shouldDownscale,
    computeScaledSize,
    hasTransparentPixels,
    downscaleImage,
    resolveActualFilename,
} from '../../static/js/constructor/violation/violation-image-resize.js';

// --- resolveResizeMode ---

test('resolveResizeMode: high → 1600/0.8, medium → 1200/0.7', () => {
    assert.deepEqual(resolveResizeMode('high'), { maxDim: 1600, quality: 0.8 });
    assert.deepEqual(resolveResizeMode('medium'), { maxDim: 1200, quality: 0.7 });
    // Пресеты доступны и как таблица.
    assert.equal(RESIZE_PRESETS.high.maxDim, 1600);
    assert.equal(RESIZE_PRESETS.medium.quality, 0.7);
});

test('resolveResizeMode: original / неизвестный режим → null', () => {
    assert.equal(resolveResizeMode('original'), null);
    assert.equal(resolveResizeMode('zzz'), null);
    assert.equal(resolveResizeMode(undefined), null);
});

// --- shouldDownscale (ветка пропуска GIF/original; PNG теперь пережимается) ---

test('shouldDownscale: JPEG и PNG пережимаются в high и medium', () => {
    assert.equal(shouldDownscale('image/jpeg', 'high'), true);
    assert.equal(shouldDownscale('image/jpeg', 'medium'), true);
    assert.equal(shouldDownscale('image/png', 'high'), true);
    assert.equal(shouldDownscale('image/png', 'medium'), true);
});

test('shouldDownscale: режим original — никогда не пережимаем', () => {
    assert.equal(shouldDownscale('image/jpeg', 'original'), false);
    assert.equal(shouldDownscale('image/png', 'original'), false);
});

test('shouldDownscale: GIF в сжатии НЕ пережимается (анимация)', () => {
    assert.equal(shouldDownscale('image/gif', 'high'), false);
    assert.equal(shouldDownscale('image/gif', 'medium'), false);
});

// --- hasTransparentPixels (чистая проверка альфа-канала по RGBA-буферу) ---

test('hasTransparentPixels: пустой буфер → нет прозрачных пикселей', () => {
    assert.equal(hasTransparentPixels(new Uint8ClampedArray([])), false);
});

test('hasTransparentPixels: все альфа-байты 255 → непрозрачно', () => {
    // 3 пикселя RGBA, альфа всегда 255.
    const data = new Uint8ClampedArray([
        10, 20, 30, 255,
        40, 50, 60, 255,
        70, 80, 90, 255,
    ]);
    assert.equal(hasTransparentPixels(data), false);
});

test('hasTransparentPixels: один пиксель с alpha < 255 в конце буфера → прозрачно', () => {
    const data = new Uint8ClampedArray([
        10, 20, 30, 255,
        40, 50, 60, 255,
        70, 80, 90, 254, // последний пиксель чуть прозрачный
    ]);
    assert.equal(hasTransparentPixels(data), true);
});

test('hasTransparentPixels: большой буфер, единственный прозрачный пиксель в середине → находится', () => {
    const pixelCount = 10000;
    const data = new Uint8ClampedArray(pixelCount * 4).fill(255);
    const transparentPixelIndex = 5000;
    data[transparentPixelIndex * 4 + 3] = 0; // альфа середины буфера
    assert.equal(hasTransparentPixels(data), true);
});

// --- computeScaledSize (сохранение аспекта, без апскейла) ---

test('computeScaledSize: длинная сторона > maxDim → масштаб с сохранением аспекта', () => {
    assert.deepEqual(computeScaledSize(3200, 2400, 1600), { width: 1600, height: 1200 });
    assert.deepEqual(computeScaledSize(2400, 3200, 1600), { width: 1200, height: 1600 });
});

test('computeScaledSize: обе стороны ≤ maxDim → без апскейла', () => {
    assert.deepEqual(computeScaledSize(800, 600, 1600), { width: 800, height: 600 });
    assert.deepEqual(computeScaledSize(1600, 900, 1600), { width: 1600, height: 900 });
});

test('computeScaledSize: вырожденные размеры → возвращаются как есть', () => {
    assert.deepEqual(computeScaledSize(0, 0, 1600), { width: 0, height: 0 });
});

// --- downscaleImage: skip/degrade-ветки (без canvas) ---

test('downscaleImage: mode=original не трогает байты — читает оригинал', async () => {
    let readArg = null;
    const fakeReader = (f) => { readArg = f; return Promise.resolve('data:orig'); };
    const file = { type: 'image/jpeg', name: 'p.jpg' };

    const url = await downscaleImage(file, { mode: 'original', readAsDataUrl: fakeReader });

    assert.equal(url, 'data:orig');
    assert.equal(readArg, file, 'прочитан именно оригинальный файл, canvas не задействован');
});

test('downscaleImage: GIF в сжатии → оригинал (JPEG убил бы анимацию)', async () => {
    const file = { type: 'image/gif', name: 'a.gif' };
    const url = await downscaleImage(file, { mode: 'high', readAsDataUrl: () => Promise.resolve('data:gif') });
    assert.equal(url, 'data:gif');
});

// PNG больше не пропускается по типу до декодирования (shouldDownscale теперь
// true) — в node нет createImageBitmap/document, поэтому конвейер падает в
// catch и деградирует к оригиналу так же, как любой другой сбой canvas.
// Настоящая проверка альфы (hasTransparentPixels) — LIVE, в браузере.
test('downscaleImage: PNG в сжатии в node (без canvas) → оригинал через catch-деградацию', async () => {
    const file = { type: 'image/png', name: 'a.png', size: 5000 };
    const url = await downscaleImage(file, { mode: 'high', readAsDataUrl: () => Promise.resolve('data:png') });
    assert.equal(url, 'data:png');
});

// --- resolveActualFilename (#12: имя файла должно отражать факт перекодирования) ---

test('resolveActualFilename: непрозрачный PNG перекодирован в JPEG → расширение .jpg', () => {
    const file = { type: 'image/png', name: 'screenshot.png' };
    const name = resolveActualFilename(file, 'data:image/jpeg;base64,AAAA');
    assert.equal(name, 'screenshot.jpg');
});

test('resolveActualFilename: базовое имя с точками сохраняется, меняется только расширение', () => {
    const file = { type: 'image/png', name: 'screenshot.v2.final.png' };
    const name = resolveActualFilename(file, 'data:image/jpeg;base64,AAAA');
    assert.equal(name, 'screenshot.v2.final.jpg');
});

test('resolveActualFilename: имя без расширения → просто добавляется .jpg', () => {
    const file = { type: 'image/png', name: 'screenshot' };
    const name = resolveActualFilename(file, 'data:image/jpeg;base64,AAAA');
    assert.equal(name, 'screenshot.jpg');
});

test('resolveActualFilename: прозрачный PNG остался PNG → имя не тронуто', () => {
    const file = { type: 'image/png', name: 'screenshot.png' };
    const name = resolveActualFilename(file, 'data:image/png;base64,AAAA');
    assert.equal(name, 'screenshot.png');
});

test('resolveActualFilename: JPEG-оригинал (пережат, формат не изменился) → имя не тронуто', () => {
    const file = { type: 'image/jpeg', name: 'photo.jpg' };
    const name = resolveActualFilename(file, 'data:image/jpeg;base64,AAAA');
    assert.equal(name, 'photo.jpg');
});

test('resolveActualFilename: режим original (PNG не пережат, url = исходный PNG) → имя не тронуто', () => {
    const file = { type: 'image/png', name: 'screenshot.png' };
    const name = resolveActualFilename(file, 'data:image/png;base64,AAAA');
    assert.equal(name, 'screenshot.png');
});

test('resolveActualFilename: PNG-файл с уже .jpeg-именем (нетипично) → не переименовывается повторно', () => {
    const file = { type: 'image/png', name: 'mislabeled.jpeg' };
    const name = resolveActualFilename(file, 'data:image/jpeg;base64,AAAA');
    assert.equal(name, 'mislabeled.jpeg');
});
