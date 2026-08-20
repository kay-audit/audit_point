/**
 * Чистая группировка замечаний по таблицам для колокольчика.
 *
 * `collectTableWarnings` отдаёт по одному замечанию на ПАРУ «таблица × проблема»,
 * поэтому десять недозаполненных таблиц давали десять почти одинаковых строк
 * («нет данных», «нет данных», …). Здесь однотипные замечания сворачиваются в
 * одну группу-«облако» с перечнем таблиц внутри.
 *
 * Модуль БЕЗ импортов приложения/DOM — как соседний `notifications-warnings-cache.js`,
 * чтобы покрываться под node:test. Замыкания onClick и сборку записей центра
 * делает `notifications-source-tables.js`.
 */

/**
 * Склоняет слово «таблица» по числу (русские правила).
 *
 * @param {number} n Количество таблиц.
 * @returns {string} Строка вида «1 таблица» / «2 таблицы» / «7 таблиц».
 */
export function formatTablesCount(n) {
  const count = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  const mod100 = count % 100;
  const mod10 = count % 10;

  let word = 'таблиц';
  if (mod10 === 1 && mod100 !== 11) {
    word = 'таблица';
  } else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    word = 'таблицы';
  }
  return `${count} ${word}`;
}

/**
 * Поднимает первую букву — тексты замечаний приходят строчными
 * («нет данных»), а заголовок строки в списке начинается с заглавной.
 *
 * @param {string} text
 * @returns {string}
 */
function capitalize(text) {
  const s = String(text || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Сворачивает плоский список замечаний в группы по виду проблемы.
 *
 * Ключ группы — пара «severity + текст замечания»: одинаковый текст с разной
 * критичностью (теоретически возможно при развитии проверок) не сольётся в одну
 * строку с неверным цветом. Порядок групп — по первому появлению в исходном
 * списке, порядок таблиц внутри группы — порядок обхода: и то, и другое
 * детерминировано обходом `AppState.tables`, поэтому список не «прыгает»
 * между живыми рефрешами.
 *
 * Одна и та же таблица в группе не дублируется: `collectTableWarnings` не
 * выдаёт двух одинаковых замечаний на таблицу, но группировка не должна
 * зависеть от этого свойства источника.
 *
 * @param {Array<{tableId: *, tableName: string, issue: string, severity: string}>} warnings
 * @returns {Array<{key: string, issue: string, severity: string, title: string,
 *   body: string, tables: Array<{tableId: *, tableName: string}>}>}
 */
export function groupTableWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];

  const byKey = new Map();

  for (const w of warnings) {
    if (!w) continue;
    const issue = String(w.issue || '');
    const severity = w.severity === 'error' ? 'error' : 'warning';
    const key = `${severity}:${issue}`;

    let group = byKey.get(key);
    if (!group) {
      group = { key, issue, severity, title: capitalize(issue), body: '', tables: [] };
      byKey.set(key, group);
    }
    if (group.tables.some((t) => t.tableId === w.tableId)) continue;
    group.tables.push({ tableId: w.tableId, tableName: w.tableName });
  }

  const groups = [...byKey.values()];
  for (const group of groups) {
    group.body = formatTablesCount(group.tables.length);
  }
  return groups;
}

// Дублируем в window ради inline-скриптов; guard — модуль импортируется в node:test.
if (typeof window !== 'undefined') {
  window.groupTableWarnings = groupTableWarnings;
  window.formatTablesCount = formatTablesCount;
}
