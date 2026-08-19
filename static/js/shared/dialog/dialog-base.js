/**
 * Базовый менеджер диалоговых окон
 *
 * Предоставляет общий функционал для всех типов диалогов:
 * - Управление overlay
 * - Закрытие по Escape и клику вне диалога
 * - Блокировка прокрутки body
 * - Анимации открытия/закрытия
 */
import { AppConfig } from '../app-config.js';
import { EscapeStack } from '../escape-stack.js';

export class DialogBase {
    /**
     * Текущие активные диалоги (стек для вложенных диалогов)
     * @private
     * @type {HTMLElement[]}
     */
    static _activeDialogs = [];

    /**
     * Создает overlay элемент
     * @protected
     * @returns {HTMLElement} Элемент overlay
     */
    static _createOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'custom-dialog-overlay';
        return overlay;
    }

    /**
     * Селектор focusable-элементов внутри overlay'а (для focus-trap'а и
     * автофокуса при открытии диалога). Исключаем элементы с tabindex="-1"
     * (программно фокусируемые, но не tab-доступные) и disabled.
     * @private
     */
    static _FOCUSABLE_SELECTOR = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled]):not([type="hidden"])',
        'textarea:not([disabled])',
        'select:not([disabled])',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    /**
     * Возвращает все видимые focusable-элементы внутри overlay'а.
     * Видимость определяем по offsetParent (учитывает display:none/visibility:hidden
     * у предков). Достаточно для нашего набора диалогов — в overlay'е почти всегда
     * один блок с кнопками.
     * @private
     */
    static _getFocusableElements(overlay) {
        const all = overlay.querySelectorAll(this._FOCUSABLE_SELECTOR);
        return Array.from(all).filter(el => el.offsetParent !== null || el === overlay);
    }

    /** @private */
    static _getFirstFocusable(overlay) {
        const list = this._getFocusableElements(overlay);
        return list[0] || null;
    }

    /** @private */
    static _getLastFocusable(overlay) {
        const list = this._getFocusableElements(overlay);
        return list[list.length - 1] || null;
    }

    /**
     * Вешает Tab focus-trap на overlay. Tab на последнем — переводит на первый,
     * Shift+Tab на первом — переводит на последний. Handler хранится в
     * overlay._trapHandler — удаляется в _hideDialog.
     * @private
     */
    static _setupFocusTrap(overlay) {
        const handler = (e) => {
            if (e.key !== 'Tab') return;
            // Trap должен работать только на самом верхнем диалоге; если поверх
            // открыт ещё один — не вмешиваемся.
            if (this._activeDialogs[this._activeDialogs.length - 1] !== overlay) return;

            const focusables = this._getFocusableElements(overlay);
            if (focusables.length === 0) {
                // Нечего трапить — но и Tab не должен «убежать» из модала.
                e.preventDefault();
                return;
            }
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement;

            if (e.shiftKey) {
                if (active === first || !overlay.contains(active)) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (active === last || !overlay.contains(active)) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };
        overlay.addEventListener('keydown', handler);
        overlay._trapHandler = handler;
    }

    /** @private */
    static _removeFocusTrap(overlay) {
        if (overlay._trapHandler) {
            overlay.removeEventListener('keydown', overlay._trapHandler);
            delete overlay._trapHandler;
        }
    }

    /**
     * Показывает диалог с анимацией.
     *
     * Дополнительно настраивает a11y:
     * - role="dialog" + aria-modal="true" (если не заданы вызывающим кодом);
     * - aria-labelledby на первый заголовок диалога (data-dialog-title|h1..h4);
     * - сохраняет previousFocus и переводит фокус на первый focusable;
     * - вешает Tab focus-trap.
     *
     * @protected
     * @param {HTMLElement} overlay - Overlay элемент
     */
    static _showDialog(overlay, opts = {}) {
        const {appendToBody = true, animate = true} = opts;

        // Сохраняем элемент, у которого был фокус до открытия — вернём после _hideDialog.
        overlay._previousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;

        if (appendToBody) document.body.appendChild(overlay);
        // Идемпотентность: повторный show() того же overlay без промежуточного
        // hide() (напр. двойной клик по «Помощь») не должен дублировать запись
        // в стеке — иначе один hide() не обнулит _activeDialogs и скролл body
        // останется залочен. Разные overlay'и по-прежнему складываются в стек.
        if (this._activeDialogs.indexOf(overlay) === -1) {
            this._activeDialogs.push(overlay);
            this._lockBodyScroll();
        }

        // Признак "уже в DOM" — _hideDialog не будет удалять.
        overlay._preserveInDom = !appendToBody;

        // Отменяем предыдущий незавершённый hide() по этому overlay: без
        // clearTimeout его таймер догонит уже открытый диалог — снимет
        // _preserveInDom и повесит обратно 'hidden' (диалог схлопнется сам
        // собой), а следующий hide() увидит _preserveInDom=undefined и удалит
        // статическую ноду из DOM. Флаг снимаем здесь же, иначе следующий
        // hide() стал бы no-op с _closing=true от прошлого цикла.
        if (overlay._closeTimer) {
            clearTimeout(overlay._closeTimer);
            delete overlay._closeTimer;
        }
        delete overlay._closing;

        // Принудительный reflow для анимации (void — явное выражение, чтобы линтеры/минификаторы не выкинули его как «unused expression»)
        if (animate) void overlay.offsetHeight;
        // Класс закрытия мог остаться от отменённого hide() — он держит opacity: 0
        // и перебивает .visible (идёт ниже в таблице стилей).
        overlay.classList.remove('closing');
        overlay.classList.add('visible');

        // ARIA-маркеры модального диалога. role/aria-modal не перетираем,
        // если уже выставлены вызывающим кодом.
        if (!overlay.hasAttribute('role')) {
            overlay.setAttribute('role', 'dialog');
        }
        if (!overlay.hasAttribute('aria-modal')) {
            overlay.setAttribute('aria-modal', 'true');
        }
        if (!overlay.hasAttribute('aria-labelledby')) {
            const heading = overlay.querySelector('[data-dialog-title], h1, h2, h3, h4');
            if (heading) {
                if (!heading.id) {
                    heading.id = `dialog-title-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
                }
                overlay.setAttribute('aria-labelledby', heading.id);
            }
        }

        // Фокус-менеджмент. setTimeout(0) — даём DOM дорисоваться после reflow
        // и смены классов visibility (иначе focus() уходит «в никуда» при
        // первом открытии диалога, когда внутренний блок только-только появился).
        setTimeout(() => {
            const first = this._getFirstFocusable(overlay);
            if (first) {
                try { first.focus(); } catch (_) { /* noop */ }
            } else {
                // Нет focusable — фокус на сам overlay, чтобы Esc/Tab продолжили работать.
                if (!overlay.hasAttribute('tabindex')) {
                    overlay.setAttribute('tabindex', '-1');
                }
                try { overlay.focus(); } catch (_) { /* noop */ }
            }
        }, 0);

        // Focus-trap: Tab/Shift+Tab циклит фокус внутри overlay'а.
        // Снимаем прежний trap перед установкой нового — при повторном show()
        // того же overlay иначе утёк бы старый keydown-listener.
        this._removeFocusTrap(overlay);
        this._setupFocusTrap(overlay);
    }

    /**
     * Скрывает и удаляет диалог с анимацией. После удаления возвращает
     * фокус на _previousFocus (если элемент ещё в DOM).
     *
     * @protected
     * @param {HTMLElement} overlay - Overlay элемент для удаления
     * @param {number} [delay] - Задержка перед удалением (мс)
     */
    static _hideDialog(overlay, delay = AppConfig.dialog.closeDelay) {
        if (!overlay || !overlay.parentNode) return;

        // Идемпотентность: повторный синхронный _hideDialog того же overlay
        // (напр. двойной клик по крестику) не должен ставить второй setTimeout —
        // иначе первый снимает _preserveInDom, а второй уходит в remove() и
        // физически удаляет статическую ноду (напр. #helpModal) из DOM.
        if (overlay._closing) return;
        overlay._closing = true;

        const index = this._activeDialogs.indexOf(overlay);
        if (index > -1) {
            this._activeDialogs.splice(index, 1);
        }

        // Унифицированно снимаем escape-handler и focus-trap здесь, чтобы подклассы не дублировали
        // логику и keydown-listener'ы не висели на оторванной DOM-ноде после закрытия (включая closeAllDialogs).
        this._removeEscapeHandler(overlay);
        this._removeFocusTrap(overlay);

        overlay.classList.add('closing');
        overlay.classList.remove('visible');

        // previousFocus захватываем здесь — после remove() ссылка на overlay уже не нужна.
        const previousFocus = overlay._previousFocus;
        delete overlay._previousFocus;

        overlay._closeTimer = setTimeout(() => {
            delete overlay._closing;
            delete overlay._closeTimer;
            const preserveInDom = overlay._preserveInDom;
            delete overlay._preserveInDom;
            if (preserveInDom) {
                // Существующая в шаблоне нода — скрываем, не удаляем.
                overlay.classList.remove('closing');
                overlay.classList.add('hidden');
            } else if (overlay.parentNode) {
                overlay.remove();
            }

            // Разблокируем прокрутку только если нет других активных диалогов
            if (this._activeDialogs.length === 0) {
                this._unlockBodyScroll();
            }

            // Возвращаем фокус — только если элемент ещё в DOM и видим.
            // Без isConnected проверки .focus() на оторванном узле — no-op,
            // но фокус уходит на body (теряется контекст для скринридера).
            if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
                try { previousFocus.focus(); } catch (_) { /* noop */ }
            }
        }, delay);
    }

    /**
     * Настраивает закрытие диалога по клику на overlay
     * @protected
     * @param {HTMLElement} overlay - Overlay элемент
     * @param {HTMLElement} dialog - Внутренний диалог (не должен закрываться при клике на него)
     * @param {Function} onClose - Callback при закрытии
     */
    static _setupOverlayClickHandler(overlay, dialog, onClose) {
        overlay.addEventListener('click', (e) => {
            // Закрываем только если клик был именно на overlay, а не на его содержимом
            if (e.target === overlay) {
                onClose();
            }
        });

        // Предотвращаем всплытие событий от диалога к overlay
        if (dialog) {
            dialog.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
    }

    /**
     * Настраивает обработчик закрытия по клавише Escape через EscapeStack.
     * Стек LIFO: срабатывает только верхний хэндлер, событие гасится через
     * stopImmediatePropagation — старые legacy-listener'ы не отрабатывают.
     * @protected
     * @param {HTMLElement} overlay - Overlay элемент
     * @param {Function} onClose - Callback при закрытии
     */
    static _setupEscapeHandler(overlay, onClose) {
        const unsub = EscapeStack.push(() => onClose());
        overlay._escapeUnsub = unsub;
    }

    /**
     * Удаляет обработчик Escape при закрытии диалога
     * @protected
     * @param {HTMLElement} overlay - Overlay элемент
     */
    static _removeEscapeHandler(overlay) {
        if (overlay._escapeUnsub) {
            overlay._escapeUnsub();
            delete overlay._escapeUnsub;
        }
    }

    /**
     * Блокирует прокрутку основной страницы
     * @protected
     */
    static _lockBodyScroll() {
        if (!document.body.classList.contains('dialog-open')) {
            // Сохраняем текущую позицию прокрутки
            const scrollY = window.scrollY;
            document.body.style.top = `-${scrollY}px`;
            document.body.classList.add('dialog-open');
        }
    }

    /**
     * Разблокирует прокрутку основной страницы
     * @protected
     */
    static _unlockBodyScroll() {
        if (document.body.classList.contains('dialog-open')) {
            const scrollY = document.body.style.top;
            document.body.classList.remove('dialog-open');
            document.body.style.top = '';

            // Восстанавливаем позицию прокрутки
            if (scrollY) {
                window.scrollTo(0, parseInt(scrollY || '0') * -1);
            }
        }
    }

    /**
     * Создает простой элемент с классом и текстом
     * @protected
     * @param {string} tag - HTML-тег
     * @param {string} className - CSS-класс
     * @param {string} text - Текстовое содержимое
     * @returns {HTMLElement} Созданный элемент
     */
    static _createElement(tag, className, text) {
        const element = document.createElement(tag);
        element.className = className;
        element.textContent = text;
        return element;
    }

    /**
     * Создает кнопку с обработчиком клика
     * @protected
     * @param {string} className - CSS-класс кнопки
     * @param {string} text - Текст кнопки
     * @param {Function} onClick - Обработчик клика
     * @returns {HTMLElement} Элемент кнопки
     */
    static _createButton(className, text, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = text;
        button.addEventListener('click', onClick);
        return button;
    }

    /**
     * Клонирует template элемент
     * @protected
     * @param {string} templateId - ID template
     * @returns {DocumentFragment|null} Клонированный template
     */
    static _cloneTemplate(templateId) {
        const template = document.getElementById(templateId);
        if (!template) {
            console.error(`Template ${templateId} не найден`);
            return null;
        }
        return template.content.cloneNode(true);
    }

    /**
     * Заполняет поля в элементе данными
     * @protected
     * @param {Element} element - Элемент для заполнения
     * @param {string} fieldName - Имя поля (data-field)
     * @param {*} value - Значение для установки
     */
    static _fillField(element, fieldName, value) {
        const field = element.querySelector(`[data-field="${fieldName}"]`);
        if (!field) return;

        if (field.type === 'checkbox') {
            field.checked = !!value;
        } else if (field.type === 'number') {
            field.value = value !== null && value !== undefined ? value : '';
        } else if (field.tagName === 'BUTTON') {
            field.textContent = value;
        } else {
            if (field.textContent !== undefined && field.tagName !== 'INPUT' && field.tagName !== 'TEXTAREA' && field.tagName !== 'SELECT') {
                field.textContent = value;
            } else {
                field.value = value || '';
            }
        }
    }

    /**
     * Заполняет все поля с data-field атрибутом
     * @protected
     * @param {Element} element - Корневой элемент
     * @param {Object} data - Объект с данными {fieldName: value}
     */
    static _fillFields(element, data) {
        element.querySelectorAll('[data-field]').forEach(field => {
            const fieldName = field.getAttribute('data-field');
            if (data.hasOwnProperty(fieldName)) {
                const value = data[fieldName];

                if (field.type === 'checkbox') {
                    field.checked = !!value;
                } else if (field.type === 'number') {
                    field.value = value !== null && value !== undefined ? value : '';
                } else if (field.tagName === 'BUTTON') {
                    field.textContent = value;
                } else {
                    if (field.textContent !== undefined && field.tagName !== 'INPUT' && field.tagName !== 'TEXTAREA' && field.tagName !== 'SELECT') {
                        field.textContent = value;
                    } else {
                        field.value = value || '';
                    }
                }
            }
        });
    }

    /**
     * Получает количество активных диалогов
     * @returns {number} Количество открытых диалогов
     */
    static getActiveDialogsCount() {
        return this._activeDialogs.length;
    }

    /**
     * Закрывает все активные диалоги
     */
    static closeAllDialogs() {
        const dialogs = [...this._activeDialogs]; // Копия для безопасной итерации
        dialogs.forEach(dialog => {
            this._removeFocusTrap(dialog);
            this._hideDialog(dialog, 0);
        });
        this._activeDialogs = [];
        this._unlockBodyScroll();
    }
}

// Глобальный доступ
window.DialogBase = DialogBase;
