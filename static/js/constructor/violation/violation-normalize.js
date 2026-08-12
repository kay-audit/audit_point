/**
 * Нормализация формы нарушения на загрузке акта (находка аудита #20).
 *
 * Эталонная дефолт-форма нарушения объявлена в ОДНОМ месте (createDefaultViolationShape)
 * и переиспользуется _createViolationObject (state-content.js) — иначе два источника
 * истины дрейфуют друг от друга при будущих правках полей.
 *
 * Блочная модель: форма генерируется циклом по реестру VIOLATION_FIELDS
 * (violation-fields.js) — каждое поле получает единый контейнер
 * {enabled, blocks}, mandatory-поля создаются включёнными; плюс скаляр
 * fieldOrder (null = стандартный порядок).
 *
 * Повреждённые акты (ручная правка БД, испорченный localStorage-снимок)
 * могут не содержать части под-объектов нарушения. normalizeViolations
 * ДО-заполняет только ОТСУТСТВУЮЩИЕ ключи эталоном, не трогая валидные
 * данные — идемпотентный проход при загрузке, по образцу normalizeFontSizes
 * (6.4, textblock-toolbar.js).
 *
 * Модуль без DOM — тестируется под node:test напрямую (без _browser-stub).
 */

import { VIOLATION_FIELDS } from './violation-fields.js';

/**
 * Дефолтная форма нового нарушения (эталон, зеркалит _createViolationObject
 * без id/nodeId). Функция, а не константа — каждый вызов возвращает новый
 * объект, чтобы разные нарушения не делили один вложенный объект по ссылке.
 * @returns {Object}
 */
export function createDefaultViolationShape() {
    const shape = { fieldOrder: null };
    for (const field of VIOLATION_FIELDS) {
        shape[field.key] = {
            enabled: field.mandatory,
            blocks: [],
        };
    }
    return shape;
}

/**
 * До-заполняет ОТСУТСТВУЮЩИЕ ключи одного нарушения эталоном. Мутирует
 * переданный объект (не пересоздаёт) — валидные данные не перезатираются.
 * @param {Object} violation
 * @returns {boolean} true, если что-то было дозаполнено
 */
function fillMissingFields(violation) {
    const defaults = createDefaultViolationShape();
    let changed = false;

    for (const [key, defaultValue] of Object.entries(defaults)) {
        const isSubObject = defaultValue !== null && typeof defaultValue === 'object';

        if (!isSubObject) {
            if (!(key in violation)) {
                violation[key] = defaultValue;
                changed = true;
            }
            continue;
        }

        if (!violation[key] || typeof violation[key] !== 'object') {
            violation[key] = defaultValue;
            changed = true;
            continue;
        }

        // Под-объект присутствует — дозаполняем только его отсутствующие ключи.
        for (const [subKey, subDefault] of Object.entries(defaultValue)) {
            if (!(subKey in violation[key])) {
                violation[key][subKey] = subDefault;
                changed = true;
            }
        }
    }

    return changed;
}

/**
 * Нормализует словарь нарушений акта на загрузке (#20): до-заполняет
 * недостающие под-объекты/скаляры эталонной формой у КАЖДОГО нарушения.
 * Мутирует переданный словарь на месте (как normalizeFontSizes мутирует
 * textBlocks) — не пересоздаёт объекты нарушений.
 *
 * @param {Object<string, Object>} [violations]
 * @returns {{changed: boolean, count: number}} count — число нарушений,
 *          у которых что-то было дозаполнено.
 */
export function normalizeViolations(violations) {
    if (!violations || typeof violations !== 'object') {
        return { changed: false, count: 0 };
    }

    let changed = false;
    let count = 0;

    for (const violation of Object.values(violations)) {
        if (!violation || typeof violation !== 'object') continue;
        if (fillMissingFields(violation)) {
            changed = true;
            count++;
        }
    }

    return { changed, count };
}

if (typeof window !== 'undefined') {
    window.normalizeViolations = normalizeViolations;
}
