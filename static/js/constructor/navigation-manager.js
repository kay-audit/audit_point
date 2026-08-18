/**
 * Менеджер навигации между шагами
 *
 * Управляет переходами между шагами конструктора,
 * обработкой кнопок навигации и валидацией данных перед сохранением.
 */
import { App } from './app.js';
import { FormatMenuManager } from './header/format-menu-manager.js';
import { StorageManager } from './storage-manager.js';
import { ValidationAct } from './validation/validation-act.js';
import { ValidationTable } from './validation/validation-table.js';
import { APIClient, ContentConflictError, LockLostError } from '../shared/api.js';
import { AppConfig } from '../shared/app-config.js';
import { Notifications } from '../shared/notifications.js';

export class NavigationManager {
    /** Гард от повторного запуска «сохранить и скачать» во время выполнения. */
    static _actionInFlight = false;

    /**
     * Настройка обработчиков навигации
     */
    static setup() {
        this._setupHeaderNavigation();
    }

    /**
     * Настройка навигации через клик по заголовкам шагов
     * @private
     */
    static _setupHeaderNavigation() {
        const header = document.querySelector('.header');
        header?.querySelectorAll('.step').forEach(step => {
            step.addEventListener('click', () => {
                const stepNum = parseInt(step.dataset.step);
                App.goToStep(stepNum);
            });
        });
    }

    /**
     * Сохранение акта и экспорт выбранных форматов — действие кнопки-индикатора
     * в шапке и горячей клавиши Ctrl+Shift+S. Всегда сохраняем в БД (если есть
     * что синхронизировать), затем генерируем и скачиваем выбранные в настройках
     * форматы. Read-only: в БД не пишем — доступно только скачивание файлов.
     */
    static async saveAndExport() {
        return this._runSave(true);
    }

    /**
     * Быстрое сохранение акта в БД без экспорта — горячая клавиша Ctrl+S.
     * В режиме просмотра — no-op с уведомлением (запись в БД недоступна).
     */
    static async saveToDatabase() {
        return this._runSave(false);
    }

    /**
     * Общая воронка сохранения для Ctrl+S (withExport=false) и Ctrl+Shift+S /
     * кнопки-индикатора (withExport=true). Единый гард от повторного запуска,
     * read-only-ветка и dirty-гейт сохранения в БД — для обеих точек входа.
     * @private
     * @param {boolean} withExport - генерировать и скачивать выбранные форматы
     */
    static async _runSave(withExport) {
        // Проверка наличия выбранного акта
        if (!window.currentActId) {
            Notifications.warning('Сначала выберите акт');
            return;
        }

        // Гард от повторного запуска, пока предыдущий save/export не завершился.
        if (this._actionInFlight) return;

        // Коммитим зависшие правки (textblock в debounce, ячейка таблицы) ДО
        // валидации, чтения exportData() и проверки dirty-состояния. Save/export-
        // методы api.js флашат повторно (идемпотентно), но валидация и dirty-гейт
        // ниже тоже читают state.
        StorageManager._flushPendingEdits();

        const isReadOnly = !!AppConfig.readOnlyMode?.isReadOnly;
        const formats = withExport ? FormatMenuManager.getSelectedFormats() : [];

        // Read-only: сохранять в БД нельзя ни на одной точке входа.
        if (isReadOnly) {
            if (!withExport) {
                // Ctrl+S в режиме просмотра — сохранять нечего и некуда.
                Notifications.warning(AppConfig.readOnlyMode.messages.cannotSave);
                return;
            }
            // Ctrl+Shift+S / кнопка: доступно только скачивание выбранных форматов.
            if (formats.length === 0) {
                Notifications.warning('Выберите формат экспорта в настройках');
                return;
            }
            if (!this._validateForExport()) return;

            this._actionInFlight = true;
            try {
                await this._exportFiles(formats);
            } catch (error) {
                this._handleSaveExportError(error);
            } finally {
                this._actionInFlight = false;
            }
            return;
        }

        // Предупреждения о незаполненности (пустые таблицы, ТБ) — всегда,
        // не блокируют (#8: WIP-акт сохраняется в БД как есть).
        this._showContentWarnings();

        // Экспорт в файл требует валидной структуры: сломанная структура даёт
        // битый документ. Сохранение в БД эту проверку НЕ проходит (#8).
        if (formats.length > 0 && !this._validateForExport()) return;

        this._actionInFlight = true;
        try {
            // 1. Сохранение в БД — всегда. Ручной save persist'ит ТЕКУЩЕЕ
            // состояние, включая только что закоммиченные pending-правки (H5-A:
            // ячейка/textblock в редактировании). Гейтить по dirty-флагу нельзя —
            // он под-репортит такие правки, и save молча потерял бы их (PUT
            // читает exportActData(), а не флаг).
            await this._saveToDatabase();

            // 2. Экспорт файлов (если в настройках выбраны форматы).
            if (formats.length > 0) {
                await this._exportFiles(formats);
            } else if (withExport) {
                // Сняты все галочки форматов: в БД сохранили, а скачивать нечего.
                // Молчать нельзя — отсутствие файлов выглядит как сбой сохранения.
                // Ctrl+S сюда не попадает: у него formats пуст по построению.
                Notifications.warning('Выберите формат экспорта в настройках');
            }
        } catch (error) {
            this._handleSaveExportError(error);
        } finally {
            this._actionInFlight = false;
        }
    }

