/**
 * Клиентское сжатие картинок перед загрузкой (#25).
 *
 * Тестируется ЧИСТАЯ логика (выбор maxDim/quality по режиму, предикат
 * пережатия, пересчёт размеров, детекция альфы, синхронизация имени файла) и
 * сам конвейер downscaleImage на подставном canvas: WebP-путь, честный фолбэк
 * на JPEG в браузере без WebP-энкодера, сохранение прозрачности и размерный
 * гейт. Результат конвейера — Blob для отправки на сервер (байты в содержимом
 * акта больше не живут).
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

/**
 * Подставной canvas-конвейер: createImageBitmap + document.createElement.
 * Браузер без WebP-энкодера молча отдаёт PNG — стенд это воспроизводит.
 */
function installCanvasStub({
    bitmap = { width: 3000, height: 2000 },
    webpSupported = true,
    blobSize = 1000,
    pixels = null,
} = {}) {
    const encodeCalls = [];
    let drawnSize = null;

    globalThis.createImageBitmap = async () => ({
        width: bitmap.width,
        height: bitmap.height,
        close() {},
    });
    globalThis.document = {
        createElement: () => {
            const canvas = {
                width: 0,
                height: 0,
                getContext: () => ({
                    drawImage: (_bmp, _x, _y, w, h) => { drawnSize = { width: w, height: h }; },
                    getImageData: () => ({
                        data: pixels || new Uint8ClampedArray([1, 2, 3, 255]),
                    }),
                }),
                toBlob: (cb, type, quality) => {
                    encodeCalls.push({ type, quality });
                    const actual = (type === 'image/webp' && !webpSupported) ? 'image/png' : type;
                    cb({ type: actual, size: blobSize });
                },
            };
            return canvas;
        },
    };

    return { encodeCalls, drawn: () => drawnSize };
}

function uninstallCanvasStub() {
    delete globalThis.createImageBitmap;
    delete globalThis.document;
}

// --- resolveResizeMode ---

test('resolveResizeMode: high → 1920/0.9, medium → 1400/0.8', () => {
    assert.deepEqual(resolveResizeMode('high'), { maxDim: 1920, quality: 0.9 });
    assert.deepEqual(resolveResizeMode('medium'), { maxDim: 1400, quality: 0.8 });
    // Пресеты доступны и как таблица.
    assert.equal(RESIZE_PRESETS.high.maxDim, 1920);
    assert.equal(RESIZE_PRESETS.medium.quality, 0.8);
});

test('resolveResizeMode: original / неизвестный режим → null', () => {
    assert.equal(resolveResizeMode('original'), null);
    assert.equal(resolveResizeMode('zzz'), null);
    assert.equal(resolveResizeMode(undefined), null);
});

// --- shouldDownscale (ветка пропуска GIF/original) ---

test('shouldDownscale: JPEG, PNG и WebP пережимаются в high и medium', () => {
    assert.equal(shouldDownscale('image/jpeg', 'high'), true);
    assert.equal(shouldDownscale('image/jpeg', 'medium'), true);
    assert.equal(shouldDownscale('image/png', 'high'), true);
    assert.equal(shouldDownscale('image/png', 'medium'), true);
    assert.equal(shouldDownscale('image/webp', 'high'), true);
    assert.equal(shouldDownscale('image/webp', 'medium'), true);
});

