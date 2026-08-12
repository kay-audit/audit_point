/**
 * Резолвер таблиц: единый адрес для узловых и встроенных таблиц.
 *
 * Машинерия таблиц (операции с ячейками, контекст-меню, ресайз) адресует
 * таблицу строковым `tableId` из `cell.dataset.tableId`. Узловая таблица
 * лежит в `AppState.tables[id]`, встроенная — внутри нарушения, в
 * `violation[fieldKey].blocks[].table`, и в `AppState.tables` НЕ регистрируется
 * (у неё нет узла дерева, подвида, пинов и каскадов). Чтобы обе получили одну
 * и ту же машинерию, вводится синтетический id
 * `vt::<violationId>::<fieldKey>::<blockId>`, а все чтения идут через
 * `resolveTable`.
 *
 * КРИТИЧНО: встроенная таблица резолвится КАЖДЫЙ РАЗ заново от
 * `AppState.violations`. Ссылку кэшировать нельзя — проход через Proxy
 * состояния (state-core) и есть то, что помечает акт несохранённым при записи
 * в ячейку; закэшированная «сырая» ссылка обошла бы трекинг.
 */
import { AppState } from '../state/state-core.js';
import { ItemsRenderer } from '../items/items-renderer.js';
import { PreviewManager } from '../preview/preview.js';
import { createTableElement } from './table-render.js';
import { tableManager } from './table-core.js';

/** Префикс синтетического id встроенной таблицы. */
const EMBEDDED_PREFIX = 'vt';
/** Разделитель частей синтетического id (в id нарушения/поля/блока не встречается). */
const SEP = '::';

/**
 * Собирает синтетический id встроенной таблицы блока нарушения.
 * @param {string} violationId - ID нарушения
 * @param {string} fieldKey - Ключ поля реестра
 * @param {string} blockId - ID блока типа 'table'
 * @returns {string} `vt::<violationId>::<fieldKey>::<blockId>`
 */
export function makeEmbeddedTableId(violationId, fieldKey, blockId) {
    return [EMBEDDED_PREFIX, violationId, fieldKey, blockId].join(SEP);
}

/**
 * Признак синтетического id встроенной таблицы.
 * @param {string} tableId - ID таблицы
 * @returns {boolean}
 */
export function isEmbeddedTableId(tableId) {
    return typeof tableId === 'string' && tableId.startsWith(EMBEDDED_PREFIX + SEP);
}

/**
 * Разбирает синтетический id на адрес блока нарушения.
 * @param {string} tableId - ID таблицы
 * @returns {{violationId: string, fieldKey: string, blockId: string}|null}
 *          null — id не встроенный либо повреждён
 */
export function parseEmbeddedTableId(tableId) {
    if (!isEmbeddedTableId(tableId)) return null;
    const parts = tableId.split(SEP);
    if (parts.length !== 4) return null;
    const [, violationId, fieldKey, blockId] = parts;
    if (!violationId || !fieldKey || !blockId) return null;
    return { violationId, fieldKey, blockId };
}

/**
 * Возвращает объект таблицы по id: встроенную — проходом по AppState.violations
 * (каждый раз заново, см. шапку модуля), узловую — из AppState.tables.
 * @param {string} tableId - ID таблицы
 * @returns {Object|undefined} Объект таблицы ({grid, colWidths, ...}) либо undefined
 */
export function resolveTable(tableId) {
    const parsed = parseEmbeddedTableId(tableId);
    if (!parsed) {
        return isEmbeddedTableId(tableId) ? undefined : AppState.tables?.[tableId];
    }

    const blocks = AppState.violations?.[parsed.violationId]?.[parsed.fieldKey]?.blocks;
    if (!Array.isArray(blocks)) return undefined;
    return blocks.find(b => b && b.id === parsed.blockId)?.table;
}

/**
 * Реакция на СТРУКТУРНУЮ правку таблицы (вставка/удаление строк и колонок,
 * merge/unmerge, фиксация ширин): пересобрать DOM редактора и обновить превью.
 *
 * Узловая таблица — пересборка своей `.table-section` (ItemsRenderer) и полный
 * ре-рендер превью. Встроенная — пересборка внутри host-контейнера блока и
 * точечный патч превью нарушения.
 *
 * @param {string} tableId - ID таблицы
 */
export function afterTableChanged(tableId) {
    const parsed = parseEmbeddedTableId(tableId);
    if (!parsed) {
        ItemsRenderer.updateTable(tableId);
        PreviewManager.update();
        return;
    }

    const host = document.querySelector(`[data-embedded-table-id="${tableId}"]`);
    const table = resolveTable(tableId);
    if (host && table) {
        // Пересборка отправляет прежние ячейки в detached-DOM — выделение по
        // ним держит устаревшие координаты (то же делает ItemsRenderer.updateTable).
        tableManager.clearSelection();
        host.innerHTML = '';
        host.appendChild(createTableElement(table, tableId));
        tableManager.attachEventListenersToContainer(host);
    }

    PreviewManager.updateBlock('violation', parsed.violationId);
}

/**
 * Реакция на КОНТЕНТНУЮ правку одной ячейки (коммит редактирования): только
 * точечный патч превью — DOM ячейки редактора уже обновлён вводом, пересборка
 * таблицы здесь была бы лишней работой на каждый коммит.
 *
 * @param {string} tableId - ID таблицы
 */
export function afterTableCellChanged(tableId) {
    const parsed = parseEmbeddedTableId(tableId);
    if (!parsed) {
        PreviewManager.updateBlock('table', tableId);
        return;
    }
    PreviewManager.updateBlock('violation', parsed.violationId);
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
    window.resolveTable = resolveTable;
}
