/**
 * Менеджер меню настроек приложения
 *
 * Управляет отображением и поведением меню настроек
 * и сохраняет изменения настроек в localStorage.
 */
import { EscapeStack } from '../../shared/escape-stack.js';

export class SettingsMenuManager {
    /** @private Состояние настроек приложения */
    static _state = {
        showActHeader: true
    };

    /** Общий ключ localStorage для баз знаний (синхронизация с порталом) */
    static _kbStorageKey = 'assistant_knowledge_bases';

    /** Ключ localStorage для режима ОАРБ */
    static _oarbModeKey = 'assistant_oarb_mode';

    /** Допустимые значения режима ОАРБ */
    static _validOarbModes = ['off', 'adaptive', 'always'];

    /** Ключ localStorage для режима сравнения корректора текста */
    static _correctorDiffModeKey = 'corrector_diff_mode';

    /** Допустимые режимы сравнения корректора: в строку / 2 окна / 3 окна */
    static _validCorrectorDiffModes = ['inline', 'panes2', 'panes3'];

    /** @type {string[]} Ключи баз знаний (загружаются из DOM) */
    static _kbKeys = [];

    /** @type {Object<string, boolean>} Состояние баз знаний */
    static _kbState = {};

    /**
     * Инициализирует меню настроек и подключает обработчики событий
     */
    static setup() {
        const btn = document.getElementById('settingsMenuBtn');
        const menu = document.getElementById('settingsMenu');
        const closeBtn = document.getElementById('closeSettingsMenuBtn');
        const showActHeaderToggle = document.getElementById('showActHeaderToggle');

        // Показ/скрытие меню при клике на кнопку
        btn?.addEventListener('click', e => {
            e.stopPropagation();
            this.toggle();
        });

        // Закрытие меню кнопкой крестика
        closeBtn?.addEventListener('click', () => {
            this.hide();
        });

        // Скрытие меню при клике вне его области
        document.addEventListener('click', e => {
            if (!menu?.contains(e.target) && !btn?.contains(e.target)) {
                this.hide();
            }
        });

        // Предотвращаем закрытие при клике внутри меню
        menu?.addEventListener('click', e => e.stopPropagation());

        // Закрытие по Escape — через EscapeStack (push в show, unsub в hide).

        // Обработчик переключения отображения шапки акта
        showActHeaderToggle?.addEventListener('change', () => {
            this._state.showActHeader = showActHeaderToggle.checked;
            this._saveSettings();
            if (window.PreviewManager?.update) window.PreviewManager.update();
        });

        // Загрузка и применение сохраненных настроек
        this._loadSettings();
        if (showActHeaderToggle) showActHeaderToggle.checked = this._state.showActHeader;

        // Базы знаний AI-ассистента (загружаем ключи из DOM, общий localStorage с порталом)
        this._loadKbKeysFromDOM();
        this._loadKbState();
        this._applyKbState();
        this._setupKbToggles();
        this._applyOarbMode();
        this._setupOarbModeSelect();
        this._applyCorrectorDiffMode();
        this._setupCorrectorDiffModeSelect();
    }

    /**
     * Показывает меню настроек
     */
    static show() {
        const menu = document.getElementById('settingsMenu');
        const btn = document.getElementById('settingsMenuBtn');

        if (menu) {
            menu.classList.remove('hidden');
        }
        if (btn) {
            btn.classList.add('active');
        }
        if (!this._escapeUnsub) {
            this._escapeUnsub = EscapeStack.push(() => this.hide());
        }
    }

    /**
     * Скрывает меню настроек
     */
    static hide() {
        const menu = document.getElementById('settingsMenu');
        const btn = document.getElementById('settingsMenuBtn');

        if (menu) {
            menu.classList.add('hidden');
        }
        if (btn) {
            btn.classList.remove('active');
        }
        if (this._escapeUnsub) {
            this._escapeUnsub();
            this._escapeUnsub = null;
        }
    }

    /**
     * Переключает видимость меню настроек
     */
    static toggle() {
        const menu = document.getElementById('settingsMenu');
        if (menu && menu.classList.contains('hidden')) {
            this.show();
        } else {
            this.hide();
        }
    }

    /**
     * Возвращает копию текущих настроек приложения.
     *
     * Копия, а не сам `_state`: внешний код (предпросмотр) только читает флаги
     * и не должен мутировать приватное состояние в обход `_saveSettings`.
     * @returns {{showActHeader: boolean}}
     */
    static getSettings() {
        return {...this._state};
    }

    /**
     * Сохраняет текущие настройки в localStorage
     * @private
     */
    static _saveSettings() {
        localStorage.setItem('app_settings', JSON.stringify(this._state));
    }

    /**
     * Загружает сохраненные настройки из localStorage
     * @private
     */
    static _loadSettings() {
        const saved = localStorage.getItem('app_settings');
        if (saved) {
            try {
                this._state = {...this._state, ...JSON.parse(saved)};
            } catch (e) {
                console.error('Ошибка загрузки настроек:', e);
            }
        }
    }

