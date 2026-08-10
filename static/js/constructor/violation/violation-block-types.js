/**
 * Типы и фабрики блоков полей нарушения (блочная модель).
 *
 * Единственный источник строк-типов block.type на фронте. Значения
 * сериализуются в содержимое акта и зеркалят Literal-типы union'а
 * ViolationBlock (app/domains/acts/schemas/act_content.py:
 * ViolationTextBlockSchema / ViolationImageBlockSchema /
 * ViolationTableBlockSchema) — менять только синхронно с бэком.
 * Пин синхронизации — tests/domains/acts/test_violation_fields_guard.py
 * (TestBlockTypesSync парсит этот файл).
 *
 * Модуль без DOM и импортов приложения — тестируется под node:test.
 */

export const BLOCK_TYPES = Object.freeze({
    TEXT: 'text',
    IMAGE: 'image',
    TABLE: 'table',
});

/**
 * Генерит id блока по конвенции элементов акта:
 * `<type>_<timestamp>_<случайный суффикс>`. Id стабилен на весь жизненный
 * цикл блока (нужен диффу версий и DnD); при копировании нарушения id
 * регенерируется (node-clipboard.js::regenerateIds).
 * @param {string} type
 * @returns {string}
 */
function generateBlockId(type) {
    return `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Текст-блок: rich-HTML с полным тулбаром (включая списки).
 * @param {string} [content] - Начальное rich-HTML содержимое
 * @returns {Object}
 */
export function createTextBlock(content = '') {
    return { id: generateBlockId(BLOCK_TYPES.TEXT), type: BLOCK_TYPES.TEXT, content };
}

/**
 * Блок-картинка: inline data-URL, подпись, имя файла, ширина в % (0 — авто).
 * @param {Object} [extraData]
 * @param {string} [extraData.url]
 * @param {string} [extraData.filename]
 * @param {number} [extraData.width]
 * @returns {Object}
 */
export function createImageBlock(extraData = {}) {
    return {
        id: generateBlockId(BLOCK_TYPES.IMAGE),
        type: BLOCK_TYPES.IMAGE,
        url: extraData.url || '',
        caption: '',
        filename: extraData.filename || '',
        width: extraData.width || 0,
    };
}

/**
 * Блок-таблица: обычная таблица (сетка + ширины колонок), без метаданных
 * узла дерева — metrics/risk-подвиды и пины к встроенным таблицам не
 * применяются.
 * @param {Object} [table] - Готовая сетка {grid, colWidths}; по умолчанию пустая
 * @returns {Object}
 */
export function createTableBlock(table = null) {
    return {
        id: generateBlockId(BLOCK_TYPES.TABLE),
        type: BLOCK_TYPES.TABLE,
        table: table || { grid: [], colWidths: [] },
    };
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
    window.BLOCK_TYPES = BLOCK_TYPES;
}
