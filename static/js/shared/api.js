/**
 * Ошибка "лок акта потерян": сервер вернул 409 на PUT /content.
 * Типовой сценарий — пока вкладка была в фоне, сработал autoExit
 * (через background-throttled таймер), снял блокировку и сохранил акт.
 * Юзер видит UI акта, но фактически уже не владеет локом — следующий Save → 409.
 * Вызывающая сторона ловит этот тип и делает редирект на список с плашкой,
 * идентичной той, что показывается при штатном autoExit'е.
 */
import { AppConfig } from './app-config.js';
import { AuthManager } from './auth.js';
import { DialogManager } from './dialog/dialog-confirm.js';
import { Notifications } from './notifications.js';
import { formatValidationDetail } from './api-errors.js';
import { sanitizeActContent } from '../constructor/state/act-content-sanitizer.js';
import { shouldOfferRestore } from '../constructor/state/draft-restore.js';
import { normalizePinnedOrder, reconcileTableKind } from '../constructor/table/table-kind.js';

// Constructor-зона: lazy-доступ через window.
// Прямые import'ы из ../constructor/* тянули весь constructor граф
// (App, AppState, StorageManager, ChangelogTracker, ActsMenuManager,
// ItemsRenderer, PreviewManager, AuditIdService) на любую portal-страницу
// через цепочку portal-common.js → shared/api.js, и module-level подписки
// constructor'а (App.init / _initStateTracking) стреляли где не нужно.
// Сами классы публикуются на window своими модулями (constructor entry);
// методы api.js, использующие их, вызываются только в constructor-сессии.

export class LockLostError extends Error {
    constructor() {
        super('Блокировка акта потеряна');
        this.name = 'LockLostError';
        this.code = 'lock-lost';
    }
}
window.LockLostError = LockLostError;

/**
 * PERSIST-6: предел тела запроса для fetch с keepalive. Спецификация
 * ограничивает суммарное тело всех keepalive-запросов ~64KB; при превышении
 * fetch(..., {keepalive:true}) бросает синхронно. Порог держим чуть ниже 64KB
 * (запас на заголовки). Тело крупнее — обычный fetch как best-effort (при
 * закрытии вкладки может не долететь).
 * @type {number}
 */
const KEEPALIVE_MAX_BODY_BYTES = 60 * 1024;

/**
 * Клиент для взаимодействия с API
 *
 * Обрабатывает все HTTP-запросы к серверу для работы с актами.
 * Предоставляет методы для генерации и скачивания файлов актов,
 * загрузки/сохранения содержимого из БД, а также удаления актов.
 */
export class APIClient {
    /**
     * Флаг in-flight PUT /content (H-N1-UX). Защищает от двойного запроса
     * при mash'е Ctrl+S/клике "Сохранить" — повторные вызовы saveActContent
     * пока предыдущий не завершился (resolve/reject) молча отбрасываются.
     */
    static _saveInFlight = false;

    /**
     * #11: промис завершения текущего PUT /content. forceSaveToDb (аварийная
     * quota-эскалация) дожидается его перед своим PUT, чтобы не разъехаться с
     * периодическим сохранением (сервер — last-writer-wins без версии). null,
     * когда обычного PUT в полёте нет.
     */
    static _saveInFlightPromise = null;