test('shouldDownscale: режим original — никогда не пережимаем', () => {
    assert.equal(shouldDownscale('image/jpeg', 'original'), false);
    assert.equal(shouldDownscale('image/png', 'original'), false);
    assert.equal(shouldDownscale('image/webp', 'original'), false);
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

// --- downscaleImage: skip-ветки (без canvas) ---

test('downscaleImage: mode=original не трогает байты — возвращает исходный файл', async () => {
    const file = { type: 'image/jpeg', name: 'p.jpg', size: 5000 };
    assert.equal(await downscaleImage(file, { mode: 'original' }), file);
});

test('downscaleImage: GIF в сжатии → оригинал (перекодировка убила бы анимацию)', async () => {
    const file = { type: 'image/gif', name: 'a.gif', size: 5000 };
    assert.equal(await downscaleImage(file, { mode: 'high' }), file);
});

test('downscaleImage: сбой canvas (нет createImageBitmap) → оригинал', async () => {
    const file = { type: 'image/png', name: 'a.png', size: 5000 };
    assert.equal(await downscaleImage(file, { mode: 'high' }), file);
});

// --- downscaleImage: конвейер на подставном canvas ---

test('downscaleImage: PNG-скриншот перекодируется в WebP с качеством режима', async (t) => {
    const stub = installCanvasStub({ bitmap: { width: 3000, height: 2000 }, blobSize: 300 });
    t.after(uninstallCanvasStub);

    const file = { type: 'image/png', name: 'shot.png', size: 900000 };
    const result = await downscaleImage(file, { mode: 'high' });

    assert.equal(result.type, 'image/webp');
    assert.deepEqual(stub.encodeCalls, [{ type: 'image/webp', quality: 0.9 }]);
    // Длинная сторона ужата до maxDim пресета high.
    assert.deepEqual(stub.drawn(), { width: 1920, height: 1280 });
});

test('downscaleImage: прозрачный PNG в WebP-пути перекодируется (альфу WebP держит)', async (t) => {
    const transparent = new Uint8ClampedArray([1, 2, 3, 0]);
    installCanvasStub({ bitmap: { width: 800, height: 600 }, blobSize: 100, pixels: transparent });
    t.after(uninstallCanvasStub);

    const file = { type: 'image/png', name: 'logo.png', size: 5000 };
    const result = await downscaleImage(file, { mode: 'high' });

    assert.equal(result.type, 'image/webp', 'прозрачность больше не повод отдавать оригинал');
});

test('downscaleImage: браузер без WebP → честный фолбэк на JPEG', async (t) => {
    const stub = installCanvasStub({
        bitmap: { width: 3000, height: 2000 }, webpSupported: false, blobSize: 300,
    });
    t.after(uninstallCanvasStub);

    const file = { type: 'image/png', name: 'shot.png', size: 900000 };
    const result = await downscaleImage(file, { mode: 'medium' });

    assert.equal(result.type, 'image/jpeg');
    assert.deepEqual(
        stub.encodeCalls,
        [{ type: 'image/webp', quality: 0.8 }, { type: 'image/jpeg', quality: 0.8 }],
        'сначала пробуем WebP, затем JPEG — по ФАКТИЧЕСКОМУ типу blob, а не по аргументу',
    );
});

test('downscaleImage: браузер без WebP + прозрачный PNG → оригинал (JPEG схлопнул бы альфу)', async (t) => {
    const transparent = new Uint8ClampedArray([1, 2, 3, 10]);
    const stub = installCanvasStub({
        bitmap: { width: 3000, height: 2000 },
        webpSupported: false,
        blobSize: 100,
        pixels: transparent,
    });
    t.after(uninstallCanvasStub);

    const file = { type: 'image/png', name: 'logo.png', size: 5000 };
    const result = await downscaleImage(file, { mode: 'high' });

    assert.equal(result, file);
    assert.deepEqual(stub.encodeCalls, [{ type: 'image/webp', quality: 0.9 }], 'до JPEG не дошли');
});

test('downscaleImage: размер в пикселях не менялся и результат тяжелее → оригинал', async (t) => {
    installCanvasStub({ bitmap: { width: 800, height: 600 }, blobSize: 9000 });
    t.after(uninstallCanvasStub);

    const file = { type: 'image/png', name: 'icon.png', size: 4000 };
    assert.equal(await downscaleImage(file, { mode: 'high' }), file);
});

test('downscaleImage: картинка реально ужата — берём перекодированную даже если она тяжелее', async (t) => {
    installCanvasStub({ bitmap: { width: 5000, height: 4000 }, blobSize: 9000 });
    t.after(uninstallCanvasStub);

    const file = { type: 'image/jpeg', name: 'photo.jpg', size: 4000 };
    const result = await downscaleImage(file, { mode: 'high' });

    assert.equal(result.type, 'image/webp', 'пиксельный размер важнее последнего килобайта');
});

// --- resolveActualFilename (#12: имя файла должно отражать факт перекодирования) ---

test('resolveActualFilename: PNG перекодирован в WebP → расширение .webp', () => {
    const file = { type: 'image/png', name: 'screenshot.png' };
    assert.equal(resolveActualFilename(file, { type: 'image/webp' }), 'screenshot.webp');
});

test('resolveActualFilename: базовое имя с точками сохраняется, меняется только расширение', () => {
    const file = { type: 'image/png', name: 'screenshot.v2.final.png' };
    assert.equal(resolveActualFilename(file, { type: 'image/webp' }), 'screenshot.v2.final.webp');
});

test('resolveActualFilename: имя без расширения → просто добавляется .webp', () => {
    const file = { type: 'image/png', name: 'screenshot' };
    assert.equal(resolveActualFilename(file, { type: 'image/webp' }), 'screenshot.webp');
});

test('resolveActualFilename: JPEG-фолбэк → расширение .jpg', () => {
    const file = { type: 'image/png', name: 'screenshot.png' };
    assert.equal(resolveActualFilename(file, { type: 'image/jpeg' }), 'screenshot.jpg');
});

test('resolveActualFilename: перекодировки не было (тот же MIME) → имя не тронуто', () => {
    const file = { type: 'image/jpeg', name: 'photo.jpg' };
    assert.equal(resolveActualFilename(file, { type: 'image/jpeg' }), 'photo.jpg');
});

test('resolveActualFilename: режим original (вернулся сам файл) → имя не тронуто', () => {
    const file = { type: 'image/png', name: 'screenshot.png' };
    assert.equal(resolveActualFilename(file, file), 'screenshot.png');
});

test('resolveActualFilename: имя уже с верным расширением → не переименовывается повторно', () => {
    const png = { type: 'image/png', name: 'mislabeled.jpeg' };
    assert.equal(resolveActualFilename(png, { type: 'image/jpeg' }), 'mislabeled.jpeg');
    const jpeg = { type: 'image/jpeg', name: 'already.webp' };
    assert.equal(resolveActualFilename(jpeg, { type: 'image/webp' }), 'already.webp');
});

test('resolveActualFilename: неизвестный MIME результата → имя не тронуто', () => {
    const file = { type: 'image/png', name: 'screenshot.png' };
    assert.equal(resolveActualFilename(file, { type: 'application/octet-stream' }), 'screenshot.png');
});
