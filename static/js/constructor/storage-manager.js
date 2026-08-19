/**
 * Менеджер локального хранилища
 *
 * Управляет сохранением и восстановлением состояния приложения
 * в localStorage с автоматическим дебаунсом и валидацией размера.
 * Интегрирован с системой Proxy для автоматического отслеживания изменений.
 * Отслеживает синхронизацию с БД для предотвращения потери данных.
 */
import { loadActConfig } from './act-config.js';
import { ItemsRenderer } from './items/items-renderer.js';
import { LifecycleHelper } from './lifecycle-helper.js';
import { AppState } from './state/state-core.js';
import { VIEW_POSITION_KEY_PREFIX } from './state/view-position-store.js';
// ActsManagerPage не импортируется: constructor → portal — неправильное направление
// зон. Используем lazy через window.ActsManagerPage (см. invalidateCache-вызов ниже).
import { APIClient, ContentConflictError, LockLostError } from '../shared/api.js';
import { AppConfig } from '../shared/app-config.js';
import { DialogManager } from '../shared/dialog/dialog-confirm.js';
import { Notifications } from '../shared/notifications.js';

export class StorageManager {
    /**
     * Таймер для дебаунса автосохранения
     * @private
     * @type {number|null}
     */
    static _saveTimeout = null;

    /**
     * Период дебаунса автосохранения в localStorage, мс.
     * Инициализируется фолбэком из AppConfig, при инициализации менеджера
     * переопределяется значением с бэка (`autoSavePeriodSeconds` из /config/lock).
     * @private
     * @type {number}
     */
    static _autoSaveDebounceMs = AppConfig.localStorage.autoSaveDebounce;

    /**
     * Интервал периодического автосохранения в localStorage
     * @private
     * @type {number|null}
     */
    static _periodicSaveInterval = null;

    /**
     * Интервал периодического сохранения в БД
     * @private
     * @type {number|null}
     */
    static _periodicDbSaveInterval = null;

    /**
     * Единое состояние persistence-индикатора.
     * Возможные значения:
     *  - 'saved'      — синхронизировано с localStorage И БД (белый);
     *  - 'local-only' — сохранено только в localStorage, не в БД (жёлтый);
     *  - 'unsaved'    — есть изменения, ещё не сохранённые даже локально (красный).
     *
     * Старые булевы флаги (_hasUnsavedChanges, _isSyncedWithDB) остаются как
     * computed-зеркала через _setState — массивы load-bearing consumer'ов
     * (beforeunload, периодические таймеры, hasUnsavedChanges()) продолжают
     * работать без массовой замены проверок.
     * @private
     * @type {'saved'|'local-only'|'unsaved'}
     */
    static _state = 'saved';

    /**
     * Флаг для отслеживания несохраненных изменений в localStorage
     * (зеркало _state === 'unsaved'). Управляется через _setState.
     * @private
     * @type {boolean}
     */
    static _hasUnsavedChanges = false;

    /**
     * Флаг для отслеживания синхронизации с БД
     * (зеркало _state === 'saved'). Управляется через _setState.
     * @private
     * @type {boolean}
     */
    static _isSyncedWithDB = true;

    /**
     * Счётчик глубины блокировки автоматического отслеживания (M.11).
     * disableTracking() инкрементирует, enableTracking() декрементирует
     * (с полом 0); отслеживание выключено, пока счётчик > 0. Счётчик (а не
     * boolean) нужен, чтобы вложенные/перекрывающиеся пары disable/enable
     * композировались, а не затирали друг друга.
     * @private
     * @type {number}
     */
    static _trackingDepth = 0;

    /**
     * PERSIST-4: «эпоха грязности» — монотонный счётчик реальных мутаций
     * состояния. Инкрементится в той же точке, что и dirty-переход
     * (markAsUnsaved), под тем же tracking-гардом: пока трекинг выключен
     * (вокруг синхронной сериализации), эпоха заморожена. saveActContent
     * запоминает эпоху перед PUT и, если она выросла за время await (значит
     * пользователь печатал во время сохранения), НЕ помечает акт
     * синхронизированным — эти правки в отправленную data не попали.
     * @private
     * @type {number}
     */
    static _dirtyEpoch = 0;

    /**
     * Серверный updated_at акта на момент последней успешной синхронизации
     * с БД (из ответа GET-контента или PUT-сохранения). Пишется в метаданные
     * снимка localStorage (baseUpdatedAt) как справочное поле для диагностики;
     * в решении о восстановлении черновика больше НЕ участвует — updated_at
     * бампится и НЕ-контентными записями (метаданные, соседние части КМ),
     * из-за чего давал ложные конфликты. Источник истины OCC — content_version.
     * @private
     * @type {string|null}
     */
    static _baseUpdatedAt = null;

    /**
     * Серверный acts.content_version на момент последней успешной
     * синхронизации с БД (metadata из GET-контента или ответ PUT). База
     * optimistic-конкуренции: уходит эхом в expected_content_version каждого
     * PUT /content и пишется в снимок черновика (baseContentVersion) для
     * решения о восстановлении (H3). Инкрементируется бэкендом ТОЛЬКО при
     * записи контента — правки метаданных/соседних частей КМ его не трогают.
     * 0 — валидное значение (акт ещё ни разу не сохранял контент).
     * @private
     * @type {number|null}
     */
    static _baseContentVersion = null;

    /**
     * Флаг «о сбое сохранения в БД уже предупреждали» (§9 offline).
     * Не даёт спамить предупреждением на каждый периодический тик;
     * сбрасывается при первой успешной синхронизации (markAsSyncedWithDB).
     * @private
     * @type {boolean}
     */
    static _dbSaveFailureNotified = false;

    /**
     * Флаг «автоматические PUT в БД остановлены до перезагрузки страницы».
     * Взводится при 409 content-conflict (акт сохранил кто-то другой) и при
     * потере лока: ретрай в обеих ситуациях обречён, а тик каждые 2 минуты
     * спамил бы сервер заведомо провальными запросами. Снимок-черновик при
     * этом остаётся последним носителем правок; выбор версии пользователь
     * делает после перезагрузки (диалог конфликта в _maybeRestoreDraft).
     * @private
     * @type {boolean}
     */
    static _dbAutoSaveHalted = false;

    /**
     * Причина остановки авто-PUT: 'conflict' (409 content-conflict) или
     * 'lock' (лок акта потерян). Нужна внешним save-путям, чтобы отказ «на
     * входе» (forceSaveToDb не шлёт заведомо обречённый запрос) отдавал
     * ошибку ТОГО ЖЕ типа, что и живой отказ сервера: иначе потеря лока
     * маскировалась бы под конфликт версий — и плашка выхода, и ветвление
     * в _escalateQuotaToDb врали бы о причине.
     * @private
     * @type {'conflict'|'lock'|null}
     */
    static _dbAutoSaveHaltCause = null;

    /**
     * Обработчик window 'online' для немедленного повторного сохранения
     * в БД после восстановления соединения. null = не подписан.
     * @private
     * @type {Function|null}
     */
    static _onlineRetryHandler = null;

    /**
     * Флаг программного выхода со страницы
     * При установке в true обработчик beforeunload не блокирует навигацию
     * @private
     * @type {boolean}
     */
    static _programmaticExit = false;

    /**
     * Сохранённый обработчик document 'click' (перехват навигации по ссылкам).
     * Храним, чтобы снять его в _teardownEventHandlers (pfe-10/12). null = не подписан.
     * @private
     * @type {Function|null}
     */
    static _navClickHandler = null;

