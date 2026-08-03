/**
 * Общий менеджер sidebar для всех portal-страниц (landing, acts-manager, admin, ck).
 *
 * Управляет сворачиванием/разворачиванием sidebar,
 * навигацией между страницами и загрузкой информации о пользователе.
 */
import { LandingPage } from './landing/landing-page.js';
import { AppConfig } from '../shared/app-config.js';
import { AuthManager } from '../shared/auth.js';
import { ChatModalManager } from '../shared/chat/chat-modal.js';
import { UserCard } from './user-card.js';
import { renderPortalAvatars } from './user-avatar.js';
import { resolveTopbarUserLines } from './user-card-core.js';

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
        this._loadUserInfo();
        UserCard.init();

        console.log('PortalSidebar: инициализация завершена');
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
        // Навигация по активным ссылкам
        const navLinks = document.querySelectorAll('.sidebar-nav a.sidebar-nav-item');
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

    /**
     * Загружает информацию о текущем пользователе в topbar: ФИО (с фолбэком
     * на username), логин второй строкой и фото профиля.
     * @private
     */
    static _loadUserInfo() {
        try {
            const profile = AuthManager.getCurrentUserProfile();
            const username = AuthManager.getCurrentUser();
            const { name, login } = resolveTopbarUserLines(profile, username);

            const userNameElement = document.getElementById('currentUserName');
            if (userNameElement && name) {
                userNameElement.textContent = name;
            }

            const userLoginElement = document.getElementById('currentUserLogin');
            if (userLoginElement) {
                userLoginElement.textContent = login;
                userLoginElement.classList.toggle('hidden', !login);
            }

            renderPortalAvatars(username, profile && profile.avatar_version);
        } catch (error) {
            console.error('PortalSidebar: ошибка загрузки информации о пользователе:', error);
        }
    }

}

window.PortalSidebar = PortalSidebar;
