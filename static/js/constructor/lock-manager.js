/**
 * Менеджер блокировок актов
 *
 * Загружает настройки блокировок с сервера, управляет продлением и снятием блокировок.
 * Автоматически завершает сессию при бездействии пользователя.
 * Гарантирует одиночный unlock: предотвращает дублирующее снятие блокировки через sendBeacon.
 */
import { loadActConfig } from './act-config.js';
import { InactivityWatchdog } from './inactivity-watchdog.js';
import { LifecycleHelper } from './lifecycle-helper.js';
import { AppState } from './state/state-core.js';
import { StorageManager } from './storage-manager.js';
import { APIClient, ContentConflictError, LockLostError } from '../shared/api.js';
import { AppConfig } from '../shared/app-config.js';
import { AuthManager } from '../shared/auth.js';
import { DialogManager } from '../shared/dialog/dialog-confirm.js';
import { Notifications } from '../shared/notifications.js';

export class LockManager {
    static _actId = null;
    static _config = null;
    static _extensionInterval = null;
    static _countdownInterval = null;
    static _lastExtensionAt = Date.now();
    static _warningShown = false;
    static _isExiting = false;
    static _exitPromise = null;
    static _manualUnlockTriggered = false;
    // Счётчик подряд-неудач продления лока (pfe-11). Объявлен статически,
    // чтобы значение было корректным (0) с момента загрузки класса, а не
    // только после первого _resetState. _resetState обнуляет его на старте
    // каждой сессии (см. ниже).
    static _extendConsecutiveFailures = 0;
    static _beforeUnloadHandler = null;
    // Слежение за бездействием (activity-листенеры, idle-таймер, visibilitychange)
    // вынесено в InactivityWatchdog; LockManager использует его композицией.
    static _watchdog = null;
    // Дедлайн диалога неактивности (Date.now() + timeoutSeconds*1000). null = диалог не показан.
    // Хранится статически, чтобы _handleVisibilityChange мог решить — пора ли выкидывать.
    static _inactivityDialogDeadline = null;
    // Программный close активного диалога неактивности (получаем из DialogManager.onMount).
    static _inactivityDialogClose = null;

    /**
     * Инициализирует менеджер для конкретного акта
     * @param {number} actId - ID акта
     */
    static async init(actId) {
        // Проверяем режим только чтения - блокировка не нужна
        if (AppConfig.readOnlyMode?.isReadOnly) {
            console.log('LockManager: Режим только чтения, блокировка не требуется');
            this._actId = actId; // Сохраняем ID для возможного использования
            return;
        }

        if (!Number.isInteger(actId) || actId <= 0) {
            console.warn('[LockManager] init вызван с невалидным actId:', actId, new Error().stack);
            throw new Error('INVALID_ACT_ID');
        }

        this._actId = actId;
        this._resetState();

        try {
            await this._loadConfig();
            await this._lockAct();

            // Повторный init после destroy: старый watchdog останавливаем,
            // иначе его listeners остались бы висеть на document.
            if (this._watchdog) this._watchdog.stop();
            this._watchdog = new InactivityWatchdog({
                checkIntervalSeconds: this._config.inactivityCheckIntervalSeconds,
                idleTimeoutMinutes: this._config.inactivityTimeoutMinutes,
                onIdle: (minutesIdle) => this._handleInactivity(minutesIdle),
                onVisibilityChange: () => this._handleVisibilityChange()
            });
            this._watchdog.start();
            this._startAutoExtension();
            this._setupBeforeUnload();

            console.log('[LockManager] init OK для actId=', actId);
            console.log('Настройки блокировок:', this._config);
        } catch (error) {
            console.error('Ошибка инициализации LockManager:', error);
            throw error;
        }
    }