    /**
     * Lock «идёт сохранение снимка» (pfe-3). Взводится на время saveState и
     * сбрасывается в finally. Не даёт периодическому и явному save пересечься
     * на одном снимке (re-entrant вызов пропускается).
     * @private
     * @type {boolean}
     */
    static _saveInProgress = false;

    /**
     * B-15: lock «идёт PUT /content в БД» — сериализует периодическое и
     * повторное сохранение, чтобы на сервер не уехали две версии в
     * неопределённом порядке (optimistic locking на бэке нет).
     * @private
     * @type {boolean}
     */
    static _dbSaveInProgress = false;

    /**
     * B-3: lock «идёт аварийная quota-эскалация в БД» — не плодим параллельные
     * форс-PUT при серии переполнений localStorage.
     * @private
     * @type {boolean}
     */
    static _quotaEscalationInFlight = false;

    /**
     * #5: «об эскалации quota→БД уже уведомили» — постоянный флаг, гасит спам
     * success-тостов при СЕРИИ переполнений (каждая правка крупного акта снова
     * переполняет LS → снова эскалация). Сбрасывается, когда обычная запись
     * снимка в localStorage снова проходит (вернулись в норму) — тогда будущее
     * переполнение уведомит заново.
     * @private
     * @type {boolean}
     */
    static _quotaEscalationNotified = false;

    /**
     * PERSIST-3: срок жизни ЧУЖОГО снимка-черновика (снимка другого акта) в
     * localStorage — 7 дней. Пока чужой снимок моложе этого срока, вкладка
     * текущего акта его НЕ удаляет: иначе несинхронизированный черновик
     * соседнего акта, открытого в другой вкладке, был бы стёрт (потеря
     * правок). Удаляются только заведомо протухшие (заброшенные ≥ 7 дней)
     * чужие снимки — для высвобождения места. 7 дней — компромисс между
     * «не терять активные черновики» и «не копить мусор бесконечно».
     * @private
     * @type {number}
     */
    static FOREIGN_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

    /**
     * Префикс ключей бэкапов конфликтных черновиков (см. stashConflictSnapshot).
     * Конвенция — как у stateKeyPrefix (`audit_workstation_state`), отдельное
     * пространство ключей, которое штатная перезапись снимка не трогает.
     * @type {string}
     */
    static CONFLICT_BACKUP_KEY_PREFIX = 'audit_workstation_conflict';

    /**
     * Инициализация менеджера хранилища
     *
     * НЕ восстанавливает состояние автоматически.
     * Восстановление выполняется явно через ActsMenuManager.
     */
    static init() {
        try {
            this._checkLocalStorageAvailable();
            this._setupEventHandlers();
            this._updateSaveIndicator();
            // Подгрузка периода автосохранения с бэка (fire-and-forget):
            // дебаунс актуален только после первой правки пользователя, поэтому
            // ждать ответ не нужно; ошибка fetch оставляет фолбэк.
            this._loadAutoSaveConfig();

            console.log('StorageManager инициализирован (без автовосстановления)');
        } catch (error) {
            console.error('Ошибка инициализации StorageManager:', error);
            Notifications.warning('Автосохранение недоступно в этом браузере');
        }
    }

    /**
     * Проверяет доступность localStorage
     * @private
     * @throws {Error} Если localStorage недоступен
     */
    static _checkLocalStorageAvailable() {
        try {
            const testKey = '__storage_test__';
            localStorage.setItem(testKey, 'test');
            localStorage.removeItem(testKey);
        } catch (e) {
            throw new Error('localStorage недоступен');
        }
    }

    /**
     * Загружает период автосохранения с сервера через общий загрузчик
     * `loadActConfig` (тот же кэшированный GET /config/lock, что и у LockManager).
     * Берёт `autoSavePeriodSeconds` (секунды) и переводит в мс. При ошибке/
     * отсутствии значения оставляет фолбэк — инициализацию не роняет.
     * @private
     */
    static async _loadAutoSaveConfig() {
        const config = await loadActConfig();
        const seconds = config?.autoSavePeriodSeconds;
        if (Number.isFinite(seconds) && seconds > 0) {
            this._autoSaveDebounceMs = seconds * 1000;
        }
    }

    /**
     * Настраивает обработчики событий для автосохранения
     * @private
     */
    static _setupEventHandlers() {
        // pfe-12: повторный init должен быть идемпотентным — гасим прежние
        // интервалы и навигационные слушатели ДО создания новых, иначе
        // накапливаются двойные таймеры и PUT-каналы.
        this._teardownEventHandlers();

        // Предупреждение при попытке закрыть страницу с несохраненными данными.
        // Регистрируется через общий реестр beforeunload-обработчиков LifecycleHelper,
        // чтобы можно было централизованно снять обработчик при destroy/teardown.
        const beforeUnloadHandler = (e) => {
            // Сохраняем в localStorage перед закрытием.
            // PERSIST-6: keepalive — если снимок не влезет в LS и уйдёт в
            // аварийную эскалацию БД, обычный fetch браузер отменит при
            // закрытии вкладки. keepalive:true даёт запросу пережить unload
            // (в пределах лимита тела ~64KB, см. forceSaveToDb).
            if (this._hasUnsavedChanges) {
                this.saveState(true, { keepalive: true });
            }

            // При программном выходе не показываем диалог браузера
            if (this._programmaticExit) {
                return;
            }

            // Предупреждаем только если данные не синхронизированы с БД
            if (!this._isSyncedWithDB && window.currentActId) {
                e.preventDefault();
                e.returnValue = 'У вас есть несохраненные изменения. Вы уверены, что хотите покинуть страницу?';
                return e.returnValue;
            }
        };
        if (typeof LifecycleHelper !== 'undefined') {
            LifecycleHelper.registerBeforeUnload('storage:unsaved-warning', beforeUnloadHandler);
        } else {
            window.addEventListener('beforeunload', beforeUnloadHandler);
        }

        // Перехват попыток навигации (для показа кастомного диалога)
        this._setupNavigationInterception();

        // Периодическое автосохранение в localStorage (каждые 2 минуты при наличии изменений)
        // E-6: пропускаем тик, если идёт drag-and-drop — иначе сохраним промежуточное
        // состояние treeData во время mutation, в которой parent.children в неконсистентном виде.
        // Через периодический интервал следующий тик подберёт изменения.
        this._periodicSaveInterval = setInterval(() => {
            if (AppState._dragInProgress) return;
            if (this._hasUnsavedChanges) {
                this.saveState(true);
            }
        }, AppConfig.localStorage.periodicSaveInterval);

        // Периодическое сохранение в БД (каждые 2 минуты при наличии несинхронизированных данных)
        // E-6: та же защита от race с drag'ом.
        //
        // E2 (by-design): авто/периодическое сохранение НЕ запускает контентную
        // валидацию (пустые заголовки/нет данных/нет шапки). Это сознательно —
        // черновик обязан сохраняться всегда, а каскад метрик/рисков легитимно
        // создаёт пустые сводные таблицы, которые контентная проверка пометила
        // бы как неполные. Контентная валидация — только перед ЭКСПОРТОМ
        // (navigation-manager). Структурная целостность остаётся защищённой
        // сервером (HTTP 422) на каждом PUT /content независимо от saveType.
        this._periodicDbSaveInterval = setInterval(async () => {
            if (AppState._dragInProgress) return;
            // PERSIST-1: read-only зритель не пишет в БД — иначе фоновый PUT
            // ловит 403 и показывает тост «Не удалось сохранить». Обычно RO-акт
            // и не грязный, но это защита в глубину на случай случайной пометки.
            if (AppConfig.readOnlyMode?.isReadOnly) return;
            if (this._dbSaveInProgress) return; // B-15: другое сохранение уже пишет
            if (this._dbAutoSaveHalted) return; // 409-конфликт/потеря лока: ретрай обречён
            if (this.hasUnsyncedChanges() && window.currentActId) {
                this._dbSaveInProgress = true;
                try {
                    await APIClient.saveActContent(window.currentActId, { saveType: 'periodic' });
                } catch (err) {
                    // §9 offline: ошибку не глотаем — предупреждаем (один раз
                    // до успеха) и подписываемся на восстановление соединения.
                    console.error('Периодическое сохранение в БД не удалось:', err);
                    this._handleDbSaveFailure(err);
                } finally {
                    this._dbSaveInProgress = false;
                }
            }
        }, AppConfig.localStorage.periodicSaveInterval);
    }

