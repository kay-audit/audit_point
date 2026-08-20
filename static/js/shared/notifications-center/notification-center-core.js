/**
 * Чистое ядро центра уведомлений (без DOM/window/fetch).
 *
 * Вынесено для покрытия node:test: выбор цвета бейджа по критичности, подсчёт
 * самого бейджа и мердж живых + персистентных уведомлений в единый список для
 * рендера. Guard `window` в конце — модуль также импортируется в браузере.
 *
 * Нормализованная форма элемента списка:
 *   {
 *     id: string,
 *     kind: 'live' | 'persisted',
 *     source: string,
 *     severity: 'error' | 'warning' | 'info',
 *     title: string,
 *     body: string,
 *     link?: string,           // только у персистентных
 *     element_ref?: string,    // только у персистентных
 *     is_read?: boolean,       // только у персистентных
 *     onClick?: () => void,    // только у живых
 *     count?: number,          // только у живых групп (размер группы)
 *     children?: Array,        // только у живых групп (вложенные записи)
 *   }
 */

/** Порядок критичности: чем больше число — тем важнее. */
const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };

/**
 * Нормализует произвольную строку severity к одному из трёх уровней.
 *
 * Серверный домен допускает 'success' — он трактуется как 'info' (нейтральная
 * критичность для цвета бейджа). Всё неизвестное → 'info'.
 *
 * @param {string} [severity]
 * @returns {'error'|'warning'|'info'}
 */
export function normalizeSeverity(severity) {
  if (severity === 'error' || severity === 'warning' || severity === 'info') {
    return severity;
  }
  return 'info';
}

/**
 * Выбирает цвет бейджа по максимальной критичности среди элементов.
 *
 * Учитывает и живые, и персистентные (вход — единый список нормализованных или
 * сырых элементов с полем `severity`). error важнее warning важнее info.
 * Пустой вход → 'info'.
 *
 * @param {Array<{severity?: string}>} items
 * @returns {'error'|'warning'|'info'}
 */
