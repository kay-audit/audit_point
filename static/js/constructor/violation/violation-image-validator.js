/**
 * Валидатор картинок нарушений (H6).
 *
 * Проверяет файл ДО кодирования в base64 (readAsDataURL) во всех точках
 * приёма: выбор файлов, drag&drop, Ctrl+V. Лимиты подтягиваются один раз
 * с GET /api/v1/acts/limits (паттерн chat-files._loadLimits); до ответа
 * сервера действуют дефолты — зеркало ACTS__IMAGES__* (settings.py),
 * серверная валидация схемы в любом случае прикроет.
 *
 * Тот же единственный GET наполняет и СТРУКТУРНЫЕ лимиты (таблицы/шрифт,
 * секции tables/textblocks ответа) — getStructureLimits() для гейтов
 * таблиц и тулбара шрифта (см. table-cells-operations.js, table-sizes.js).
 */

import { AppConfig } from '../../shared/app-config.js';
import { applyActsAllowlist } from '../../shared/sanitize.js';
import { formatMb } from '../../shared/format-units.js';
import { VIOLATION_FIELD_KEYS } from './violation-fields.js';
import { BLOCK_TYPES } from './violation-block-types.js';

/** Дефолтные лимиты — зеркало ImagesSettings (app/domains/acts/settings.py). */
export const DEFAULT_IMAGE_LIMITS = {
    maxFileSize: 4 * 1024 * 1024,
    maxTotalSizePerAct: 5 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
    maxItemsPerViolation: 50,
    imageMaxHeightPercent: 40,
};

/**
 * Дефолтные структурные лимиты (таблицы/шрифт) — синхронный фолбэк до ответа
 * сервера. Источник истины в рантайме — GET /acts/limits (секции tables /
 * textblocks из настроек ACTS__TABLES__* / ACTS__TEXTBLOCKS__*); до ответа
 * берём AppConfig.limits (зеркало дефолтов схемы).
 */
export const DEFAULT_STRUCTURE_LIMITS = {
    maxRows: AppConfig.limits.table.maxRows,
    maxCols: AppConfig.limits.table.maxCols,
    minColWidthPx: AppConfig.limits.table.minColWidthPx,
    fontSizeMin: AppConfig.limits.textblock.fontSizeMin,
    fontSizeMax: AppConfig.limits.textblock.fontSizeMax,
    // Базовый размер текстблока (px) — единый источник для редактора/превью.
    fontSizeDefault: AppConfig.limits.textblock.fontSizeDefault,
    // B-13/#7: макс. число блоков на узел — фолбэк до ответа /acts/limits.
    textBlocksPerNode: AppConfig.content.limits.textBlocksPerNode,
    violationsPerNode: AppConfig.content.limits.violationsPerNode,
    tablesPerNode: AppConfig.content.limits.tablesPerNode,
};

let _limits = { ...DEFAULT_IMAGE_LIMITS };
let _structure = { ...DEFAULT_STRUCTURE_LIMITS };
let _loadPromise = null;

/**
 * Однократно загружает лимиты с сервера. Ошибка сети/прокси тихо
 * игнорируется — остаются дефолты.
 *
 * @returns {Promise<Object>} Актуальные лимиты
 */