    /**
     * Различает причину сбоя фонового сохранения в БД и выбирает честную
     * реакцию (образец ручного пути — NavigationManager._handleSaveExportError):
     *  - 409 content-conflict: акт сохранил кто-то другой — ретрай обречён
     *    (expected_content_version устарел). Останавливаем авто-PUT до перезагрузки,
     *    снимок-черновик НЕ трогаем, говорим честно кто изменил акт;
     *  - потеря лока: ретрай так же обречён (лока больше нет) — останавливаем
     *    авто-PUT, снимок остаётся, без ложного «повторная попытка автоматически»;
     *  - прочие сбои (сеть/5xx): прежняя offline-машинерия — дедуп-предупреждение
     *    и ретрай по 'online'.
     * @private
     * @param {Error} err ошибка из APIClient.saveActContent
     */
    static _handleDbSaveFailure(err) {
        if (err instanceof ContentConflictError) {
            this.handleContentConflict(err);
            return;
        }
        if (err instanceof LockLostError) {
            const alreadyHalted = this._dbAutoSaveHalted;
            this._dbAutoSaveHalted = true;
            this._dbAutoSaveHaltCause = 'lock';
            if (alreadyHalted) return; // повторный тик не дублирует предупреждение
            Notifications.warning(
                'Блокировка акта потеряна — автосохранение в базу остановлено. '
                + 'Ваши правки сохранены локально как черновик. Обновите страницу, '
                + 'чтобы продолжить работу.'
            );
            return;
        }
        this._notifyDbSaveFailure();
    }

    /**
     * Единая реакция на ContentConflictError из ЛЮБОГО пути сохранения
     * (периодический тик, Ctrl+S/кнопка, переключение акта, клик по ссылке,
     * quota-эскалация): ретрай с той же базой обречён, поэтому останавливаем
     * автоматические PUT до перезагрузки/входа в акт и показываем ОДНО честное
     * уведомление (кто изменил акт; правки — в локальном черновике). Повторные
     * вызовы при уже взведённом halt уведомление не дублируют — иначе mash
     * Ctrl+S спамил бы одинаковыми тостами.
     *
     * @param {ContentConflictError} err ошибка конфликта из APIClient
     */
    static handleContentConflict(err) {
        if (!this._dbAutoSaveHalted) {
            const editedBy = err?.lastEditedBy
                ? `пользователем ${err.lastEditedBy}`
                : 'другим пользователем';
            Notifications.warning(
                `Акт изменён ${editedBy}. Ваши правки сохранены локально как черновик. `
                + 'Обновите страницу, чтобы выбрать версию.'
            );
        }
        this._dbAutoSaveHalted = true;
        this._dbAutoSaveHaltCause = 'conflict';
    }

    /**
     * Остановлены ли автоматические PUT в БД (409-конфликт/потеря лока).
     * Публичный предикат для внешних save-путей (forceSaveToDb не должен
     * слать заведомо обречённый запрос).
     *
     * @returns {boolean}
     */
    static isDbAutoSaveHalted() {
        return this._dbAutoSaveHalted;
    }

    /**
     * Причина остановки авто-PUT — чтобы отказ «на входе» отдавал ошибку
     * того же типа, что живой отказ сервера (см. _dbAutoSaveHaltCause).
     *
     * @returns {'conflict'|'lock'|null}
     */
    static getDbAutoSaveHaltCause() {
        return this._dbAutoSaveHaltCause;
    }

    /**
     * Обрабатывает сбой фонового сохранения в БД (§9 offline).
     *
     * Показывает предупреждение один раз (без спама на каждый периодический
     * тик; повторное предупреждение возможно только после успешной
     * синхронизации) и подписывается на window 'online' для немедленного
     * повторного сохранения при восстановлении соединения.
     * @private
     */
    static _notifyDbSaveFailure() {
        if (!this._dbSaveFailureNotified) {
            this._dbSaveFailureNotified = true;
            Notifications.warning(
                'Не удалось сохранить изменения в базу данных. ' +
                'Правки сохранены локально; повторная попытка — автоматически.'
            );
        }
        if (!this._onlineRetryHandler) {
            this._onlineRetryHandler = () => {
                this._retryDbSave();
            };
            window.addEventListener('online', this._onlineRetryHandler);
        }
    }

    /**
     * Немедленный повторный save в БД после восстановления соединения.
     * При новой неудаче уведомление не дублируется (_dbSaveFailureNotified
     * ещё взведён), подписка на 'online' сохраняется до успеха.
     * @private
     */
    static async _retryDbSave() {
        if (AppState._dragInProgress) return;
        if (this._dbSaveInProgress) return; // B-15
        if (this._dbAutoSaveHalted) return; // 409-конфликт/потеря лока: ретрай обречён
        if (!this.hasUnsyncedChanges() || !window.currentActId) return;
        this._dbSaveInProgress = true;
        try {
            await APIClient.saveActContent(window.currentActId, { saveType: 'periodic' });
        } catch (err) {
            console.error('Повторное сохранение после восстановления сети не удалось:', err);
            // Тот же разбор причины, что у периодического тика: 409-конфликт
            // или потеря лока на этом пути так же обречены на ретрай, и молчать
            // о них нельзя — иначе halt не взводится, честного уведомления нет,
            // подписка на 'online' живёт вечно и каждый новый online шлёт
            // очередной заведомо провальный PUT.
            this._handleDbSaveFailure(err);
        } finally {
            this._dbSaveInProgress = false;
        }
    }

    /**
     * Снимает подписку на 'online' и сбрасывает флаг показанного
     * предупреждения о сбое сохранения в БД.
     * @private
     */
    static _resetDbSaveFailureState() {
        this._dbSaveFailureNotified = false;
        if (this._onlineRetryHandler) {
            window.removeEventListener('online', this._onlineRetryHandler);
            this._onlineRetryHandler = null;
        }
    }

