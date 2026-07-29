/**
 * Имена CSS-классов, связывающие рендер контент-панели с обработчиками.
 *
 * Единственный источник истины для классов, которые создаёт рендер
 * (TextBlockManager / ViolationManager) и по которым другие модули ищут
 * эти элементы (querySelector / classList.contains). Берите имена отсюда —
 * тогда рассинхрон «рендер пишет один класс, обработчик ищет другой»
 * невозможен (исторический пример: мёртвая синхронизация DOM→state искала
 * `.text-block-section` вместо реального `.textblock-section`).
 */
export const RENDER_CLASSES = {
    /** Секция текстового блока (создаёт TextBlockManager.createTextBlockElement). */
    TEXTBLOCK_SECTION: 'textblock-section',
    /** contenteditable-редактор текстового блока (создаёт TextBlockManager.createEditor). */
    TEXTBLOCK_EDITOR: 'textblock-editor',
    /** Секция нарушения (создаёт ViolationManager.createViolationElement). */
    VIOLATION_SECTION: 'violation-section',
    /**
     * Rich-поле нарушения — живой contenteditable-хост (Task 1.3.3, создаёт
     * ViolationManager._createRichFieldEditor). По этому классу + атрибуту
     * contenteditable="true" read-only-проход в app.js гасит поля в режиме
     * просмотра — класс load-bearing, не переименовывать без правки app.js.
     */
    VIOLATION_FIELD: 'violation-field',
    /** Визуальный стиль текстового поля нарушения (рамка/паддинги/фокус). */
    VIOLATION_TEXTAREA: 'violation-textarea',
};