    /**
     * Сохранение в базу данных
     * @private
     */
    static async _saveToDatabase() {
        try {
            await APIClient.saveActContent(window.currentActId, { saveType: 'manual' });
            // Уведомление уже показано в APIClient.saveActContent
        } catch (err) {
            console.error('Ошибка сохранения в БД:', err);
            throw err; // Пробрасываем ошибку выше
        }
    }

    /**
     * Единая обработка ошибки сохранения/экспорта.
     *
     * LockLostError (лок снят, 409): save НЕ прошёл — изменения НЕ записаны в БД.
     * Ставим ОТДЕЛЬНЫЙ флаг `sessionLockLost` (не `sessionAutoExited`, у которого
     * плашка лжёт «изменения сохранены») и жёстко редиректим на список актов.
     * Черновик в localStorage НЕ трогаем — он остаётся последним носителем
     * несохранённых правок. Прочие ошибки — уведомление.
     * @private
     */
    static _handleSaveExportError(error) {
        if (error instanceof ContentConflictError) {
            // Конфликт версий (409 content-conflict на ручном save): единое
            // честное уведомление + остановка обречённых авто-PUT — через общий
            // обработчик StorageManager. Generic-тост «Произошла ошибка» здесь
            // лгал бы недосказанностью (правки живы, в локальном черновике).
            console.warn('[NavigationManager] ContentConflictError на save → честное уведомление, авто-PUT остановлены');
            StorageManager.handleContentConflict(error);
            return;
        }
        if (typeof LockLostError !== 'undefined' && error instanceof LockLostError) {
            console.warn('[NavigationManager] LockLostError на save → редирект на список актов (изменения НЕ в БД)');
            sessionStorage.setItem('sessionLockLost', 'true');
            // Снимаем браузерный beforeunload-warning. allowUnload() НЕ чистит
            // localStorage — только ставит флаг программного выхода, так что
            // локальный черновик сохраняется.
            if (typeof StorageManager !== 'undefined' && typeof StorageManager.allowUnload === 'function') {
                StorageManager.allowUnload();
            }
            // Жёсткий редирект без confirmNavigation: save вернул 409,
            // markAsSyncedWithDB не вызвался, hasUnsavedChanges=true →
            // confirmNavigation показал бы плашку «Несохранённые изменения. Уйти?»
            // и блокировал бы навигацию. Сессия уже завершена — спрашивать поздно.
            window.location.href = AppConfig.api.getUrl('/acts');
            return;
        }
        console.error('Ошибка при обработке:', error);
        Notifications.error(
            `Произошла ошибка: ${error.message}`,
            AppConfig.notifications.duration.error
        );
    }

    /**
     * Экспорт файлов в выбранных форматах
     * @private
     * @param {string[]} formats - Массив форматов для экспорта
     */
    static async _exportFiles(formats) {
        try {
            await APIClient.generateAct(formats);
            // Уведомления показаны в APIClient.generateAct
        } catch (err) {
            console.error('Ошибка экспорта файлов:', err);
            throw err; // Пробрасываем ошибку выше
        }
    }

    /**
     * Валидация структуры акта
     * @private
     * @returns {boolean} true если валидация прошла успешно
     */
    static _validateStructure() {
        const result = ValidationAct.validateStructure();
        if (!result.valid) {
            Notifications.error(
                result.message,
                AppConfig.notifications.duration.error
            );
            return false;
        }
        return true;
    }

    /**
     * Валидация ПЕРЕД ЭКСПОРТОМ в файл: только error-уровень (структура +
     * заголовки таблиц). Сломанная структура даёт битый документ — экспорт
     * блокируем. Сохранение в БД эту проверку НЕ проходит (#8).
     * @private
     * @returns {boolean} true если структура пригодна для экспорта
     */
    static _validateForExport() {
        if (!this._validateStructure()) return false;
        const headerCheckResult = ValidationTable.validateHeaders();
        if (!headerCheckResult.valid) {
            Notifications.error(
                headerCheckResult.message,
                AppConfig.notifications.duration.warning
            );
            return false;
        }
        return true;
    }

    /**
     * Показывает НЕблокирующие предупреждения о незаполненности (пустые
     * таблицы, не назначенные ТБ). Сохранение не прерывается.
     * @private
     */
    static _showContentWarnings() {
        const dataCheckResult = ValidationTable.validateData();
        if (dataCheckResult.isWarning) {
            Notifications.show(
                dataCheckResult.message,
                'warning',
                AppConfig.notifications.duration.warning
            );
        }
        const tbCheckResult = ValidationAct.validateTb();
        if (tbCheckResult.isWarning) {
            Notifications.show(
                tbCheckResult.message,
                'warning',
                AppConfig.notifications.duration.warning
            );
        }
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.NavigationManager = NavigationManager;
