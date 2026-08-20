/**
 * Чистое ядро контентной валидации таблиц (без DOM/AppState).
 *
 * Работает напрямую с dense-сеткой (`grid` — массив строк ячеек). Вынесено из
 * `validation-table.js`, чтобы покрыть подсчёт шапки и наличие данных unit-
 * тестами (node:test) без браузера.
 *
 * Ключевое отличие от прежней логики: шапка может занимать НЕСКОЛЬКО строк
 * подряд (как у таблицы метрик: «Код метрики» + «ФЛ»/«ЮЛ»). Считаем подряд
 * идущие сверху строки-заголовки (mirror DOCX `_header_row_count`), а данными
 * считаем всё, что ниже. Прежний код брал только ПЕРВУЮ строку-заголовок, из-за
 * чего вторая строка шапки ошибочно засчитывалась как данные (E5), а таблица
 * без шапки молча проходила (E6).
 */

/**
 * Проверяет, что сетка непустая и является массивом строк.
 * @param {Object[][]} grid
 * @returns {boolean}
 */
function isUsableGrid(grid) {
  return Array.isArray(grid) && grid.length > 0;
}

/**
 * Является ли строка строкой-заголовком (содержит хотя бы одну ячейку isHeader).
 * @param {Object[]} row
 * @returns {boolean}
 */
function isHeaderRow(row) {
  return Array.isArray(row) && row.some((cell) => cell.isHeader === true);
}

/**
 * Считает количество подряд идущих сверху строк-заголовков.
 *
 * Останавливается на первой не-заголовочной строке: заголовок, расположенный
 * ниже строк данных, в шапку не входит.
 *
 * @param {Object[][]} grid Dense-сетка.
 * @returns {number} Число строк шапки (0 — шапки нет).
 */
export function countHeaderRows(grid) {
  if (!isUsableGrid(grid)) return 0;
  let count = 0;
  for (const row of grid) {
    if (!isHeaderRow(row)) break;
    count += 1;
  }
  return count;
}

/**
 * Есть ли среди ячеек шапки (всех строк заголовка) пустые видимые ячейки.
 *
 * Поглощённые объединением ячейки (`isSpanned`) игнорируются — их содержимое
 * несёт ведущая ячейка.
 *
 * @param {Object[][]} grid Dense-сетка.
 * @returns {boolean} true — есть пустой заголовок.
 */
