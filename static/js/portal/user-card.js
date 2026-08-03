/**
 * Карточка-превью пользователя в topbar портала.
 *
 * Наведение на блок пользователя (#topbarUserProfile) с задержкой открывает
 * hover-карточку (#userCardPopover) с ФИО/должностью/email и кнопкой «Выйти»
 * (см. topbar.html). Клик по блоку ведёт на страницу профиля (/profile).
 *
 * Инициализируется из PortalSidebar.init() — топбар общий для всех
 * portal-страниц, отдельного вызова на каждой странице не требует.
 */
import { AppConfig } from '../shared/app-config.js';
import { AuthManager } from '../shared/auth.js';
import { EscapeStack } from '../shared/escape-stack.js';
import { resolveUserCardFields } from './user-card-core.js';

/** Задержка открытия карточки по наведению (мс). */
const HOVER_OPEN_DELAY_MS = 500;
/** Грейс-период перед закрытием после ухода мыши — даёт перейти на карточку. */
const HOVER_CLOSE_GRACE_MS = 300;

export class UserCard {
    static _trigger = null;
    static _popover = null;
    static _openTimer = null;
    static _closeTimer = null;
    static _escapeUnsub = null;
    static _isOpen = false;

    /**
     * Инициализирует карточку. Тихо выходит, если разметки топбара нет
     * (страница без пользовательского блока).
     */
    static init() {
        const trigger = document.getElementById('topbarUserProfile');
        const popover = document.getElementById('userCardPopover');
        if (!trigger || !popover) return;

        this._trigger = trigger;
        this._popover = popover;
        this._isOpen = false;

        this._populate();
        this._bindEvents();
    }

    /**
     * Заполняет карточку данными текущего пользователя. Пустая должность/email
     * скрывают соответствующую строку.
     * @private
     */
    static _populate() {
        const fields = resolveUserCardFields(
            AuthManager.getCurrentUserProfile(),
            AuthManager.getCurrentUser(),
        );

        const nameEl = document.getElementById('userCardName');
        const jobEl = document.getElementById('userCardJob');
        const emailEl = document.getElementById('userCardEmail');

        if (nameEl) nameEl.textContent = fields.name;
        if (jobEl) {
            jobEl.textContent = fields.job;
            jobEl.classList.toggle('hidden', !fields.job);
        }
        if (emailEl) {
            emailEl.textContent = fields.email;
            emailEl.classList.toggle('hidden', !fields.email);
        }
    }

    /** @private */
    static _bindEvents() {
        this._trigger.addEventListener('mouseenter', () => this._scheduleOpen());
        this._trigger.addEventListener('mouseleave', () => this._scheduleClose());
        this._popover.addEventListener('mouseenter', () => this._cancelClose());
        this._popover.addEventListener('mouseleave', () => this._scheduleClose());

        this._trigger.addEventListener('click', (e) => {
            e.preventDefault();
            this._close();
            const href = this._trigger.getAttribute('href') || '/profile';
            window.location.href = AppConfig.api.getUrl(href);
        });
    }

    /** @private */
    static _scheduleOpen() {
        this._cancelClose();
        if (this._isOpen) return;
        clearTimeout(this._openTimer);
        this._openTimer = setTimeout(() => this._open(), HOVER_OPEN_DELAY_MS);
    }

    /** @private */
    static _cancelOpen() {
        clearTimeout(this._openTimer);
        this._openTimer = null;
    }

    /** @private */
    static _scheduleClose() {
        this._cancelOpen();
        clearTimeout(this._closeTimer);
        this._closeTimer = setTimeout(() => this._close(), HOVER_CLOSE_GRACE_MS);
    }

    /** @private */
    static _cancelClose() {
        clearTimeout(this._closeTimer);
        this._closeTimer = null;
    }

    /** @private */
    static _open() {
        if (this._isOpen) return;
        this._popover.classList.remove('hidden');
        this._isOpen = true;
        this._escapeUnsub = EscapeStack.push(() => this._close());
    }

    /** @private */
    static _close() {
        if (!this._isOpen) return;
        this._popover.classList.add('hidden');
        this._isOpen = false;
        this._cancelOpen();
        this._cancelClose();
        if (this._escapeUnsub) {
            this._escapeUnsub();
            this._escapeUnsub = null;
        }
    }
}

window.UserCard = UserCard;