    /**
     * Загружает ключи баз знаний из data-атрибутов DOM-элементов.
     * Пропускает ОАРБ (управляется отдельным селектом) и задизейбленные опции.
     * @private
     */
    static _loadKbKeysFromDOM() {
        this._kbKeys = [];
        this._kbState = {};

        const options = document.querySelectorAll('.settings-option[data-kb-key]');
        for (const opt of options) {
            const key = opt.dataset.kbKey;
            // ОАРБ — режимный контрол, не чекбокс; задизейбленные — read-only
            if (key && key !== 'knowledge_base_oarb' && !opt.classList.contains('settings-option--disabled')) {
                this._kbKeys.push(key);
                this._kbState[key] = false;
            }
        }
    }

    /**
     * Читает режим ОАРБ из localStorage
     * @returns {'off'|'adaptive'|'always'}
     * @private
     */
    static _getOarbMode() {
        const val = localStorage.getItem(this._oarbModeKey);
        return this._validOarbModes.includes(val) ? val : 'always';
    }

    /**
     * Синхронизирует сегмент-контрол режима ОАРБ с localStorage
     * @private
     */
    static _applyOarbMode() {
        const mode = this._getOarbMode();
        const btns = document.querySelectorAll('[data-oarb-mode] [data-oarb-mode-option]');
        for (const btn of btns) {
            btn.setAttribute('aria-pressed', String(btn.dataset.oarbModeOption === mode));
        }
    }

    /**
     * Обработчики клика по кнопкам сегмент-контрола режима ОАРБ
     * @private
     */
    static _setupOarbModeSelect() {
        const btns = document.querySelectorAll('[data-oarb-mode] [data-oarb-mode-option]');
        for (const btn of btns) {
            btn.addEventListener('click', () => {
                const val = btn.dataset.oarbModeOption;
                try {
                    localStorage.setItem(this._oarbModeKey, val);
                } catch (e) {
                    console.warn('SettingsMenuManager: не удалось сохранить режим ОАРБ', e);
                }
                this._applyOarbMode();
            });
        }
    }

    /**
     * Читает режим сравнения корректора из localStorage.
     * @returns {'inline'|'panes2'|'panes3'}
     */
    static getCorrectorDiffMode() {
        const val = localStorage.getItem(this._correctorDiffModeKey);
        return this._validCorrectorDiffModes.includes(val) ? val : 'panes2';
    }

    /**
     * Синхронизирует сегмент-контрол режима сравнения с localStorage
     * @private
     */
    static _applyCorrectorDiffMode() {
        const mode = this.getCorrectorDiffMode();
        const btns = document.querySelectorAll('[data-corrector-diff-mode] [data-corrector-diff-option]');
        for (const btn of btns) {
            btn.setAttribute('aria-pressed', String(btn.dataset.correctorDiffOption === mode));
        }
    }

    /**
     * Обработчики клика по кнопкам сегмент-контрола режима сравнения
     * @private
     */
    static _setupCorrectorDiffModeSelect() {
        const btns = document.querySelectorAll('[data-corrector-diff-mode] [data-corrector-diff-option]');
        for (const btn of btns) {
            btn.addEventListener('click', () => {
                const val = btn.dataset.correctorDiffOption;
                try {
                    localStorage.setItem(this._correctorDiffModeKey, val);
                } catch (e) {
                    console.warn('SettingsMenuManager: не удалось сохранить режим сравнения', e);
                }
                this._applyCorrectorDiffMode();
            });
        }
    }

    /**
     * Загружает состояние баз знаний из общего localStorage
     * @private
     */
    static _loadKbState() {
        try {
            const data = localStorage.getItem(this._kbStorageKey);
            if (!data) return;

            const saved = JSON.parse(data);
            if (saved && typeof saved === 'object') {
                for (const key of this._kbKeys) {
                    if (typeof saved[key] === 'boolean') {
                        this._kbState[key] = saved[key];
                    }
                }
            }
        } catch (e) {
            console.warn('SettingsMenuManager: не удалось загрузить настройки баз знаний', e);
        }
    }

    /**
     * Сохраняет состояние баз знаний в общий localStorage
     * @private
     */
    static _saveKbState() {
        try {
            localStorage.setItem(this._kbStorageKey, JSON.stringify(this._kbState));
        } catch (e) {
            console.warn('SettingsMenuManager: не удалось сохранить настройки баз знаний', e);
        }
    }

    /**
     * Синхронизирует чекбоксы баз знаний с текущим состоянием
     * @private
     */
    static _applyKbState() {
        const checkboxes = document.querySelectorAll('.settings-option[data-kb-key] input[data-kb-key]');
        for (const checkbox of checkboxes) {
            const key = checkbox.dataset.kbKey;
            if (key) {
                checkbox.checked = !!this._kbState[key];
            }
        }
    }

    /**
     * Обработчики change на тумблерах баз знаний (используют data-kb-key)
     * @private
     */
    static _setupKbToggles() {
        const checkboxes = document.querySelectorAll('.settings-option[data-kb-key] input[data-kb-key]');
        for (const checkbox of checkboxes) {
            const key = checkbox.dataset.kbKey;
            if (!key) continue;

            checkbox.addEventListener('change', () => {
                this._kbState[key] = checkbox.checked;
                this._saveKbState();
            });
        }
    }

}

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => SettingsMenuManager.setup());

// Глобальный доступ
window.SettingsMenuManager = SettingsMenuManager;
