/**
 * Клиентский даунскейл картинок перед вставкой в акт (#25).
 *
 * Фото с телефона (5-8 МБ JPEG) раздувают акт и упираются в суммарный лимит
 * (#2). Перед вставкой предлагаем пользователю режим сжатия (диалог качества,
 * Q3) и уменьшаем длинную сторону + перекодируем в JPEG на клиенте.
 *
 * Пережимаем JPEG и PNG. GIF (потеряет анимацию) в режимах сжатия отдаём как
 * есть. Непрозрачные PNG-скриншоты — самый массовый тип вложений в актах, и
 * раньше пропускались целиком наравне с прозрачными «на всякий случай»; теперь
 * прозрачность проверяется по факту декодированных пикселей — createImageBitmap
 * + canvas отдают честный альфа-канал даже для палитровых PNG с tRNS, так что
 * прежнее возражение про неточную детекцию снято. Полупрозрачные PNG остаются
 * оригиналом, непрозрачные перекодируются в JPEG наравне с фото. Защитный
 * размерный гейт (blob.size < file.size) не даёт перекодированному JPEG
 * проиграть исходнику по весу — актуально и для PNG со сплошным текстом/
 * линиями, и для обычного JPEG-пути.
 *
 * Чистая логика (resolveResizeMode / shouldDownscale / computeScaledSize /
 * hasTransparentPixels) и skip-ветки downscaleImage покрыты node-тестами; сам
 * canvas-конвейер (createImageBitmap / toBlob / getImageData) исполняется
 * только в браузере — LIVE.
 */

import { readFileAsDataUrl } from './violation-file-reading.js';

/** Пресеты режимов сжатия: длинная сторона (px) и качество JPEG (0..1). */
export const RESIZE_PRESETS = {
    high: { maxDim: 1600, quality: 0.8 },   // «Сжатие» (по умолчанию)
    medium: { maxDim: 1200, quality: 0.7 }, // «Среднее»
};

/**
 * Возвращает пресет режима сжатия либо null для 'original'/неизвестного.
 *
 * @param {string} mode - Режим ('high' | 'medium' | 'original')
 * @returns {{maxDim: number, quality: number} | null}
 */
export function resolveResizeMode(mode) {
    return RESIZE_PRESETS[mode] || null;
}

/**
 * Нужно ли пережимать файл: JPEG/PNG и только в режиме сжатия.
 *
 * Итоговое решение по PNG (сохранить прозрачный оригинал или перекодировать
 * непрозрачный в JPEG) принимается позже, в downscaleImage, по факту
 * декодированных пикселей — здесь только грубый фильтр по MIME-типу.
 *
 * @param {string} fileType - MIME-тип файла (file.type)
 * @param {string} mode - Выбранный режим качества
 * @returns {boolean}
 */
export function shouldDownscale(fileType, mode) {
    if (!resolveResizeMode(mode)) return false; // 'original' / неизвестный
    // GIF — анимация: JPEG её убьёт, пропускаем целиком.
    return fileType === 'image/jpeg' || fileType === 'image/png';
}

/**
 * Есть ли хоть один полупрозрачный/прозрачный пиксель в RGBA-буфере.
 *
 * Чистая функция без DOM/canvas — принимает уже декодированные пиксели
 * (например, ImageData.data). Шагает по каждому 4-му байту (альфа-канал).
 *
 * @param {Uint8ClampedArray|number[]} data - RGBA-буфер (4 байта на пиксель)
 * @returns {boolean}
 */
export function hasTransparentPixels(data) {
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
    }
    return false;
}

/**
 * Пересчитывает размеры под maxDim по длинной стороне с сохранением аспекта.
 * Апскейл не делаем (мелкие картинки остаются как есть).
 *
 * @param {number} width - Исходная ширина
 * @param {number} height - Исходная высота
 * @param {number} maxDim - Предел длинной стороны
 * @returns {{width: number, height: number}}
 */
export function computeScaledSize(width, height, maxDim) {
    const longSide = Math.max(width, height);
    if (!Number.isFinite(longSide) || longSide <= 0 || longSide <= maxDim) {
        return { width, height };
    }
    const scale = maxDim / longSide;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

/**
 * Читает файл в data-URL, при необходимости пережав его на canvas.
 *
 * Для 'original' и GIF (см. shouldDownscale) возвращает оригинальные байты
 * через обычный readAsDataURL. Для JPEG/PNG в режиме сжатия — уменьшает
 * длинную сторону до maxDim; для PNG дополнительно проверяет альфа-канал
 * уменьшенного изображения (hasTransparentPixels) и при наличии прозрачности
 * отдаёт оригинал, не перекодируя. Непрозрачные PNG и JPEG перекодируются в
 * JPEG с заданным quality, но только если это реально выигрывает в размере
 * (blob.size < file.size) — иначе тоже оригинал. Любой сбой canvas/bitmap
 * деградирует к оригиналу.
 *
 * @param {File|Blob} file - Исходный файл картинки
 * @param {Object} [options]
 * @param {string} [options.mode='high'] - Режим качества
 * @param {number} [options.maxDim] - Явный предел (по умолчанию из режима)
 * @param {number} [options.quality] - Явное качество (по умолчанию из режима)
 * @param {(f: File|Blob) => Promise<string>} [options.readAsDataUrl] - Чтение (для тестов)
 * @returns {Promise<string>} data-URL (ужатый JPEG или оригинал)
 */
export async function downscaleImage(file, options = {}) {
    const { mode = 'high', readAsDataUrl = readFileAsDataUrl } = options;

    if (!shouldDownscale(file.type, mode)) {
        return readAsDataUrl(file);
    }

    const preset = resolveResizeMode(mode);
    const maxDim = options.maxDim ?? preset.maxDim;
    const quality = options.quality ?? preset.quality;

    try {
        const bitmap = await createImageBitmap(file);
        try {
            const { width, height } = computeScaledSize(bitmap.width, bitmap.height, maxDim);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0, width, height);

            if (file.type === 'image/png') {
                // Альфа проверяется на уже уменьшенном canvas — дешевле, а
                // интерполяция drawImage сохраняет полупрозрачность (полностью
                // непрозрачный источник останется непрозрачным).
                const { data } = ctx.getImageData(0, 0, width, height);
                if (hasTransparentPixels(data)) return readAsDataUrl(file);
            }

            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
            // Защитный гейт: перекодированный JPEG отдаём, только если он
            // реально меньше исходника (актуально для PNG-скринов с текстом/
            // линиями, где JPEG может проиграть; заодно прикрывает и JPEG-путь).
            if (blob && blob.size < file.size) return readAsDataUrl(blob);
        } finally {
            if (typeof bitmap.close === 'function') bitmap.close();
        }
    } catch (_) {
        // Canvas/bitmap недоступны или упали (в т.ч. getImageData на tainted
        // canvas) — отдаём оригинал, как и остальные сбои конвейера.
    }
    return readAsDataUrl(file);
}

// Window-global для inline-скриптов шаблонов (guarded — модуль тестируется в node).
if (typeof window !== 'undefined') {
    window.ViolationImageResize = {
        downscaleImage,
        resolveResizeMode,
        shouldDownscale,
        computeScaledSize,
        hasTransparentPixels,
    };
}
