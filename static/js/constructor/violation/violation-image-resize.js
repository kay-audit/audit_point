/**
 * Клиентский даунскейл картинок перед загрузкой в акт (#25).
 *
 * Фото с телефона (5-8 МБ JPEG) раздувают акт и упираются в суммарный лимит
 * (#2). Перед загрузкой предлагаем пользователю режим сжатия (диалог качества,
 * Q3) и уменьшаем длинную сторону + перекодируем на клиенте. Результат —
 * ГОТОВЫЕ К ОТПРАВКЕ БАЙТЫ (Blob), а не data-URL: картинка едет на сервер
 * multipart'ом, в содержимом акта остаётся только image_id.
 *
 * Целевой формат для 'high'/'medium' — WebP, не JPEG. Акты состоят из
 * скриншотов банковских систем с мелким текстом, а блочный DCT + chroma
 * subsampling JPEG дают вокруг букв ореолы; WebP на тех же 25-35% меньшем
 * весе держит края символов и, в отличие от JPEG, умеет прозрачность.
 * Пережимаем JPEG, PNG и WebP; GIF пропускаем целиком — canvas отдал бы
 * только первый кадр и убил анимацию.
 *
 * Прозрачность больше НЕ повод отказаться от перекодирования: альфа переживает
 * WebP. Проверка hasTransparentPixels осталась только в JPEG-фолбэке (браузер
 * без WebP-энкодера) — там альфа действительно схлопнулась бы в чёрное.
 *
 * Размерный гейт (перекодированное принимаем, только если оно легче исходника)
 * тоже сузился: он применяется, лишь когда РАЗМЕР В ПИКСЕЛЯХ не менялся. Если
 * длинная сторона реально ужата, отдаём перекодированное даже при большем
 * весе — иначе «Сжатие» тихо возвращало бы исходник в 5000 px, который потом
 * всё равно масштабируется в превью и в Word.
 *
 * Режим 'original' («Исходное») тоже перекодирует, но иначе: формат остаётся
 * СВОИМ (PNG → PNG, JPEG → JPEG), не WebP, а гейт всегда строгий («принять,
 * только если результат легче») — даже если предохранительный cap по стороне
 * что-то ужал. Смысл режима — не терять деталей и не менять формат, а не
 * «вообще ничего не делать»: PNG-скриншот, уже хорошо пожатый исходным
 * энкодером, после canvas.toBlob('image/png') вполне может распухнуть, и в
 * этом режиме такой результат обязан быть отброшен в пользу оригинала.
 *
 * Чистая логика (resolveResizeMode / shouldDownscale / computeScaledSize /
 * hasTransparentPixels / resolveActualFilename) и skip-ветки downscaleImage
 * покрыты node-тестами; сам canvas-конвейер (createImageBitmap / toBlob /
 * getImageData) исполняется только в браузере — LIVE.
 */

/**
 * Пресеты режимов сжатия: длинная сторона (px) и качество (0..1).
 *
 * `high` держит длинную сторону 1920 px намеренно: типичный скриншот FullHD
 * при этом не ресемплится ВООБЩЕ. Прежние 1600 давали дробный коэффициент
 * 0.83, который размывает однопиксельные штрихи букв сильнее, чем любая
 * перекодировка, — а вес отыгрывается качеством энкодера (WebP 0.9 ≈ JPEG 0.95
 * по чёткости при заметно меньшем файле). `medium` — режим «полегче»: 1400 px
 * и 0.8, там уже сознательный размен чёткости на вес.
 *
 * `original` («Исходное») — мягкий пресет: 4096 px (это выше типичного
 * 12-Мп телефонного фото ~4000 px по длинной стороне — ресемплится только
 * настоящий outlier вроде RAW-скана) и качество 0.95 — почти без потерь
 * там, где формат вообще lossy (JPEG/WebP). Для PNG quality каналом
 * toBlob игнорируется (PNG lossless), но это не проблема: размерный гейт
 * (см. pickSmaller ниже, вызывается с scaled=false) в этом режиме строгий
 * и без вариантов откатится к оригиналу, если перекодировка не выиграла в весе.
 */
export const RESIZE_PRESETS = {
    high: { maxDim: 1920, quality: 0.9 },     // «Сжатие» (по умолчанию)
    medium: { maxDim: 1400, quality: 0.8 },   // «Среднее»
    original: { maxDim: 4096, quality: 0.95 }, // «Исходное» — свой формат, мягкое сжатие
};

/** Расширение файла по MIME итоговых байтов. */
const EXTENSION_BY_MIME = {
    'image/webp': 'webp',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
};

/**
 * Возвращает пресет режима сжатия либо null для неизвестного режима.
 *
 * @param {string} mode - Режим ('high' | 'medium' | 'original')
 * @returns {{maxDim: number, quality: number} | null}
 */
export function resolveResizeMode(mode) {
    return RESIZE_PRESETS[mode] || null;
}

/**
 * Нужно ли пережимать файл: растр с одним кадром и только в известном режиме.
 *
 * @param {string} fileType - MIME-тип файла (file.type)
 * @param {string} mode - Выбранный режим качества
 * @returns {boolean}
 */
export function shouldDownscale(fileType, mode) {
    if (!resolveResizeMode(mode)) return false; // неизвестный режим
    // GIF — анимация: canvas отдаст только первый кадр, пропускаем целиком.
    return fileType === 'image/jpeg'
        || fileType === 'image/png'
        || fileType === 'image/webp';
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
 * Кодирует canvas в blob запрошенного типа. Браузер без энкодера этого формата
 * молча отдаёт PNG — поэтому проверяем ФАКТИЧЕСКИЙ blob.type, а не аргумент.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} mimeType - Желаемый MIME
 * @param {number} quality - Качество (0..1)
 * @returns {Promise<Blob|null>} Blob нужного типа либо null
 */
