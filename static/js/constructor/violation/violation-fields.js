/**
 * Декларативный контракт полей нарушения — блочная модель.
 *
 * Зеркало бэкенд-реестра полей нарушения: ключ, метка, стандартный порядок
 * (defaultOrder) и два флага — mandatory (поле нельзя выключить, чекбокс не
 * рендерится) и small (мелкий шрифт 9pt в DOCX). Каждое поле — единый
 * контейнер {enabled, blocks} с блоками трёх типов (см.
 * violation-block-types.js). Пользовательский порядок полей конкретного
 * нарушения — violation.fieldOrder (null = defaultOrder отсюда).
 *
 * ВАЖНО: набор синхронизируется ВРУЧНУЮ с бэкенд-реестром
 * app/domains/acts/violation_fields.py (как block_types.py ↔ block-types.js):
 * бэк не импортирует JS. Точные строки меток и порядок закреплены
 * тест-стражем tests/js/violation-fields.test.mjs; соответствие схеме
 * ViolationSchema — tests/domains/acts/test_violation_fields_guard.py.
 */

export const VIOLATION_FIELDS = Object.freeze([
  Object.freeze({ key: 'violated', label: 'Нарушено', defaultOrder: 0, mandatory: true, small: true }),
  Object.freeze({ key: 'established', label: 'Установлено', defaultOrder: 1, mandatory: true, small: true }),
  Object.freeze({ key: 'description', label: 'Описание', defaultOrder: 2, mandatory: false, small: false }),
  Object.freeze({ key: 'codeMining', label: 'CodeMining', defaultOrder: 3, mandatory: false, small: false }),
  Object.freeze({ key: 'processMining', label: 'ProcessMining', defaultOrder: 4, mandatory: false, small: false }),
  Object.freeze({ key: 'additionalContent', label: 'Дополнительный контент', defaultOrder: 5, mandatory: false, small: true }),
  Object.freeze({ key: 'reasons', label: 'Причины', defaultOrder: 6, mandatory: false, small: false }),
  Object.freeze({ key: 'measures', label: 'Принятые меры', defaultOrder: 7, mandatory: false, small: false }),
  Object.freeze({ key: 'consequences', label: 'Последствия', defaultOrder: 8, mandatory: false, small: false }),
  Object.freeze({ key: 'responsible', label: 'Ответственные', defaultOrder: 9, mandatory: false, small: false }),
]);

export const VIOLATION_LABELS = Object.freeze(
  Object.fromEntries(VIOLATION_FIELDS.map(f => [f.key, f.label]))
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
 * Порядок отображения полей нарушения: violation.fieldOrder, если задан и
 * валиден (перестановка ВСЕХ ключей реестра), иначе стандартный порядок.
 * Невалидный fieldOrder (после смены состава полей и т.п.) молча
 * игнорируется в пользу стандартного — данные полей от этого не страдают.
 * @param {Object} [violation]
 * @returns {string[]}
 */
export function getOrderedFieldKeys(violation) {
  const order = violation && violation.fieldOrder;
  if (!Array.isArray(order)) return VIOLATION_FIELD_KEYS;
  if (order.length !== VIOLATION_FIELD_KEYS.length) return VIOLATION_FIELD_KEYS;
  const known = new Set(VIOLATION_FIELD_KEYS);
  const seen = new Set();
  for (const key of order) {
    if (!known.has(key) || seen.has(key)) return VIOLATION_FIELD_KEYS;
    seen.add(key);
  }
  return order;
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
  window.VIOLATION_FIELDS = VIOLATION_FIELDS;
  window.VIOLATION_LABELS = VIOLATION_LABELS;
  window.VIOLATION_FIELD_KEYS = VIOLATION_FIELD_KEYS;
  window.MANDATORY_FIELD_KEYS = MANDATORY_FIELD_KEYS;
  window.getOrderedFieldKeys = getOrderedFieldKeys;
}
