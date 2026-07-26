/**
 * Общий менеджер sidebar для всех portal-страниц (landing, acts-manager, admin, ck).
 *
 * Управляет сворачиванием/разворачиванием sidebar,
 * навигацией между страницами и загрузкой информации о пользователе.
 */
import { LandingPage } from './landing/landing-page.js';
import { AppConfig } from '../shared/app-config.js';
import { ChatModalManager } from '../shared/chat/chat-modal.js';
import { Notifications } from '../shared/notifications.js';

export class PortalSidebar {
    static _storageKey = 'sidebar_collapsed';

    /**
     * Инициализирует sidebar
     */
    static init() {
        this._restoreState();
        this._setupToggle();
        this._setupNavigation();
        this._setupChatButton();
        this._setupLockedItems();

        console.log('PortalSidebar: инициализация завершена');
    }

    /**
     * Перехватывает клики по заблокированным пунктам sidebar (`.sidebar-nav-item--locked`).
     *
     * На landing логика дублировалась в LandingPage._setupSidebarLockedItems,
     * но на других страницах (acts-manager, sql-agent, ck_*_*) обработчик не
     * висел — клик по серой ссылке с замком уезжал на чужой раздел. Теперь
     * хук живёт в PortalSidebar.init() и работает на всех страницах с sidebar.
     *
     * Дополнительно: чтобы ссылка не уезжала даже без JS, атрибут href при
     * рендере заменяется на «#» (см. template sidebar.html). Здесь дублируем
     * защиту: preventDefault + Notifications.info с подсказкой.
     *
     * @private
     */
    static _setupLockedItems() {
        const items = document.querySelectorAll(
            '.sidebar-nav-item.sidebar-nav-item--locked'
        );
        items.forEach((item) => {
            item.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const label = item.querySelector('.sidebar-nav-label')?.textContent?.trim()
                    || item.getAttribute('title') || 'этот раздел';
                if (Notifications && typeof Notifications.info === 'function') {
                    Notifications.info(
                        `Для получения доступа к «${label}» обратитесь к администратору`
                    );
                }
            });
            item.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    item.click();
                }
            });
        });
    }

    /**
     * Восстанавливает состояние сворачивания из localStorage
     * @private
     */
    static _restoreState() {
        const sidebar = document.getElementById('landingSidebar');
        if (!sidebar) return;

        const collapsed = localStorage.getItem(this._storageKey) === 'true';
        if (collapsed) {
            sidebar.classList.add('collapsed');
        }
    }

    /**
     * Настраивает кнопку сворачивания/разворачивания
     * @private
     */
    static _setupToggle() {
        const toggleBtn = document.getElementById('sidebarToggleBtn');
        const sidebar = document.getElementById('landingSidebar');
        if (!toggleBtn || !sidebar) return;

        toggleBtn.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
            const isCollapsed = sidebar.classList.contains('collapsed');
            localStorage.setItem(this._storageKey, isCollapsed.toString());
        });
    }

    /**
     * Настраивает навигацию по ссылкам sidebar
     * @private
     */
    static _setupNavigation() {
        // Навигация по активным ссылкам. Заблокированные пункты
        // (sidebar-nav-item--locked) пропускаем — ими занимается
        // _setupLockedItems(): preventDefault + Notifications.info.
        const navLinks = document.querySelectorAll(
            '.sidebar-nav a.sidebar-nav-item:not(.sidebar-nav-item--locked)'
        );
        navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const href = link.getAttribute('href');
                if (href) {
                    window.location.href = AppConfig.api.getUrl(href);
                }
            });
        });

        // Обработчики для disabled кнопок
        const disabledButtons = document.querySelectorAll('.sidebar-nav-item[disabled]');
        disabledButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                const toolName = button.querySelector('.sidebar-nav-label')?.textContent;
                console.log(`Инструмент "${toolName}" пока недоступен`);
            });
        });
    }

    /**
     * Обработчик кнопки чата в footer сайдбара
     * @private
     */
    static _setupChatButton() {
        const chatBtn = document.getElementById('sidebarChatBtn');
        if (!chatBtn) return;

        chatBtn.addEventListener('click', () => {
            // На landing page: разворачиваем встроенный чат
            const chatPanel = document.getElementById('chatPanel');
            if (chatPanel && typeof LandingPage !== 'undefined') {
                LandingPage.expandChat();
                return;
            }

            // На других страницах: открываем модальный чат
            if (typeof ChatModalManager !== 'undefined') {
                ChatModalManager.open();
            }
        });
    }

}

window.PortalSidebar = PortalSidebar;
