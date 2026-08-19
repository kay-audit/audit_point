/**
 * Менеджер диалоговых окон подтверждения
 *
 * Создает модальные окна для подтверждения действий и информирования пользователя.
 * Наследует базовый функционал от DialogBase.
 */
import { DialogBase } from './dialog-base.js';

export class DialogManager extends DialogBase {
    /**
     * Показывает диалоговое окно с подтверждением
     *
     * @param {Object} options - Параметры диалога
     * @param {string} [options.title='Подтверждение'] - Заголовок диалога
     * @param {string} [options.message='Вы уверены?'] - Текст сообщения
     * @param {string} [options.icon='⚠️'] - Иконка (эмодзи)
     * @param {string} [options.confirmText='Да'] - Текст кнопки подтверждения
     * @param {string} [options.cancelText='Отмена'] - Текст кнопки отмены
     * @param {string} [options.type='warning'] - Тип диалога (success, warning, error, info)
     * @param {boolean} [options.hideCancel=false] - Скрыть кнопку отмены (одна кнопка, любое закрытие = true)
     * @param {boolean} [options.hideConfirm=false] - Скрыть кнопку подтверждения
     * @param {boolean} [options.allowEscape=true] - Разрешить закрытие по Escape
     * @param {boolean} [options.allowOverlayClose=true] - Разрешить закрытие кликом вне диалога
     * @param {*} [options.escapeResult] - Результат резолва при закрытии Escape/кликом вне
     *                                     диалога ВМЕСТО дефолтного (false, при hideCancel —
     *                                     true). Позволяет вызывающей стороне отличить
     *                                     случайное закрытие от явной кнопки отмены
     *                                     (например, диалог конфликта черновика не должен
     *                                     удалять снимок по Escape).
     * @param {Function} [options.onMount] - Колбэк, синхронно вызываемый сразу после добавления overlay в DOM.
     *                                       Получает overlay-элемент и close-handle: `({ overlay, close })`.
     *                                       `close(result)` программно закрывает диалог и резолвит промис.
     *                                       Используйте вместо `querySelector('.custom-dialog-overlay:last-child')` — без race.
     * @returns {Promise<boolean|*>} Promise: true при подтверждении, false при отмене кнопкой,
     *                               escapeResult (если задан) при Escape/клике вне диалога
     */
    static show(options = {}) {
        const {
            title = 'Подтверждение',
            message = 'Вы уверены?',
            icon = '⚠️',
            confirmText = 'Да',
            cancelText = 'Отмена',
            type = 'warning',
            hideCancel = false,
            hideConfirm = false,
            allowEscape = true,
            allowOverlayClose = true,
            escapeResult = undefined,
            onMount = null
        } = options;

        return new Promise((resolve) => {
            // Создаем overlay и диалог
            const overlay = this._createOverlay();
            const dialog = this._createConfirmDialog({
                title,
                message,
                icon,
                confirmText,
                cancelText,
                type,
                hideCancel,
                hideConfirm,
                onConfirm: () => {
                    this._closeAndResolve(overlay, resolve, true);
                },
                onCancel: () => {
                    this._closeAndResolve(overlay, resolve, false);
                }
            });

            overlay.appendChild(dialog);

            // Находим внутренний диалог для правильной обработки кликов
            const dialogElement = overlay.querySelector('.custom-dialog');

            // Показываем диалог
            this._showDialog(overlay);

            // Колбэк монтирования: передаём overlay и программный close.
            // Вызываем СИНХРОННО после _showDialog — overlay уже в DOM, race с querySelector исключён.
            if (typeof onMount === 'function') {
                const close = (result = false) => {
                    this._closeAndResolve(overlay, resolve, result);
                };
                try {
                    onMount({ overlay, close });
                } catch (e) {
                    console.error('DialogManager.show.onMount error:', e);
                }
            }

            // Определяем результат при закрытии Esc/overlay
            // escapeResult задан -> он и возвращается (вызывающая сторона
            //   отличает случайное закрытие от явной кнопки отмены)
            // hideCancel=true -> закрытие возвращает true (как подтверждение)
            // hideCancel=false -> закрытие возвращает false (отмена)
            const closeResult = escapeResult !== undefined
                ? escapeResult
                : (hideCancel ? true : false);

            // Настраиваем закрытие по клику вне диалога (если разрешено)
            if (allowOverlayClose) {
                this._setupOverlayClickHandler(overlay, dialogElement, () => {
                    this._closeAndResolve(overlay, resolve, closeResult);
                });
            }

            // Закрытие по Escape (если разрешено)
            if (allowEscape) {
                this._setupEscapeHandler(overlay, () => {
                    this._closeAndResolve(overlay, resolve, closeResult);
                });
            }
        });
    }

    /**
     * Закрывает диалог и резолвит промис
     * @private
     * @param {HTMLElement} overlay - Элемент overlay
     * @param {Function} resolve - Функция resolve промиса
     * @param {boolean} result - Результат для resolve
     */
    static _closeAndResolve(overlay, resolve, result) {
        this._removeEscapeHandler(overlay);
        this._hideDialog(overlay);
        resolve(result);
    }