async function encodeCanvas(canvas, mimeType, quality) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
    return blob && blob.type === mimeType ? blob : null;
}

/**
 * Принимать ли перекодированные байты вместо исходных.
 *
 * Если пиксельный размер реально ужат — да, всегда (пользователь просил
 * уменьшить картинку, а не только её вес). Если размер не менялся, смысл
 * перекодировки только в весе: отдаём результат, лишь когда он легче.
 *
 * @param {Blob} blob - Перекодированные байты
 * @param {File|Blob} file - Исходный файл
 * @param {boolean} scaled - Менялся ли размер в пикселях
 * @returns {Blob} blob либо исходный file
 */
function pickSmaller(blob, file, scaled) {
    return (scaled || blob.size < file.size) ? blob : file;
}

/**
 * Готовит байты картинки к загрузке, при необходимости пережав их на canvas.
 *
 * Для GIF (см. shouldDownscale) возвращает исходный файл без изменений —
 * анимация. Для 'high'/'medium' уменьшает длинную сторону до maxDim и
 * перекодирует в WebP; браузер без WebP-энкодера получает JPEG-фолбэк, а
 * полупрозрачная картинка в этом фолбэке остаётся оригиналом (JPEG схлопнул
 * бы альфу). Для 'original' формат НЕ меняется (перекодирует в СВОЙ же MIME
 * файла) и гейт всегда строгий: результат принимается, только если он легче
 * оригинала, — если canvas.toBlob дал файл тяжелее исходника (типично для
 * уже хорошо пожатого PNG), отдаём оригинал байт-в-байт. Любой сбой
 * canvas/bitmap/toBlob деградирует к оригиналу.
 *
 * @param {File|Blob} file - Исходный файл картинки
 * @param {Object} [options]
 * @param {string} [options.mode='high'] - Режим качества
 * @param {number} [options.maxDim] - Явный предел (по умолчанию из режима)
 * @param {number} [options.quality] - Явное качество (по умолчанию из режима)
 * @returns {Promise<Blob>} Байты для отправки (перекодированные либо исходные)
 */
export async function downscaleImage(file, options = {}) {
    const { mode = 'high' } = options;

    if (!shouldDownscale(file.type, mode)) {
        return file;
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
            const scaled = width !== bitmap.width || height !== bitmap.height;

            if (mode === 'original') {
                // Формат — свой (PNG остаётся PNG, JPEG — JPEG); альфа не
                // страдает, т.к. целевой MIME совпадает с исходным (не JPEG-
                // фолбэк). Гейт строгий (scaled=false) независимо от того,
                // сработал ли предохранительный cap по стороне — режим
                // «Исходное» не должен ухудшать файл ни при каких условиях.
                const recoded = await encodeCanvas(canvas, file.type, quality);
                return recoded ? pickSmaller(recoded, file, false) : file;
            }

            const webp = await encodeCanvas(canvas, 'image/webp', quality);
            if (webp) return pickSmaller(webp, file, scaled);

            // WebP-энкодера в браузере нет — падаем на JPEG. Альфа его не
            // переживёт, поэтому полупрозрачное отдаём оригиналом. Проверяем
            // уже уменьшенный canvas: интерполяция drawImage сохраняет
            // полупрозрачность (непрозрачный источник останется непрозрачным).
            if (file.type !== 'image/jpeg') {
                const { data } = ctx.getImageData(0, 0, width, height);
                if (hasTransparentPixels(data)) return file;
            }

            const jpeg = await encodeCanvas(canvas, 'image/jpeg', quality);
            if (jpeg) return pickSmaller(jpeg, file, scaled);
        } finally {
            if (typeof bitmap.close === 'function') bitmap.close();
        }
    } catch (_) {
        // Canvas/bitmap недоступны или упали (в т.ч. getImageData на tainted
        // canvas) — отдаём оригинал, как и остальные сбои конвейера.
    }
    return file;
}

/**
 * Приводит имя файла к формату РЕАЛЬНО отправляемых байтов (#12).
 *
 * downscaleImage молча перекодирует картинку (обычно в WebP, в фолбэке — в
 * JPEG) — без синхронизации блок хранил бы имя «screenshot.png» при webp-теле,
 * и пользователь, скачавший файл из акта, получил бы неоткрываемое расширение.
 * Имя меняем только по ФАКТУ смены MIME; если расширение уже соответствует
 * итоговому типу, не трогаем.
 *
 * @param {File|Blob} file - Исходный файл (до пережатия): читает .type/.name
 * @param {Blob} result - Байты, фактически возвращённые downscaleImage
 * @returns {string} Имя файла с расширением, соответствующим факту
 */
export function resolveActualFilename(file, result) {
    const name = file.name || '';
    const mime = result && typeof result.type === 'string' ? result.type : '';
    const ext = EXTENSION_BY_MIME[mime];
    if (!ext || mime === file.type) return name;

    // Имя уже несёт верное расширение (для JPEG годятся оба варианта).
    const alreadyCorrect = mime === 'image/jpeg'
        ? /\.jpe?g$/i.test(name)
        : new RegExp(`\\.${ext}$`, 'i').test(name);
    if (alreadyCorrect) return name;

    const base = name.replace(/\.[^./\\]*$/, '');
    return `${base || 'image'}.${ext}`;
}

// Window-global для inline-скриптов шаблонов (guarded — модуль тестируется в node).
if (typeof window !== 'undefined') {
    window.ViolationImageResize = {
        downscaleImage,
        resolveResizeMode,
        shouldDownscale,
        computeScaledSize,
        hasTransparentPixels,
        resolveActualFilename,
    };
}
