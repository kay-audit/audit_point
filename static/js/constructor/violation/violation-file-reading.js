/**
 * Чтение файла в data-URL и распознавание типа картинки по сигнатуре.
 *
 * Модуль без импортов приложения — тестируется под node:test
 * (readFile внедряется параметром).
 */

/**
 * Читает один файл в data-URL.
 *
 * @param {File} file - Файл для чтения
 * @returns {Promise<string>} data-URL содержимого
 */
export function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = () => reject(
            reader.error || new Error(`Не удалось прочитать файл ${file.name}`),
        );
        reader.readAsDataURL(file);
    });
}

/**
 * Магические сигнатуры первых байтов файла → MIME.
 *
 * Этот набор — ЕДИНЫЙ ИСТОЧНИК ИСТИНЫ для того, что настройка вправе разрешать:
 * sniffer может подтвердить только формат, чью сигнатуру знает, поэтому
 * DEFAULT_ALLOWED_IMAGE_MIME производится отсюда — список и sniffer не разъедутся.
 * webp входит в набор: он разрешён бэком (ACTS__IMAGES__ALLOWED_MIME_TYPES) и в
 * него же кодирует скриншоты клиентское сжатие; DOCX-экспорт перекодирует webp
 * в PNG на сервере через Pillow.
 *
 * Сигнатура — список кусков {offset, bytes}: у webp опознавательных байтов два
 * («RIFF» в начале и «WEBP» с 8-го байта), одного RIFF мало — им начинаются и
 * WAV, и AVI.
 */
const IMAGE_MAGIC_SIGNATURES = [
    { mime: 'image/png', parts: [{ offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47] }] },
    { mime: 'image/jpeg', parts: [{ offset: 0, bytes: [0xFF, 0xD8, 0xFF] }] },
    // GIF87a / GIF89a
    { mime: 'image/gif', parts: [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }] },
    {
        mime: 'image/webp',
        parts: [
            { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
            { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // WEBP
        ],
    },
];

/** Разрешённые по умолчанию типы картинок — производны от IMAGE_MAGIC_SIGNATURES. */
export const DEFAULT_ALLOWED_IMAGE_MIME = IMAGE_MAGIC_SIGNATURES.map((s) => s.mime);

/**
 * Человекочитаемые ярлыки распознаваемых форматов (PNG/JPEG/GIF/WEBP) — производны от
 * IMAGE_MAGIC_SIGNATURES. Для честных сообщений об отклонении файла (не хардкод).
 */
export const RECOGNIZED_IMAGE_FORMATS = IMAGE_MAGIC_SIGNATURES.map(
    (s) => s.mime.replace('image/', '').toUpperCase(),
);

/**
 * Определяет MIME картинки по первым байтам (магическая сигнатура).
 *
 * @param {Uint8Array|number[]} bytes - Первые байты файла (не меньше 12)
 * @returns {string|null} MIME ('image/png'|'image/jpeg'|'image/gif'|'image/webp') или null
 */
export function detectImageMagic(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    for (const sig of IMAGE_MAGIC_SIGNATURES) {
        const matched = sig.parts.every(
            (part) => part.bytes.every((b, i) => arr[part.offset + i] === b),
        );
        if (matched) return sig.mime;
    }
    return null;
}

/**
 * Проверяет, что содержимое файла — картинка разрешённого типа (#26).
 * Читает первые 12 байт и матчит сигнатуру; отсекает мусор и переименованные
 * не-картинки (напр. PDF/EXE с расширением .png) ДО чтения/ресайза.
 *
 * @param {File|Blob} file - Проверяемый файл
 * @param {string[]} [allowedMimeTypes] - Разрешённые типы (из getImageLimits())
 * @returns {Promise<boolean>} true, если сигнатура — картинка из allowed-списка
 */
export async function sniffImageMagic(file, allowedMimeTypes = DEFAULT_ALLOWED_IMAGE_MIME) {
    try {
        const buffer = await file.slice(0, 12).arrayBuffer();
        const detected = detectImageMagic(new Uint8Array(buffer));
        return detected !== null && allowedMimeTypes.includes(detected);
    } catch (_) {
        return false;
    }
}