export function loadImageLimits() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
        try {
            const resp = await fetch(AppConfig.api.getUrl('/api/v1/acts/limits'), {
                credentials: 'same-origin',
            });
            if (!resp.ok) return _limits;
            const data = await resp.json();
            const img = data && data.images;
            if (img) {
                if (typeof img.max_file_size === 'number') _limits.maxFileSize = img.max_file_size;
                if (typeof img.max_total_size_per_act === 'number') _limits.maxTotalSizePerAct = img.max_total_size_per_act;
                if (Array.isArray(img.allowed_mime_types) && img.allowed_mime_types.length) {
                    _limits.allowedMimeTypes = img.allowed_mime_types;
                }
                if (typeof img.max_items_per_violation === 'number') _limits.maxItemsPerViolation = img.max_items_per_violation;
                if (typeof img.image_max_height_percent === 'number') _limits.imageMaxHeightPercent = img.image_max_height_percent;
            }
            const tbl = data && data.tables;
            if (tbl) {
                if (typeof tbl.max_rows === 'number') _structure.maxRows = tbl.max_rows;
                if (typeof tbl.max_cols === 'number') _structure.maxCols = tbl.max_cols;
                if (typeof tbl.min_col_width_px === 'number') _structure.minColWidthPx = tbl.min_col_width_px;
                // #7: серверный лимит числа таблиц на узел.
                if (typeof tbl.per_node === 'number') _structure.tablesPerNode = tbl.per_node;
            }
            const tb = data && data.textblocks;
            if (tb) {
                if (typeof tb.font_size_min === 'number') _structure.fontSizeMin = tb.font_size_min;
                if (typeof tb.font_size_max === 'number') _structure.fontSizeMax = tb.font_size_max;
                // EXP-2: базовый размер текстблока (редактор/превью) — из настроек.
                if (typeof tb.font_size_default === 'number') _structure.fontSizeDefault = tb.font_size_default;
                // B-13: серверный лимит числа текстблоков на узел.
                if (typeof tb.per_node === 'number') _structure.textBlocksPerNode = tb.per_node;
            }
            const vio = data && data.violations;
            if (vio) {
                // #7: серверный лимит числа нарушений на узел.
                if (typeof vio.per_node === 'number') _structure.violationsPerNode = vio.per_node;
            }
            // B-5/4е: единый allowlist санитайзера из той же выдачи /acts/limits.
            if (data && data.sanitizer) {
                applyActsAllowlist(data.sanitizer);
            }
            // §6.8: kill-switch телеметрии редактора из той же выдачи. false →
            // модуль перестаёт слать батчи (бэк и так ответит 204 без записи).
            if (data && typeof data.editor_telemetry_enabled === 'boolean') {
                window.EditorTelemetry?.setEnabled?.(data.editor_telemetry_enabled);
            }
        } catch (_) {
            // Сеть/CORS — дефолты, серверная валидация прикроет.
        }
        return _limits;
    })();
    return _loadPromise;
}

/**
 * Текущие лимиты (дефолты до ответа сервера).
 *
 * @returns {Object} Лимиты картинок
 */
export function getImageLimits() {
    return _limits;
}

/**
 * Текущие структурные лимиты таблиц/шрифта (дефолты до ответа сервера).
 *
 * @returns {{maxRows:number, maxCols:number, minColWidthPx:number,
 *            fontSizeMin:number, fontSizeMax:number, fontSizeDefault:number,
 *            textBlocksPerNode:number, violationsPerNode:number,
 *            tablesPerNode:number}}
 */
export function getStructureLimits() {
    return _structure;
}

/** Сброс к дефолтам — для тестов. */
export function resetImageLimitsForTests() {
    _limits = { ...DEFAULT_IMAGE_LIMITS };
    _structure = { ...DEFAULT_STRUCTURE_LIMITS };
    _loadPromise = null;
}

/**
 * Оценивает размер картинки в байтах по длине base64-payload data-URL
 * (×0.75: 4 символа base64 = 3 байта).
 *
 * @param {string} url - data-URL картинки
 * @returns {number} Приблизительный размер в байтах
 */
export function estimateDataUrlBytes(url) {
    if (typeof url !== 'string' || !url.startsWith('data:')) return 0;
    const comma = url.indexOf(',');
    const payloadLength = comma >= 0 ? url.length - comma - 1 : url.length;
    return Math.round(payloadLength * 0.75);
}

/**
 * Суммарный размер всех картинок акта (по data-URL image-блоков ВСЕХ полей
 * нарушения — блочная модель: картинка может лежать в любом поле реестра).
 *
 * @param {Object} violations - Словарь нарушений (AppState.violations)
 * @returns {number} Суммарный размер в байтах
 */
