/**
 * Единый shared-центр уведомлений (колокольчик) для портала и конструктора.
 *
 * Показывает в одном выпадающем меню:
 *   - персистентные уведомления из домена notifications (GET/POST API);
 *   - живые источники (например, замечания по таблицам в конструкторе) —
 *     регистрируются через registerSource(), НЕ персистятся.
 *
 * НЕ путать с toast-системой `shared/notifications.js` (window.Notifications) —
 * это всплывашки, а не колокольчик.
 *
 * Биндится к существующей разметке по DOM-id:
 *   #notificationsBtn / #notificationsMenu / #notificationsBody /
 *   #notificationsBadge / #closeNotificationsBtn / #notificationsReadAllBtn (опц.).
 * Если обязательных элементов нет — init() тихо выходит (страница без колокольчика).
 */
import { EscapeStack } from '../escape-stack.js';
import { AppConfig } from '../app-config.js';
import { makeResizablePanel } from '../resizable-panel.js';
import {
  pickBadgeSeverityWithServer,
  computeBadge,
  formatBadgeCount,
  mergeFeed,
  normalizeSeverity,
  countPersistedUnread,
  countUnreadLive,
  resolvePollIntervalMs,
} from './notification-center-core.js';

/** Интервал поллинга по умолчанию (мс) — фолбэк, если конфиг недоступен. */
const DEFAULT_POLL_INTERVAL_MS = 30000;
/** Нижняя граница интервала поллинга (мс) — защита от слишком частого опроса. */
const MIN_POLL_INTERVAL_MS = 5000;

// Границы ручного ресайза меню (передаются в makeResizablePanel). Меню прижато
// к правому краю, поэтому ширина растёт влево (growX:'left'), высота — вниз.
const MENU_MIN_WIDTH = 320;
const MENU_MAX_WIDTH_PX = 640;
const MENU_MAX_WIDTH_VW = 90;
const MENU_MIN_HEIGHT = 200;
const MENU_MAX_HEIGHT_VH = 85;
/** Ключ localStorage с сохранённым размером меню (общий портал/конструктор). */
const MENU_SIZE_KEY = 'notif:menu:size';

export class NotificationCenter {
  /**
   * @param {{enablePersisted?: boolean}} [options]
   *   enablePersisted — включить встроенный персистентный источник (API). По
   *   умолчанию true. На страницах без бэкенд-уведомлений можно передать false.
   */
  constructor(options = {}) {
    this.enablePersisted = options.enablePersisted !== false;

    this.btn = null;
    this.menu = null;
    this.body = null;
    this.badge = null;
    this.closeBtn = null;
    this.readAllBtn = null;

    this.isOpen = false;
    this._escapeUnsub = null;
    this._pollTimer = null;
    // teardown ручного ресайза меню (общая утилита makeResizablePanel).
    this._resizer = null;

    // Контекстное меню записи (Прочитать/Непрочитанным/Удалить). Один общий
    // элемент на body, переиспользуется. Заменяет прежний крестик dismiss.
    this._ctxMenu = null;
    this._ctxOpen = false;
    this._ctxEscapeUnsub = null;
    // Интервал поллинга (мс). Фолбэк до загрузки конфига с бэкенда
    // (GET /config отдаёт значение из NOTIFICATIONS__POLL_INTERVAL_SECONDS).
    this._pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    // Флаг teardown: поллинг стартует асинхронно (после _loadConfig), а destroy()
    // может успеть раньше резолва — тогда отложенный _startPolling не должен
    // создать «осиротевший» таймер.
    this._destroyed = false;

    /** @type {Map<string, {collect: Function}>} */
    this._sources = new Map();
    // id раскрытых групп однотипных замечаний. Живые источники рефрешатся на
    // каждое изменение документа и список перерисовывается целиком — без этой
    // памяти открытая группа схлопывалась бы под курсором при каждой правке.
    /** @type {Set<string>} */
    this._expandedGroups = new Set();
    /** Последний снимок персистентных уведомлений (форма NotificationOut). */
    this._persisted = [];
    // Точное число непрочитанных персистентных с сервера (GET .../unread-count).
    // Снимок /notifications ограничен limit=50, поэтому подсчёт по списку врёт
    // при большом хвосте — для бейджа используем это точное число, когда оно
    // загружено. null до первой удачной загрузки (тогда fallback на подсчёт).
    this._persistedUnreadCount = null;
    // Максимальная критичность непрочитанных видимых уведомлений с сервера
    // ('error'|'warning'|'info'|null). Снимок /notifications ограничен limit=50,
    // поэтому error в хвосте за позицией 50 не попал бы в окраску бейджа — эта
    // серверная severity сворачивается в расчёт цвета. null до первой загрузки.
    this._persistedUnreadSeverity = null;

    // Стабильные ссылки на обработчики — нужны для destroy().
    this._onBtnClick = (e) => { e.stopPropagation(); this.toggle(); };
    this._onCloseClick = (e) => { e.stopPropagation(); this.close(); };
    this._onReadAllClick = (e) => { e.stopPropagation(); this._markAllRead(); };
    this._onDocClick = (e) => this._handleOutsideClick(e);
    this._onVisibilityChange = () => this._handleVisibilityChange();
    this._onRefreshEvent = () => this.refresh();
    // Прокрутка (любого контейнера или окна) и ресайз сдвигают якорь
    // контекстного меню (position:fixed) — закрываем его. Скролл слушаем на
    // window в capture-фазе: ловит и прокрутку внутреннего списка, и страницы.
    this._onScroll = () => this._closeContextMenu();
    // Ресайз окна сдвигает якорь контекстного меню — закрываем его. Пере-кламп
    // размера самого меню при ресайзе окна делает makeResizablePanel.
    this._onWinResize = () => this._closeContextMenu();
  }

