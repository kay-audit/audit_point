/**
 * Декларативный контракт полей нарушения — блочная модель.
 *
 * Зеркало бэкенд-реестра полей нарушения: ключ, метка, стандартный порядок
 * (defaultOrder) и три флага — mandatory (поле нельзя выключить, чекбокс не
 * рендерится), small (мелкий шрифт 9pt в DOCX) и labeled (метка выводится в
 * рендерах экспорта и превью). Каждое поле — единый контейнер
 * {enabled, blocks} с блоками трёх типов (см. violation-block-types.js).
 * Пользовательский порядок полей конкретного нарушения — violation.fieldOrder
 * (null = defaultOrder отсюда).
 *
 * labeled=false у codeMining/processMining/additionalContent: в экспортах и
 * превью их контент идёт подряд, без заголовка-метки (решение владельца).
 * Подписи полей В ФОРМЕ конструктора это не затрагивает — там label
 * используется всегда.
 *
 * ВАЖНО: набор синхронизируется ВРУЧНУЮ с бэкенд-реестром
 * app/domains/acts/violation_fields.py (как block_types.py ↔ block-types.js):
 * бэк не импортирует JS. Точные строки меток и порядок закреплены
 * тест-стражем tests/js/violation-fields.test.mjs; соответствие схеме
 * ViolationSchema — tests/domains/acts/test_violation_fields_guard.py.
 */

export const VIOLATION_FIELDS = Object.freeze([
  Object.freeze({ key: 'violated', label: 'Нарушено', defaultOrder: 0, mandatory: true, small: true, labeled: true }),
  Object.freeze({ key: 'established', label: 'Установлено', defaultOrder: 1, mandatory: true, small: true, labeled: true }),
  Object.freeze({ key: 'description', label: 'Описание', defaultOrder: 2, mandatory: false, small: false, labeled: true }),
  Object.freeze({ key: 'codeMining', label: 'CodeMining', defaultOrder: 3, mandatory: false, small: false, labeled: false }),
  Object.freeze({ key: 'processMining', label: 'ProcessMining', defaultOrder: 4, mandatory: false, small: false, labeled: false }),
  Object.freeze({ key: 'additionalContent', label: 'Дополнительный контент', defaultOrder: 5, mandatory: false, small: false, labeled: false }),
  Object.freeze({ key: 'reasons', label: 'Причины', defaultOrder: 6, mandatory: false, small: false, labeled: true }),
  Object.freeze({ key: 'measures', label: 'Принятые меры', defaultOrder: 7, mandatory: false, small: false, labeled: true }),
  Object.freeze({ key: 'consequences', label: 'Последствия', defaultOrder: 8, mandatory: false, small: false, labeled: true }),
  Object.freeze({ key: 'responsible', label: 'Ответственные', defaultOrder: 9, mandatory: false, small: false, labeled: true }),
]);

export const VIOLATION_LABELS = Object.freeze(
  Object.fromEntries(VIOLATION_FIELDS.map(f => [f.key, f.label]))
);

// Дескриптор поля по ключу — реестр закрыт, карту строим один раз.
// Зеркало FIELD_BY_KEY из violation_fields.py; потребители (форма нарушения,
// превью) читают её отсюда, а не собирают свою копию (ревью №21).
export const FIELD_BY_KEY = Object.freeze(
  Object.fromEntries(VIOLATION_FIELDS.map(f => [f.key, f]))
);

// Ключи всех 10 полей в стандартном порядке.
export const VIOLATION_FIELD_KEYS = Object.freeze(
  VIOLATION_FIELDS.map(f => f.key)
);

// Обязательные поля (без чекбокса, enabled всегда true).
export const MANDATORY_FIELD_KEYS = Object.freeze(
  VIOLATION_FIELDS.filter(f => f.mandatory).map(f => f.key)
);

/**
 * Валиден ли пользовательский порядок полей: перестановка ВСЕХ ключей реестра
 * ровно по разу. Единый предикат для чтения (getOrderedFieldKeys) и записи
 * (мутатор setFieldOrder) — реакция на невалидный порядок у них разная
 * (молча дефолт против отказа записи), а критерий обязан быть один.
 * Зеркало is_valid_field_order из violation_fields.py.
 * @param {*} order - Проверяемое значение (обычно violation.fieldOrder)
 * @returns {boolean}
 */
export function isValidFieldOrder(order) {
  if (!Array.isArray(order)) return false;
  if (order.length !== VIOLATION_FIELD_KEYS.length) return false;
  const known = new Set(VIOLATION_FIELD_KEYS);
  const seen = new Set();
  for (const key of order) {
    if (!known.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * Порядок отображения полей нарушения: violation.fieldOrder, если задан и
 * валиден (перестановка ВСЕХ ключей реестра), иначе стандартный порядок.
 * Невалидный fieldOrder (после смены состава полей и т.п.) молча
 * игнорируется в пользу стандартного — данные полей от этого не страдают.
 * @param {Object} [violation]
 * @returns {string[]}
 */
export function getOrderedFieldKeys(violation) {
  const order = violation && violation.fieldOrder;
  return isValidFieldOrder(order) ? order : VIOLATION_FIELD_KEYS;
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
  window.VIOLATION_FIELDS = VIOLATION_FIELDS;
  window.VIOLATION_LABELS = VIOLATION_LABELS;
  window.VIOLATION_FIELD_KEYS = VIOLATION_FIELD_KEYS;
  window.MANDATORY_FIELD_KEYS = MANDATORY_FIELD_KEYS;
  window.getOrderedFieldKeys = getOrderedFieldKeys;
}
