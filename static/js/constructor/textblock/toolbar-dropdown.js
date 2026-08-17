/**
 * ToolbarDropdown — обёртка над паттерном button[aria-haspopup=listbox] +
 * div[role=listbox], который раньше существовал только у дропдауна размера
 * шрифта в textblock-toolbar.js (BUG-3). Task 5 (A1) схлопывает выравнивание
 * и списки в такие же дропдауны — три потребителя оправдывают вынос
 * абстракции; спекулятивной конфигурируемости сверх нужд этих трёх нет.
 *
 * BUG-3: pointerdown/mousedown на триггере И на пунктах меню ОБЯЗАНЫ звать
 * preventDefault — иначе contenteditable теряет фокус/выделение раньше click
 * (см. toolbar-btn, textblock-toolbar.js:150-155), и применяемая команда
 * уходит в ветку «каретка» вместо «выделение».
 *
 * Закрытие — по клику вне picker и по Escape через общий EscapeStack, тем же
 * паттерном, что и AppendixNumberDropdown
 * (static/js/portal/acts-manager/appendix-number-dropdown.js).
 */
import { EscapeStack } from '../../shared/escape-stack.js';

export class ToolbarDropdown {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.picker - корневой контейнер дропдауна
     *   (триггер + меню); клик ВНЕ него закрывает меню.
     * @param {HTMLElement} options.trigger - кнопка-триггер
     *   (button[aria-haspopup=listbox]).
     * @param {HTMLElement} options.menu - список пунктов (div[role=listbox]).
     * @param {string} [options.itemSelector='[role="option"]'] - селектор
     *   кликабельных пунктов меню (делегирование через closest — пункты
     *   рендерятся потребителем строкой innerHTML, без листенеров на каждый).
     * @param {(item: HTMLElement, e: Event) => void} [options.onSelect] -
     *   клик по пункту меню; вызывается ПОСЛЕ закрытия меню.
     * @param {() => void} [options.onOpen] - перед открытием меню (обновить
     *   подсветку активного пункта — аналог updateFontSizeSelect).
     */
    constructor({ picker, trigger, menu, itemSelector = '[role="option"]', onSelect, onOpen }) {
        if (!picker || !trigger || !menu) {
            throw new Error('ToolbarDropdown: picker/trigger/menu обязательны');
        }
        this._picker = picker;
        this._trigger = trigger;
        this._menu = menu;
        this._itemSelector = itemSelector;
        this._onSelect = typeof onSelect === 'function' ? onSelect : null;
        this._onOpen = typeof onOpen === 'function' ? onOpen : null;

        this._isOpen = false;
        this._escapeUnsub = null;
        this._onDocumentMouseDown = this._onDocumentMouseDown.bind(this);

        // Дропдаун — единственный источник истины о своём открытом/закрытом
        // состоянии: закрывает DOM явно, не полагаясь на разметку потребителя
        // (там и так уже стоит class="hidden", но дублировать здесь дешевле,
        // чем плодить рассинхрон при будущей правке шаблона).
        this._menu.classList.add('hidden');
        this._trigger.setAttribute('aria-expanded', 'false');

        this._bind();
    }

    /** @returns {boolean} Открыт ли дропдаун. */
    get isOpen() {
        return this._isOpen;
    }

    /** Переключает открыт/закрыт. */
    toggle() {
        if (this._isOpen) this.close();
        else this.open();
    }

    /** Открывает меню (идемпотентно). */
    open() {
        if (this._isOpen) return;
        this._isOpen = true;
        this._menu.classList.remove('hidden');
        this._trigger.setAttribute('aria-expanded', 'true');
        this._onOpen?.();
        document.addEventListener('mousedown', this._onDocumentMouseDown);
        this._escapeUnsub = EscapeStack.push(() => {
            this.close();
        });
    }

    /** Закрывает меню (идемпотентно). */
    close() {
        if (!this._isOpen) return;
        this._isOpen = false;
        this._menu.classList.add('hidden');
        this._trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', this._onDocumentMouseDown);
        if (this._escapeUnsub) {
            this._escapeUnsub();
            this._escapeUnsub = null;
        }
    }

    /** @private */
    _bind() {
        this._trigger.addEventListener('mousedown', (e) => e.preventDefault());
        this._trigger.addEventListener('pointerdown', (e) => e.preventDefault());
        this._trigger.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggle();
        });

        this._menu.addEventListener('mousedown', (e) => {
            if (e.target.closest(this._itemSelector)) e.preventDefault();
        });
        this._menu.addEventListener('pointerdown', (e) => {
            if (e.target.closest(this._itemSelector)) e.preventDefault();
        });
        this._menu.addEventListener('click', (e) => {
            const item = e.target.closest(this._itemSelector);
            if (!item) return;
            e.preventDefault();
            e.stopPropagation();
            // aria-disabled="true" (например, indent/outdent вне списка,
            // textblock-toolbar.js::_updateListsTriggerState) — пункт видим, но
            // неактивен: меню остаётся открытым, onSelect не зовётся. preventDefault
            // выше всё равно отработал — клик по нему не должен ронять
            // фокус/выделение редактора.
            if (item.getAttribute('aria-disabled') === 'true') return;
            this.close();
            this._onSelect?.(item, e);
        });
    }

    /** @private */
    _onDocumentMouseDown(e) {
        if (!this._picker.contains(e.target)) this.close();
    }
}

window.ToolbarDropdown = ToolbarDropdown;
