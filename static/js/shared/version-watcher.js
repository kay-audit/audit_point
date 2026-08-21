/**
 * Слежение за версией приложения на сервере (freshness открытой вкладки).
 *
 * Задача: вкладка, открытая до релиза, продолжает работать на старой статике
 * (версия вшита в путь `/static/vX.Y.Z/js/...`). Такая вкладка должна узнать,
 * что сервер уехал на другую версию, и ПРЕДЛОЖИТЬ пользователю перезагрузиться.
 *
 * ВАЖНО: автоматической перезагрузки здесь нет и быть не должно. В конструкторе
 * живёт несохранённый акт и блокировка акта на Redis — самовольный reload
 * потерял бы работу пользователя. Решение о перезагрузке принимает только он,
 * кнопкой в баннере.
 *
 * Как работает:
 *   - своя версия читается из `<meta name="app-version">` (его печатают
 *     base_portal.html и base_constructor.html). Тега нет — модуль тихо
 *     не запускается (служебные страницы без базового шаблона);
 *   - раз в `DEFAULT_POLL_INTERVAL_MS` спрашивает GET /api/v1/system/version;
 *   - скрытую вкладку не поллит вовсе (в сеть не ходим, пока document.hidden);
 *   - возврат на вкладку освежает проверку сразу, но не чаще одной проверки
 *     в `DEFAULT_MIN_RECHECK_INTERVAL_MS` (щёлканье вкладками не должно
 *     превращаться в шторм запросов);
 *   - версии разошлись ЛЮБЫМ образом (в том числе откат назад) — показываем
 *     баннер и прекращаем поллинг, спрашивать дальше нечего;
 *   - сеть/5xx/429/битый ответ — молча игнорируем, поллинг продолжается;
 *   - 401/403 — сессия кончилась, поллинг прекращаем совсем.
 */
import { AppConfig } from './app-config.js';

/** Интервал опроса версии сервера (мс). */
export const DEFAULT_POLL_INTERVAL_MS = 60000;

/**
 * Минимальный интервал между проверками (мс) — троттлинг для проверок,
 * инициированных возвратом на вкладку.
 */
export const DEFAULT_MIN_RECHECK_INTERVAL_MS = 15000;

/** Путь эндпоинта версии (обёртывается AppConfig.api.getUrl). */
export const VERSION_ENDPOINT = '/api/v1/system/version';

/** Текст баннера. */
const BANNER_TEXT = 'Вышло обновление приложения. Обновите страницу, чтобы получить новую версию.';

/**
 * Читает версию текущей страницы из `<meta name="app-version">`.
 *
 * @returns {string|null} Непустая версия или null, если тега нет/он пустой.
 */
export function readPageVersion() {
    const meta = document.querySelector('meta[name="app-version"]');
    if (!meta) return null;
    const raw = meta.getAttribute ? meta.getAttribute('content') : meta.content;
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value || null;
}

export class VersionWatcher {
    /**
     * @param {Object} [options]
     * @param {number} [options.pollIntervalMs] Интервал опроса сервера (мс).
     * @param {number} [options.minRecheckIntervalMs] Минимальный зазор между
     *   проверками для visibilitychange-триггера (мс).
     */
    constructor(options = {}) {
        this.pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
        this.minRecheckIntervalMs = options.minRecheckIntervalMs || DEFAULT_MIN_RECHECK_INTERVAL_MS;

        /** Версия, на которой отрисована текущая страница. */
        this.pageVersion = null;
        /** Поллинг остановлен окончательно (баннер показан / 401 / destroy). */
        this.stopped = false;

        this._timer = null;
        /** Момент последней СЕТЕВОЙ проверки (Date.now()), 0 — проверок не было. */
        this._lastCheckAt = 0;
        this._banner = null;
        /** Пользователь нажал «Позже» — до перезагрузки страницы не тревожим. */
        this._dismissed = false;
        this._onVisibilityChange = () => this._handleVisibilityChange();
    }

    /**
     * Запускает слежение. Если meta-тега с версией нет — тихий no-op.
     *
     * @returns {boolean} true, если слежение запущено.
     */
    init() {
        const version = readPageVersion();
        if (!version) return false;

        this.pageVersion = version;
        this.stopped = false;
        this._timer = setInterval(() => this._tick(), this.pollIntervalMs);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
        return true;
    }

    /** Прекращает поллинг: снимает таймер и подписку на visibilitychange. */
    stop() {
        this.stopped = true;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }

    /** Полная остановка со снятием баннера (используется в тестах). */
    destroy() {
        this.stop();
        this._removeBanner();
    }