    static async lockAct(actId) {

        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/acts/${actId}/lock`), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            await this._throwApiError(response);
        }

        return response.json();
    }

    static async unlockAct(actId) {

        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/acts/${actId}/unlock`), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            await this._throwApiError(response);
        }

        return response.json();
    }

    static async extendLock(actId) {

        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/acts/${actId}/extend-lock`), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            await this._throwApiError(response);
        }

        return response.json();
    }

    /**
     * Генерирует и сохраняет акты на сервере
     *
     * @param {string|string[]} formats - Формат или массив форматов ('txt', 'md', 'docx')
     * @returns {Promise<boolean>} true если хотя бы один файл создан успешно
     */
    static async generateAct(formats = 'txt') {
        window.StorageManager.disableTracking();

        try {
            // B-16: snapshot (с внутренним flush) + сериализация через единую
            // воронку exportActData — экспорт не уедет без последних символов.
            window.StorageManager.saveState(true);

            const data = window.StorageManager.exportActData();
            const formatList = Array.isArray(formats) ? formats : [formats];

            const validFormats = formatList.filter(fmt =>
                ['txt', 'docx', 'md'].includes(fmt)
            );

            if (validFormats.length === 0) {
                Notifications.error('Не выбраны валидные форматы для сохранения');
                return false;
            }

            const results = [];
            let successCount = 0;
            let errorCount = 0;

            for (const format of validFormats) {
                const result = await this._generateSingleFormat(format, data);
                results.push(result);

                if (result.success) {
                    successCount++;
                } else {
                    errorCount++;
                }
            }

            this._showGenerationResults(successCount, errorCount, results);

            if (successCount > 0) {
                // Скачиваем созданные файлы сразу, без диалога-вопроса.
                await this._downloadAllFiles(results);
            }

            return successCount > 0;

        } catch (error) {
            Notifications.error(
                `Произошла ошибка: ${error.message}`,
                AppConfig.notifications.duration.longSuccess
            );
            return false;
        } finally {
            setTimeout(() => {
                window.StorageManager.enableTracking();
            }, AppConfig.timings.enableTrackingAfterGenerate);
        }
    }

    /**
     * Генерирует акт в одном формате
     * @private
     */
    static async _generateSingleFormat(format, data) {
        try {
            // Передаём act_id для привязки файла к контролю доступа
            const actId = new URLSearchParams(window.location.search).get('act_id');
            let url = `/api/v1/acts/export/save-act?fmt=${format}`;
            if (actId) {
                url += `&act_id=${encodeURIComponent(actId)}`;
            }

            const response = await this._fetchWithTimeout(AppConfig.api.getUrl(url),
                {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(data)
                }
            );

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const result = await response.json();
            return {
                format,
                filename: result.filename,
                success: true
            };

        } catch (error) {
            console.error(`Ошибка генерации формата ${format}:`, error);
            return {
                format,
                error: error.message,
                success: false
            };
        }
    }

    /**
     * Показывает результаты генерации файлов
     * @private
     */
    static _showGenerationResults(successCount, errorCount, results) {
        if (successCount > 0 && errorCount === 0) {
            const formatsList = results
                .filter(r => r.success)
                .map(r => r.format.toUpperCase())
                .join(', ');
            Notifications.success(
                `Создано ${successCount} файл(ов): ${formatsList}`,
                AppConfig.notifications.duration.longSuccess
            );
        } else if (successCount > 0 && errorCount > 0) {
            Notifications.info(
                `Успешно: ${successCount}, Ошибок: ${errorCount}`,
                AppConfig.notifications.duration.longSuccess
            );
        } else {
            Notifications.error(
                'Не удалось создать файлы',
                AppConfig.notifications.duration.longSuccess
            );
        }
    }

    /**
     * Скачивает все успешно созданные файлы
     * @private
     */
    static async _downloadAllFiles(results) {
        const successfulResults = results.filter(r => r.success);
        let downloadedCount = 0;
        let downloadErrors = 0;

        for (const result of successfulResults) {
            try {
                await this.downloadFile(result.filename);
                downloadedCount++;
            } catch (error) {
                downloadErrors++;
            }
        }

        this._showDownloadResults(downloadedCount, downloadErrors, successfulResults.length);
    }

    /**
     * Показывает результаты скачивания файлов
     * @private
     */
    static _showDownloadResults(downloadedCount, downloadErrors, totalFiles) {
        if (downloadedCount === totalFiles) {
            Notifications.success(
                `Успешно скачано ${downloadedCount} файл(ов)`,
                AppConfig.notifications.duration.success
            );
        } else {
            Notifications.info(
                `Скачано: ${downloadedCount}, Ошибок: ${downloadErrors}`,
                AppConfig.notifications.duration.info
            );
        }
    }

    /**
     * Скачивает сгенерированный файл
     *
     * @param {string} filename - Имя файла для скачивания
     * @returns {Promise<void>}
     */
    static async downloadFile(filename) {
        try {
            const response = await this._fetchWithTimeout(AppConfig.api.getUrl(
                `/api/v1/acts/export/download/${filename}`)
            );

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error(`Файл "${filename}" не найден на сервере`);
                }
                throw new Error(
                    `Ошибка сервера: ${response.status} ${response.statusText}`
                );
            }

            const blob = await response.blob();
            this._triggerDownload(blob, filename);

        } catch (error) {
            throw error;
        }
    }

    /**
     * Инициирует скачивание blob как файла
     * @private
     */
    static _triggerDownload(blob, filename) {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;

        document.body.appendChild(a);
        a.click();

        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    }

    /**
     * Загружает содержимое акта из БД (фасад).
     *
     * Разделён на две фазы: _fetchActContent (только сеть) и _applyActContent
     * (применение к состоянию, включая диалог восстановления черновика).
     * Вызывающие, которым нужно вклинить захват лока МЕЖДУ сетью и применением
     * (acts-menu::_autoLoadAct, §3.4), дёргают фазы по отдельности. Прочие
     * вызывающие (переключение акта, обновление метаданных), где лок уже
     * захвачен, используют этот фасад — поведение для них не меняется.
     *
     * @param {number} actId - ID акта
     * @returns {Promise<void>}
     * @throws {Error} При ошибке доступа или загрузки
     */
    static async loadActContent(actId) {
        const content = await this._fetchActContent(actId);
        await this._applyActContent(actId, content);
    }

    /**
     * Сетевая фаза загрузки акта (§3.4).
     *
     * Только запрос + обработка статусов (403/404/timeout) + парсинг JSON.
     * Никаких побочных эффектов над состоянием: не трогает window.actMetadata,
     * права, трекинг, дерево и НЕ показывает диалог восстановления черновика —
     * это позволяет вызывающему захватить лок до применения контента.
     *
     * @param {number} actId - ID акта
     * @returns {Promise<Object>} Распарсенный content акта
     * @throws {Error} При ошибке доступа (code ACCESS_DENIED/NOT_FOUND) или загрузки
     */
    static async _fetchActContent(actId) {
        const username = AuthManager.getCurrentUser();

        if (!username) {
            throw new Error('Пользователь не авторизован');
        }

        const resp = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/acts/${actId}/content`), {
            headers: {}
        });

        if (!resp.ok) {
            if (resp.status === 403) {
                const error = new Error('Нет доступа к акту');
                error.code = 'ACCESS_DENIED';
                throw error;
            } else if (resp.status === 404) {
                const error = new Error('Акт не найден');
                error.code = 'NOT_FOUND';
                throw error;
            }
            throw new Error('Ошибка загрузки акта');
        }

        return await resp.json();
    }

    /**
     * Применяет права пользователя из content к AppConfig.readOnlyMode (§3.4).
     *
     * Вынесено отдельно, чтобы _autoLoadAct мог установить read-only статус
     * между fetch и захватом лока (LockManager.init пропускает лок в read-only).
     * Идемпотентно: повторный вызов из _applyActContent безвреден.
     *
     * @param {Object} content - content акта (с полем userPermission)
     */
    static _applyUserPermission(content) {
        if (content?.userPermission) {
            AppConfig.readOnlyMode.isReadOnly = !content.userPermission.canEdit;
            AppConfig.readOnlyMode.userRole = content.userPermission.role;
        }
    }

    /**
     * Применяющая фаза загрузки акта (§3.4).
     *
     * Всё, что было после получения content: метаданные, права (readOnlyMode),
     * setBaseUpdatedAt, диалог восстановления черновика (_maybeRestoreDraft),
     * санитайзер, инициализация/загрузка дерева, рендер, баннер read-only.
     * Вызывается ПОСЛЕ захвата лока в _autoLoadAct (чтобы диалог черновика
     * показывался когда уже известно, занят ли акт).
     *
     * @param {number} actId - ID акта
     * @param {Object} content - Распарсенный content из _fetchActContent
     * @returns {Promise<void>}
     */
    static async _applyActContent(actId, content) {
        try {
            // Сохраняем метаданные в глобальную переменную
            window.actMetadata = content.metadata;

            // Обрабатываем права пользователя. Идемпотентно: _autoLoadAct (§3.4)
            // вызывает _applyUserPermission ДО захвата лока, чтобы LockManager.init
            // знал read-only статус (read-only пользователь не захватывает лок).
            this._applyUserPermission(content);

            // Получаем флаг процессной проверки из метаданных
            const isProcessBased = content.metadata?.is_process_based !== undefined
                ? content.metadata.is_process_based
                : true;

            // H3: запоминаем серверный updated_at — базу метаданных снимка
            // черновика (baseUpdatedAt). Обновляется при каждой успешной
            // синхронизации (GET здесь, PUT в saveActContent).
            const serverUpdatedAt = content.metadata?.updated_at ?? null;
            window.StorageManager.setBaseUpdatedAt(serverUpdatedAt);

            // H3: восстановление несинхронизированного черновика из localStorage.
            // Предлагается ТОЛЬКО если акт с момента снимка никто не менял
            // (baseUpdatedAt снимка совпадает с серверным updated_at);
            // устаревший снимок молча удаляется.
            let draftRestored = false;
            if (!AppConfig.readOnlyMode.isReadOnly) {
                draftRestored = await this._maybeRestoreDraft(actId, content, serverUpdatedAt);
            }

            // M.13-фронт: последний рубеж от несогласованных данных (сироты
            // словарей, висячие ссылки узлов). Новые бэкенд не пропускает,
            // но в БД могли остаться исторически испорченные записи.
            const sanitizeReport = sanitizeActContent(content);
            if (sanitizeReport.changed) {
                // B-19: детальный report уходит в серверный лог (контракт C4);
                // пользователю молчим — это not-actionable фоновая чистка зомби-данных.
                console.warn('Несогласованные данные акта исправлены при загрузке:', sanitizeReport);
                window.ErrorBoundary?._reportToServer?.({
                    category: 'sanitize-report',
                    message: 'Несогласованные данные акта исправлены при загрузке',
                    detail: { actId, ...sanitizeReport },
                });
            }

            // 6.4: нормализуем нестандартные размеры шрифта legacy-актов к палитре
            // (унифицированный акт). Правит content ДО присвоения в AppState; при
            // изменении помечаем акт несохранённым после re-enable tracking (ниже).
            const fontNorm = window.normalizeFontSizes
                ? window.normalizeFontSizes(content.textBlocks, window.textBlockManager?.fontSizes || [])
                : { changed: false, count: 0 };
            if (fontNorm.changed) {
                console.info(`6.4: нормализовано нестандартных размеров шрифта: ${fontNorm.count}`);
            }

            // #20: до-заполняем недостающие под-объекты/скаляры формы нарушения
            // эталоном (legacy-акты после ручной правки БД/сбойного мигратора).
            // Правит content.violations ДО присвоения в AppState; при изменении
            // помечаем акт несохранённым после re-enable tracking (ниже), как fontNorm.
            const violationsNorm = window.normalizeViolations
                ? window.normalizeViolations(content.violations)
                : { changed: false, count: 0 };
            if (violationsNorm.changed) {
                console.info(`#20: нормализована форма нарушений: ${violationsNorm.count}`);
            }

            // Отключаем tracking на время загрузки
            window.StorageManager.disableTracking();

            // Проверяем, пустой ли акт
            const isEmpty = !content.tree ||
                !Array.isArray(content.tree.children) ||
                content.tree.children.length === 0;

            const AppState = window.AppState;
            if (isEmpty) {
                // Акт пуст, инициализируем дефолтную структуру

                // Очищаем состояние ДО инициализации
                AppState.treeData = null;
                AppState.tables = {};
                AppState.textBlocks = {};
                AppState.violations = {};

                // Инициализируем дерево и таблицы с учетом типа проверки
                AppState.initializeTree(isProcessBased);
                AppState.generateNumbering();

                // Привязываем фактуры к узлам дерева
                if (content.invoices) {
                    this._attachInvoicesToTree(AppState.treeData, content.invoices);
                }

                // Асинхронно присваиваем audit_point_id (не блокируем пользователя)
                if (window.AuditIdService) {
                    window.AuditIdService.assignMissingPointIds(actId, AppState.treeData);
                }

                // Флаг: дефолтную структуру нужно сохранить после блокировки
                this._pendingDefaultStructureSave = !AppConfig.readOnlyMode.isReadOnly;

                Notifications.info('Акт инициализирован с базовой структурой');
            } else {
                // Загружаем существующее содержимое из БД
                AppState.treeData = content.tree;
                AppState.tables = content.tables || {};
                AppState.textBlocks = content.textBlocks || {};
                AppState.violations = content.violations || {};

                // Миграция: strip числового префикса из label для item-узлов
                this._migrateStripNumberFromLabels(AppState.treeData);

                // Реконсайлер подвида таблицы (kind) node↔table. Узел —
                // источник истины; kind, заданный только в tables[id],
                // поднимается на узел, объект таблицы синхронизируется с узлом.
                reconcileTableKind(AppState.treeData, AppState.tables);

                // Нормализация порядка: закреплённые таблицы (метрики/риски) —
                // в начало children. Чинит старые акты, где pinned-таблица
                // оказалась не первой. Делается после reconcileTableKind
                // (kind уже поднят на узлы) и до нумерации.
                normalizePinnedOrder(AppState.treeData);

                AppState.generateNumbering();

                // Привязываем фактуры к узлам дерева
                if (content.invoices) {
                    this._attachInvoicesToTree(AppState.treeData, content.invoices);
                }

                // Асинхронно присваиваем audit_point_id (не блокируем пользователя)
                if (window.AuditIdService) {
                    window.AuditIdService.assignMissingPointIds(actId, AppState.treeData);
                }
            }

            // #17: эталонный снимок нарушений для diff-аудита правок при
            // сохранении. Берётся ПОСЛЕ присвоения AppState.violations в обеих
            // ветках (пустой акт / загруженный контент). Снимок не клонирует
            // base64-байты картинок (см. ViolationAudit). Новый load
            // переустанавливает эталон целиком → корректен при switch'е акта.
            // Lazy-доступ через window (как ItemsRenderer/PreviewManager ниже):
            // ViolationAudit публикуется constructor entry (violation-init.js),
            // без статического import'а constructor-графа в api.js.
            if (window.ViolationAudit) window.ViolationAudit.snapshot(AppState.violations);

            // Обновляем интерфейс
            if (typeof treeManager !== 'undefined') {
                treeManager.render();
            }
            if (window.ItemsRenderer) {
                window.ItemsRenderer.renderAll();
            }
            if (window.PreviewManager) {
                window.PreviewManager.update();
            }

            // Включаем tracking обратно с задержкой.
            // Снимок в localStorage здесь НЕ пишется: снимок существует только
            // при несинхронизированных правках (см. StorageManager.saveState).
            setTimeout(() => {
                window.StorageManager.enableTracking();
                if (fontNorm.changed && !AppConfig.readOnlyMode.isReadOnly) {
                    // 6.4: нормализация изменила content — теперь, когда tracking
                    // снова включён, помечаем акт несохранённым (автосейв персистит).
                    // #4: НЕ в read-only — у зрителя нет прав на PUT (иначе фоновый
                    // автосейв бил бы в 403), а нормализация в БД всё равно не уйдёт.
                    window.StorageManager.markAsUnsaved();
                }
                if (violationsNorm.changed && !AppConfig.readOnlyMode.isReadOnly) {
                    // #20: аналогично fontNorm — до-заполнение формы нарушения
                    // помечает акт несохранённым, не в read-only (см. комментарий выше).
                    window.StorageManager.markAsUnsaved();
                }
                if (sanitizeReport.changed && !AppConfig.readOnlyMode.isReadOnly) {
                    // №8: аналогично fontNorm/violationsNorm — без этого вылеченные
                    // сиротой/бэк-референсом данные не персистятся, и каждое
                    // открытие акта лечит их заново (тот же серверный отчёт).
                    window.StorageManager.markAsUnsaved();
                }
                if (draftRestored) {
                    // Восстановленный черновик ещё не в БД — помечаем как
                    // несинхронизированный ПОСЛЕ bootstrap-вызовов
                    // markAsSyncedWithDB вызывающих сторон (acts-menu/app).
                    window.StorageManager.applyRestoredDraftState();
                }
            }, AppConfig.timings.enableTrackingAfterLoad);

            // Показываем баннер и применяем режим просмотра если нет прав на редактирование
            if (AppConfig.readOnlyMode.isReadOnly) {
                this._showReadOnlyBanner();
                // Применяем read-only стили к интерфейсу
                if (window.App && window.App._applyReadOnlyMode) {
                    window.App._applyReadOnlyMode();
                }
                // Применяем ограничения к меню актов
                if (window.ActsMenuManager && window.ActsMenuManager.applyReadOnlyRestrictions) {
                    window.ActsMenuManager.applyReadOnlyRestrictions();
                }
            }

        } catch (err) {
            console.error('Ошибка загрузки акта:', err);
            window.StorageManager.enableTracking();
            throw err;
        }
    }

    /**
     * Предлагает восстановить несинхронизированный черновик акта (H3).
     *
     * Решение принимает чистый предикат shouldOfferRestore: восстановление
     * предлагается только если акт с момента снимка никто не менял
     * (baseUpdatedAt снимка == серверный updated_at). Устаревший или
     * повреждённый снимок молча удаляется; при отказе пользователя — тоже.
     * При согласии данные снимка подставляются в content и дальше идут
     * штатным путём загрузки (reconcile/normalize/нумерация/рендер).
     *
     * @private
     * @param {number} actId ID акта
     * @param {Object} content Контент акта из GET (мутируется при восстановлении)
     * @param {string|null} serverUpdatedAt Серверный updated_at акта
     * @returns {Promise<boolean>} true если черновик восстановлен
     */
    static async _maybeRestoreDraft(actId, content, serverUpdatedAt) {
        const snapshot = window.StorageManager.readSnapshot(actId);
        const verdict = shouldOfferRestore(snapshot, serverUpdatedAt);

        if (verdict === 'discard') {
            window.StorageManager.removeSnapshot(actId);
            return false;
        }
        if (verdict !== 'restore') {
            return false;
        }

        const savedAtDate = new Date(snapshot.savedAt);
        const savedAtText = Number.isFinite(savedAtDate.getTime())
            ? savedAtDate.toLocaleString('ru-RU')
            : snapshot.savedAt;

        const confirmed = await DialogManager.show({
            title: 'Несохранённый черновик',
            message: `Найден несохранённый черновик от ${savedAtText}. Восстановить?`,
            icon: '📝',
            confirmText: 'Восстановить',
            cancelText: 'Отклонить'
        });

        if (!confirmed) {
            window.StorageManager.removeSnapshot(actId);
            return false;
        }

        content.tree = snapshot.data.tree;
        content.tables = snapshot.data.tables || {};
        content.textBlocks = snapshot.data.textBlocks || {};
        content.violations = snapshot.data.violations || {};
        console.log('Черновик акта восстановлен из localStorage (снимок от', snapshot.savedAt, ')');
        return true;
    }

    /**
     * Сохраняет дефолтную структуру в БД (без уведомлений)
     * @private
     */
    static async _saveDefaultStructure(actId, username) {
        try {
            const data = window.AppState.exportData();

            const resp = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/acts/${actId}/content`), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (!resp.ok) {
                const error = await resp.text();
                console.error('Ошибка сохранения дефолтной структуры:', error);
                throw new Error('Ошибка сохранения дефолтной структуры');
            }

            // H3: PUT бампит updated_at на сервере — фиксируем новую базу
            // для метаданных снимка черновика.
            const result = await resp.json().catch(() => null);
            if (result?.updated_at) {
                window.StorageManager.setBaseUpdatedAt(result.updated_at);
            }

        } catch (err) {
            // Ранее ошибка глоталась "чтобы не прерывать работу", но это
            // приводило к молчаливой потере состояния: пользователь видел
            // пустой акт и думал что всё в порядке, при повторной правке
            // ловил 404/409. Теперь предупреждаем явно и пробрасываем —
            // вызывающий (acts-menu.js::_autoLoadAct) обязан обработать
            // и не продолжать как ни в чём не бывало.
            console.error('Не удалось сохранить начальную структуру:', err);
            if (typeof Notifications !== 'undefined') {
                Notifications.warning(
                    'Не удалось сохранить начальную структуру акта — повторите вход'
                );
            }
            throw err;
        }
    }

    /**
     * Сохраняет содержимое акта в БД
     *
     * @param {number} actId - ID акта
     * @param {Object} [options] - Опции сохранения
     * @param {string} [options.saveType='auto'] - Тип сохранения: 'manual' | 'periodic' | 'auto'
     * @returns {Promise<void>}
     */
    static async saveActContent(actId, { saveType = 'auto' } = {}) {
        const username = AuthManager.getCurrentUser();

        if (!username) {
            throw new Error('Пользователь не авторизован');
        }

        // H-N1-UX: гард от двойного PUT при mash'е Ctrl+S / клике "Сохранить".
        // Без него каждый повторный вызов уходил отдельным запросом на /content,
        // пока предыдущий ещё в полёте — лишняя нагрузка и risk race-condition'ов.
        if (APIClient._saveInFlight) {
            console.log('saveActContent уже в процессе — пропускаем повторный вызов');
            return null;
        }
        APIClient._saveInFlight = true;
        // #11: публикуем промис завершения — forceSaveToDb на него дождётся.
        let _resolveSave;
        APIClient._saveInFlightPromise = new Promise((r) => { _resolveSave = r; });

        try {
            // PERSIST-4: запоминаем эпоху грязности ДО сериализации. Трекинг
            // выключаем ТОЛЬКО вокруг синхронного exportActData (flush
            // активного редактора внутри него не должен поднять эпоху — эти
            // правки как раз уходят в data). Символы, напечатанные во время
            // await PUT ниже, инкрементят эпоху при включённом трекинге, и
            // после ответа мы это заметим (см. решение о markAsSyncedWithDB).
            const epochBeforeSave = window.StorageManager.getDirtyEpoch();

            // B-16: flush зависших правок + сериализация одной воронкой —
            // иначе PUT уедет без последних символов активного редактора.
            window.StorageManager.disableTracking();
            let data;
            try {
                data = window.StorageManager.exportActData();
            } finally {
                window.StorageManager.enableTracking();
            }
            data.saveType = saveType;
            data.changelog = window.ChangelogTracker ? window.ChangelogTracker.flush() : [];

            const resp = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/acts/${actId}/content`), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (!resp.ok) {
                if (resp.status === 403) {
                    throw new Error('Нет доступа к акту');
                } else if (resp.status === 404) {
                    throw new Error('Акт не найден');
                } else if (resp.status === 409) {
                    // Лок потерян (автовыход по неактивности успел снять блокировку
                    // пока вкладка была в фоне). Кидаем типизированную ошибку,
                    // вызывающая сторона (navigation-manager) делает редирект на список
                    // с тем же sessionStorage-флагом, что и autoExit.
                    throw new LockLostError();
                } else if (resp.status === 422) {
                    // Серверная структурная валидация таблиц (P6a): рваная сетка,
                    // несовпадение числа ширин, объединение за границами,
                    // взаимоисключение флагов. detail приходит массивом
                    // {loc, msg} с русским msg — показываем пользователю «где и
                    // что не так», а не глотаем под общую «Ошибка сохранения».
                    let detail = null;
                    try {
                        const body = await resp.json();
                        detail = formatValidationDetail(body.detail);
                    } catch {
                        // не-JSON ответ — оставляем fallback ниже
                    }
                    throw new Error(detail || 'Данные акта не прошли проверку структуры таблиц');
                }
                throw new Error('Ошибка сохранения');
            }

            const result = await resp.json();
            console.log('Акт сохранен в БД:', result);

            // H3: фиксируем новый серверный updated_at (бэкенд бампит его при
            // каждом сохранении) — база для метаданных будущих снимков.
            if (result?.updated_at) {
                window.StorageManager.setBaseUpdatedAt(result.updated_at);
            }

            // #5: PUT подтверждён — коммитим отложенный снимок аудита нарушений
            // (иначе неудачное сохранение теряло бы правку безвозвратно).
            window.ViolationAudit?.confirmSave?.();

            // PERSIST-4/A1: единый финал успешного PUT (эпоха-гейт синхронизации
            // + снятие снимка при стабильной эпохе; гашение offline-машинерии в
            // любом случае). Если за время PUT пользователь печатал (эпоха
            // выросла), эти правки в отправленную data НЕ попали — акт остаётся
            // dirty и дошлётся следующим циклом.
            window.StorageManager.finalizeDbSave(actId, epochBeforeSave);

            // Бэкенд может вернуть мягкое предупреждение (Finding 3/8): сохранение
            // прошло, но есть на что обратить внимание. Для периодического
            // (фонового) сохранения toast не показываем — это сюрпризные
            // уведомления при автосейве.
            if (result?.warning && saveType !== 'periodic') {
                Notifications.warning(result.warning);
            }

            // Статус валидации акта (#8): бэк — источник истины. Сохраняем
            // замечания для колокольчика конструктора и, при ручном сохранении,
            // показываем краткий toast с конкретикой (что именно проверить).
            const issues = Array.isArray(result?.validation_issues) ? result.validation_issues : [];
            const validationStatus = result?.validation_status || 'ok';
            if (window.AppState) {
                window.AppState.validationStatus = validationStatus;
                window.AppState.validationIssues = issues;
            }
            document.dispatchEvent(new CustomEvent('act:validation-updated', {
                detail: { status: validationStatus, issues },
            }));
            // Тост по статусу (#8): error — критично (красный), warning — работа
            // не закончена (жёлтый). Полный список замечаний — в колокольчике
            // акта. На периодическом (фоновом) сохранении тост не показываем.
            if (saveType !== 'periodic' && validationStatus !== 'ok') {
                const head = issues.slice(0, 3).map(i => i.message).join('; ');
                if (validationStatus === 'error') {
                    Notifications.error(`Акт требует проверки${head ? ': ' + head : ''}`);
                } else {
                    Notifications.warning(`Работа не закончена${head ? ': ' + head : ''}`);
                }
            }

            Notifications.success('Акт сохранен в базу данных');

        } catch (err) {
            console.error('Ошибка сохранения акта в БД:', err);
            // §6.8: сохранение в БД не удалось — фиксируем в телеметрии редактора
            // (фоновые сбои сохранения иначе молчат).
            window.EditorTelemetry?.track?.('save_failure');
            // Для LockLostError не показываем toast — вызывающая сторона сделает
            // редирект на список с плашкой autoExit (одинаковый UX с фоновым autoExit'ом).
            // Для периодического (фонового) сохранения toast на каждый тик не
            // показываем — дедуплицированное предупреждение и ретрай по 'online'
            // делает StorageManager (§9 offline).
            if (!(err instanceof LockLostError) && saveType !== 'periodic') {
                Notifications.error(`Не удалось сохранить акт: ${err.message}`);
            }
            throw err;
        } finally {
            APIClient._saveInFlight = false;
            APIClient._saveInFlightPromise = null;
            if (_resolveSave) _resolveSave();
            // PERSIST-4: трекинг больше не выключается на весь PUT — он
            // выключается только вокруг синхронного exportActData выше (и там же
            // включается обратно), чтобы правки во время await PUT не терялись.
        }
    }

    /**
     * B-3: форс-PUT текущего акта в БД в обход localStorage. Вызывается ТОЛЬКО из
     * аварийной эскалации StorageManager при переполнении localStorage: снимок
     * записать не удалось, единственный носитель правок — память, надо немедленно
     * зафиксировать в БД. #11: с обычным периодическим PUT сериализуется через
     * _saveInFlight (дожидается in-flight, затем держит гард). Бросает ошибку
     * наверх БЕЗ собственного toast (решение об UX принимает StorageManager).
     * @param {number} actId
     * @param {{keepalive?: boolean}} [opts={}] - PERSIST-6: при keepalive:true
     *   (эскалация из beforeunload) запрос помечается keepalive, чтобы пережить
     *   закрытие вкладки — но только если тело влезает в лимит keepalive
     *   (KEEPALIVE_MAX_BODY_BYTES); тело крупнее уходит обычным fetch.
     * @returns {Promise<Object>} ответ PUT
     * @throws {Error|LockLostError}
     */
    static async forceSaveToDb(actId, { keepalive = false } = {}) {
        const username = AuthManager.getCurrentUser();
        if (!username) {
            throw new Error('Пользователь не авторизован');
        }
        // #11: сериализуемся с обычным (периодическим) PUT. Дожидаемся его
        // завершения, затем ДЕРЖИМ _saveInFlight на время своего PUT — новый
        // периодический saveActContent тогда сам себя пропустит (гард in-flight),
        // и два PUT не разъедутся на last-writer-wins без версии на сервере.
        while (APIClient._saveInFlight && APIClient._saveInFlightPromise) {
            try {
                await APIClient._saveInFlightPromise;
            } catch {
                /* чужой PUT упал — не наша забота, продолжаем аварийное сохранение */
            }
        }
        APIClient._saveInFlight = true;
        try {
            // PERSIST-4: та же эпоха грязности, что в saveActContent. Запоминаем
            // ДО сериализации; трекинг выключаем только вокруг синхронного
            // exportActData (flush активного редактора внутри него не должен
            // поднять эпоху — эти правки уходят в data). Без гейта
            // markAsSyncedWithDB хоронил бы символы, напечатанные во время PUT
            // (body уже собран exportActData) → потеря при reload.
            const epochBeforeSave = window.StorageManager.getDirtyEpoch();

            // flush+сериализация одной воронкой (B-16).
            window.StorageManager.disableTracking();
            let data;
            try {
                data = window.StorageManager.exportActData();
            } finally {
                window.StorageManager.enableTracking();
            }
            data.saveType = 'manual';
            data.changelog = window.ChangelogTracker ? window.ChangelogTracker.flush() : [];

            const body = JSON.stringify(data);
            // PERSIST-6: keepalive только если тело влезает в лимит — иначе
            // fetch с keepalive бросит синхронно. Крупное тело (типичный кейс
            // переполнения LS) уходит обычным fetch как best-effort.
            const bodyBytes = new Blob([body]).size;
            if (keepalive && bodyBytes > KEEPALIVE_MAX_BODY_BYTES) {
                // Без этого предупреждения деградация в обычный fetch молчалива —
                // о том, что аварийное сохранение не переживёт закрытие вкладки,
                // никто не узнаёт до потери правок.
                console.warn('Черновик больше 60КБ — сохранение при закрытии вкладки не гарантировано.');
            }
            const useKeepalive = keepalive && bodyBytes <= KEEPALIVE_MAX_BODY_BYTES;

            const resp = await this._fetchWithTimeout(
                AppConfig.api.getUrl(`/api/v1/acts/${actId}/content`),
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    ...(useKeepalive ? { keepalive: true } : {}),
                }
            );
            if (!resp.ok) {
                if (resp.status === 409) throw new LockLostError();
                throw new Error(`Аварийное сохранение в БД не удалось (HTTP ${resp.status})`);
            }
            const result = await resp.json();
            if (result?.updated_at) window.StorageManager.setBaseUpdatedAt(result.updated_at);
            // #5: PUT подтверждён — коммитим отложенный снимок аудита нарушений.
            window.ViolationAudit?.confirmSave?.();
            // PERSIST-4/A1: единый финал (эпоха-гейт синхронизации + снятие снимка
            // + гашение offline-машинерии). Eviction снимка живёт здесь, а не в
            // _escalateQuotaToDb — атомарно с гейтом (как в saveActContent).
            window.StorageManager.finalizeDbSave(actId, epochBeforeSave);
            return result;
        } catch (err) {
            // §6.8: аварийное сохранение в БД не удалось — фиксируем в телеметрии
            // редактора и пробрасываем (UX-решение принимает StorageManager).
            window.EditorTelemetry?.track?.('save_failure');
            throw err;
        } finally {
            APIClient._saveInFlight = false;
        }
    }

    /**
     * Удаляет акт из БД
     *
     * @param {number} actId - ID акта
     * @returns {Promise<void>}
     */
    static async deleteAct(actId) {
        const username = AuthManager.getCurrentUser();

        if (!username) {
            throw new Error('Пользователь не авторизован');
        }

        try {
            const resp = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/acts/${actId}`), {
                method: 'DELETE',
                headers: {}
            });

            if (!resp.ok) {
                if (resp.status === 403) {
                    throw new Error('Нет доступа к акту');
                } else if (resp.status === 404) {
                    throw new Error('Акт не найден');
                }
                throw new Error('Ошибка удаления акта');
            }

            const result = await resp.json();
            console.log('Акт удален из БД:', result);

            Notifications.success('Акт успешно удален');

        } catch (err) {
            console.error('Ошибка удаления акта:', err);
            Notifications.error(`Не удалось удалить акт: ${err.message}`);
            throw err;
        }
    }

    /**
     * Миграция: удаляет числовой префикс из label для item-узлов.
     * Нужна для обратной совместимости с данными, где label содержал номер.
     * @private
     * @param {Object} node - Узел дерева для обработки
     */
    static _migrateStripNumberFromLabels(node) {
        if (!node) return;

        if (node.children) {
            for (const child of node.children) {
                // Только для item-узлов (не table/textblock/violation)
                if (!child.type || child.type === AppConfig.nodeTypes.ITEM) {
                    const match = child.label?.match(/^\d+(?:\.\d+)*\.\s*(.+)$/);
                    if (match) {
                        child.label = match[1];
                    }
                }
                this._migrateStripNumberFromLabels(child);
            }
        }
    }

    /**
     * Привязывает фактуры из БД к соответствующим узлам дерева.
     * @private
     * @param {Object} node - Узел дерева
     * @param {Object} invoicesMap - Словарь фактур {node_id: invoice_data}
     */
    static _attachInvoicesToTree(node, invoicesMap) {
        if (!node) return;
        if (invoicesMap[node.id]) {
            const inv = invoicesMap[node.id];
            node.invoice = {
                db_type: inv.db_type,
                schema_name: inv.schema_name,
                table_name: inv.table_name,
                metrics: inv.metrics || [],
                process: inv.process || [],
                profile_div: inv.profile_div || null,
            };
        }
        if (node.children) {
            for (const child of node.children) {
                this._attachInvoicesToTree(child, invoicesMap);
            }
        }
    }

    // -----------------------------------------------------------------
    // Фактуры
    // -----------------------------------------------------------------

    /**
     * Загружает справочник метрик
     *
     * @returns {Promise<Array<{code: string, metric_name: string, metric_group: string|null}>>}
     */
    static async loadMetricDict() {

        const response = await this._fetchWithTimeout(
            AppConfig.api.getUrl('/api/v1/acts/invoice/metrics'),
            {
                headers: {}
            }
        );

        if (!response.ok) {
            await this._throwApiError(response);
        }

        return response.json();
    }

    /**
     * Загружает справочник процессов
     * @returns {Promise<Array<{process_code: string, process_name: string}>>}
     */
    static async loadProcessDict() {
        const response = await this._fetchWithTimeout(
            AppConfig.api.getUrl('/api/v1/acts/invoice/processes'),
            { headers: {} }
        );
        if (!response.ok) {
            await this._throwApiError(response);
        }
        return response.json();
    }

    /**
     * Загружает справочник подразделений
     * @returns {Promise<Array<{name: string}>>}
     */
    static async loadSubsidiaryDict() {
        const response = await this._fetchWithTimeout(
            AppConfig.api.getUrl('/api/v1/acts/invoice/subsidiaries'),
            { headers: {} }
        );
        if (!response.ok) {
            await this._throwApiError(response);
        }
        return response.json();
    }

    /**
     * Загружает полный список таблиц для фактуры
     *
     * @param {string} dbType - Тип БД ('hive' или 'greenplum')
     * @returns {Promise<Array<{table_name: string}>>}
     */
    static async loadInvoiceTables(dbType) {

        const response = await this._fetchWithTimeout(
            AppConfig.api.getUrl(`/api/v1/acts/invoice/tables/${dbType}`),
            {
                headers: {}
            }
        );

        if (!response.ok) {
            await this._throwApiError(response);
        }

        return response.json();
    }

    /**
     * Сохраняет фактуру (UPSERT по act_id + node_id)
     *
     * @param {Object} data - Данные фактуры
     * @param {AbortSignal} [signal] - Сигнал отмены запроса
     * @returns {Promise<Object>} Сохраненная фактура
     */
    static async saveInvoice(data, signal) {

        const response = await this._fetchWithTimeout(AppConfig.api.getUrl('/api/v1/acts/invoice/save'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
            signal,
        });

        if (!response.ok) {
            await this._throwApiError(response);
        }

        return response.json();
    }

    /**
     * Верификация фактуры (TODO-заглушка)
     *
     * @param {number} invoiceId - ID фактуры
     * @param {number} actId - ID акта для проверки доступа
     * @param {AbortSignal} [signal] - Сигнал отмены запроса
     * @returns {Promise<Object>} Результат верификации
     */
    static async verifyInvoice(invoiceId, actId, signal) {

        const response = await this._fetchWithTimeout(AppConfig.api.getUrl('/api/v1/acts/invoice/verify'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ invoice_id: invoiceId, act_id: actId }),
            signal,
        });

        if (!response.ok) {
            await this._throwApiError(response);
        }

        return response.json();
    }

    /**
     * Создает ошибку API.
     * Поля:
     *   - `status` — HTTP-статус ответа.
     *   - `code` — машинный код из envelope бэка (kebab-case, см. AppError.to_envelope).
     *     `null`, если ответ без envelope (timeout 408, non-JSON).
     *   - `extra` — словарь дополнительных полей envelope (locked_by, retry_after_sec и т.п.),
     *     `null`, если бэк его не прислал.
     * @private
     */
    static _createError(status, detail, code = null, extra = null) {
        const error = new Error(detail);
        error.status = status;
        error.code = code;
        error.extra = extra;
        return error;
    }

    /**
     * Обёртка fetch с таймаутом через AbortController.
     *
     * При истечении таймаута сам fetch падает с DOMException "AbortError";
     * вызывающие методы должны конвертировать его в _createError(408, ...).
     * Если в opts уже передан signal — уважаем его, не подменяя на свой
     * (комбинировать AbortSignal в браузере пока нельзя без полифилла,
     * пользовательский abort приоритетнее).
     *
     * Polling-вызовы чата (chat-stream.js) НЕ должны использовать
     * этот wrapper — у них свой жизненный цикл ожидания ответа.
     *
     * @param {string} url
     * @param {RequestInit} [opts={}]
     * @param {number} [timeoutMs=30000]
     * @returns {Promise<Response>}
     * @private
     */
    static async _fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
        if (opts.signal) {
            // Уже есть пользовательский AbortSignal — не оборачиваем.
            return fetch(url, opts);
        }
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        try {
            // Прямой нативный fetch — без рекурсии в _fetchWithTimeout.
            return await fetch(url, {...opts, signal: controller.signal});
        } catch (err) {
            // Если abort вызван таймером — переводим в стандартный 408.
            // AbortError name стабильный (DOM spec), code 20 — fallback для
            // старых браузеров.
            if (timedOut && (err?.name === 'AbortError' || err?.code === 20)) {
                throw this._createError(408, 'Превышено время ожидания ответа сервера');
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Парсит JSON-тело ответа и бросает ошибку API.
     * Безопасно обрабатывает не-JSON ответы (HTML-страницы ошибок и т.д.).
     * @private
     */
    static async _throwApiError(response, fallbackDetail) {
        let detail;
        let code = null;
        let extra = null;
        try {
            const body = await response.json();
            detail = body.detail;
            // Унифицированный error envelope из AppError.to_envelope():
            //   {detail: str, code: kebab-case-str, extra?: dict}.
            // `code`/`extra` есть только если бэк бросил AppError;
            // generic-ответы (timeout, не-AppError exception) приходят без них.
            if (typeof body.code === 'string') {
                code = body.code;
            }
            if (body.extra && typeof body.extra === 'object') {
                extra = body.extra;
            }
            // FastAPI 422 возвращает detail как массив ValidationError-объектов:
            // [{loc, msg, type, ...}, ...]. Без форматирования в UI прилетал
            // "[object Object]". Сворачиваем в человекочитаемую строку, msg
            // у pydantic-валидаторов уже на русском.
            detail = formatValidationDetail(detail);
        } catch {
            // Сервер вернул не-JSON ответ
        }
        throw this._createError(
            response.status,
            detail || fallbackDetail || `Ошибка сервера (${response.status})`,
            code,
            extra,
        );
    }

    /**
     * Показывает баннер режима только чтения
     * @private
     */
    static _showReadOnlyBanner() {
        // Проверяем, не показан ли уже баннер
        if (document.querySelector('.read-only-banner')) {
            return;
        }

        const banner = document.createElement('div');
        banner.className = 'read-only-banner';
        banner.innerHTML = `
            <span class="read-only-banner-icon">👁</span>
            <span class="read-only-banner-text">${AppConfig.readOnlyMode.messages.viewOnlyBanner}</span>
        `;

        // Вставляем баннер после header
        const header = document.querySelector('.header');
        if (header && header.nextSibling) {
            header.parentNode.insertBefore(banner, header.nextSibling);
        } else {
            document.body.insertBefore(banner, document.body.firstChild);
        }
    }

    /**
     * Загружает содержимое акта (raw JSON) без побочных эффектов.
     * Используется для diff-сравнения версий.
     * @param {number} actId
     * @returns {Promise<Object>}
     */
    static async loadActContentRaw(actId) {
        const resp = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/acts/${actId}/content`), {
            headers: {}
        });
        if (!resp.ok) throw this._createError(resp.status, `HTTP ${resp.status}`);
        return resp.json();
    }

    // -------------------------------------------------------------------------
    // АУДИТ-ЛОГ И ВЕРСИИ
    // -------------------------------------------------------------------------

    /**
     * Получает записи аудит-лога акта
     * @param {number} actId - ID акта
     * @param {Object} [params] - Параметры фильтрации
     * @returns {Promise<{items: Array, total: number}>}
     */
    static async getAuditLog(actId, { action, username, fromDate, toDate, limit = 50, offset = 0 } = {}) {
        const query = new URLSearchParams();
        if (action) query.set('action', action);
        if (username) query.set('username', username);
        if (fromDate) query.set('from_date', fromDate);
        if (toDate) query.set('to_date', toDate);
        query.set('limit', limit);
        query.set('offset', offset);

        const resp = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/acts/${actId}/audit-log?${query}`), {
            headers: {}
        });
        if (!resp.ok) throw this._createError(resp.status, 'Ошибка загрузки аудит-лога');
        return resp.json();
    }

    /**
     * Получает список версий содержимого акта
     * @param {number} actId - ID акта
     * @param {Object} [params] - Параметры пагинации
     * @returns {Promise<{items: Array, total: number}>}
     */
    static async getVersions(actId, { limit = 50, offset = 0 } = {}) {
        const resp = await this._fetchWithTimeout(
            AppConfig.api.getUrl(`/api/v1/acts/${actId}/versions?limit=${limit}&offset=${offset}`),
            { headers: {} }
        );
        if (!resp.ok) throw this._createError(resp.status, 'Ошибка загрузки версий');
        return resp.json();
    }

    /**
     * Получает полный снэпшот конкретной версии
     * @param {number} actId - ID акта
     * @param {number} versionId - ID версии
     * @returns {Promise<Object>}
     */
    static async getVersion(actId, versionId) {
        const resp = await this._fetchWithTimeout(
            AppConfig.api.getUrl(`/api/v1/acts/${actId}/versions/${versionId}`),
            { headers: {} }
        );
        if (!resp.ok) throw this._createError(resp.status, 'Ошибка загрузки версии');
        return resp.json();
    }

    /**
     * Восстанавливает содержимое акта из указанной версии
     * @param {number} actId - ID акта
     * @param {number} versionId - ID версии
     * @returns {Promise<Object>}
     */
    static async restoreVersion(actId, versionId) {
        const resp = await this._fetchWithTimeout(
            AppConfig.api.getUrl(`/api/v1/acts/${actId}/versions/${versionId}/restore`),
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw this._createError(resp.status, err.detail || 'Ошибка восстановления версии');
        }
        return resp.json();
    }

    // -------------------------------------------------------------------------
    // РОЛИ И АДМИНИСТРИРОВАНИЕ
    // -------------------------------------------------------------------------

    /**
     * Загружает роли текущего пользователя
     * @returns {Promise<{is_admin: boolean, roles: Array}>}
     */
    static async loadMyRoles() {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl('/api/v1/roles/my-roles'), {
            headers: {}
        });
        if (!response.ok) throw this._createError(response.status, 'Ошибка загрузки ролей');
        return response.json();
    }

    /**
     * Загружает список всех доступных ролей (для админ-панели)
     * @returns {Promise<Array<{id: number, name: string, description: string}>>}
     */
    static async loadAllRoles() {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl('/api/v1/admin/roles'), {
            headers: {}
        });
        if (!response.ok) throw this._createError(response.status, 'Ошибка загрузки ролей');
        const data = await response.json();
        return data.items || [];
    }

    /**
     * Загружает страницу справочника пользователей (для админ-панели).
     * Возвращает весь пагинированный ответ, чтобы вызывающий мог реализовать
     * подгрузку «Загрузить ещё» по total/offset.
     * @param {number} [limit=50] - размер страницы
     * @param {number} [offset=0] - смещение
     * @param {string} [q=''] - поиск по ФИО/логину/email (фильтр на стороне БД)
     * @returns {Promise<{items: Array, total: number, limit: number, offset: number}>}
     */
    static async loadUserDirectory(limit = 50, offset = 0, q = '') {
        const params = new URLSearchParams({ limit, offset });
        if (q) params.set('q', q);
        const url = AppConfig.api.getUrl(
            `/api/v1/admin/users/directory?${params.toString()}`
        );
        const response = await this._fetchWithTimeout(url, { headers: {} });
        if (!response.ok) throw this._createError(response.status, 'Ошибка загрузки справочника');
        const data = await response.json();
        return {
            items: data.items || [],
            total: data.total ?? (data.items || []).length,
            limit: data.limit ?? limit,
            offset: data.offset ?? offset,
        };
    }

    /**
     * Назначает роль пользователю
     * @param {string} targetUsername - Имя пользователя
     * @param {number} roleId - ID роли
     * @returns {Promise<Object>}
     */
    static async assignRole(targetUsername, roleId) {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/admin/users/${targetUsername}/roles`), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ role_id: roleId })
        });
        if (!response.ok) {
            await this._throwApiError(response);
        }
        return response.json();
    }

    /**
     * Снимает роль с пользователя
     * @param {string} targetUsername - Имя пользователя
     * @param {number} roleId - ID роли
     * @returns {Promise<Object>}
     */
    static async removeRole(targetUsername, roleId) {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/admin/users/${targetUsername}/roles/${roleId}`), {
            method: 'DELETE',
            headers: {}
        });
        if (!response.ok) {
            await this._throwApiError(response);
        }
        return response.json();
    }

    /**
     * Поиск пользователей в справочнике (для добавления в систему)
     * @param {string} query - Строка поиска (мин. 2 символа)
     * @param {AbortSignal} [signal] - Сигнал отмены запроса
     * @returns {Promise<Array<{username: string, fullname: string, job: string, email: string}>>}
     */
    static async searchUsers(query, signal) {
        const response = await this._fetchWithTimeout(
            AppConfig.api.getUrl(`/api/v1/admin/users/search?q=${encodeURIComponent(query)}`),
            { headers: {}, signal }
        );
        if (!response.ok) throw this._createError(response.status, 'Ошибка поиска пользователей');
        const data = await response.json();
        return data.items || [];
    }

    /**
     * Загружает актуальный список ролей пользователя (для повторной синхронизации
     * после неуспешного assign/remove — серверный rollback на app-уровне).
     * @param {string} targetUsername - Имя пользователя
     * @returns {Promise<{username: string, roles: Array<{id:number, name:string, code?:string}>}>}
     */
    static async getUserRoles(targetUsername) {
        const response = await fetch(
            AppConfig.api.getUrl(`/api/v1/admin/users/${targetUsername}/roles`),
            { headers: {} }
        );
        if (!response.ok) {
            await this._throwApiError(response);
        }
        return response.json();
    }

    /**
     * Поиск пользователей в справочнике для аудиторской группы
     * @param {string} query - Строка поиска (мин. 2 символа)
     * @returns {Promise<Array<{username: string, fullname: string, job: string}>>}
     */
    static async searchTeamUsers(query) {
        const response = await this._fetchWithTimeout(
            AppConfig.api.getUrl(`/api/v1/acts/users/search?q=${encodeURIComponent(query)}`),
            { headers: {} }
        );
        if (!response.ok) throw this._createError(response.status, 'Ошибка поиска пользователей');
        const data = await response.json();
        return data.items || [];
    }

    /**
     * Загружает состояние батчеров и фоновых задач (admin observability).
     * Возвращает снимок {batchers: {...}, background_tasks: {...}}.
     * @returns {Promise<{batchers: Object, background_tasks: Object}>}
     */
    static async loadDiagnostics() {
        const response = await fetch(AppConfig.api.getUrl('/api/v1/admin/diagnostics'), {
            headers: {}
        });
        if (!response.ok) await this._throwApiError(response);
        return response.json();
    }

    /**
     * Загружает журнал админ-операций с фильтрами и пагинацией.
     * @param {Object} [filters]
     * @param {string} [filters.action]
     * @param {string} [filters.targetUsername]
     * @param {string} [filters.adminUsername]
     * @param {string} [filters.fromDate] - YYYY-MM-DD
     * @param {string} [filters.toDate] - YYYY-MM-DD
     * @param {number} [filters.limit=50] - 1..200
     * @param {number} [filters.offset=0]
     * @returns {Promise<{items: Array, total: number}>}
     */
    static async loadAdminAuditLog({
        action,
        targetUsername,
        adminUsername,
        fromDate,
        toDate,
        limit = 50,
        offset = 0,
    } = {}) {
        const query = new URLSearchParams();
        if (action) query.set('action', action);
        if (targetUsername) query.set('target_username', targetUsername);
        if (adminUsername) query.set('admin_username', adminUsername);
        if (fromDate) query.set('from_date', fromDate);
        if (toDate) query.set('to_date', toDate);
        query.set('limit', String(limit));
        query.set('offset', String(offset));

        const response = await fetch(
            AppConfig.api.getUrl(`/api/v1/admin/audit-log?${query}`),
            { headers: {} }
        );
        if (!response.ok) await this._throwApiError(response);
        return response.json();
    }

    // ========================================================================
    // ЦК домены (Фин.Рез. / Клиентский опыт)
    // ========================================================================

    /**
     * Поиск записей валидации ЦК.
     * @param {string} prefix - 'ck-fin-res' или 'ck-client-exp'
     * @param {Object} filters - {start_date?, end_date?, metric_code?, process_code?}
     */
    static async searchCkRecords(prefix, filters = {}) {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/${prefix}/records/search`), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(filters)
        });
        if (!response.ok) await this._throwApiError(response);
        const json = await response.json();
        return json.items || [];
    }

    /**
     * Поиск записей ЦК с пагинацией/фильтрами/сортировкой — полный ответ.
     * @param {string} prefix - 'ck-fin-res' или 'ck-client-exp'
     * @param {Object} body - {filters, sort: [{by, dir}], limit, offset}
     * @returns {Promise<{items: Array, total: number}>}
     */
    static async searchCkRecordsPage(prefix, body = {}) {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/${prefix}/records/search`), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        if (!response.ok) await this._throwApiError(response);
        const json = await response.json();
        return { items: json.items || [], total: json.total || 0 };
    }

    /**
     * Групповое сохранение записи ЦК (общие поля + развертка по ТБ).
     * @param {string} prefix - 'ck-fin-res'
     * @param {Object} body - {group_key, expected_row_ids, common, breakdown}
     * @returns {Promise<{deactivated: number, inserted: number, skipped: number}>}
     */
    static async groupSaveCkRecords(prefix, body) {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/${prefix}/records/group-save`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) await this._throwApiError(response);
        return response.json();
    }

    /**
     * Групповое удаление записи ЦК (все строки группы).
     * @param {string} prefix - 'ck-fin-res'
     * @param {Object} body - {group_key, expected_row_ids}
     * @returns {Promise<{deleted: number}>}
     */
    static async groupDeleteCkRecord(prefix, body) {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/${prefix}/records/group-delete`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) await this._throwApiError(response);
        return response.json();
    }

    /**
     * Получить запись по ID.
     * @param {string} prefix - 'ck-fin-res' или 'ck-client-exp'
     * @param {number} id
     */
    static async getCkRecord(prefix, id) {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/${prefix}/records/${id}`), {
            headers: {}
        });
        if (!response.ok) await this._throwApiError(response);
        return response.json();
    }

    /**
     * Создать новую запись.
     * @param {string} prefix
     * @param {Object} data
     */
    static async createCkRecord(prefix, data) {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/${prefix}/records`), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        if (!response.ok) await this._throwApiError(response);
        return response.json();
    }

    /**
     * Пакетное обновление записей.
     * @param {string} prefix
     * @param {Array} items - [{id, ...fields}]
     */
    static async updateCkRecords(prefix, items) {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/${prefix}/records/batch-update`), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(items)
        });
        if (!response.ok) await this._throwApiError(response);
        return response.json();
    }

    /**
     * Мягкое удаление записи.
     * @param {string} prefix
     * @param {number} id
     */
    static async deleteCkRecord(prefix, id) {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/${prefix}/records/${id}`), {
            method: 'DELETE',
            headers: {}
        });
        if (!response.ok) await this._throwApiError(response);
        return response.json();
    }

    /**
     * Получить данные справочника.
     * @param {string} prefix
     * @param {string} name - 'processes', 'terbanks', 'metrics', 'departments', 'channels', 'products', 'teams'
     */
    static async getCkDictionary(prefix, name) {
        const response = await this._fetchWithTimeout(AppConfig.api.getUrl(`/api/v1/${prefix}/dictionaries/${name}`), {
            headers: {}
        });
        if (!response.ok) await this._throwApiError(response);
        const json = await response.json();
        return json.data;
    }
}

// Глобальный доступ
window.APIClient = APIClient;