  /**
   * Захватывает DOM, навешивает обработчики, запускает поллинг и первый refresh.
   * Если обязательных элементов нет — тихо выходит.
   */
  init() {
    this.btn = document.getElementById('notificationsBtn');
    this.menu = document.getElementById('notificationsMenu');
    this.body = document.getElementById('notificationsBody');
    this.badge = document.getElementById('notificationsBadge');
    this.closeBtn = document.getElementById('closeNotificationsBtn');
    this.readAllBtn = document.getElementById('notificationsReadAllBtn');
    if (!this.btn || !this.menu || !this.body || !this.badge) {
      return; // страница без колокольчика — ничего не делаем
    }

    this._destroyed = false; // на случай повторной инициализации после destroy()

    this.btn.addEventListener('click', this._onBtnClick);
    if (this.closeBtn) this.closeBtn.addEventListener('click', this._onCloseClick);
    if (this.readAllBtn) this.readAllBtn.addEventListener('click', this._onReadAllClick);

    // Ресайз меню угловой ручкой (общая утилита; меню прижато вправо → растёт
    // влево и вниз). Утилита сама восстанавливает сохранённый размер и пере-клампит.
    const resizeHandle = this.menu.querySelector('.notifications-menu-resize');
    if (resizeHandle) {
      this._resizer = makeResizablePanel({
        panel: this.menu,
        handle: resizeHandle,
        growX: 'left',
        minWidth: MENU_MIN_WIDTH,
        maxWidthPx: MENU_MAX_WIDTH_PX,
        maxWidthVw: MENU_MAX_WIDTH_VW,
        minHeight: MENU_MIN_HEIGHT,
        maxHeightVh: MENU_MAX_HEIGHT_VH,
        storageKey: MENU_SIZE_KEY,
        cursor: 'nesw-resize',
      });
    }

    document.addEventListener('click', this._onDocClick);
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    document.addEventListener('notifications:refresh', this._onRefreshEvent);
    window.addEventListener('scroll', this._onScroll, true);
    window.addEventListener('resize', this._onWinResize);

    if (this.enablePersisted) {
      // Сначала тянем интервал из конфига, затем запускаем поллинг. Сбой
      // загрузки конфига → остаётся фолбэк-интервал. Guard _destroyed: если
      // destroy() успел отработать до резолва — таймер не создаём.
      this._loadConfig().then(() => {
        if (!this._destroyed) this._startPolling();
      });
      // Стартовая загрузка персистентных: иначе бейдж пуст до первого
      // поллинг-тика (~30с). Guard _destroyed — destroy() мог успеть раньше.
      // Только счётчик — список никому не нужен, пока меню не открыли.
      this._loadPersisted({ listToo: false }).then(() => {
        if (!this._destroyed) this.refresh();
      });
    }

    this.refresh();
  }