    /**
     * Явный метод ручного unlock из внешнего кода.
     * ДЕЛАЕТ:
     *  - отключает beforeunload
     *  - ставит флаг, чтобы sendBeacon не отправлялся
     *  - снимает блокировку на сервере
     *  - останавливает все таймеры
     */
    static async manualUnlock() {
        // Read-only пользователь не имеет блокировки - ничего делать не нужно
        if (AppConfig.readOnlyMode?.isReadOnly) {
            console.log('LockManager.manualUnlock: read-only режим, блокировка не требуется');
            return;
        }

        if (!this._actId) {
            console.warn('LockManager.manualUnlock вызван без активного акта');
            return;
        }

        if (this._isExiting || this._manualUnlockTriggered) {
            console.log('LockManager.manualUnlock: уже выполняется выход/разблокировка');
            return;
        }

        this._manualUnlockTriggered = true;
        this.disableBeforeUnload();
        this.destroy();

        const username = AuthManager?.getCurrentUser?.() || null;
        if (!username) {
            console.warn('LockManager.manualUnlock: пользователь неизвестен — пропускаем unlock');
            return;
        }

        try {
            const resp = await fetch(AppConfig.api.getUrl(`/api/v1/acts/${this._actId}/unlock`), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!resp.ok) {
                console.warn('LockManager.manualUnlock: не удалось снять блокировку, статус', resp.status);
                Notifications.error(`Не удалось снять блокировку акта (код ${resp.status}). Блокировка истечёт автоматически.`);
            } else {
                console.log(`[LockManager] Акт ${this._actId} успешно разблокирован вручную`);
            }
        } catch (e) {
            console.error('[LockManager] Ошибка сети при manualUnlock:', e);
            Notifications.error('Не удалось снять блокировку акта. Проверьте соединение.');
        }
    }

    /**
     * Загружает конфигурацию блокировок с сервера
     * @private
     */
    static async _loadConfig() {
        const config = await loadActConfig();
        if (config) {
            this._config = config;
            console.log('Настройки блокировок загружены:', this._config);
        } else {
            console.error('Ошибка загрузки, используем значения по умолчанию');
            this._config = {
                lockDurationMinutes: AppConfig.lock.lockDurationMinutes,
                inactivityTimeoutMinutes: AppConfig.lock.inactivityTimeoutMinutes,
                inactivityCheckIntervalSeconds: AppConfig.lock.inactivityCheckIntervalSeconds,
                minExtensionIntervalMinutes: AppConfig.lock.minExtensionIntervalMinutes,
                inactivityDialogTimeoutSeconds: AppConfig.lock.inactivityDialogTimeoutSeconds
            };
        }
    }

    /**
     * Сбрасывает внутреннее состояние менеджера
     * @private
     */
    static _resetState() {
        this._lastExtensionAt = Date.now();
        this._warningShown = false;
        this._isExiting = false;
        this._exitPromise = null;
        this._manualUnlockTriggered = false;
        // Счётчик подряд-неудач extend сбрасываем при старте сессии: иначе
        // транзиентные фейлы прошлого акта (destroy()+init() в той же вкладке)
        // переносятся и преждевременно достигают _MAX_EXTEND_FAILURES.
        this._extendConsecutiveFailures = 0;
    }

    /**
     * Выполняет запрос на блокировку акта
     * @private
     */
    static async _lockAct() {
        const response = await fetch(AppConfig.api.getUrl(`/api/v1/acts/${this._actId}/lock`), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.status === 409) {
            let error;
            try {
                error = await response.json();
            } catch {
                error = {detail: `Акт заблокирован (${response.status})`};
            }
            // Envelope ActLockError: {detail, code: 'act-locked', extra: {locked_by, locked_until}}.
            // Fallback на регекс по detail — для совместимости с не-AppError ответами.
            const lockedBy = (error.code === 'act-locked' && error.extra?.locked_by)
                ? error.extra.locked_by
                : this._extractUsernameFromError(error.detail);

            await DialogManager.show({
                title: 'Акт редактируется',
                message: AppConfig.lock.messages.actLockedByUser(lockedBy),
                icon: '🔒',
                type: 'warning',
                confirmText: 'Вернуться к списку',
                hideCancel: true,
                allowEscape: false,
                allowOverlayClose: false
            });

            // Разрешаем навигацию без предупреждения браузера
            const acts409Url = AppConfig.api.getUrl('/acts');
            if (typeof StorageManager !== 'undefined' && typeof StorageManager.confirmNavigation === 'function') {
                await StorageManager.confirmNavigation(acts409Url, { url: acts409Url });
            } else {
                window.location.href = acts409Url;
            }
            throw new Error('ACT_LOCKED');
        }

        if (!response.ok) {
            await DialogManager.show({
                title: 'Ошибка блокировки',
                message: AppConfig.lock.messages.lockFailed,
                icon: '⚠️',
                type: 'danger',
                confirmText: 'Вернуться к списку',
                hideCancel: true,
                allowEscape: false,
                allowOverlayClose: false
            });

            const acts500Url = AppConfig.api.getUrl('/acts');
            if (typeof StorageManager !== 'undefined' && typeof StorageManager.confirmNavigation === 'function') {
                await StorageManager.confirmNavigation(acts500Url, { url: acts500Url });
            } else {
                window.location.href = acts500Url;
            }
            throw new Error('LOCK_FAILED');
        }

        const data = await response.json();
        console.log('Акт заблокирован до', data.locked_until);
    }

