/**
 * Декларативный контракт полей нарушения (#31A, бэкбон рефакторинга «Нарушения»).
 *
 * Зеркало реестра описаний полей нарушения: ключ, метка, порядок, вид (kind)
 * и два флага рендера (small — мелкий шрифт, showLabelInPreview — показывать
 * подпись поля в превью/форме). На этом контракте позже стоит унификация
 * подписей и единый рендер формы (следующие задачи бэкбона) — в этом файле
 * контракт только объявлен, рендереры не трогаются.
 *
 * `rich` (Task 1.3.2) — поле редактируется через rich-поверхность
 * (ViolationFieldSurface, violation-field-surface.js) и требует HTML-
 * санитайзера; true на 6 текстовых полях (violated/established/reasons/
 * measures/consequences/responsible). У descriptionList/additionalContent
 * флаг отсутствует (список/картинки — свой UI, не текстовый rich-редактор).
 *
 * ВАЖНО: набор синхронизируется ВРУЧНУЮ с бэкенд-реестром
 * app/domains/acts/violation_fields.py (как block_types.py ↔ block-types.js):
 * бэк не импортирует JS. Точные строки меток и порядок закреплены
 * тест-стражем tests/js/violation-fields.test.mjs; соответствие схеме
 * ViolationSchema — tests/domains/acts/test_violation_fields_guard.py.
 */

export const VIOLATION_FIELDS = Object.freeze([
  Object.freeze({ key: 'violated', label: 'Нарушено', order: 0, kind: 'pair', small: true, showLabelInPreview: true, rich: true }),
  Object.freeze({ key: 'established', label: 'Установлено', order: 1, kind: 'pair', small: true, showLabelInPreview: true, rich: true }),
  Object.freeze({ key: 'descriptionList', label: '', order: 2, kind: 'list', small: true, showLabelInPreview: false }),
  Object.freeze({ key: 'additionalContent', label: '', order: 3, kind: 'additional', small: true, showLabelInPreview: false }),
  Object.freeze({ key: 'reasons', label: 'Причины', order: 4, kind: 'optional_text', small: false, showLabelInPreview: true, rich: true }),
  Object.freeze({ key: 'measures', label: 'Принятые меры', order: 5, kind: 'optional_text', small: false, showLabelInPreview: true, rich: true }),
  Object.freeze({ key: 'consequences', label: 'Последствия', order: 6, kind: 'optional_text', small: false, showLabelInPreview: true, rich: true }),
  Object.freeze({ key: 'responsible', label: 'Ответственные', order: 7, kind: 'optional_text', small: false, showLabelInPreview: true, rich: true }),
]);

export const VIOLATION_LABELS = Object.freeze(
  Object.fromEntries(VIOLATION_FIELDS.map(f => [f.key, f.label]))
);

// Подпись кейса дополнительного контента ("Кейс 1", "Кейс 2", ...).
export const CASE_LABEL_TEMPLATE = 'Кейс {n}';

// Свободный текст дополнительного контента — без подписи (решение #10).
export const FREE_TEXT_LABEL = '';

// Window-globals для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
  window.VIOLATION_FIELDS = VIOLATION_FIELDS;
  window.VIOLATION_LABELS = VIOLATION_LABELS;
  window.CASE_LABEL_TEMPLATE = CASE_LABEL_TEMPLATE;
  window.FREE_TEXT_LABEL = FREE_TEXT_LABEL;
}
