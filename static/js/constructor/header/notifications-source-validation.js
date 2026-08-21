/**
 * Живой источник «validation» для shared-центра уведомлений (только конструктор).
 *
 * Показывает конкретные замечания структурной валидации акта (#8), которые
 * бэк вернул на последнем сохранении (window.AppState.validationIssues). Это
 * источник истины статуса акта (вычислен сервером), поэтому статус акта
 * «требует проверки» определяется именно этими замечаниями.
 *
 * ВАЖНО: в списке колокольчика источник показывает НЕ ВСЕ полученные замечания —
 * табличные коды из `SUPPRESSED_CODES` он опускает, потому что то же самое
 * (и живее, и сгруппированно) уже показывает источник «tables». Скрытие
 * касается только отображения: статус акта по-прежнему считает сервер по
 * полному набору замечаний.
 *
 * Замечания НЕ персистятся отдельно — снимок последнего ответа сохранения;
 * рефреш центра — по событию `act:validation-updated` (диспатчит api.js).
 */

/**
 * Коды серверных замечаний, которые этот источник НЕ показывает.
 *
 * Ровно те три кода, которые дублирует живой источник «tables»: он считает то
 * же самое по `AppState.tables` (`collectTableWarnings`), обновляется на каждое
 * изменение предпросмотра (а не раз в сохранение) и умеет сворачивать
 * однотипные замечания в группу «Нет данных — 4 таблицы». Показывать их ещё и
 * здесь — значит выводить каждое замечание дважды: сгруппированно и плоско.
 *
 * Прочие серверные коды (`empty_structure`, `missing_sections`,
 * `unprotected_sections`, `violation_incomplete`) аналога на клиенте не имеют и
 * показываются как раньше.
 *
 * @type {Set<string>}
 */
export const SUPPRESSED_CODES = new Set([
  'table_no_data',
  'table_no_header',
  'table_empty_header',
]);

/**
 * Собирает элементы уведомлений из validation_issues последнего сохранения.
 *
 * Замечания с кодами из `SUPPRESSED_CODES` отбрасываются — их показывает
 * источник «tables» (см. описание модуля).
 *
 * @returns {Array<{id:string,title:string,body:string,severity:string}>}
 */
export function collectValidationItems() {
  const state = (typeof window !== 'undefined' && window.AppState) || {};
  const issues = Array.isArray(state.validationIssues) ? state.validationIssues : [];
  return issues
    .filter((issue) => !SUPPRESSED_CODES.has(issue.code))
    .map((issue, i) => ({
      id: `validation:${issue.code || 'issue'}:${issue.ref || i}`,
      title: 'Структура акта',
      body: issue.message || '',
      severity: issue.severity === 'error' ? 'error' : 'warning',
    }));
}

/**
 * Регистрирует источник «validation» и подписывает рефреш на событие
 * обновления статуса валидации (после сохранения).
 * @param {Object} center NotificationCenter.
 */
export function registerValidationSource(center) {
  if (!center) return;

  center.registerSource('validation', {
    collect: () => collectValidationItems(),
  });

  document.addEventListener('act:validation-updated', () => center.refresh());
}

// Window-global для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
  window.registerValidationSource = registerValidationSource;
}