    /**
     * Создает диалоговое окно подтверждения
     * @private
     * @param {Object} params - Параметры диалога
     * @param {string} params.title - Заголовок
     * @param {string} params.message - Сообщение
     * @param {string} params.icon - Иконка
     * @param {string} params.confirmText - Текст кнопки подтверждения
     * @param {string} params.cancelText - Текст кнопки отмены
     * @param {string} params.type - Тип диалога
     * @param {boolean} params.hideCancel - Скрыть кнопку отмены
     * @param {boolean} params.hideConfirm - Скрыть кнопку подтверждения
     * @param {Function} params.onConfirm - Обработчик подтверждения
     * @param {Function} params.onCancel - Обработчик отмены
     * @returns {HTMLElement} Элемент диалога
     */
    static _createConfirmDialog(params) {
        const {
            title,
            message,
            icon,
            confirmText,
            cancelText,
            type,
            hideCancel,
            hideConfirm,
            onConfirm,
            onCancel
        } = params;

        const dialog = document.createElement('div');
        dialog.className = 'custom-dialog';

        // Иконка с типом
        const iconEl = this._createElement('div', `dialog-icon ${type}`, icon);

        // Заголовок
        const titleEl = this._createElement('h3', 'dialog-title', title);

        // Сообщение
        const messageEl = this._createElement('p', 'dialog-message', message);

        // Собираем диалог
        dialog.appendChild(iconEl);
        dialog.appendChild(titleEl);
        dialog.appendChild(messageEl);

        // Контейнер кнопок (создаём только если есть хотя бы одна кнопка)
        if (!hideCancel || !hideConfirm) {
            const buttonsContainer = this._createButtonsContainer(
                confirmText,
                cancelText,
                hideCancel,
                hideConfirm,
                onConfirm,
                onCancel
            );
            dialog.appendChild(buttonsContainer);
        }

        return dialog;
    }

    /**
     * Создает контейнер с кнопками
     * @private
     * @param {string} confirmText - Текст кнопки подтверждения
     * @param {string} cancelText - Текст кнопки отмены
     * @param {boolean} hideCancel - Скрыть кнопку отмены
     * @param {boolean} hideConfirm - Скрыть кнопку подтверждения
     * @param {Function} onConfirm - Обработчик подтверждения
     * @param {Function} onCancel - Обработчик отмены
     * @returns {HTMLElement} Контейнер с кнопками
     */
    static _createButtonsContainer(confirmText, cancelText, hideCancel, hideConfirm, onConfirm, onCancel) {
        const container = document.createElement('div');
        container.className = 'dialog-buttons';

        // Кнопка отмены (если не скрыта)
        if (!hideCancel) {
            const cancelBtn = this._createButton('btn btn-secondary dialog-cancel', cancelText, onCancel);
            container.appendChild(cancelBtn);
        }

        // Кнопка подтверждения (если не скрыта)
        if (!hideConfirm) {
            const confirmBtn = this._createButton('btn btn-primary dialog-confirm', confirmText, onConfirm);
            container.appendChild(confirmBtn);
        }

        return container;
    }

    /**
     * Показывает информационное сообщение (без кнопки отмены)
     * @param {Object} options - Параметры диалога
     * @param {string} [options.title='Информация'] - Заголовок
     * @param {string} [options.message] - Сообщение
     * @param {string} [options.icon='ℹ️'] - Иконка
     * @param {string} [options.confirmText='ОК'] - Текст кнопки
     * @param {string} [options.type='info'] - Тип диалога
     * @param {boolean} [options.allowEscape=true] - Разрешить закрытие по Escape
     * @param {boolean} [options.allowOverlayClose=true] - Разрешить закрытие кликом вне диалога
     * @returns {Promise<boolean>} Promise, который всегда резолвится true
     */
    static alert(options = {}) {
        const {
            title = 'Информация',
            message = '',
            icon = 'ℹ️',
            confirmText = 'ОК',
            type = 'info',
            allowEscape = true,
            allowOverlayClose = true
        } = options;

        return new Promise((resolve) => {
            const overlay = this._createOverlay();
            const dialog = this._createAlertDialog({
                title,
                message,
                icon,
                confirmText,
                type,
                onConfirm: () => {
                    this._closeAndResolve(overlay, resolve, true);
                }
            });

            overlay.appendChild(dialog);

            const dialogElement = overlay.querySelector('.custom-dialog');

            this._showDialog(overlay);

            if (allowOverlayClose) {
                this._setupOverlayClickHandler(overlay, dialogElement, () => {
                    this._closeAndResolve(overlay, resolve, true);
                });
            }

            if (allowEscape) {
                this._setupEscapeHandler(overlay, () => {
                    this._closeAndResolve(overlay, resolve, true);
                });
            }
        });
    }

    /**
     * Создает диалоговое окно-оповещение (только одна кнопка)
     * @private
     */
    static _createAlertDialog(params) {
        const {title, message, icon, confirmText, type, onConfirm} = params;

        const dialog = document.createElement('div');
        dialog.className = 'custom-dialog';

        const iconEl = this._createElement('div', `dialog-icon ${type}`, icon);
        const titleEl = this._createElement('h3', 'dialog-title', title);
        const messageEl = this._createElement('p', 'dialog-message', message);

        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'dialog-buttons';
        const confirmBtn = this._createButton('btn btn-primary dialog-confirm', confirmText, onConfirm);
        buttonsContainer.appendChild(confirmBtn);

        dialog.appendChild(iconEl);
        dialog.appendChild(titleEl);
        dialog.appendChild(messageEl);
        dialog.appendChild(buttonsContainer);

        return dialog;
    }
}

// Глобальный доступ
window.DialogManager = DialogManager;
