/**
 * Валидация таблиц
 *
 * Проверяет заполненность заголовков и корректность структуры таблиц.
 *
 * Отдельной проверки «таблица без данных» здесь больше нет: тост о ней при
 * сохранении дублировал серверный (`table_no_data` → «Работа не закончена: …»
 * в `api.js`), а для колокольчика её считает чистое ядро через
 * `collectContentWarnings`.
 */
import { AppState } from '../state/state-core.js';
import { TreeUtils } from '../tree/tree-utils.js';
import { ValidationCore } from './validation-core.js';
import { hasEmptyHeaders, countHeaderRows, collectTableWarnings } from './validation-table-core.js';

export const ValidationTable = {
    /**
     * Проверяет заполненность и наличие заголовков всех таблиц.
     *
     * Блокирующая контентная проверка: ловит таблицы с пустыми ячейками шапки
     * И таблицы вовсе без строки заголовка (E6). Подсчёт шапки — через чистое
     * ядро (учитывает многострочную шапку).
     *
     * @returns {Object} Результат валидации с полями valid, message, isWarning
     */
    validateHeaders() {
        const emptyHeaders = [];
        const noHeaderTables = [];

        for (const tableId in AppState.tables) {
            const table = AppState.tables[tableId];

            if (!this._hasValidGrid(table)) continue;

            const tableName = this._getTableName(tableId);

            // E6: таблица без единой строки заголовка.
            if (countHeaderRows(table.grid) === 0) {
                noHeaderTables.push(`- ${tableName}`);
                continue;
            }

            if (hasEmptyHeaders(table.grid)) {
                emptyHeaders.push(`- ${tableName}`);
            }
        }

        const parts = [];
        if (noHeaderTables.length > 0) {
            parts.push(`Таблицы без строки заголовка:\n${noHeaderTables.join('\n')}`);
        }
        if (emptyHeaders.length > 0) {
            parts.push(`Не заполнены заголовки таблиц:\n${emptyHeaders.join('\n')}`);
        }

        if (parts.length > 0) {
            const message = `${parts.join('\n')}\nЗаполните заголовки таблиц перед экспортом.`;
            return ValidationCore.failure(message);
        }

        return ValidationCore.success();
    },

    /**
     * Собирает контентные/структурные замечания по всем таблицам (E3).
     *
     * Возвращает плоский список проблем без блокировки. Критичность — в поле
     * severity: 'error' (нарушена структура сетки) или 'warning' (нет шапки E6,
     * пустые заголовки, нет данных E5). Делегирует чистому ядру
     * collectTableWarnings; здесь только подстановка AppState.tables и резолвера
     * имени таблицы.
     *
     * @returns {Array<{tableId:string, tableName:string, issue:string, severity:'error'|'warning'}>}
     *   Список проблем.
     */
    collectContentWarnings() {
        return collectTableWarnings(AppState.tables, (id) => this._getTableName(id));
    },

    /**
     * Проверяет наличие валидной grid-структуры
     * @private
     * @param {Object} table - Объект таблицы
     * @returns {boolean} Есть ли валидная grid
     */
    _hasValidGrid(table) {
        return table.grid && Array.isArray(table.grid) && table.grid.length > 0;
    },

    /**
     * Получает название таблицы из дерева
     * @private
     * @param {string} tableId - ID таблицы
     * @returns {string} Название таблицы
     */
    _getTableName(tableId) {
        const node = TreeUtils.findNodeByTableId(tableId);
        return node?.label || `Таблица ${tableId}`;
    }
};

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.ValidationTable = ValidationTable;