    /**
     * Настраивает перехват попыток навигации.
     * Покрывает:
     *  - клик по `<a href>` (внутренние ссылки) — кастомный диалог;
     *  - back/forward (popstate) — диалог показывает confirmHistoryNavigation,
     *    её зовёт единственный владелец события (ActsMenuManager); своего
     *    слушателя popstate здесь нет намеренно, см. док-комментарий метода;
     *  - закрытие вкладки/прямой URL-ввод — браузерный beforeunload (см. _setupEventHandlers).
     * Программное `window.location.href = ...` всё равно отлавливается beforeunload —
     * перехватить set'тер location напрямую браузер не даёт.
     * @private
     */
    static _setupNavigationInterception() {
        // Флаг разрешения навигации (для программных переходов)
        window._allowNavigation = false;

        // Слияние с текущим history.state, а не замена целиком: ActsMenuManager
        // пишет в ту же запись истории свой actId (порядок init'ов двух модулей
        // не гарантирован), и замена состояния целиком стирала бы его.
        history.replaceState({...(history.state || {}), _lockNavGuard: true}, '', window.location.href);

        // Перехватываем клики по ссылкам. Хендлер храним в поле (стрелка
        // сохраняет this=класс), чтобы снять его в _teardownEventHandlers
        // (pfe-10/12).
        this._navClickHandler = async (e) => {
            // Игнорируем если навигация разрешена
            if (window._allowNavigation) return;

            const link = e.target.closest('a[href]');

            // Игнорируем если это не ссылка или если href пустой/якорь
            if (!link || !link.href || link.href.startsWith('#') || link.href.startsWith('javascript:')) {
                return;
            }

            // Игнорируем внешние ссылки и ссылки с target="_blank"
            if (link.target === '_blank' || link.hostname !== window.location.hostname) {
                return;
            }

            // Проверяем наличие несохраненных изменений
            if (this.hasUnsyncedChanges()) {
                e.preventDefault();

                const confirmed = await DialogManager.show({
                    title: 'Несохраненные изменения',
                    message: 'У вас есть несохраненные изменения. Если вы продолжите, они будут утеряны. Сохранить изменения в базу данных?',
                    icon: '⚠️',
                    confirmText: 'Сохранить и продолжить',
                    cancelText: 'Не сохранять'
                });

                if (confirmed) {
                    try {
                        await APIClient.saveActContent(window.currentActId, { saveType: 'manual' });
                        // E1: saveActContent — no-op (return null), если параллельный
                        // (периодический) PUT уже в полёте; дождёмся его, иначе тост
                        // «Изменения сохранены» подтвердил бы несостоявшуюся запись.
                        if (APIClient._saveInFlightPromise) {
                            await APIClient._saveInFlightPromise.catch(() => {});
                        }
                        // Если акт всё ещё не синхронизирован (тот PUT no-op'нулся/
                        // упал, либо правки печатались во время PUT) — форсим
                        // гарантированный PUT, чтобы подтверждение не было ложным.
                        if (this.hasUnsyncedChanges()) {
                            await APIClient.forceSaveToDb(window.currentActId);
                        }
                        Notifications.success('Изменения сохранены');
                    } catch (err) {
                        console.error('Ошибка сохранения:', err);
                        if (err instanceof ContentConflictError) {
                            // Конфликт версий: честное уведомление + остановка
                            // авто-PUT (единая обработка); generic-тост — ложь
                            // («не удалось» без причины и без судьбы правок).
                            this.handleContentConflict(err);
                        } else {
                            Notifications.error('Не удалось сохранить изменения');
                        }

                        const continueAnyway = await DialogManager.show({
                            title: 'Ошибка сохранения',
                            message: 'Не удалось сохранить изменения. Продолжить без сохранения?',
                            icon: '❌',
                            confirmText: 'Продолжить',
                            cancelText: 'Отмена'
                        });

                        if (!continueAnyway) {
                            return;
                        }
                    }
                }

                // Разрешаем навигацию и переходим по ссылке
                window._allowNavigation = true;
                window.location.href = link.href;
            }
        };
        document.addEventListener('click', this._navClickHandler);
    }

    /**
     * Решение о продолжении браузерной навигации back/forward при наличии
     * несинхронизированных с БД правок.
     *
     * Собственного слушателя `popstate` у StorageManager НЕТ намеренно.
     * Раньше их было два — этот страж и переключатель акта в ActsMenuManager;
     * они висели на одном событии независимо, в непредсказуемом порядке
     * (порядок init'ов двух модулей не гарантирован) и гонялись между собой:
     * проверка «есть ли правки» синхронна, а диалог — нет, поэтому пока
     * пользователь читал вопрос, переключение уже снимало лок со старого акта,
     * брало лок на новый и подменяло AppState его контентом. Кнопка «Остаться»
     * к этому моменту не имела смысла — оставаться было негде. Теперь владелец
     * события один (обработчик popstate в ActsMenuManager), и он спрашивает
     * эту функцию ДО того, как начнёт переключение.
     *
     * При отказе восстанавливаем адресную строку: popstate приходит уже после
     * того, как браузер сменил URL, поэтому «остаться» — это дописать поверх
     * целевой записи запись ПОКАЗАННОГО акта. Прежний страж пушил
     * `window.location.href`, то есть URL цели, и созданная им запись не
     * соответствовала показанному акту.
     *
     * При согласии — ничего: мы уже стоим на целевой записи истории. Прежний
     * страж делал `history.back()`, и тот порождал второй popstate (второе
     * переключение акта) и затирал forward-запись; он же навсегда взводил
     * `window._allowNavigation`, глуша страж кликов по ссылкам до конца сессии.
     *
     * @param {number} shownActId - ID акта, который показан сейчас
     * @param {string} shownUrl - URL этого акта (на него возвращаемся при отказе)
     * @returns {Promise<boolean>} true — навигацию продолжаем
     */
    static async confirmHistoryNavigation(shownActId, shownUrl) {
        if (window._allowNavigation) return true;
        if (!this.hasUnsyncedChanges()) return true;

        const confirmed = await DialogManager.show({
            title: 'Несохраненные изменения',
            message: 'У вас есть несохранённые изменения. Вернуться к предыдущей странице без сохранения?',
            icon: '⚠️',
            confirmText: 'Уйти без сохранения',
            cancelText: 'Остаться'
        });
        if (!confirmed) {
            // Мержим с history.state целевой записи (чтобы не терять чужих
            // полей), но actId выставляем свой: запись описывает показанный
            // акт, а не тот, куда вёл back/forward.
            history.pushState(
                {...(history.state || {}), actId: shownActId, _lockNavGuard: true},
                '',
                shownUrl
            );
        }
        return confirmed;
    }

    /**
     * Снимает все слушатели и гасит таймеры StorageManager (pfe-10/12).
     *
     * Идемпотентно: безопасно вызывать повторно (поля занулены, unregister/
     * removeEventListener — no-op для отсутствующих). Используется и при
     * повторном init (_setupEventHandlers), и при destroy.
     * @private
     */
    static _teardownEventHandlers() {
        if (this._periodicSaveInterval) {
            clearInterval(this._periodicSaveInterval);
            this._periodicSaveInterval = null;
        }
        if (this._periodicDbSaveInterval) {
            clearInterval(this._periodicDbSaveInterval);
            this._periodicDbSaveInterval = null;
        }
        if (typeof LifecycleHelper !== 'undefined') {
            LifecycleHelper.unregister('storage:unsaved-warning');
        }
        if (this._navClickHandler) {
            document.removeEventListener('click', this._navClickHandler);
            this._navClickHandler = null;
        }
    }

    /**
     * Единственная точка перевода persistence-state в новое значение.
     * Синхронно обновляет зеркальные булевы флаги и индикатор.
     * Старые API-методы (markAsUnsaved / _markAsSaved / markAsSyncedWithDB)
     * — обёртки над _setState.
     *
     * @private
     * @param {'saved'|'local-only'|'unsaved'} newState
     */
    static _setState(newState) {
        if (newState !== 'saved' && newState !== 'local-only' && newState !== 'unsaved') {
            console.warn('StorageManager._setState: неизвестное состояние', newState);
            return;
        }
        this._state = newState;
        // Зеркала для обратной совместимости с консьюмерами, читающими булевы поля
        // напрямую (beforeunload-warning, _updateSaveIndicator, hasUnsavedChanges).
        this._hasUnsavedChanges = (newState === 'unsaved');
        this._isSyncedWithDB = (newState === 'saved');
        this._updateSaveIndicator();
    }