  /**
   * Регистрирует живой источник уведомлений.
   * @param {string} key Уникальный ключ источника (например 'tables').
   * @param {{collect: () => Array}} handlers
   *   collect — собирает живые элементы (форма {id,title,body,severity,source?}).
   */
  registerSource(key, handlers) {
    if (!key || !handlers || typeof handlers.collect !== 'function') return;
    this._sources.set(key, handlers);
    this.refresh();
  }

  /** Снимает живой источник. */
  unregisterSource(key) {
    this._sources.delete(key);
    this.refresh();
  }

  /**
   * Пересобирает данные и обновляет бейдж (и список, если меню открыто).
   *
   * Персистентные подтягиваются с API (если включены) только при открытии и по
   * поллингу/событию — здесь используется последний снимок. Бейдж считается по
   * живым (всегда свежие) + непрочитанным персистентным.
   */
  refresh() {
    if (!this.badge) return;
    const live = this._collectLive();
    this._renderBadge(live, this._persisted);
    if (this.isOpen) this._renderList(live, this._persisted);
  }

  /**
   * Собирает живые элементы из всех зарегистрированных источников.
   * Сбой одного источника не должен ломать колокольчик.
   * @private
   * @returns {Array<Object>}
   */
  _collectLive() {
    const items = [];
    for (const [key, handlers] of this._sources) {
      try {
        const collected = handlers.collect();
        if (Array.isArray(collected)) {
          for (const it of collected) {
            items.push({ ...it, source: it.source || key });
          }
        }
      } catch (e) {
        console.warn('[NotificationCenter] источник', key, 'упал при collect:', e);
      }
    }
    return items;
  }

  /**
   * Обновляет счётчик-бейдж: значение и цвет по максимальной критичности.
   * @private
   * @param {Array} live
   * @param {Array} persisted
   */
  _renderBadge(live, persisted) {
    // Точное серверное число непрочитанных приоритетнее подсчёта по снимку
    // (снимок ограничен limit=50). До первой удачной загрузки — fallback на снимок.
    const persistedUnread = (this._persistedUnreadCount != null)
      ? this._persistedUnreadCount
      : countPersistedUnread(persisted);
    // Бейдж считает только НЕпрочитанные живые: прочитанные клиентом (сводка
    // актов) выпадают из счётчика, «вечно горящие» (внутри акта, без состояния)
    // считаются всегда.
    const { count, hidden } = computeBadge(persistedUnread, countUnreadLive(live));

    if (hidden) {
      this.badge.classList.add('hidden');
      this.badge.classList.remove('notif-badge--error', 'notif-badge--warning', 'notif-badge--info');
      return;
    }

    this.badge.classList.remove('hidden');
    this.badge.textContent = formatBadgeCount(count);

    // Цвет — по живым + серверной severity непрочитанных персистентных
    // (this._persistedUnreadSeverity, GET .../unread-count). Локальный снимок
    // persisted для цвета не используется: серверный агрегат уже полон (не
    // ограничен limit=50) и свежий на каждый тик, а снимок при закрытом меню
    // может не обновляться вовсе (см. _loadPersisted/_pollTick).
    const unreadLive = live.filter((it) => it && it.is_read !== true);
    const sev = pickBadgeSeverityWithServer(unreadLive, this._persistedUnreadSeverity);
    this.badge.classList.toggle('notif-badge--error', sev === 'error');
    this.badge.classList.toggle('notif-badge--warning', sev === 'warning');
    this.badge.classList.toggle('notif-badge--info', sev === 'info');
  }

  /** Переключает видимость меню. */
  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Открывает меню, подтягивает свежие персистентные и рендерит список. */
  open() {
    this.menu.classList.remove('hidden');
    this.btn.classList.add('active');
    this.isOpen = true;
    this._escapeUnsub = EscapeStack.push(() => this.close());

    // Сначала рисуем по текущему снимку, затем дозагружаем персистентные.
    this._renderList(this._collectLive(), this._persisted);
    if (this.enablePersisted) {
      this._loadPersisted().then(() => {
        if (this.isOpen) this._renderList(this._collectLive(), this._persisted);
      });
    }
  }

