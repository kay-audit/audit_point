/**
 * Живой источник «tables» для shared-центра уведомлений (только конструктор).
 *
 * Регистрирует в общий NotificationCenter живой источник, который отдаёт
 * контентные/структурные замечания по таблицам (ValidationTable.collectContentWarnings()).
 * Замечания НЕ персистятся — это снимок текущего состояния документа.
 *
 * Однотипные замечания сворачиваются в одну раскрывающуюся группу
 * (см. `notifications-warnings-group.js`), чтобы десяток недозаполненных таблиц
 * не превращался в десяток одинаковых строк.
 *
 * Клик по замечанию переводит к проблемной таблице в предпросмотре (inline-панель
 * #preview или модальное меню previewMenuManager) и кратко подсвечивает её рамкой.
 *
 * Рефреш центра — по событию `preview:content-changed` (живое обновление).
 */
import { ValidationTable } from '../validation/validation-table.js';
import { makeWarningsCache } from './notifications-warnings-cache.js';
import { groupTableWarnings } from './notifications-warnings-group.js';

/** Модульный кеш замечаний по таблицам (один на конструктор). */
const _warningsCache = makeWarningsCache(() => ValidationTable.collectContentWarnings());

/**
 * Возвращает закешированные замечания по таблицам.
 *
 * Первый вызов после инвалидации обходит дерево; последующие до следующей
 * инвалидации отдают тот же снимок. Инвалидацию дёргает предпросмотр в начале
 * каждого тика обновления (см. preview.js).
 *
 * @returns {Array}
 */
export function getCachedTableWarnings() {
  return _warningsCache.get();
}

/** Сбрасывает кеш замечаний (вызывается предпросмотром перед перерасчётом). */
export function invalidateTableWarningsCache() {
  _warningsCache.invalidate();
}

/**
 * Скроллит к элементу предпросмотра и кратко подсвечивает его рамкой.
 * @param {HTMLElement} el
 */
function scrollAndFlash(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('preview-table-wrapper--flash');
  setTimeout(() => el.classList.remove('preview-table-wrapper--flash'), 1300);
}

/**
 * Переходит к таблице в предпросмотре и подсвечивает её.
 *
 * Если inline-панель #preview видима — скроллит к таблице в ней. Иначе открывает
 * модальное меню предпросмотра (previewMenuManager) и подсвечивает таблицу там.
 *
 * @param {string} tableId
 * @param {NotificationCenter} center Центр — чтобы закрыть колокольчик перед переходом.
 */
function navigateToTable(tableId, center) {
  if (tableId == null) return;
  const sel = `.preview-table-wrapper[data-table-id="${CSS.escape(String(tableId))}"]`;

  const inline = document.querySelector('#preview ' + sel);
  if (inline && inline.offsetParent !== null) {
    // inline-панель видима — скроллим прямо в ней.
    if (center) center.close();
    scrollAndFlash(inline);
    return;
  }

  // Иначе открываем модальное меню предпросмотра и подсвечиваем там.
  if (window.previewMenuManager) {
    if (center) center.close();
    window.previewMenuManager.open();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const inModal = document.querySelector('#previewMenuBody ' + sel);
      if (inModal) scrollAndFlash(inModal);
    }));
  }
}

/**
 * Строит запись перехода к одной таблице.
 *
 * Одна и та же форма служит и самостоятельной записью (когда замечание такого
 * вида ровно одно), и подстрокой раскрытой группы. Различие — тело: у
 * самостоятельной это текст замечания, у подстроки оно пустое, потому что
 * замечание уже написано в шапке группы и под каждой таблицей повторялось бы
 * слово в слово.
 *
 * @param {{tableId:*, tableName:string}} table
 * @param {string} issue Текст замечания (идёт в id записи).
 * @param {string} severity
 * @param {string} body Тело записи ('' — без тела).
 * @param {NotificationCenter} center
 * @returns {{id:string,title:string,body:string,severity:string,onClick:Function}}
 */
function makeTableItem(table, issue, severity, body, center) {
  return {
    id: `tables:${table.tableId}:${issue}`,
    title: table.tableName,
    body,
    severity,
    onClick: () => navigateToTable(table.tableId, center),
  };
}

/**
 * Собирает живые замечания по таблицам в нормализованной форме источника.
 *
 * Однотипные замечания сворачиваются в одну строку-группу: «Не заполнены
 * заголовки — 7 таблиц» вместо семи почти одинаковых записей. Группа несёт
 * `children` (переходы к каждой таблице) и `count`; центр рисует её
 * раскрывающейся. Группа из одной таблицы разворачивается обратно в обычную
 * запись — «×1» ничего не сообщает, а лишний клик мешает.
 *
 * Бейдж колокольчика считает элементы, которые вернул источник, поэтому после
 * группировки он показывает число групп — ровно то, что видно в списке.
 *
 * @param {NotificationCenter} center
 * @returns {Array<Object>}
 */
function collectTableItems(center) {
  // Тот же снимок, что и рамки таблиц в предпросмотре — без повторного обхода
  // дерева (кеш инвалидируется предпросмотром в начале тика обновления).
  const groups = groupTableWarnings(getCachedTableWarnings());

  return groups.map((group) => {
    if (group.tables.length === 1) {
      return makeTableItem(group.tables[0], group.issue, group.severity, group.issue, center);
    }
    return {
      id: `tables:group:${group.key}`,
      title: group.title,
      body: group.body,
      severity: group.severity,
      count: group.tables.length,
      children: group.tables.map(
        (t) => makeTableItem(t, group.issue, group.severity, '', center)
      ),
    };
  });
}

/**
 * Регистрирует источник «tables» в переданном центре и подписывает рефреш.
 * @param {NotificationCenter} center
 */
export function registerTablesSource(center) {
  if (!center) return;

  center.registerSource('tables', {
    collect: () => collectTableItems(center),
  });

  // Живое обновление при изменении содержимого предпросмотра.
  document.addEventListener('preview:content-changed', () => center.refresh());
}

// Window-global для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
  window.registerTablesSource = registerTablesSource;
}