    /**
     * Извлекает имя пользователя из текста ошибки
     * @private
     */
    static _extractUsernameFromError(errorDetail) {
        if (typeof errorDetail !== 'string') return 'другим пользователем';
        const match = errorDetail.match(/пользователем\s+([^\s.]+)/);
        return match ? match[1] : 'другим пользователем';
    }

    /**
     * Максимум подряд-неудач extend перед инициацией выхода.
     * Транзиентная сетевая ошибка (DNS, proxy reset) не должна сразу выкидывать
     * пользователя — retry на следующем тике auto-extension даёт шанс восстановиться.
     */
    static _MAX_EXTEND_FAILURES = 3;

    /**
     * Продлевает блокировку по API.
     * @private
     * @returns {Promise<{ok: boolean, fatal: boolean}>}
     *   - ok=true            — продление прошло
     *   - ok=false fatal=true — сервер явно отверг (4xx: lock потерян, юзер сменился)
     *   - ok=false fatal=false — транзиентная ошибка (5xx, network) — стоит retry
     */
    static async _extendLock() {
        if (!this._actId || !Number.isInteger(this._actId)) {
            console.error('[LockManager] _extendLock без валидного actId:', this._actId);
            return { ok: false, fatal: true };
        }
        try {
            const response = await fetch(AppConfig.api.getUrl(`/api/v1/acts/${this._actId}/extend-lock`), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            if (!response.ok) {
                // 4xx — серверное отвержение (403/404/409 = блокировка чужая/снята). Fatal.
                // 5xx — серверная ошибка, разумно retry.
                const fatal = response.status >= 400 && response.status < 500;
                console.error(
                    `Продление блокировки HTTP ${response.status}`
                    + (fatal ? ' (fatal — lock потерян)' : ' (транзиентная)')
                );
                return { ok: false, fatal };
            }
            const data = await response.json();
            console.log('Блокировка продлена до', data.locked_until);
            return { ok: true, fatal: false };
        } catch (error) {
            // Сетевая ошибка (fetch reject) — почти всегда транзиентная.
            console.error('Сетевая ошибка продления блокировки:', error);
            return { ok: false, fatal: false };
        }
    }

    /**
     * Безопасное продление с подсчётом подряд-неудач.
     * @private
     * @returns {Promise<{ok: boolean, shouldExit: boolean}>}
     */
    static async _extendLockSafely() {
        const result = await this._extendLock();
        if (result.ok) {
            this._lastExtensionAt = Date.now();
            this._extendConsecutiveFailures = 0;
            return { ok: true, shouldExit: false };
        }
        // Fatal — выходим сразу. Transient — копим до MAX_EXTEND_FAILURES.
        if (result.fatal) {
            return { ok: false, shouldExit: true };
        }
        this._extendConsecutiveFailures = (this._extendConsecutiveFailures || 0) + 1;
        const shouldExit = this._extendConsecutiveFailures >= LockManager._MAX_EXTEND_FAILURES;
        console.warn(
            `Транзиентная ошибка продления: попытка ${this._extendConsecutiveFailures}`
            + `/${LockManager._MAX_EXTEND_FAILURES}`
            + (shouldExit ? ' — лимит исчерпан, выходим' : ' — retry на следующем тике')
        );
        return { ok: false, shouldExit };
    }

    /**
     * Автоматическое продление блокировки.
     * @private
     */
    static _startAutoExtension() {
        const intervalMs = this._config.inactivityCheckIntervalSeconds * 1000;
        this._extensionInterval = setInterval(async () => {
            const now = Date.now();
            const sinceActivity = this._watchdog.getIdleMs() / 1000 / 60;
            const sinceExtension = (now - this._lastExtensionAt) / 1000 / 60;
            if (
                sinceActivity < this._config.inactivityTimeoutMinutes &&
                sinceExtension >= this._config.minExtensionIntervalMinutes
            ) {
                console.log('Пользователь активен → продлеваем блокировку');
                const result = await this._extendLockSafely();
                if (result.shouldExit) {
                    console.error('Автопродление не удалось → выход');
                    this._initiateExit('extensionFailed');
                }
            }
        }, intervalMs);
    }

    /**
     * Настраивает beforeunload, который выполняет unlock при закрытии страницы.
     * Если установлен флаг _manualUnlockTriggered, sendBeacon не отправляется.
     * @private
     */
    static _setupBeforeUnload() {
        this._beforeUnloadHandler = () => {
            try {
                if (this._isExiting || this._manualUnlockTriggered || !this._actId) return;

                const username = AuthManager.getCurrentUser();
                const blob = new Blob(
                    [JSON.stringify({username})],
                    {type: 'application/json'}
                );

                navigator.sendBeacon(AppConfig.api.getUrl(`/api/v1/acts/${this._actId}/unlock`), blob);
                console.log('BeforeUnload → отправлен beacon для unlock');
            } finally {
                // Снимаем document-listeners и таймеры даже если beacon не отправлен:
                // навигация (переход на другой акт через JupyterHub-proxy, back-button)
                // оставляла бы 4 listener'а на document плюс активные интервалы.
                this.destroy();
            }
        };
        if (typeof LifecycleHelper !== 'undefined') {
            LifecycleHelper.registerBeforeUnload('lock:manual-unlock', this._beforeUnloadHandler);
        } else {
            window.addEventListener('beforeunload', this._beforeUnloadHandler);
        }
    }

    /**
     * Отключает обработчик beforeunload.
     * Используется при ручной разблокировке.
     */
    static disableBeforeUnload() {
        if (this._beforeUnloadHandler) {
            if (typeof LifecycleHelper !== 'undefined') {
                LifecycleHelper.unregister('lock:manual-unlock');
            } else {
                window.removeEventListener('beforeunload', this._beforeUnloadHandler);
            }
            this._beforeUnloadHandler = null;
            console.log('LockManager.beforeunload отключен');
        }
    }

    /**
     * Завершает все интервалы, таймеры и останавливает watchdog
     * (снимает activity- и visibilitychange-listeners на document).
     * Идемпотентен; безопасно вызывать повторно.
     */
    static destroy() {
        if (this._extensionInterval) {
            clearInterval(this._extensionInterval);
            this._extensionInterval = null;
        }
        if (this._countdownInterval) {
            clearInterval(this._countdownInterval);
            this._countdownInterval = null;
        }
        this._inactivityDialogDeadline = null;
        this._inactivityDialogClose = null;
        if (this._watchdog) this._watchdog.stop();
    }

    /**
     * Реакция на возврат вкладки в активное состояние.
     * Chrome/Edge в фоне throttle'ят setInterval/setTimeout (вплоть до ~раза в минуту),
     * поэтому диалог неактивности может "застрять" с устаревшим countdown'ом, либо
     * порог неактивности мог быть превышен пока fired-таймер ещё не успел сработать.
     * Никаких HTTP-запросов здесь не делаем — лок на бэке мог быть уже снят
     * предыдущим autoExit'ом, и Save обработает 409 отдельно.
     * @private
     */
    static _handleVisibilityChange() {
        if (document.hidden) return;
        if (this._isExiting) return;
        if (!this._actId) return;

        // Случай A: диалог открыт и его дедлайн уже прошёл → немедленный autoExit.
        if (this._inactivityDialogDeadline !== null
            && Date.now() >= this._inactivityDialogDeadline) {
            console.log('[LockManager] visibilitychange: дедлайн диалога просрочен, инициируем autoExit');
            this._closeInactivityDialog();
            this._initiateExit('autoExit');
            return;
        }

        // Случай B: диалога нет, но порог неактивности уже превышен →
        // сразу autoExit без промежуточного диалога «Продолжить?».
        // Юзер был неактивен дольше threshold; лок на сервере мог уже истечь
        // сам по TTL (lockDurationMinutes). Спрашивать «остаться?»
        // бессмысленно: extend всё равно упадёт 4xx → fatal → _initiateExit.
        if (this._inactivityDialogDeadline === null) {
            const idleMs = this._watchdog.getIdleMs();
            const idleThresholdMs = this._config.inactivityTimeoutMinutes * 60 * 1000;
            if (idleMs >= idleThresholdMs) {
                console.log('[LockManager] visibilitychange: порог неактивности превышен, autoExit');
                this._watchdog.stopIdleCheck();
                this._initiateExit('autoExit');
            }
        }
    }

    /**
     * Принудительно закрывает диалог неактивности (если открыт), очищает countdown и дедлайн.
     * Используется при autoExit'е из setInterval'а countdown'а либо из visibilitychange,
     * чтобы overlay не "висел" поверх редиректа.
     * @private
     */
    static _closeInactivityDialog() {
        if (this._countdownInterval) {
            clearInterval(this._countdownInterval);
            this._countdownInterval = null;
        }
        this._inactivityDialogDeadline = null;
        if (typeof this._inactivityDialogClose === 'function') {
            try {
                // Резолвим dialogPromise значением `false` (как cancel) — после await guard
                // _isExiting=true перехватит ветку и extend не пойдёт. Любое значение здесь подходит.
                this._inactivityDialogClose(false);
            } catch (e) {
                console.warn('[LockManager] _closeInactivityDialog: ошибка close-handle:', e);
            }
            this._inactivityDialogClose = null;
        }
    }

    /**
     * Обрабатывает состояние бездействия и вызывает автоматическое завершение.
     * @private
     */
    static async _handleInactivity(minutesInactive) {
        const capturedActId = this._actId;
        const cfg = AppConfig.lock;
        const timeoutSeconds = this._config.inactivityDialogTimeoutSeconds;

        // Дедлайн считаем по реальному времени. Это критично для фоновой вкладки:
        // Chrome throttle'ит setInterval/setTimeout до ~раза в минуту, и старый
        // decrement-counter (remaining--) разъезжается с реальностью.
        // setInterval здесь — только для обновления UI; решение о выходе принимается
        // по Date.now() >= deadline, что устойчиво к любому throttling.
        const deadline = Date.now() + timeoutSeconds * 1000;
        this._inactivityDialogDeadline = deadline;

        const dialogPromise = DialogManager.show({
            title: cfg.messages.inactivityTitle,
            message: cfg.messages.inactivityQuestion(minutesInactive),
            icon: '💤',
            type: 'warning',
            confirmText: 'Продолжить',
            cancelText: 'Сохранить и выйти',
            onMount: ({ overlay, close }) => {
                // Сохраняем close-handle, чтобы _closeInactivityDialog мог программно
                // закрыть overlay при autoExit (race-free, без querySelector).
                this._inactivityDialogClose = close;

                const messageEl = overlay?.querySelector('.dialog-message');
                let countdownEl = null;
                if (messageEl) {
                    countdownEl = document.createElement('p');
                    countdownEl.className = 'dialog-message';
                    countdownEl.style.marginTop = '4px';
                    countdownEl.style.fontWeight = 'bold';
                    countdownEl.textContent = `Авто-выход через ${timeoutSeconds} сек.`;
                    messageEl.after(countdownEl);
                }

                // Тикаем чаще 1 сек, чтобы при возврате видимости UI догнал реальность
                // не позже чем за 250 мс. Решение о выходе тоже принимает этот же
                // setInterval — отдельный setTimeout убран, иначе таймеры расходятся
                // при throttling.
                this._countdownInterval = setInterval(() => {
                    const remainingMs = deadline - Date.now();
                    const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
                    if (countdownEl) countdownEl.textContent = `Авто-выход через ${remaining} сек.`;
                    if (remainingMs <= 0) {
                        clearInterval(this._countdownInterval);
                        this._countdownInterval = null;
                        console.log('Истекло время подтверждения, автосохранение и выход.');
                        // Закрываем overlay программно перед редиректом, иначе
                        // диалог остаётся "висящим" поверх (особенно если interval
                        // сработал в фоне с задержкой).
                        this._closeInactivityDialog();
                        this._initiateExit('autoExit');
                    }
                }, 250);
            }
        });

        const stay = await dialogPromise;

        // Если за время ожидания диалога _actId сменился (переключение акта) или
        // менеджер уже завершает работу — диалог «осиротел» и его результат
        // не относится к текущему состоянию. Тихо прерываем.
        if (this._actId !== capturedActId || this._isExiting) {
            console.warn('[LockManager] _handleInactivity: orphan dialog (actId changed or already exiting), abort');
            return;
        }

        if (this._countdownInterval) {
            clearInterval(this._countdownInterval);
            this._countdownInterval = null;
        }
        this._inactivityDialogDeadline = null;
        this._inactivityDialogClose = null;

        if (stay) {
            // В диалоге «остаться?» юзер явно нажал «Да» — это интерактивная точка,
            // здесь retry-стратегия неуместна (юзер ждёт мгновенный ответ).
            // shouldExit учитывает оба варианта: fatal-4xx или исчерпан лимит retry.
            const result = await this._extendLockSafely();
            if (result.ok) {
                this._watchdog?.touch();
                if (Notifications) Notifications.success(cfg.messages.sessionExtended);
                this._watchdog?.startIdleCheck();
            } else {
                if (Notifications) Notifications.error(cfg.messages.cannotExtend);
                await this._initiateExit('extensionFailed');
            }
        } else {
            await this._initiateExit('manualExit');
        }
    }

    /**
     * Выполняет корректное завершение сессии и разблокировку акта.
     * @private
     */
    static async _initiateExit(action) {
        if (this._isExiting) return this._exitPromise;
        this._isExiting = true;
        // Закрываем диалог неактивности ДО destroy() — destroy сбросит _inactivityDialogClose,
        // и закрыть overlay программно станет невозможно (overlay остался бы висеть).
        this._closeInactivityDialog();
        this._exitPromise = (async () => {
            this._manualUnlockTriggered = true; // блокируем sendBeacon

            this.destroy();
            this.disableBeforeUnload();

            // Разрешаем навигацию без предупреждения браузера
            if (typeof StorageManager !== 'undefined' && typeof StorageManager.allowUnload === 'function') {
                StorageManager.allowUnload();
            }

            const effectiveActId = this._actId || (typeof window !== 'undefined' ? window.currentActId : null);
            const username = AuthManager?.getCurrentUser?.() || null;
            // Флаг для плашки на списке актов (session-exit-notice.js). Дефолт —
            // «вышли с сохранением»; при упавшем save ниже переопределяется на
            // честный: 409 → sessionLockLost, прочее → sessionExitSaveFailed.
            // Плашки об успехе НЕ должны показываться, когда контент не в БД.
            let messageFlag = action === 'autoExit'
                ? 'sessionAutoExited'
                : 'sessionExitedWithSave';

            console.log(`LockManager: выход (${action}) начат… effectiveActId=${effectiveActId}`);

            if (typeof Notifications !== 'undefined' && Notifications.warning) {
                Notifications.warning('Сессия истекла. Сохраняем акт…');
            }

            try {
                // --- 1️⃣ Сохраняем акт ТОЛЬКО если есть AppState (значит открыт в конструкторе) ---
                if (typeof AppState !== 'undefined' && AppState?.exportData) {
                    if (Number.isInteger(effectiveActId) && effectiveActId > 0) {
                        try {
                            // Выходной save идёт ЕДИНЫМ путём APIClient.saveActContent —
                            // тем же, что Ctrl+S и периодика: общий in-flight гард
                            // (+опубликованный _saveInFlightPromise, который чтит
                            // forceSaveToDb), таймаут, flush+эпоха-гейт finalizeDbSave,
                            // разбор 409 (_parseConflictError), обновление баз OCC.
                            // Прежний сырой fetch дублировал ~90 строк и ставил гард
                            // без промиса — forceSaveToDb проскакивал wait и слал
                            // конкурентный PUT. Дожидаемся чужого PUT (иначе
                            // saveActContent no-op'нется по гарду); между выходом из
                            // цикла и вызовом нет await — гард захватывается синхронно.
                            while (APIClient._saveInFlight && APIClient._saveInFlightPromise) {
                                try {
                                    await APIClient._saveInFlightPromise;
                                } catch {
                                    /* чужой PUT упал — выходной save всё равно нужен */
                                }
                            }
                            const saved = await APIClient.saveActContent(effectiveActId, { saveType: 'manual' });
                            // Гард in-flight отдаёт null вместо исключения:
                            // молча считать это успехом нельзя — плашка соврала
                            // бы «вышли с сохранением» при неуехавшем контенте.
                            if (!saved) {
                                throw new Error('Сохранение пропущено: другой PUT ещё в полёте');
                            }
                            console.log('[LockManager] Контент акта сохранён');
                        } catch (saveErr) {
                            // Контент НЕ в БД: плашка на списке актов обязана быть
                            // честной, а не «вышли с сохранением». Снимок-черновик
                            // остаётся в localStorage носителем правок (диалог
                            // конфликта/восстановления предложит выбор при открытии).
                            if (saveErr instanceof ContentConflictError) {
                                // Конфликт версий — свой флаг: плашка «лок снят по
                                // бездействию» лгала бы о причине.
                                messageFlag = 'sessionExitContentConflict';
                            } else if (saveErr instanceof LockLostError) {
                                messageFlag = 'sessionLockLost';
                            } else {
                                messageFlag = 'sessionExitSaveFailed';
                            }
                            console.error('LockManager: ошибка при сохранении контента конструктора:', saveErr);
                        }
                    } else {
                        console.warn('[LockManager] _initiateExit: actId невалиден, save пропущен');
                    }
                } else {
                    console.log('[LockManager] AppState отсутствует — пропускаем сохранение (страница метаданных)');
                }

                // --- 2️⃣ Снимаем блокировку ---
                if (Number.isInteger(effectiveActId) && effectiveActId > 0 && username) {
                    try {
                        const resp = await fetch(AppConfig.api.getUrl(`/api/v1/acts/${effectiveActId}/unlock`), {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            }
                        });

                        if (!resp.ok) {
                            console.warn(`[LockManager] Ошибка unlock (код ${resp.status})`);
                        } else {
                            console.log(`[LockManager] Акт ${effectiveActId} успешно разблокирован (exit)`);
                        }
                    } catch (unlockErr) {
                        console.error('[LockManager] Ошибка сети при unlock:', unlockErr);
                    }
                }

                sessionStorage.setItem(messageFlag, 'true');
            } catch (err) {
                console.error('[LockManager] Ошибка выхода:', err);
                sessionStorage.setItem(messageFlag, 'true');
            } finally {
                const closedId = this._actId;
                this._actId = null;
                console.log(`LockManager: завершение выхода для акта ${closedId}`);
                const exitUrl = AppConfig.api.getUrl('/acts');
                // Жёсткий редирект без confirmNavigation: сессия завершается
                // принудительно (autoExit / extensionFailed / manualExit).
                // Если save выше упал (например 409 при чужом локе),
                // markAsSyncedWithDB не вызвался → confirmNavigation показал бы
                // плашку «Несохранённые изменения. Уйти?» и блокировал бы
                // навигацию. allowUnload() уже снят выше.
                setTimeout(() => {
                    window.location.href = exitUrl;
                }, AppConfig.timings.redirectAfterUnlock);
            }
        })();
        return this._exitPromise;
    }
}

window.LockManager = LockManager;
