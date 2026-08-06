/**
 * Менеджер стартовой страницы (Landing Page)
 *
 * Управляет отображением портала инструментов компании:
 * - Sidebar с навигацией по инструментам
 * - Workflow dashboard с проектами (заглушка)
 * - AI-чат ассистент (заглушка)
 */
import { LandingSettingsManager } from '../portal-settings.js';
import { ChatManager } from '../../shared/chat/chat-manager.js';

export class LandingPage {
    static _chatCollapsed = false;

    /**
     * Инициализирует landing page
     */
    static init() {
        console.log('LandingPage: инициализация');

        this._setupNavigation();
        LandingSettingsManager.init();
        ChatManager.init();

        // Восстановление состояния чата из sessionStorage
        const sidebarBtn = document.getElementById('sidebarChatBtn');
        if (sessionStorage.getItem('chat_collapsed') === 'true') {
            this._collapseChat(false);
        } else {
            if (sidebarBtn) sidebarBtn.classList.add('sidebar-chat-hidden');
        }

        console.log('LandingPage: инициализация завершена');
    }

    /**
     * Настраивает обработчики для topbar, чата и workflow
     * @private
     */
    static _setupNavigation() {
        // Кнопка закрытия чата — сворачивает панель
        const chatCloseBtn = document.querySelector('#chatPanel .chat-close-btn');
        if (chatCloseBtn) {
            chatCloseBtn.addEventListener('click', () => this._collapseChat());
        }

        // Кнопки в topbar (кроме настроек — обрабатывается LandingSettingsManager)
        const topbarButtons = document.querySelectorAll('.landing-topbar-btn');
        topbarButtons.forEach(button => {
            if (button.id === 'landingSettingsBtn') return;
            button.addEventListener('click', () => {
                console.log('Функция в разработке');
            });
        });

        // Кнопка фильтров в workflow
        const filterBtn = document.querySelector('.workflow-filter-btn');
        if (filterBtn) {
            filterBtn.addEventListener('click', () => {
                console.log('Фильтры проектов (функция в разработке)');
            });
        }
    }

    /**
     * Обновляет список проектов (заглушка для будущей интеграции с workflow)
     * @private
     */
    static async _refreshProjects() {
        console.log('Обновление списка проектов (функция в разработке)');
        // В будущем здесь будет запрос к workflow API
    }

    /**
     * Сворачивает чат-панель с анимацией
     * @param {boolean} animate — использовать анимацию (false при восстановлении состояния)
     */
    static _collapseChat(animate = true) {
        const chatPanel = document.getElementById('chatPanel');
        const content = document.querySelector('.landing-content');
        const sidebarBtn = document.getElementById('sidebarChatBtn');
        if (!chatPanel) return;

        if (animate) {
            chatPanel.classList.add('chat-collapsing');
            chatPanel.addEventListener('transitionend', () => {
                chatPanel.classList.add('chat-collapsed');
                chatPanel.classList.remove('chat-collapsing');
            }, { once: true });
        } else {
            chatPanel.classList.add('chat-collapsed');
        }

        if (content) content.classList.add('chat-hidden');
        if (sidebarBtn) sidebarBtn.classList.remove('sidebar-chat-hidden');
        this._chatCollapsed = true;
        sessionStorage.setItem('chat_collapsed', 'true');
    }

    /**
     * Разворачивает чат-панель
     */
    static expandChat() {
        const chatPanel = document.getElementById('chatPanel');
        const content = document.querySelector('.landing-content');
        const sidebarBtn = document.getElementById('sidebarChatBtn');
        if (!chatPanel) return;

        chatPanel.classList.remove('chat-collapsed');
        if (content) content.classList.remove('chat-hidden');
        if (sidebarBtn) sidebarBtn.classList.add('sidebar-chat-hidden');
        this._chatCollapsed = false;
        sessionStorage.setItem('chat_collapsed', 'false');

        const input = chatPanel.querySelector('.chat-input');
        if (input && !input.disabled) setTimeout(() => input.focus(), 300);
    }
}

// Экспортируем в глобальную область видимости
window.LandingPage = LandingPage;