    /**
     * Помечает состояние как измененное и запускает дебаунс сохранения
     *
     * Автоматически вызывается через Proxy при изменении AppState.
     * Игнорируется если отслеживание временно отключено.
     */
    static markAsUnsaved() {
        if (this._trackingDepth > 0) {
            return;
        }
        // PERSIST-4: реальная мутация состояния — двигаем эпоху грязности.
        // После tracking-гарда: пока трекинг выключен (сериализация), эпоха
        // не растёт (иначе exportActData сам себе поднял бы эпоху).
        this._dirtyEpoch++;
        this._setState('unsaved');
        // Запускаем дебаунс автосохранения
        this._debouncedSave();
    }

    /**
     * Помечает состояние как сохраненное в localStorage (но не обязательно в БД).
     * @private
     */
    static _markAsSaved() {
        // Если уже синхронизировано с БД — состояние не должно деградировать в 'local-only'.
        // _markAsSaved вызывается из saveState (всегда после mutation), поэтому
        // прежнее состояние почти всегда было 'unsaved'. Сохраняем 'saved' если оно было.
        if (this._state === 'saved') {
            return;
        }
        this._setState('local-only');
    }

    /**
     * Помечает состояние как синхронизированное с БД.
     * Заодно сбрасывает offline-машинерию (предупреждение о сбое сохранения
     * можно показывать снова, подписка на 'online' больше не нужна) и
     * остановку авто-PUT: «мы в синхроне с БД» опровергает «ретрай обречён».
     * Это же снимает halt при in-page переключении акта — bootstrap нового
     * акта (_loadActIntoView) зовёт markAsSyncedWithDB, и конфликт акта A
     * не глушит автосейв акта B (destroy при смене акта не вызывается).
     */
    static markAsSyncedWithDB() {
        this._setState('saved');
        this._resetDbSaveFailureState();
        this._dbAutoSaveHalted = false;
        this._dbAutoSaveHaltCause = null;
    }

    /**
     * PERSIST-4/A1: единый финал успешного PUT в БД для saveActContent и
     * forceSaveToDb (устраняет дубль эпоха-гейта в двух save-путях).
     *
     * Эпоха стабильна → правок во время await PUT не было: помечаем
     * синхронизированным (заодно гасит offline-машинерию) и снимаем
     * снимок-черновик. Эпоха выросла → правки печатались во время PUT и в
     * отправленную data не попали: акт остаётся грязным (дошлётся следующим
     * циклом), НО сам PUT прошёл — сервер достижим, поэтому всё равно гасим
     * offline-машинерию (дедуп-предупреждение + подписку 'online'). Без этого
     * после разового сбоя сохранения следующий реальный сбой уже не
     * предупредил бы, пока не случится стабильный по эпохе успех (A1).
     *
     * @param {number} actId
     * @param {number} epochBeforeSave эпоха грязности, снятая ДО сериализации
     */
    static finalizeDbSave(actId, epochBeforeSave) {
        if (this.getDirtyEpoch() === epochBeforeSave) {
            this.markAsSyncedWithDB();
            this.removeSnapshot(actId);
        } else {
            this._resetDbSaveFailureState();
        }
    }

    /**
     * PERSIST-4: текущее значение эпохи грязности (счётчика реальных мутаций).
     * saveActContent запоминает его перед PUT и сравнивает после — если эпоха
     * выросла, за время сохранения появились новые правки.
     * @returns {number}
     */
    static getDirtyEpoch() {
        return this._dirtyEpoch;
    }

    /**
     * Запоминает серверный updated_at акта (база для метаданных снимка).
     * Вызывается после успешного GET-контента и успешного PUT-сохранения.
     *
     * @param {string|null} updatedAt ISO-строка серверного updated_at
     */
    static setBaseUpdatedAt(updatedAt) {
        this._baseUpdatedAt = updatedAt || null;
    }

    /**
     * Серверный updated_at последней синхронизации (или null, если база не
     * установлена). Справочное значение (метаданные снимка черновика);
     * в OCC-проверке не участвует — см. getBaseContentVersion.
     *
     * @returns {string|null}
     */
    static getBaseUpdatedAt() {
        return this._baseUpdatedAt;
    }

    /**
     * Запоминает серверный acts.content_version (база OCC). Вызывается после
     * успешного GET-контента (metadata.content_version) и успешного PUT
     * (content_version из ответа). 0 — валидное значение; всё, что не целое
     * число, сбрасывает базу в null (optimistic-проверка выключается).
     *
     * @param {number|null} version Счётчик версий контента с сервера
     */
    static setBaseContentVersion(version) {
        this._baseContentVersion = Number.isInteger(version) ? version : null;
    }

    /**
     * Текущая база OCC — acts.content_version последней синхронизации
     * (или null, если база не установлена). Уходит эхом (тем же int) в
     * expected_content_version каждого PUT /content.
     *
     * @returns {number|null}
     */
    static getBaseContentVersion() {
        return this._baseContentVersion;
    }

    /**
     * Помечает восстановленный из localStorage черновик как
     * несинхронизированный с БД и переписывает снимок свежими метаданными.
     * Вызывается из loadActContent после включения трекинга — итоговое
     * состояние 'local-only' (жёлтый): данные есть локально, но не в БД.
     */
    static applyRestoredDraftState() {
        this._setState('unsaved');
        this.saveState(true);
    }

    /**
     * Отложенное сохранение с дебаунсом
     * @private
     */
    static _debouncedSave() {
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
        }