export function hasEmptyHeaders(grid) {
  const headerRowCount = countHeaderRows(grid);
  if (headerRowCount === 0) return false;

  for (let r = 0; r < headerRowCount; r++) {
    for (const cell of grid[r]) {
      if (!cell.isSpanned && cell.isHeader && (!cell.content || !cell.content.trim())) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Есть ли хотя бы одна заполненная строка данных под шапкой.
 *
 * Данные — всё, что ниже строк шапки. Ячейка считается заполненной, если она не
 * поглощённая и её содержимое непустое.
 *
 * @param {Object[][]} grid Dense-сетка.
 * @returns {boolean} true — данные есть.
 */
export function hasDataRows(grid) {
  if (!isUsableGrid(grid)) return false;
  const dataStartIndex = countHeaderRows(grid);

  for (let r = dataStartIndex; r < grid.length; r++) {
    for (const cell of grid[r]) {
      if (!cell.isSpanned && cell.content && cell.content.trim()) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Агрегирует контентные проблемы таблицы.
 *
 * @param {Object[][]} grid Dense-сетка.
 * @returns {{noHeader:boolean, emptyHeaders:boolean, noData:boolean}}
 *   - noHeader: нет ни одной строки-заголовка (E6);
 *   - emptyHeaders: в шапке есть пустые ячейки;
 *   - noData: под шапкой нет заполненных строк данных (E5).
 */
export function validateTableContent(grid) {
  if (!isUsableGrid(grid)) {
    return { noHeader: false, emptyHeaders: false, noData: false };
  }

  const headerRowCount = countHeaderRows(grid);
  const noHeader = headerRowCount === 0;

  return {
    noHeader,
    emptyHeaders: hasEmptyHeaders(grid),
    noData: hasDataRows(grid) === false,
  };
}

/**
 * Структурный дефект сетки уровня «сервер отклонит сохранение/экспорт».
 *
 * Зеркалит проверки серверной TableSchema: прямоугольность, границы span.
 * СОЗНАТЕЛЬНО НЕ проверяет когерентность spanOrigin/isSpanned
 * (в отличие от validateGrid): легаси-операции вставки/удаления колонок и строк
 * оставляют ИНЕРТНЫЙ устаревший spanOrigin, который и рендер (`iterateVisibleCells`
 * смотрит только на isSpanned), и сервер игнорируют. Красить такую таблицу
 * красным — ложная тревога. Красный = только то, что реально сломает экспорт.
 *
 * Длина colWidths СОЗНАТЕЛЬНО НЕ проверяется: сервер при несовпадении длины с
 * числом колонок молча НОРМАЛИЗУЕТ веса (усечение/добивка под число колонок),
 * а не отклоняет сохранение. Клиент не должен быть строже сервера и предупреждать
 * о состоянии, которое сервер сам нормализует. Параметр сохранён в сигнатуре для
 * совместимости с вызовом из collectTableWarnings.
 *
 * @param {Object[][]} grid Dense-сетка.
 * @param {number[]} [colWidths] Веса колонок (на дефект не влияют — см. описание).
 * @returns {boolean} true, если есть структурный дефект.
 */
export function hasStructuralDefect(grid, colWidths) {
  if (!Array.isArray(grid) || grid.length === 0) return false;

  const width = grid[0].length;
  // Прямоугольность: все строки одной длины.
  for (const row of grid) {
    if (!Array.isArray(row) || row.length !== width) return true;
  }
  // Границы объединений: ведущая ячейка со span не должна выходить за сетку.
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < width; c++) {
      const cell = grid[r][c];
      if (!cell) return true;
      const rs = cell.rowSpan || 1;
      const cs = cell.colSpan || 1;
      if (r + rs - 1 >= grid.length || c + cs - 1 >= width) return true;
    }
  }

  // Пересечение объединений — точное зеркало серверного шага 4
  // (act_content.py:210-228). Строим coverage-матрицу из покрытий origin-ячеек,
  // ПРОПУСКАЯ isSpanned и синглтоны (colSpan==1 && rowSpan==1). Если покрытие
  // двух ведущих накладывается — DOCX-builder ломается, сервер отклоняет (422).
  // Когерентность spanOrigin/isSpanned СОЗНАТЕЛЬНО не проверяем (см. описание).
  const coverage = Array.from({ length: grid.length }, () => new Array(width).fill(false));
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < width; c++) {
      const cell = grid[r][c];
      if (cell.isSpanned) continue;
      const rs = cell.rowSpan || 1;
      const cs = cell.colSpan || 1;
      if (rs === 1 && cs === 1) continue;
      for (let rr = r; rr < r + rs; rr++) {
        for (let cc = c; cc < c + cs; cc++) {
          if (coverage[rr][cc]) return true;
          coverage[rr][cc] = true;
        }
      }
    }
  }

  return false;
}

/**
 * Собирает контентные/структурные замечания по всем таблицам (чистое ядро).
 *
 * Тип определяет критичность:
 *   - 'error' (красный) — структурный дефект, который сервер отклонит при
 *     сохранении/экспорте (hasStructuralDefect; контентные проверки для такой
 *     таблицы пропускаем), а также проблемы шапки: нет строки заголовка (E6) и
 *     не заполнены заголовки. Шапка красная не «на всякий случай», а по
 *     паритету с сервером: `collect_validation_issues` отдаёт `table_no_header`
 *     и `table_empty_header` с severity='error' и красит по ним карточку акта.
 *     Эти замечания показывает только клиент (серверный источник их подавляет,
 *     см. SUPPRESSED_CODES), поэтому расхождение критичности было бы видимым.
 *   - 'warning' (оранжевый) — неполнота: нет данных (E5).
 *
 * @param {Object<string,{grid?:Object[][], colWidths?:number[]}>} tables Словарь таблиц (tableId → таблица).
 * @param {(tableId:string)=>string} getTableName Резолвер имени таблицы по id.
 * @returns {Array<{tableId:string, tableName:string, issue:string, severity:'error'|'warning'}>}
 */
export function collectTableWarnings(tables, getTableName) {
  const warnings = [];
  if (!tables) return warnings;

  for (const tableId in tables) {
    const table = tables[tableId];
    const grid = table && table.grid;
    if (!Array.isArray(grid) || grid.length === 0) continue;

    // Ленивое разрешение имени: getTableName делает DFS по дереву, а валидные
    // таблицы (большинство) не дают ни одного замечания. Резолвим имя только при
    // первом push-сайте; мемо гарантирует максимум один DFS на проблемную
    // таблицу (ветки hasEmptyHeaders и !hasDataRows могут сработать обе).
    let resolvedName;
    const nameOf = () => (resolvedName ??= getTableName(tableId));

    if (hasStructuralDefect(grid, table.colWidths)) {
      warnings.push({ tableId, tableName: nameOf(), issue: 'нарушена структура таблицы', severity: 'error' });
      continue; // сетка ненадёжна — контентные проверки пропускаем
    }

    if (countHeaderRows(grid) === 0) {
      warnings.push({ tableId, tableName: nameOf(), issue: 'нет строки заголовка', severity: 'error' });
      continue;
    }
    if (hasEmptyHeaders(grid)) {
      warnings.push({ tableId, tableName: nameOf(), issue: 'не заполнены заголовки', severity: 'error' });
    }
    if (!hasDataRows(grid)) {
      warnings.push({ tableId, tableName: nameOf(), issue: 'нет данных', severity: 'warning' });
    }
  }

  return warnings;
}

// Дублируем в window ради inline-скриптов в шаблонах (см. CLAUDE.md).
// Guard: модуль также импортируется в node:test, где window отсутствует.
if (typeof window !== 'undefined') {
  window.countHeaderRows = countHeaderRows;
  window.hasEmptyHeaders = hasEmptyHeaders;
  window.hasDataRows = hasDataRows;
  window.validateTableContent = validateTableContent;
  window.hasStructuralDefect = hasStructuralDefect;
  window.collectTableWarnings = collectTableWarnings;
}
