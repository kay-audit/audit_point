/**
 * Менеджер системы помощи и инструкций.
 *
 * Содержимое helpModal лежит статически в шаблоне (не клонируется). Показ/скрытие
 * идёт через DialogBase._showDialog/_hideDialog с opt'ом appendToBody=false —
 * единый стек _activeDialogs, focus-trap, aria-modal, EscapeStack и
 * _previousFocus работают так же, как для остальных диалогов.
 */
import { AppState } from '../state/state-core.js';
import { AppConfig } from '../../shared/app-config.js';
import { DialogBase } from '../../shared/dialog/dialog-base.js';
import { Notifications } from '../../shared/notifications.js';

export class HelpManager extends DialogBase {
    /** Сохранённые позиции прокрутки по номеру шага */
    static _scrollPositions = {};

    static init() {
        try {
            const elements = this._getElements();

            if (!this._validateElements(elements)) {
                console.warn('HelpManager: не удалось найти все необходимые элементы DOM');
                return;
            }

            this._setupEventHandlers(elements);
            this.updateTooltip();
        } catch (error) {
            console.error(`Ошибка инициализации HelpManager: ${error.message}`);
        }
    }

    static _getElements() {
        return {
            helpBtn: document.getElementById('helpBtn'),
            modal: document.getElementById('helpModal'),
            closeBtn: document.getElementById('closeHelpModalBtn')
        };
    }

    static _validateElements(elements) {
        return !!(elements.helpBtn && elements.modal);
    }

    static _setupEventHandlers(elements) {
        const {helpBtn, modal, closeBtn} = elements;

        helpBtn.addEventListener('click', () => this.show());

        const modalBody = modal.querySelector('.help-modal-body');
        if (modalBody) {
            modalBody.addEventListener('scroll', () => {
                if (!modal.classList.contains('hidden')) {
                    const step = AppState.currentStep || 1;
                    this._scrollPositions[step] = modalBody.scrollTop;
                }
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }

        this._setupOverlayClickHandler(modal, modal.querySelector('.help-modal-content'), () => this.hide());
        this._setupEscapeHandler(modal, () => this.hide());
    }

    static show() {
        try {
            const currentStep = AppState.currentStep || 1;
            const elements = this._getModalElements();

            if (!elements) return;

            const contentId = AppConfig.help.contentIds[currentStep];
            const contentElement = document.getElementById(contentId);

            if (!contentElement) {
                if (typeof Notifications !== 'undefined') {
                    Notifications.info(`Помощь отсутствует для шага ${currentStep}`);
                }
                return;
            }

            this._updateModalContent(elements, currentStep, contentElement.innerHTML);

            elements.modal.classList.remove('hidden');
            this._showDialog(elements.modal, {appendToBody: false});

            this._restoreScrollPosition(elements.modal, currentStep);
        } catch (error) {
            console.error(`Ошибка показа помощи: ${error.message}`);
            if (typeof Notifications !== 'undefined') {
                Notifications.error(`Ошибка показа помощи: ${error.message}`);
            }
        }
    }

    static _getModalElements() {
        const modal = document.getElementById('helpModal');
        const title = document.getElementById('helpModalTitle');
        const body = document.getElementById('helpModalBody');

        if (!modal || !title || !body) {
            console.warn('HelpManager: структура модального окна неполная');
            return null;
        }

        return {modal, title, body};
    }

    static _updateModalContent(elements, step, content) {
        const title = AppConfig.help.titles[step] || 'Инструкция';
        elements.title.textContent = title;
        elements.body.innerHTML = content;
    }

    static _restoreScrollPosition(modal, step) {
        const modalBody = modal.querySelector('.help-modal-body');
        if (!modalBody) return;
        const savedPosition = this._scrollPositions[step] || 0;
        requestAnimationFrame(() => {
            modalBody.style.scrollBehavior = 'auto';
            modalBody.scrollTop = savedPosition;
            requestAnimationFrame(() => {
                modalBody.style.scrollBehavior = '';
            });
        });
    }

    static hide() {
        const modal = document.getElementById('helpModal');
        if (!modal) return;
        this._hideDialog(modal);
    }

    static updateTooltip() {
        const helpBtn = document.getElementById('helpBtn');
        if (!helpBtn) return;

        const currentStep = AppState.currentStep || 1;
        const stepName = AppConfig.help.stepNames[currentStep] || 'Неизвестно';

        helpBtn.title = `Инструкция: Шаг ${currentStep} - ${stepName}`;
    }
}

window.HelpManager = HelpManager;