  /** Закрывает меню. */
  close() {
    this.menu.classList.add('hidden');
    this.btn.classList.remove('active');
    this.isOpen = false;
    this._closeContextMenu();
    if (this._escapeUnsub) {
      this._escapeUnsub();
      this._escapeUnsub = null;
    }
  }

  /**
   * Снимает все обработчики и таймеры (для тестов / переинициализации).
   */
  destroy() {
    this._destroyed = true;
    this._stopPolling();
    this._closeContextMenu();
    if (this._resizer) {
      this._resizer.destroy(); // снимает слушатели ресайза + сбрасывает залипшее
      this._resizer = null;
    }
    if (this.btn) this.btn.removeEventListener('click', this._onBtnClick);
    if (this.closeBtn) this.closeBtn.removeEventListener('click', this._onCloseClick);
    if (this.readAllBtn) this.readAllBtn.removeEventListener('click', this._onReadAllClick);
    window.removeEventListener('scroll', this._onScroll, true);
    window.removeEventListener('resize', this._onWinResize);
    document.removeEventListener('click', this._onDocClick);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    document.removeEventListener('notifications:refresh', this._onRefreshEvent);
    if (this._ctxMenu && this._ctxMenu.parentNode) {
      this._ctxMenu.parentNode.removeChild(this._ctxMenu);
    }
    this._ctxMenu = null;
    if (this._escapeUnsub) {
      this._escapeUnsub();
      this._escapeUnsub = null;
    }
  }

  // ── Персистентный источник (API) ────────────────────────────────────────

  /**
   * Загружает конфиг центра уведомлений с API и применяет интервал поллинга.
   * Сетевой/парс-сбой не критичен — остаётся фолбэк-интервал.
   * @private
   * @returns {Promise<void>}
   */
  async _loadConfig() {
    try {
      const resp = await fetch(AppConfig.api.getUrl('/api/v1/notifications/config'), {
        headers: { Accept: 'application/json' },
      });
      if (!resp.ok) return;
      const data = await resp.json();
      this._pollIntervalMs = resolvePollIntervalMs(data && data.pollIntervalSeconds, {
        defaultMs: DEFAULT_POLL_INTERVAL_MS,
        minMs: MIN_POLL_INTERVAL_MS,
      });
    } catch (e) {
      // тихо — оставляем фолбэк-интервал
    }
  }

