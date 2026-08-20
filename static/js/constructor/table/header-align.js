/**
 * Горизонтальное выравнивание ячейки таблицы — зеркало DOCX-билдера.
 *
 * Зеркало серверного набора styles.py::CENTERED_MERGED_HEADER_TEXTS — при правке
 * формулировок шапок в шаблонах таблиц СИНХРОНИЗИРОВАТЬ оба места вручную
 * (импорт из Python невозможен; та же договорённость, что и names.py↔frontend).
 *
 * Правило (буквально `_fill_cell` в docx/builders/tables.py):
 *   - одиночная ячейка (colSpan ≤ 1) → 'center';
 *   - склеенная по горизонтали (colSpan > 1): 'center', если текст в
 *     centered-наборе, иначе 'left'.
 *
 * Заголовочность ячейки в правиле НЕ участвует: в билдере ветка одна на всех,
 * `is_header` управляет только заливкой, жирностью и кеглем. Прежняя сигнатура
 * с флагом `isHeader` (и `null` для данных) оставляла данные превью прижатыми
 * влево, тогда как Word центрирует их наравне с шапкой.
 */

/** Тексты объединённых шапок, которые ОСТАЮТСЯ по центру (зеркало styles.py). */
export const CENTERED_MERGED_HEADER_TEXTS = new Set([
    'Количество клиентов / элементов, ед.',
]);

/** Нормализация как _normalize_text в Python: схлоп пробелов + trim. */
function normalizeHeaderText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Возвращает выравнивание ячейки таблицы: 'left' | 'center'.
 * @param {string} content Текст ячейки.
 * @param {number} colSpan Горизонтальное объединение (число колонок).
 * @returns {('left'|'center')}
 */
export function mergedCellAlign(content, colSpan) {
    if (!(colSpan > 1)) return 'center';
    return CENTERED_MERGED_HEADER_TEXTS.has(normalizeHeaderText(content)) ? 'center' : 'left';
}

// Window-globals для inline-скриптов (guard для node:test, где window нет).
if (typeof window !== 'undefined') {
    window.CENTERED_MERGED_HEADER_TEXTS = CENTERED_MERGED_HEADER_TEXTS;
    window.mergedCellAlign = mergedCellAlign;
}
