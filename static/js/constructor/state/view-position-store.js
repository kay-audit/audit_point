/**
 * Персист позиции просмотра акта: текущий шаг конструктора, скролл панелей
 * и якорный узел превью.
 *
 * Чистые функции над Storage-совместимым объектом — без DOM и без AppState
 * (тестируются в node:test напрямую). Ключ — per-act, по образцу ключей
 * черновика/collapsed-набора: `audit_workstation_viewpos:{actId}`.
 */

export const VIEW_POSITION_KEY_PREFIX = 'audit_workstation_viewpos:';

const KEY_PREFIX = VIEW_POSITION_KEY_PREFIX;

/**
 * Ключ localStorage для позиции просмотра акта.
 * @param {number|string} actId - ID акта
 * @returns {string}
 */
export function viewPositionKey(actId) {
    return `${KEY_PREFIX}${actId}`;
}

function toNonNegativeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Загружает позицию просмотра акта. Битый JSON / чужая форма / отсутствие
 * actId — null (молча, поведение best-effort UI-настройки). Отсутствующие
 * поля восстанавливаются дефолтами, step клампится в 1|2.
 * @param {Storage} storage - localStorage-совместимое хранилище
 * @param {number|string|null|undefined} actId - ID акта
 * @returns {{step: 1|2, scroll: {treeColumn: number, previewColumn: number, step2: number}, anchorNodeId: string|null}|null}
 */
export function loadViewPosition(storage, actId) {
    if (actId === null || actId === undefined || !storage) return null;
    try {
        const raw = storage.getItem(viewPositionKey(actId));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

        const step = parsed.step === 2 ? 2 : 1;
        const rawScroll = parsed.scroll;
        const scroll = {
            treeColumn: toNonNegativeNumber(rawScroll?.treeColumn),
            previewColumn: toNonNegativeNumber(rawScroll?.previewColumn),
            step2: toNonNegativeNumber(rawScroll?.step2),
        };
        const anchorNodeId = typeof parsed.anchorNodeId === 'string' ? parsed.anchorNodeId : null;

        return { step, scroll, anchorNodeId };
    } catch {
        return null;
    }
}

/**
 * Сохраняет позицию просмотра акта. Отсутствие actId — no-op.
 *
 * Запись помечается savedAt (ISO): ключи per-act, и без метки времени они
 * копились бы по одному на каждый когда-либо открытый акт без шанса на
 * освобождение места. Метка в том же формате, что у снимков-черновиков, —
 * их общий TTL-сметатель (StorageManager._purgeForeignSnapshots) читает
 * именно это поле.
 * @param {Storage} storage - localStorage-совместимое хранилище
 * @param {number|string|null|undefined} actId - ID акта
 * @param {{step: 1|2, scroll: {treeColumn: number, previewColumn: number, step2: number}, anchorNodeId: string|null}} pos - Позиция просмотра
 */
export function saveViewPosition(storage, actId, pos) {
    if (actId === null || actId === undefined || !storage) return;
    try {
        storage.setItem(
            viewPositionKey(actId),
            JSON.stringify({ ...pos, savedAt: new Date().toISOString() })
        );
    } catch {
        // Квота/приватный режим — позиция просмотра не критична.
    }
}