        this._saveTimeout = setTimeout(() => {
            this.saveState(true);
        }, this._autoSaveDebounceMs);
    }

    /**
     * Сохраняет снимок-черновик текущего акта в localStorage (M.8, pfe-1).
     *
     * Снимок = ОДИН вызов AppState.exportData() (тот же сериализатор, что и
     * body PUT /content — никаких расхождений форматов и сырых Proxy-объектов)
     * + метаданные для восстановления (H3): actId, savedAt, baseUpdatedAt.
     *
     * Ключ — per-act (`audit_workstation_state:{actId}`), снимки других актов
     * при записи удаляются (живёт только снимок текущего акта). Снимок пишется
     * только при наличии несинхронизированных изменений и удаляется после
     * успешного PUT в БД — «снимок есть» означает «есть несохранённые правки».
     *
     * @param {boolean} [silent=false] - Не показывать лог о сохранении
     * @param {{keepalive?: boolean}} [opts={}] - PERSIST-6: keepalive
     *   пробрасывается в аварийную эскалацию БД (актуально из beforeunload).
     * @returns {boolean} true если сохранение успешно (или сохранять нечего)
     */
    static saveState(silent = false, opts = {}) {
        // pfe-3: re-entrancy guard. Если запись снимка уже идёт (периодический
        // тик прилетел во время явного save или наоборот) — пропускаем повтор,
        // чтобы два сохранения не пересеклись на одном снимке.
        if (this._saveInProgress) {
            return false;
        }
        this._saveInProgress = true;
        try {
            const actId = window.currentActId || null;
            if (!actId) {
                console.warn('saveState: нет открытого акта — снимок не записан');
                return false;
            }

            // Всё синхронизировано с БД — несинхронизированных правок нет,
            // снимок не нужен (и не должен породить ложный диалог восстановления).
            if (this._state === 'saved') {
                return true;
            }

            const snapshot = {
                actId,
                savedAt: new Date().toISOString(),
                // Справочное поле (диагностика: по какой серверной метке снят
                // черновик). Решение о восстановлении принимает baseContentVersion.
                baseUpdatedAt: this._baseUpdatedAt,
                baseContentVersion: this._baseContentVersion,
                version: 2,
                // B-16: flush зависших правок + сериализация одной воронкой —
                // снимок не уедет без последних символов активного редактора.
                data: this.exportActData()
            };
            const stateJson = JSON.stringify(snapshot);

            // Проверка размера данных. B-3: снимок не влезает в localStorage —
            // не сдаёмся, а эскалируем в БД (надёжный носитель) и освобождаем LS.
            if (stateJson.length > AppConfig.localStorage.maxStorageSize) {
                console.warn('Размер данных превышает лимит localStorage — эскалация в БД');
                this._escalateQuotaToDb(opts);
                return false;
            }

            // Сохранение данных + чистка снимков других актов и legacy-ключей
            localStorage.setItem(this._snapshotKey(actId), stateJson);
            this._purgeForeignSnapshots(actId);
            // #5: запись снимка прошла — вернулись в норму, «взводим» право на
            // повторное уведомление о будущей эскалации.
            this._quotaEscalationNotified = false;

            // 🔧При сохранении в localStorage меняем ТОЛЬКО флаг несохраненных изменений
            // Флаг синхронизации с БД НЕ трогаем
            this._markAsSaved();

            if (!silent) {
                console.log('Состояние сохранено в localStorage');
            }

            return true;

        } catch (error) {
            console.error('Ошибка сохранения в localStorage:', error);

            // B-3: переполнение localStorage — снимок не записан, правки сейчас
            // только в памяти. Эскалируем в БД, затем освобождаем LS.
            if (error.name === 'QuotaExceededError') {
                this._escalateQuotaToDb(opts);
            } else {
                Notifications.error('Ошибка сохранения данных');
            }

            return false;
        } finally {
            // pfe-3: lock снимается всегда — даже при раннем return или ошибке.
            this._saveInProgress = false;
        }
    }

    /**
     * Коммитит все зависшие правки контента в state перед сериализацией.
     *
     * Единая точка для всех persistence/export-воронок (saveState,
     * PUT /content, экспорт): ни один путь не должен читать AppState.exportData()
     * без предварительного flush'а. Покрывает:
     *  - активный textblock-редактор с непогашенным debounce (500мс);
     *  - активную rich-поверхность поля нарушения (V20/V26): её правка уходит в
     *    модель только через debounce-мост, отдельного always-fresh write-through
     *    у неё больше нет;
     *  - редактируемую ячейку таблицы (textarea в `.editing`).
     * Ячейки таблиц вне редактирования пишутся в state синхронно, поэтому
     * специального flush'а не требуют.
     *
     * Модули конструктора доступны через window (lazy, как ActsManagerPage):
     * прямой импорт textBlockManager/tableManager здесь не нужен.
     * @private
     */
    static _flushPendingEdits() {
        try {
            if (window.textBlockManager && typeof window.textBlockManager.flushActiveEditor === 'function') {
                window.textBlockManager.flushActiveEditor();
            }
            // V20: активная rich-поверхность (поле нарушения) коммитит правку в
            // модель только через debounce-мост (V26) — воронка обязана сбросить её
            // ДО сериализации, иначе сохранение/экспорт внутри окна дебаунса уедет
            // без последних символов. flushActiveEditor выше её НЕ покрывает (ловит
            // только document.activeElement с классом .textblock-editor).
            // flushActive коммитит активную поверхность ЛЮБОГО типа; для текстблока
            // идемпотентно — его TextBlockSurface.commit уходит в тот же
            // flushActiveEditor, уже погашенный строкой выше.
            if (window.EditorRegistry && typeof window.EditorRegistry.flushActive === 'function') {
                window.EditorRegistry.flushActive();
            }
            const cellsOps = window.tableManager?.cellsOps;
            if (cellsOps && typeof cellsOps.commitPendingEdit === 'function') {
                cellsOps.commitPendingEdit();
            }
        } catch (error) {
            // Flush не должен валить сохранение — в худшем случае уедет
            // предыдущее значение, но снимок/PUT всё равно состоится.
            console.error('Ошибка коммита зависших правок перед сохранением:', error);
        }
    }

    /**
     * B-16: единственная точка «flush зависших правок → сериализация». Любой
     * путь экспорта/сохранения (снимок, PUT /content, файл-экспорт, аварийный
     * save) обязан читать состояние через неё, а не AppState.exportData()
     * напрямую — иначе экспорт уедет без последних символов активного редактора.
     * @returns {Object} сериализованное состояние акта
     */
    static exportActData() {
        this._flushPendingEdits();
        return AppState.exportData();
    }

    /**
     * B-3: аварийная эскалация при переполнении localStorage (паттерн
     * server-fallback + eviction). Снимок в LS записать не удалось → форс-PUT
     * текущего акта в БД (надёжный носитель; #11: сериализован с периодическим
     * PUT через _saveInFlight) → removeSnapshot освобождает LS. При неудаче БД —
     * critical + предложение экспортировать акт. #5: success-тост — один раз на
     * серию переполнений. fire-and-forget: не блокирует синхронный saveState
     * (его зовёт и beforeunload).
     * @private
     * @param {{keepalive?: boolean}} [opts={}] - PERSIST-6: keepalive пробрасывается
     *   в forceSaveToDb (запрос переживёт закрытие вкладки при вызове из beforeunload).
     */
    static _escalateQuotaToDb(opts = {}) {
        const actId = window.currentActId || null;
        if (!actId) {
            Notifications.error('Недостаточно места для сохранения. Упростите структуру акта.');
            return;
        }
        if (this._quotaEscalationInFlight) return; // не плодим параллельные эскалации
        this._quotaEscalationInFlight = true;
        APIClient.forceSaveToDb(actId, { keepalive: opts.keepalive })
            .then(() => {
                // Eviction (removeSnapshot) теперь внутри forceSaveToDb, под
                // эпоха-гейтом PERSIST-4: снимок снимается только если за время
                // PUT не появилось новых правок (иначе черновик ещё нужен).
                // #5: тост только один раз на серию переполнений — иначе крупный
                // акт спамил бы «сохранено в БД» на каждую правку. Флаг сбросится,
                // когда обычная запись снимка в LS снова пройдёт (вернулись в норму).
                if (!this._quotaEscalationNotified) {
                    this._quotaEscalationNotified = true;
                    Notifications.success(
                        'Локальное хранилище переполнено — изменения сохранены в базу данных.'
                    );
                }
            })
            .catch((err) => {
                console.error('B-3: аварийное сохранение в БД не удалось:', err);
                // Причина отказа (конфликт версий / потеря лока) объясняется
                // отдельным честным уведомлением и взводит halt. Generic-сбои
                // сюда НЕ отдаём: _notifyDbSaveFailure обещал бы «правки
                // сохранены локально; повторная попытка — автоматически», а
                // локально их как раз сохранить и не удалось.
                if (err instanceof ContentConflictError) {
                    this.handleContentConflict(err);
                } else if (err instanceof LockLostError) {
                    this._handleDbSaveFailure(err);
                }
                // Совет экспортировать обязателен при ЛЮБОЙ причине отказа:
                // сюда мы попали из-за неудачной записи снимка в localStorage,
                // так что «правки защищены черновиком» здесь неверно — PUT не
                // прошёл, снимок не записался, правки живут только в памяти.
                Notifications.error(
                    'Локальное хранилище переполнено, а сохранить в базу данных не удалось. '
                    + 'Экспортируйте акт в файл, чтобы не потерять изменения.'
                );
            })
            .finally(() => {
                this._quotaEscalationInFlight = false;
            });
    }

    /**
     * Ключ localStorage для снимка акта.
     * @private
     * @param {number|string} actId ID акта
     * @returns {string}
     */
    static _snapshotKey(actId) {
        return `${AppConfig.localStorage.stateKeyPrefix}:${actId}`;
    }

    /**
     * Читает снимок-черновик акта из localStorage.
     * Повреждённый (не-JSON) снимок удаляется, возвращается null.
     *
     * @param {number|string} actId ID акта
     * @returns {Object|null} Снимок {actId, savedAt, baseUpdatedAt, version, data} или null
     */
    static readSnapshot(actId) {
        const key = this._snapshotKey(actId);
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (error) {
            console.error('Повреждённый снимок в localStorage — удаляем:', error);
            try {
                localStorage.removeItem(key);
            } catch { /* ignore */ }
            return null;
        }
    }

    /**
     * Удаляет снимок-черновик акта из localStorage.
     * Вызывается после успешной синхронизации с БД, при отказе от
     * восстановления и для устаревших снимков.
     *
     * @param {number|string} actId ID акта
     */
    static removeSnapshot(actId) {
        try {
            localStorage.removeItem(this._snapshotKey(actId));
        } catch (error) {
            console.error('Ошибка удаления снимка из localStorage:', error);
        }
    }

    /**
     * Ключ localStorage бэкапа конфликтного черновика (конвенция префиксов —
     * как у audit_workstation_state).
     * @private
     * @param {number|string} actId ID акта
     * @returns {string}
     */
    static _conflictBackupKey(actId) {
        return `${this.CONFLICT_BACKUP_KEY_PREFIX}:${actId}`;
    }

    /**
     * Перемещает текущий снимок-черновик акта в бэкап-ключ конфликта.
     *
     * Вызывается при dismiss (Escape/клик мимо) диалога конфликта: обычный
     * снимок нельзя оставлять на месте — первая же пометка dirty после
     * загрузки (даже фоновая нормализация) перезаписала бы его DB-контентом
     * со свежей базой, и конфликтный черновик молча погиб бы. В бэкап-ключе
     * его штатная перезапись не достаёт; диалог конфликта вернётся при
     * следующем открытии акта (_maybeRestoreDraft проверяет бэкап).
     *
     * @param {number|string} actId ID акта
     */
    static stashConflictSnapshot(actId) {
        const snapshot = this.readSnapshot(actId);
        if (!snapshot) return;
        try {
            localStorage.setItem(this._conflictBackupKey(actId), JSON.stringify(snapshot));
            this.removeSnapshot(actId);
        } catch (error) {
            // Бэкап не записался (quota) — оставляем обычный снимок на месте:
            // хоть какой-то носитель правок лучше, чем никакого.
            console.error('Не удалось отложить конфликтный черновик в бэкап:', error);
        }
    }

    /**
     * Читает бэкап конфликтного черновика акта.
     * Повреждённый (не-JSON) бэкап удаляется, возвращается null.
     *
     * @param {number|string} actId ID акта
     * @returns {Object|null} Снимок той же формы, что readSnapshot, или null
     */
    static readConflictBackup(actId) {
        const key = this._conflictBackupKey(actId);
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (error) {
            console.error('Повреждённый бэкап конфликтного черновика — удаляем:', error);
            try {
                localStorage.removeItem(key);
            } catch { /* ignore */ }
            return null;
        }
    }

    /**
     * Удаляет бэкап конфликтного черновика акта.
     * Вызывается при явном выборе судьбы бэкапа в диалоге конфликта
     * (восстановили либо оставили версию из БД) и для протухших бэкапов.
     *
     * @param {number|string} actId ID акта
     */
    static removeConflictBackup(actId) {
        try {
            localStorage.removeItem(this._conflictBackupKey(actId));
        } catch (error) {
            console.error('Ошибка удаления бэкапа конфликтного черновика:', error);
        }
    }

    /**
     * Удаляет ПРОТУХШИЕ снимки других актов и legacy-ключи старого формата.
     *
     * PERSIST-3: снимки соседних актов больше НЕ стираются огулом — иначе
     * вкладка с актом B затирала несинхронизированный черновик акта A,
     * открытого в другой вкладке (потеря правок). Свежий чужой снимок
     * (моложе FOREIGN_SNAPSHOT_TTL_MS) сохраняется; удаляются только
     * заброшенные (метка savedAt старше срока) и повреждённые — для
     * высвобождения места. Legacy-ключи единого снимка удаляются всегда.
     * @private
     * @param {number|string} currentActId ID текущего акта
     */
    static _purgeForeignSnapshots(currentActId) {
        const prefix = `${AppConfig.localStorage.stateKeyPrefix}:`;
        const conflictPrefix = `${this.CONFLICT_BACKUP_KEY_PREFIX}:`;
        const viewPosPrefix = VIEW_POSITION_KEY_PREFIX;
        const currentKey = this._snapshotKey(currentActId);
        const now = Date.now();
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            // Бэкапы конфликтных черновиков (в т.ч. текущего акта) протухают
            // тем же TTL: свежий бэкап — носитель правок (не трогаем), стухший
            // за 7 дней явно заброшен — высвобождаем место.
            const isSnapshotKey = key.startsWith(prefix) && key !== currentKey;
            const isConflictKey = key.startsWith(conflictPrefix);
            // Позиции просмотра (шаг/скролл) — по одной на каждый когда-либо
            // открытый акт. Правок они не хранят, но растут монотонно, а
            // сметать их некому: этот TTL-проход — единственная точка уборки
            // per-act ключей. Свежую (в т.ч. текущего акта) сохраняем.
            const isViewPosKey = key.startsWith(viewPosPrefix);
            if (!isSnapshotKey && !isConflictKey && !isViewPosKey) {
                continue;
            }
            if (this._isForeignSnapshotStale(key, now)) {
                toRemove.push(key);
            }
        }
        // Legacy-ключи единого снимка (формат до per-act ключей) — удаляем всегда.
        toRemove.push('audit_workstation_state', 'audit_workstation_timestamp');
        toRemove.forEach(key => localStorage.removeItem(key));
    }

    /**
     * PERSIST-3: протух ли чужой снимок (безопасен ли к удалению).
     *
     * Свежим (→ сохраняем) считается снимок с валидной меткой savedAt не
     * старше FOREIGN_SNAPSHOT_TTL_MS — за ним может стоять активный
     * несинхронизированный черновик в соседней вкладке. Протухшим (→ удаляем)
     * считается снимок с savedAt старше срока, а также повреждённый (не-JSON)
     * или без валидной savedAt — восстановить из него нечего, а реальный
     * черновик всегда пишется с savedAt.
     * @private
     * @param {string} key Ключ localStorage чужого снимка
     * @param {number} now Текущее время (Date.now()) для сравнения
     * @returns {boolean} true — снимок можно удалить
     */
    static _isForeignSnapshotStale(key, now) {
        let raw;
        try {
            raw = localStorage.getItem(key);
        } catch {
            return false;
        }
        if (!raw) return false;
        let snapshot;
        try {
            snapshot = JSON.parse(raw);
        } catch {
            // Повреждённый чужой снимок восстановить нельзя — освобождаем место.
            return true;
        }
        const savedAtMs = Date.parse(snapshot?.savedAt);
        if (!Number.isFinite(savedAtMs)) {
            // Нет валидной метки времени — реальный черновик всегда её пишет,
            // значит снимок легаси/битый: удаляем.
            return true;
        }
        return (now - savedAtMs) > this.FOREIGN_SNAPSHOT_TTL_MS;
    }

    /**
     * Временно отключает отслеживание изменений (инкремент глубины, M.11).
     *
     * Используется для операций, которые модифицируют состояние,
     * но не должны помечать его как несохраненное. Вложенные пары
     * disable/enable композируются: отслеживание включится обратно
     * только когда КАЖДЫЙ disable получит свой enable.
     */
    static disableTracking() {
        this._trackingDepth++;
    }

    /**
     * Включает отслеживание изменений обратно (декремент глубины, пол 0).
     */
    static enableTracking() {
        this._trackingDepth = Math.max(0, this._trackingDepth - 1);
    }

    /**
     * Разрешает покинуть страницу без предупреждения браузера.
     * Вызывается при программном выходе (автовыход по неактивности,
     * кнопка выхода, акт заблокирован другим пользователем).
     */
    static allowUnload() {
        this._programmaticExit = true;
    }

    /**
     * Выполняет функцию без отслеживания изменений
     *
     * @param {Function} fn - Функция для выполнения
     * @returns {*} Результат выполнения функции
     */
    static withoutTracking(fn) {
        this.disableTracking();
        try {
            return fn();
        } finally {
            this.enableTracking();
        }
    }

    /**
     * Проверяет наличие несохраненных в БД изменений
     * @returns {boolean} true если данные не синхронизированы с БД
     */
    static hasUnsyncedChanges() {
        return !this._isSyncedWithDB && window.currentActId !== null;
    }

    /**
     * Очищает сохраненные снимки актов из localStorage
     * (все per-act снимки + legacy-ключи старого формата)
     */
    static clearStorage() {
        try {
            this._clearStorage();

            // При очистке возвращаемся в чистое состояние.
            this._setState('saved');
            console.log('localStorage очищен');
        } catch (error) {
            console.error('Ошибка очистки localStorage:', error);
        }
    }

    /**
     * Внутренняя очистка без логов (для использования в catch блоках)
     * @private
     */
    static _clearStorage() {
        try {
            const prefix = `${AppConfig.localStorage.stateKeyPrefix}:`;
            const toRemove = ['audit_workstation_state', 'audit_workstation_timestamp'];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(prefix)) {
                    toRemove.push(key);
                }
            }
            toRemove.forEach(key => localStorage.removeItem(key));
        } catch (error) {
            console.error('Ошибка очистки localStorage:', error);
        }
    }

    /**
     * Получает временную метку последнего сохранения снимка текущего акта
     * @returns {string|null} ISO строка времени или null
     */
    static getLastSaveTimestamp() {
        const actId = window.currentActId || null;
        if (!actId) return null;
        return this.readSnapshot(actId)?.savedAt ?? null;
    }

    /**
     * Обновляет индикатор сохранности в UI
     * Три состояния:
     * - saved (белый): сохранено в localStorage И БД
     * - local-only (желтый): сохранено только в localStorage
     * - unsaved (красный): не сохранено нигде
     * @private
     */
    static _updateSaveIndicator() {
        const button = document.getElementById('saveIndicatorBtn');
        const label = document.getElementById('saveIndicatorLabel');

        if (!button || !label) return;

        // Read-only режим: сохранять в БД нельзя, но кнопка остаётся активной —
        // по ней доступно скачивание выбранных форматов (saveAndExport).
        if (typeof AppConfig !== 'undefined' && AppConfig.readOnlyMode?.isReadOnly) {
            button.classList.remove('unsaved', 'local-only');
            button.classList.add('saved');
            button.disabled = false;
            button.title = 'Только чтение — сохранить нельзя, доступно скачивание файлов';
            label.textContent = 'Только чтение';
            return;
        }

        // Удаляем все классы состояний
        button.classList.remove('saved', 'local-only', 'unsaved');

        // Кнопка всегда активна: клик = сохранить в БД + сгенерировать и скачать
        // выбранные форматы. Цвет и подпись отражают статус сохранности.
        const actionTitle = 'Сохранить и скачать (Ctrl+Shift+S)';
        if (this._hasUnsavedChanges) {
            // Красный: есть изменения, которые не сохранены даже в localStorage
            button.classList.add('unsaved');
            button.disabled = false;
            button.title = actionTitle;
            label.textContent = 'Не сохранено';
        } else if (!this._isSyncedWithDB && window.currentActId) {
            // Желтый: сохранено в localStorage, но не в БД
            button.classList.add('local-only');
            button.disabled = false;
            button.title = actionTitle;
            label.textContent = 'Локально';
        } else {
            // Белый: полностью синхронизировано
            button.classList.add('saved');
            button.disabled = false;
            button.title = actionTitle;
            label.textContent = 'Сохранено';
        }

        // Дополнительный лог для отладки
        console.log('Индикатор обновлен:', {
            hasUnsavedChanges: this._hasUnsavedChanges,
            isSyncedWithDB: this._isSyncedWithDB,
            state: button.classList.contains('unsaved') ? 'unsaved' :
                button.classList.contains('local-only') ? 'local-only' : 'saved'
        });
    }

    /**
     * Проверяет, есть ли несохраненные изменения
     * @returns {boolean} true если есть несохраненные изменения
     */
    static hasUnsavedChanges() {
        return this._hasUnsavedChanges;
    }

    /**
     * Универсальное подтверждение программной навигации.
     * Контракт: при необходимости спрашивает подтверждение, и если переход
     * разрешён (несохранённых изменений нет ЛИБО пользователь подтвердил) —
     * при наличии opts.url ОБЯЗАТЕЛЬНО выполняет редирект.
     *
     * Без перехода (return true без редиректа) пользователь застревал на
     * странице при отсутствии несохранённого: вызывающие места (lock-manager
     * 409/500, header-exit) делегируют переход сюда и сами не редиректят.
     *
     * @param {string} [targetUrl] - URL для редиректа (информационно, фактический переход через opts.url)
     * @param {{url?: string}} [opts]
     * @returns {Promise<boolean>}
     */
    static async confirmNavigation(targetUrl, opts = {}) {
        if (!this.hasUnsyncedChanges()) {
            if (opts.url) {
                window._allowNavigation = true;
                this.allowUnload();
                window.location.href = opts.url;
            }
            return true;
        }
        const ok = await DialogManager.show({
            type: 'confirm',
            title: 'Несохраненные изменения',
            message: 'У вас есть несохранённые изменения. Уйти со страницы?',
            icon: '⚠️',
            confirmText: 'Уйти',
            cancelText: 'Остаться'
        });
        if (ok && opts.url) {
            window._allowNavigation = true;
            this.allowUnload();
            window.location.href = opts.url;
        }
        return ok;
    }

    /**
     * Очищает все таймеры и снимает слушатели при уничтожении.
     * pfe-10: помимо таймеров снимает beforeunload/click, иначе после destroy
     * старые обработчики продолжали висеть на window/document.
     */
    static destroy() {
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            this._saveTimeout = null;
        }

        // Гасит периодические интервалы + снимает beforeunload/click.
        this._teardownEventHandlers();

        this._resetDbSaveFailureState();
        // Остановка авто-PUT (409-конфликт/потеря лока) действует «до
        // перезагрузки» — teardown сессии конструктора её и завершает.
        this._dbAutoSaveHalted = false;
        this._dbAutoSaveHaltCause = null;

        // Сбрасываем счётчик трекинга: teardown не должен оставить отслеживание
        // выключенным, если асинхронная операция (save/generate/load) отключила
        // его и не успела вернуть до уничтожения страницы (#5).
        this._trackingDepth = 0;
    }

    /**
     * Инвалидирует кеш актов (для вызова после изменений)
     */
    static invalidateActsCache() {
        if (window.ActsManagerPage && typeof window.ActsManagerPage.invalidateCache === 'function') {
            window.ActsManagerPage.invalidateCache();
        }
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.StorageManager = StorageManager;