export function estimateActImageBytes(violations) {
    let total = 0;
    for (const violation of Object.values(violations || {})) {
        for (const fieldKey of VIOLATION_FIELD_KEYS) {
            const blocks = violation?.[fieldKey]?.blocks;
            if (!Array.isArray(blocks)) continue;
            for (const block of blocks) {
                if (block && block.type === BLOCK_TYPES.IMAGE && block.url) {
                    total += estimateDataUrlBytes(block.url);
                }
            }
        }
    }
    return total;
}

/**
 * Абсурдный сырой потолок: не читаем/не декодируем гигантские файлы ДО ресайза.
 * Реальный размерный гейт (#2) работает ПОСЛЕ ресайза по ужатым байтам —
 * validateImageBytes.
 */
export const ABSURD_RAW_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Проверяет ТИП файла ДО чтения/ресайза (#26 magic-sniff — отдельно, async).
 * Размер (per-file/суммарный) сюда НЕ входит: он считается ПОСЛЕ ресайза по
 * ужатым байтам (validateImageBytes), иначе крупное фото отклонилось бы раньше,
 * чем успело ужаться.
 *
 * @param {File} file - Принимаемый файл
 * @param {Object} [context] - Контекст приёма
 * @param {number} [context.itemsCount=0] - Текущее число элементов
 *        дополнительного контента нарушения
 * @param {Object} [context.limits] - Явные лимиты (для тестов)
 * @returns {{ok: boolean, reason: string}} Результат с причиной отказа
 */
export function validateImageType(file, { itemsCount = 0, limits = null } = {}) {
    const lim = limits || _limits;
    if (!file) {
        return { ok: false, reason: 'Файл не передан' };
    }
    if (!lim.allowedMimeTypes.includes(file.type)) {
        return {
            ok: false,
            reason: `Недопустимый тип файла «${file.name || ''}» (${file.type || 'неизвестный'}). `
                + 'Разрешены: JPEG, PNG, GIF.',
        };
    }
    if (itemsCount >= lim.maxItemsPerViolation) {
        // №14: текст — из единой точки формирования (app-config.js), не хардкод.
        return { ok: false, reason: AppConfig.content.errors.contentItemsLimitReached(lim.maxItemsPerViolation) };
    }
    if (typeof file.size === 'number' && file.size > ABSURD_RAW_MAX_BYTES) {
        return {
            ok: false,
            reason: `Файл «${file.name || ''}» слишком большой (${formatMb(file.size)} МБ) для обработки.`,
        };
    }
    return { ok: true, reason: '' };
}

/**
 * Проверяет РАЗМЕР картинки ПОСЛЕ ресайза (#2): per-file + накопительный
 * суммарный лимит акта — по УЖАТЫМ байтам dataUrl (estimateDataUrlBytes).
 *
 * @param {number} bytes - Размер ужатой картинки в байтах
 * @param {Object} [context] - Контекст приёма
 * @param {number} [context.existingTotalBytes=0] - Суммарный размер уже
 *        добавленных картинок акта (включая принятые ранее в этой пачке)
 * @param {string} [context.name] - Имя файла для сообщения об отказе
 * @param {Object} [context.limits] - Явные лимиты (для тестов)
 * @returns {{ok: boolean, reason: string}} Результат с причиной отказа
 */
export function validateImageBytes(bytes, { existingTotalBytes = 0, name = '', limits = null } = {}) {
    const lim = limits || _limits;
    if (bytes > lim.maxFileSize) {
        return {
            ok: false,
            reason: `Файл «${name}» слишком большой (${formatMb(bytes)} МБ) даже после сжатия. `
                + `Лимит на файл — ${formatMb(lim.maxFileSize)} МБ.`,
        };
    }
    if (existingTotalBytes + bytes > lim.maxTotalSizePerAct) {
        return {
            ok: false,
            reason: `Суммарный размер картинок акта превысит лимит ${formatMb(lim.maxTotalSizePerAct)} МБ. `
                + `Файл «${name}» не добавлен.`,
        };
    }
    return { ok: true, reason: '' };
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.ViolationImageValidator = {
    loadImageLimits,
    getImageLimits,
    getStructureLimits,
    validateImageType,
    validateImageBytes,
    estimateDataUrlBytes,
    estimateActImageBytes,
};
