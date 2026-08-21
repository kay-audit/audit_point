/**
 * Типы, метаданные и фабрики блоков полей нарушения (блочная модель).
 *
 * Единственный источник строк-типов block.type на фронте. Значения
 * сериализуются в содержимое акта и зеркалят Literal-типы union'а
 * ViolationBlock (app/domains/acts/schemas/act_content.py:
 * ViolationTextBlockSchema / ViolationImageBlockSchema /
 * ViolationTableBlockSchema) — менять только синхронно с бэком.
 * Пин синхронизации — tests/domains/acts/test_violation_fields_guard.py
 * (TestBlockTypesSync парсит этот файл).
 *
 * Здесь же — реестр BLOCK_TYPE_META: подписи, иконки и фабрика каждого типа
 * одним объектом. До ревью №17 эти метаданные лежали пятью независимыми
 * копиями (миниатюра drag, подписи диффа, пункты контекст-меню, кнопки
 * тулбара, обёртки блоков) и расходились при любой правке.
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
 * Блок-картинка: ссылка на строку act_images, подпись, имя файла, ширина в %
 * (0 — авто). Байты в блоке НЕ живут: `image_id` — id картинки, загруженной
 * через POST /api/v1/acts/{act_id}/images. Пустой `image_id` — черновик без
 * картинки (рендерится плейсхолдером).
 * @param {Object} [extraData]
 * @param {string} [extraData.image_id]
 * @param {string} [extraData.filename]
 * @param {number} [extraData.width]
 * @returns {Object}
 */
export function createImageBlock(extraData = {}) {
    return {
        id: generateBlockId(BLOCK_TYPES.IMAGE),
        type: BLOCK_TYPES.IMAGE,
        image_id: extraData.image_id || '',
        caption: '',
        filename: extraData.filename || '',
        width: extraData.width || 0,
    };
}

/**
 * Стартовая сетка новой встроенной таблицы: 2×2, первая строка — шапка
 * (`isHeader: true` — тот же признак, по которому узловые таблицы рендерят
 * `<th>` и запрещают вставку строки выше заголовка).
 *
 * Пустой сеткой начинать нельзя: вся машинерия таблиц работает от ВЫБРАННОЙ
 * ячейки (контекст-меню, вставка строк/колонок), а на пустом гриде выбирать
 * нечего — пользователь не смог бы добавить ни строки, ни колонки.
 * @returns {{grid: Object[][], colWidths: number[]}}
 */
function createDefaultGrid() {
    const grid = [];
    for (let r = 0; r < 2; r++) {
        const row = [];
        for (let c = 0; c < 2; c++) {
            row.push({
                content: '',
                isHeader: r === 0,
                colSpan: 1,
                rowSpan: 1,
                originRow: r,
                originCol: c,
            });
        }
        grid.push(row);
    }
    return { grid, colWidths: [100, 100] };
}

/**
 * Блок-таблица: обычная таблица (сетка + ширины колонок), без метаданных
 * узла дерева — metrics/risk-подвиды и пины к встроенным таблицам не
 * применяются.
 * @param {Object} [table] - Готовая сетка {grid, colWidths}; по умолчанию 2×2 с шапкой
 * @returns {Object}
 */
export function createTableBlock(table = null) {
    return {
        id: generateBlockId(BLOCK_TYPES.TABLE),
        type: BLOCK_TYPES.TABLE,
        table: table || createDefaultGrid(),
    };
}

/**
 * Метаданные типов блоков: всё, что потребителям нужно знать о типе, кроме
 * самого рендеринга. Порядок ключей — порядок типов в UI (тулбар поля и
 * контекст-меню обходят `Object.values`), поэтому реестр объявлен в нём:
 * текст, таблица, картинка.
 *
 * Поля дескриптора:
 *  - `type`      — значение block.type (оно же ключ реестра);
 *  - `label`     — подпись обёртки блока в форме и миниатюры перетаскивания;
 *  - `shortLabel`— кнопка тулбара «+ …» и заголовок блока в диффе версий;
 *  - `menuLabel` — пункт контекст-меню (винительный падеж, из `label` не выводится);
 *  - `icon`      — эмодзи пункта контекст-меню;
 *  - `dragIcon`  — эмодзи миниатюры перетаскивания;
 *  - `create`    — фабрика блока с единой сигнатурой `(extraData) => block`.
 *
 * `label` ≠ `shortLabel` только у картинки («Изображение» в форме,
 * «Картинка» в тулбаре и диффе) — обе подписи пользовательские и живут в
 * рендерах давно, реестр их фиксирует, а не унифицирует.
 */
export const BLOCK_TYPE_META = Object.freeze({
    [BLOCK_TYPES.TEXT]: Object.freeze({
        type: BLOCK_TYPES.TEXT,
        label: 'Текст',
        shortLabel: 'Текст',
        menuLabel: 'Добавить текст',
        icon: '📄',
        dragIcon: '📝',
        create: (extraData = {}) => createTextBlock(extraData.content || ''),
    }),
    [BLOCK_TYPES.TABLE]: Object.freeze({
        type: BLOCK_TYPES.TABLE,
        label: 'Таблица',
        shortLabel: 'Таблица',
        menuLabel: 'Добавить таблицу',
        icon: '📊',
        dragIcon: '📊',
        create: () => createTableBlock(),
    }),
    [BLOCK_TYPES.IMAGE]: Object.freeze({
        type: BLOCK_TYPES.IMAGE,
        label: 'Изображение',
        shortLabel: 'Картинка',
        menuLabel: 'Добавить изображение',
        icon: '🖼️',
        dragIcon: '🖼️',
        create: (extraData = {}) => createImageBlock(extraData),
    }),
});