export function pickBadgeSeverity(items) {
  if (!Array.isArray(items) || items.length === 0) return 'info';

  let best = 'info';
  let bestRank = SEVERITY_RANK.info;
  for (const item of items) {
    const sev = normalizeSeverity(item && item.severity);
    const rank = SEVERITY_RANK[sev];
    if (rank > bestRank) {
      best = sev;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Выбирает цвет бейджа по живым элементам и серверной severity непрочитанных.
 *
 * Персистентная часть цвета берётся ИСКЛЮЧИТЕЛЬНО из `serverSeverity`
 * (бэкенд, GET .../unread-count) — это максимальная критичность среди ВСЕХ
 * непрочитанных видимых уведомлений на сервере, без ограничения снимка
 * /notifications (limit=50) и без задержки: агрегат свежий на каждый тик,
 * а локальный список персистентных для цвета — либо то же самое, либо
 * устаревший снимок (список тянется только при открытом меню, см.
 * notification-center.js: _loadPersisted/_pollTick), так что подмешивать
 * его больше не нужно. `serverSeverity` null/пустое — цвет только по живым.
 *
 * @param {Array<{severity?: string}>} liveItems Живые элементы.
 * @param {string|null} [serverSeverity] Серверная severity ('error'|'warning'|'info'|null).
 * @returns {'error'|'warning'|'info'}
 */
export function pickBadgeSeverityWithServer(liveItems, serverSeverity) {
  const colorItems = Array.isArray(liveItems) ? [...liveItems] : [];
  if (serverSeverity) colorItems.push({ severity: serverSeverity });
  return pickBadgeSeverity(colorItems);
}

/**
 * Считает значение и видимость бейджа.
 *
 * Бейдж = непрочитанные персистентные + число живых. Скрыт, когда сумма 0.
 *
 * @param {number} persistedUnread Число непрочитанных персистентных.
 * @param {number} liveCount Число живых элементов.
 * @returns {{count: number, hidden: boolean}}
 */
export function computeBadge(persistedUnread, liveCount) {
  const a = Number.isFinite(persistedUnread) ? Math.max(0, persistedUnread) : 0;
  const b = Number.isFinite(liveCount) ? Math.max(0, liveCount) : 0;
  const count = a + b;
  return { count, hidden: count === 0 };
}

/**
 * Форматирует число для текста бейджа с клампингом «много» к виду "max+".
 *
 * Точное число (включая трёхзначные) показывается как есть до порога max;
 * выше — "99+" (по умолчанию), чтобы бейдж не распирало. Дробное усекается,
 * отрицательное и нечисловое (NaN/Infinity) → "0".
 *
 * @param {number} count Итоговое число (persisted + live).
 * @param {number} [max=99] Порог, выше которого показывается "max+".
 * @returns {string} Текст для `badge.textContent`.
 */
export function formatBadgeCount(count, max = 99) {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return n > max ? max + '+' : String(n);
}

/**
 * Сливает живые и персистентные уведомления в единый упорядоченный список.
 *
 * Решение по порядку: ЖИВЫЕ идут сверху. Это замечания, которые пользователь
 * должен исправить прямо сейчас (в конструкторе — проблемные таблицы); они
 * актуальны «здесь и сейчас», в отличие от персистентных (исторические события,
 * ответы агента и т.п.). Внутри каждой группы сохраняется порядок входных
 * массивов. Каждый элемент помечается `kind` ('live'/'persisted') и приводится
 * к нормализованной severity.
 *
 * @param {Array<Object>} liveItems Живые элементы (уже с onClick).
 * @param {Array<Object>} persistedItems Персистентные элементы (форма NotificationOut).
 * @returns {Array<Object>} Нормализованный список для рендера.
 */
export function mergeFeed(liveItems, persistedItems) {
  const result = [];

  if (Array.isArray(liveItems)) {
    for (const item of liveItems) {
      if (!item) continue;
      result.push({
        id: item.id,
        kind: 'live',
        source: item.source || 'tables',
        severity: normalizeSeverity(item.severity),
        title: item.title || '',
        body: item.body || '',
        onClick: item.onClick,
        // Состояние/действия для живых элементов опциональны: их предоставляет
        // источник, поддерживающий клиентское прочтение/удаление (например,
        // сводка актов на лендинге). Источники без них (замечания внутри акта)
        // остаются «вечно горящими» без доступных действий.
        is_read: item.is_read === true,
        onMarkRead: item.onMarkRead,
        onMarkUnread: item.onMarkUnread,
        onDelete: item.onDelete,
        // Группа однотипных замечаний: `children` — вложенные записи со своими
        // переходами, `count` — их число для счётчика в шапке группы. Источник
        // без группировки этих полей не ставит, и запись остаётся обычной.
        count: Number.isFinite(item.count) ? item.count : null,
        children: Array.isArray(item.children) ? item.children : null,
      });
    }
  }

  if (Array.isArray(persistedItems)) {
    for (const item of persistedItems) {
      if (!item) continue;
      result.push({
        id: item.id,
        kind: 'persisted',
        source: item.source || '',
        severity: normalizeSeverity(item.severity),
        title: item.title || '',
        body: item.body || '',
        link: item.link || null,
        element_ref: item.element_ref || null,
        is_read: item.is_read === true,
      });
    }
  }

  return result;
}

/**
 * Считает число непрочитанных среди персистентных элементов.
 *
 * Удобный хелпер: бейдж считается по unread-count из API, но при локальном
 * mark-read (без перезапроса) центр пересчитывает по списку.
 *
 * @param {Array<{is_read?: boolean}>} persistedItems
 * @returns {number}
 */
export function countPersistedUnread(persistedItems) {
  if (!Array.isArray(persistedItems)) return 0;
  let n = 0;
  for (const item of persistedItems) {
    if (item && item.is_read !== true) n += 1;
  }
  return n;
}

/**
 * Считает число «активных» (непрочитанных) живых элементов.
 *
 * Живой элемент без явного состояния (is_read) считается непрочитанным — это
 * «вечно горящие» замечания внутри акта. Источники с клиентским состоянием
 * (сводка актов) выставляют is_read=true прочитанным, и те выпадают из счётчика
 * бейджа (но остаются в списке приглушёнными).
 *
 * @param {Array<{is_read?: boolean}>} liveItems
 * @returns {number}
 */
export function countUnreadLive(liveItems) {
  if (!Array.isArray(liveItems)) return 0;
  let n = 0;
  for (const item of liveItems) {
    if (item && item.is_read !== true) n += 1;
  }
  return n;
}

/**
 * Резолвит интервал поллинга персистентных уведомлений (мс) из настройки в
 * секундах (приходит с бэкенда через GET /config).
 *
 * Невалидное/неположительное/отсутствующее значение → defaultMs. Результат
 * ограничен снизу minMs, чтобы случайно заданный слишком частый опрос не бил
 * по бэкенду.
 *
 * @param {number|string} seconds Интервал в секундах (из конфига).
 * @param {{defaultMs?: number, minMs?: number}} [opts]
 * @returns {number} Интервал в миллисекундах.
 */
export function resolvePollIntervalMs(seconds, opts = {}) {
  const defaultMs = Number.isFinite(opts.defaultMs) ? opts.defaultMs : 30000;
  const minMs = Number.isFinite(opts.minMs) ? opts.minMs : 5000;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return defaultMs;
  return Math.max(minMs, Math.round(n * 1000));
}

// Дублируем в window ради inline-скриптов; guard — модуль импортируется в node:test.
if (typeof window !== 'undefined') {
  window.NotificationCenterCore = {
    normalizeSeverity,
    pickBadgeSeverity,
    pickBadgeSeverityWithServer,
    computeBadge,
    formatBadgeCount,
    mergeFeed,
    countPersistedUnread,
    countUnreadLive,
    resolvePollIntervalMs,
  };
}