  /** @private Запускает фоновый поллинг (пауза при скрытой вкладке). */
  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => {
      if (document.hidden) return;
      this._pollTick();
    }, this._pollIntervalMs);
  }

  /** @private */
  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /** @private При возврате на вкладку — освежаем данные (как обычный тик). */
  _handleVisibilityChange() {
    if (!document.hidden && this.enablePersisted) {
      return this._pollTick();
    }
  }

  /**
   * Общий тик обновления персистентных (поллинг-таймер и visibilitychange).
   *
   * Список (limit=50) тянется только при открытом меню — закрытому бейджу
   * достаточно unread-count, лишний SQL/HTTP на каждый тик не нужен.
   * @private
   * @returns {Promise<void>}
   */
  _pollTick() {
    return this._loadPersisted({ listToo: this.isOpen }).then(() => this.refresh());
  }

  /**
   * Загружает персистентные уведомления с API и сохраняет снимок.
   * Сетевой сбой не должен ломать колокольчик — снимок остаётся прежним.
   * @private
   * @param {{listToo?: boolean}} [opts]
   *   listToo — тянуть ли снимок списка (limit=50) вместе со счётчиком.
   *   По умолчанию true. Список нужен только рендеру меню; при закрытом меню
   *   false экономит SQL-запрос на каждый поллинг-тик.
   * @returns {Promise<void>}
   */
  async _loadPersisted({ listToo = true } = {}) {
    if (!this.enablePersisted) return;
    try {
      // Счётчик непрочитанных + их максимальная severity — всегда (нужен
      // бейджу). Снимок списка (limit=50) — только когда он реально пойдёт в
      // рендер. Каждый запрос со своим .catch(()=>null), чтобы сбой одного не
      // топил другой.
      const [resp, cr] = await Promise.all([
        listToo
          ? fetch(AppConfig.api.getUrl('/api/v1/notifications?limit=50'), { headers: { Accept: 'application/json' } }).catch(() => null)
          : Promise.resolve(null),
        fetch(AppConfig.api.getUrl('/api/v1/notifications/unread-count'), { headers: { Accept: 'application/json' } }).catch(() => null),
      ]);
      if (resp && resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data)) this._persisted = data;
      }
      // Точное число непрочитанных + severity — отдельным запросом (снимок выше
      // ограничен limit=50). Сбой не критичен: остаются прежние значения.
      if (cr && cr.ok) {
        const cd = await cr.json();
        if (Number.isFinite(cd && cd.count)) this._persistedUnreadCount = cd.count;
        if (typeof cd.severity === 'string') this._persistedUnreadSeverity = cd.severity;
        else if (cd && cd.severity === null) this._persistedUnreadSeverity = null;
      }
    } catch (e) {
      // тихо — оставляем прежний снимок
    }
  }

  /**
   * POST mark-read для персистентного уведомления + локальное обновление снимка.
   * @private
   * @param {string} id
   */
  async _markRead(id) {
    const item = this._persisted.find((n) => n && n.id === id);
    // Оптимистично уменьшаем серверный счётчик только при реальном переходе
    // непрочитано→прочитано (повторный клик по прочитанному не должен врать).
    if (item && item.is_read !== true && this._persistedUnreadCount != null && this._persistedUnreadCount > 0) {
      this._persistedUnreadCount -= 1;
    }
    if (item) item.is_read = true; // оптимистично
    this.refresh();
    try {
      await fetch(AppConfig.api.getUrl(`/api/v1/notifications/${encodeURIComponent(id)}/read`), {
        method: 'POST',
      });
    } catch (e) {
      // не критично — снимок освежится поллингом
    }
  }

  /**
   * POST mark-unread для персистентного уведомления + локальное обновление.
   * @private
   * @param {string} id
   */
  async _markUnread(id) {
    const item = this._persisted.find((n) => n && n.id === id);
    // Оптимистично увеличиваем серверный счётчик только при реальном переходе
    // прочитано→непрочитано.
    if (item && item.is_read === true && this._persistedUnreadCount != null) {
      this._persistedUnreadCount += 1;
    }
    if (item) item.is_read = false; // оптимистично
    this.refresh();
    try {
      await fetch(AppConfig.api.getUrl(`/api/v1/notifications/${encodeURIComponent(id)}/unread`), {
        method: 'POST',
      });
    } catch (e) {
      // не критично — снимок освежится поллингом
    }
  }

  /**
   * POST dismiss для персистентного уведомления + удаление из снимка.
   * @private
   * @param {string} id
   */
  async _dismiss(id) {
    // Если скрываемое уведомление было непрочитано — уменьшаем серверный счётчик.
    const dismissed = this._persisted.find((n) => n && n.id === id);
    if (dismissed && dismissed.is_read !== true && this._persistedUnreadCount != null && this._persistedUnreadCount > 0) {
      this._persistedUnreadCount -= 1;
    }
    this._persisted = this._persisted.filter((n) => !(n && n.id === id));
    this.refresh();
    try {
      await fetch(AppConfig.api.getUrl(`/api/v1/notifications/${encodeURIComponent(id)}/dismiss`), {
        method: 'POST',
      });
    } catch (e) {
      // не критично
    }
  }

  /** @private POST read-all + обновление. */
  async _markAllRead() {
    const prevCount = this._persistedUnreadCount;
    for (const n of this._persisted) {
      if (n) n.is_read = true;
    }
    this._persistedUnreadCount = 0; // оптимистично: всё прочитано
    this.refresh();
    try {
      await fetch(AppConfig.api.getUrl('/api/v1/notifications/read-all'), { method: 'POST' });
      await this._loadPersisted();
      this.refresh();
    } catch (e) {
      // Откат оптимистичного зануления: сервер read-all атомарен, при сбое состояние
      // на сервере не изменилось. is_read-флаги самовосстановятся ближайшим поллингом.
      this._persistedUnreadCount = prevCount;
      this.refresh();
    }
  }

  // ── Контекстное меню записи ──────────────────────────────────────────────

  /**
   * Возвращает доступные действия для записи в виде [{label, run, danger?}].
   *
   * Персистентные поддерживают всё (read/unread/delete через API). Живые — лишь
   * то, для чего источник дал обработчик (onMarkRead/onMarkUnread/onDelete):
   * сводка актов выдаёт их для warning-записей, замечания внутри акта — нет
   * (тогда меню пустое — «вечно горящие»). Пункт read/unread зависит от is_read.
   * @private
   * @param {Object} item
   * @returns {Array<{label: string, run: Function, danger?: boolean}>}
   */
  _actionsFor(item) {
    const isPersisted = item.kind === 'persisted';
    const canRead = isPersisted || typeof item.onMarkRead === 'function';
    const canUnread = isPersisted || typeof item.onMarkUnread === 'function';
    const canDelete = isPersisted || typeof item.onDelete === 'function';

    const actions = [];
    if (item.is_read) {
      if (canUnread) actions.push({ label: 'Отметить непрочитанным', run: () => this._setItemRead(item, false) });
    } else if (canRead) {
      actions.push({ label: 'Прочитать', run: () => this._setItemRead(item, true) });
    }
    if (canDelete) actions.push({ label: 'Удалить', danger: true, run: () => this._deleteItem(item) });
    return actions;
  }

  /**
   * Помечает запись прочитанной/непрочитанной (персистентная → API, живая →
   * обработчик источника).
   * @private
   */
  _setItemRead(item, read) {
    if (item.kind === 'persisted') {
      if (read) this._markRead(item.id);
      else this._markUnread(item.id);
      return;
    }
    try {
      if (read && typeof item.onMarkRead === 'function') item.onMarkRead();
      else if (!read && typeof item.onMarkUnread === 'function') item.onMarkUnread();
    } catch (e) {
      console.warn('[NotificationCenter] переключение прочтения живой записи упало:', e);
    }
    this.refresh();
  }

  /**
   * Удаляет запись (персистентная → dismiss API, живая → обработчик источника).
   * @private
   */
  _deleteItem(item) {
    if (item.kind === 'persisted') {
      this._dismiss(item.id);
      return;
    }
    try {
      if (typeof item.onDelete === 'function') item.onDelete();
    } catch (e) {
      console.warn('[NotificationCenter] удаление живой записи упало:', e);
    }
    this.refresh();
  }

  /** @private Создаёт (лениво) контейнер контекстного меню на body. */
  _ensureContextMenu() {
    if (this._ctxMenu) return this._ctxMenu;
    const menu = document.createElement('div');
    menu.className = 'notif-context-menu hidden';
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    this._ctxMenu = menu;
    return menu;
  }

  /**
   * Открывает контекстное меню записи в точке (x, y) вьюпорта. Пустой набор
   * действий показывает заглушку «Нет доступных действий».
   * @private
   * @param {Object} item
   * @param {number} x
   * @param {number} y
   */
  _openContextMenu(item, x, y) {
    this._closeContextMenu(); // сбрасываем прежнее меню/escape-подписку
    const menu = this._ensureContextMenu();
    menu.innerHTML = '';

    const actions = this._actionsFor(item);
    if (!actions.length) {
      const empty = document.createElement('div');
      empty.className = 'notif-context-menu-empty';
      empty.textContent = 'Нет доступных действий';
      menu.appendChild(empty);
    } else {
      for (const a of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'notif-context-menu-item' + (a.danger ? ' notif-context-menu-item--danger' : '');
        btn.setAttribute('role', 'menuitem');
        btn.textContent = a.label;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._closeContextMenu();
          try { a.run(); } catch (err) { console.warn('[NotificationCenter] действие меню упало:', err); }
        });
        menu.appendChild(btn);
      }
    }

    // Показываем, замеряем, корректируем позицию чтобы не вылезти за вьюпорт.
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8);
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    this._ctxOpen = true;
    this._ctxEscapeUnsub = EscapeStack.push(() => this._closeContextMenu());
  }

  /** @private Закрывает контекстное меню записи. */
  _closeContextMenu() {
    if (this._ctxMenu) this._ctxMenu.classList.add('hidden');
    this._ctxOpen = false;
    if (this._ctxEscapeUnsub) {
      this._ctxEscapeUnsub();
      this._ctxEscapeUnsub = null;
    }
  }

  // ── Рендер ──────────────────────────────────────────────────────────────

  /**
   * Рендерит единый список (живые сверху, затем персистентные). XSS-safe.
   * @private
   * @param {Array} live
   * @param {Array} persisted
   */
  _renderList(live, persisted) {
    const feed = mergeFeed(live, persisted);
    this.body.innerHTML = '';

    if (!feed.length) {
      const empty = document.createElement('div');
      empty.className = 'notifications-empty';
      empty.textContent = 'Уведомлений нет';
      this.body.appendChild(empty);
      return;
    }

    // Раскрытые группы, которых в свежем снимке уже нет (таблицы поправили),
    // из памяти выпадают — иначе Set копил бы мёртвые id за сессию.
    const groupIds = new Set(feed.filter((it) => it.children).map((it) => it.id));
    for (const id of this._expandedGroups) {
      if (!groupIds.has(id)) this._expandedGroups.delete(id);
    }

    for (const item of feed) {
      this.body.appendChild(item.children ? this._buildGroup(item) : this._buildItem(item));
    }
  }

  /**
   * Строит DOM группы однотипных замечаний: строка-шапка + скрытый список
   * вложенных записей.
   *
   * Шапка — обычная запись со счётчиком и стрелкой; клик по ней разворачивает
   * группу, а не уводит на лист (см. _handleItemClick). Вложенные записи
   * приходят из источника «как есть» (kind им не проставлен — это не элементы
   * ленты) и ведут себя как одиночные живые замечания.
   *
   * @private
   * @param {Object} group Нормализованный элемент с полем children.
   * @returns {HTMLElement}
   */
  _buildGroup(group) {
    const wrap = document.createElement('div');
    wrap.className = 'notification-group';

    const expanded = this._expandedGroups.has(group.id);

    const head = this._buildItem(group);
    head.classList.add('notification-item--group');
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    wrap.appendChild(head);

    const list = document.createElement('div');
    list.className = 'notification-group-children';
    if (!expanded) list.classList.add('hidden');
    for (const child of group.children) {
      if (!child) continue;
      const row = this._buildItem({
        ...child,
        kind: 'live',
        severity: normalizeSeverity(child.severity),
      });
      row.classList.add('notification-item--child');
      list.appendChild(row);
    }
    wrap.appendChild(list);

    return wrap;
  }

  /**
   * Разворачивает/сворачивает группу.
   *
   * Меняет DOM точечно, а НЕ перерисовывает список: полная перерисовка внутри
   * обработчика клика выдёргивает `event.target` из документа, и всплывший до
   * document клик обработчик «клик мимо меню» считает внешним (menu.contains()
   * по оторванному узлу — false), после чего меню закрывается прямо на глазах.
   * Память о раскрытии всё равно живёт в `_expandedGroups` — её читает
   * следующий полноценный рендер списка.
   *
   * @private
   * @param {string} id id группы.
   * @param {HTMLElement} head Строка-шапка группы (по ней ищем список детей).
   */
  _toggleGroup(id, head) {
    const expanded = !this._expandedGroups.has(id);
    if (expanded) this._expandedGroups.add(id);
    else this._expandedGroups.delete(id);

    if (!head) return;
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const list = head.parentElement
      && head.parentElement.querySelector('.notification-group-children');
    if (list) list.classList.toggle('hidden', !expanded);
  }

  /**
   * Строит DOM одной записи списка.
   * @private
   * @param {Object} item Нормализованный элемент (см. core).
   * @returns {HTMLElement}
   */
  _buildItem(item) {
    const row = document.createElement('div');
    row.className = 'notification-item';
    // Прочитанное приглушается и у персистентных, и у живых с клиентским
    // состоянием (сводка актов). Живые без состояния всегда непрочитаны.
    if (item.is_read) {
      row.classList.add('notification-item--read');
    }

    const dot = document.createElement('span');
    dot.className = 'notif-dot notif-dot--' + item.severity;
    row.appendChild(dot);

    const textWrap = document.createElement('span');
    textWrap.className = 'notification-item-text';

    const title = document.createElement('span');
    title.className = 'notification-item-title';
    title.textContent = item.title || (item.kind === 'live' ? 'Замечание' : 'Уведомление');
    // У группы к заголовку прирастает счётчик: сколько замечаний свёрнуто.
    if (Array.isArray(item.children)) {
      const count = document.createElement('span');
      count.className = 'notification-item-count';
      count.textContent = String(item.count || item.children.length);
      title.appendChild(count);
    }
    textWrap.appendChild(title);

    if (item.body) {
      const body = document.createElement('span');
      body.className = 'notification-item-body';
      body.textContent = item.body;
      textWrap.appendChild(body);
    }
    row.appendChild(textWrap);

    // Стрелка-раскрывашка группы. Поворот — в CSS по aria-expanded шапки.
    if (Array.isArray(item.children)) {
      const chevron = document.createElement('span');
      chevron.className = 'notification-item-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '▾';
      row.appendChild(chevron);
    }

    // Кнопка «⋮» открывает контекстное меню записи (Прочитать/Непрочитанным/
    // Удалить) — заменяет прежний крестик dismiss. Меню одно для всех видов;
    // набор пунктов зависит от возможностей записи (см. _actionsFor).
    const kebab = document.createElement('button');
    kebab.className = 'notification-item-menu-btn';
    kebab.type = 'button';
    kebab.setAttribute('aria-label', 'Действия с уведомлением');
    kebab.textContent = '⋮';
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = kebab.getBoundingClientRect();
      this._openContextMenu(item, r.right, r.bottom);
    });
    row.appendChild(kebab);

    // Правый клик по строке — то же контекстное меню в точке курсора.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._openContextMenu(item, e.clientX, e.clientY);
    });

    row.addEventListener('click', (e) => this._handleItemClick(item, e.currentTarget));
    return row;
  }

  /**
   * Обработчик клика по записи.
   *
   * Клик помечает уведомление прочитанным, если оно это поддерживает и ещё не
   * прочитано — независимо от того, есть переход или нет. Затем выполняется
   * навигация: у живых — их onClick (переход к таблице/акту), у персистентных —
   * переход по link. «Вечно горящие» живые (без onMarkRead) клик не гасит.
   * Исключение — шапка группы однотипных замечаний: она только раскрывается.
   * @private
   * @param {Object} item
   * @param {HTMLElement} [row] Строка, по которой кликнули (нужна группе).
   */
  _handleItemClick(item, row) {
    // Шапка группы никуда не ведёт — она открывает и закрывает свой список.
    if (Array.isArray(item.children)) {
      this._toggleGroup(item.id, row);
      return;
    }

    const canRead = item.kind === 'persisted' || typeof item.onMarkRead === 'function';
    if (canRead && !item.is_read) {
      this._setItemRead(item, true);
    }

    if (item.kind === 'live') {
      if (typeof item.onClick === 'function') {
        try { item.onClick(); } catch (e) { console.warn('[NotificationCenter] onClick упал:', e); }
      }
      return;
    }

    // persisted: переход по link (mark-read уже сделан выше).
    if (item.link) {
      let url = AppConfig.api.getUrl(item.link);
      if (item.element_ref) {
        // Якорь строим из чистой базы (отбрасываем существующий фрагмент),
        // иначе ссылка с готовым '#...' не получит element_ref.
        const base = url.split('#')[0];
        url = base + '#' + encodeURIComponent(item.element_ref);
      }
      this.close();
      window.location.href = url;
    }
  }

  /**
   * Закрытие по клику вне меню/кнопки.
   * @private
   * @param {MouseEvent} e
   */
  _handleOutsideClick(e) {
    // Клик вне открытого контекстного меню — закрываем его (клики по самим
    // пунктам гасят всплытие, сюда не доходят).
    if (this._ctxOpen && this._ctxMenu && !this._ctxMenu.contains(e.target)) {
      this._closeContextMenu();
    }
    if (!this.isOpen) return;
    const container = this.btn.closest('.notifications-menu-container');
    const insideMenu = this.menu.contains(e.target);
    const insideContainer = container ? container.contains(e.target) : this.btn.contains(e.target);
    if (!insideMenu && !insideContainer) {
      this.close();
    }
  }
}

// Window-global для совместимости с inline-скриптами в шаблонах.
if (typeof window !== 'undefined') {
  window.NotificationCenter = NotificationCenter;
}