    /**
     * Тик таймера. Скрытую вкладку не поллим — пользователь её не видит,
     * а сеть и пул соединений бэкенда трогать незачем.
     * @private
     */
    _tick() {
        if (document.hidden) return;
        return this._check();
    }

    /**
     * Возврат на вкладку: проверяем сразу, но не чаще, чем раз в
     * `minRecheckIntervalMs` — иначе переключение вкладок туда-сюда
     * генерировало бы запрос на каждый щелчок.
     * @private
     */
    _handleVisibilityChange() {
        if (document.hidden) return;
        if (Date.now() - this._lastCheckAt < this.minRecheckIntervalMs) return;
        return this._check();
    }

    /**
     * Одна проверка версии на сервере.
     *
     * Любой сбой (сеть, 5xx, 429, невалидный JSON, ответ без версии) —
     * молча игнорируется: пугать пользователя нечем, поллинг продолжается.
     * @private
     * @returns {Promise<void>}
     */
    async _check() {
        if (this.stopped) return;
        this._lastCheckAt = Date.now();

        let resp;
        try {
            resp = await fetch(AppConfig.api.getUrl(VERSION_ENDPOINT), {
                headers: { Accept: 'application/json' },
                cache: 'no-store',
            });
        } catch (e) {
            // Сетевой сбой — не повод что-то показывать, ждём следующего тика.
            return;
        }

        if (!resp || !resp.ok) {
            // Сессия кончилась (или доступ отозван) — долбить эндпоинт бессмысленно.
            if (resp && (resp.status === 401 || resp.status === 403)) {
                this.stop();
            }
            return;
        }

        let data;
        try {
            data = await resp.json();
        } catch (e) {
            return;
        }

        const raw = data && typeof data.version === 'string' ? data.version.trim() : '';
        if (!raw) return;
        // Сравнение строгое по неравенству, а не «больше/меньше»: откат релиза
        // назад — такое же расхождение и так же требует перезагрузки.
        if (raw === this.pageVersion) return;

        this.stop();
        this._showBanner();
    }

    /**
     * Показывает баннер с предложением обновить страницу.
     * Баннер ненавязчивый: не модальный, работу не блокирует.
     * @private
     */
    _showBanner() {
        if (this._dismissed || this._banner) return;
        if (!document.body) return;

        const banner = document.createElement('div');
        banner.className = 'version-banner';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');

        const text = document.createElement('span');
        text.className = 'version-banner-text';
        text.textContent = BANNER_TEXT;

        const reloadBtn = document.createElement('button');
        reloadBtn.type = 'button';
        reloadBtn.className = 'btn btn-sm btn-primary version-banner-reload';
        reloadBtn.textContent = 'Обновить';
        reloadBtn.addEventListener('click', () => this.reload());

        const laterBtn = document.createElement('button');
        laterBtn.type = 'button';
        laterBtn.className = 'btn btn-sm btn-ghost version-banner-later';
        laterBtn.textContent = 'Позже';
        laterBtn.addEventListener('click', () => this.dismiss());

        banner.appendChild(text);
        banner.appendChild(reloadBtn);
        banner.appendChild(laterBtn);
        document.body.appendChild(banner);
        this._banner = banner;
    }

    /** Перезагружает страницу (только по явному действию пользователя). */
    reload() {
        window.location.reload();
    }

    /**
     * «Позже»: убирает баннер до следующей загрузки страницы. Поллинг уже
     * остановлен, так что баннер больше не появится.
     */
    dismiss() {
        this._dismissed = true;
        this._removeBanner();
    }

    /** @private */
    _removeBanner() {
        if (!this._banner) return;
        if (typeof this._banner.remove === 'function') {
            this._banner.remove();
        } else if (this._banner.parentNode) {
            this._banner.parentNode.removeChild(this._banner);
        }
        this._banner = null;
    }
}

/**
 * Создаёт и запускает наблюдатель версии, публикуя его в window.versionWatcher.
 * Вызывается из entry-модулей. Если meta-тега версии нет — вернёт null.
 *
 * @returns {VersionWatcher|null}
 */
export function startVersionWatcher() {
    const watcher = new VersionWatcher();
    if (!watcher.init()) return null;
    window.versionWatcher = watcher;
    return watcher;
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
// Модуль импортируется и в node:test, где window нет — отсюда guard.
if (typeof window !== 'undefined') {
    window.VersionWatcher = VersionWatcher;
    window.startVersionWatcher = startVersionWatcher;
}
