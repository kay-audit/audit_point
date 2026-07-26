/**
 * Менеджер стартовой страницы (Landing Page)
 *
 * Управляет отображением портала инструментов компании:
 * - Sidebar с навигацией по инструментам
 * - Панель «Мои проекты» (GET /api/v1/acts/my-projects) — рендерит карточки
 *   актов, в которых пользователь участвует; для админа — все акты.
 *   Клик по карточке ведёт в конструктор (как кнопка «Открыть» в Управлении актами).
 * - AI-чат ассистент
 */
import { AppConfig } from '../../shared/app-config.js';
import { LandingSettingsManager } from '../portal-settings.js';
import { ChatManager } from '../../shared/chat/chat-manager.js';
import { Notifications } from '../../shared/notifications.js';

export class LandingPage {
    static _chatCollapsed = false;

    /**
     * Инициализирует landing page
     */
    static init() {
        console.log('LandingPage: инициализация');

        this._setupNavigation();
        this._setupSidebarLockedItems();
        this._loadMyProjects();
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
     * Настраивает topbar-кнопки (кроме настроек).
     * @private
     */
    static _setupNavigation() {
        const chatCloseBtn = document.querySelector('#chatPanel .chat-close-btn');
        if (chatCloseBtn) {
            chatCloseBtn.addEventListener('click', () => this._collapseChat());
        }

        const topbarButtons = document.querySelectorAll('.landing-topbar-btn');
        topbarButtons.forEach(button => {
            if (button.id === 'landingSettingsBtn') return;
            button.addEventListener('click', () => {
                console.log('Функция в разработке');
            });
        });

        const filterBtn = document.querySelector('.workflow-filter-btn');
        if (filterBtn) {
            filterBtn.addEventListener('click', () => {
                console.log('Фильтры проектов (функция в разработке)');
            });
        }
    }

    /**
     * Блокирует клики по sidebar-элементам, к которым у пользователя нет
     * доступа. Вместо перехода — уведомление «обратитесь к администратору».
     * @private
     */
    static _setupSidebarLockedItems() {
        const items = document.querySelectorAll('.sidebar-nav-item.sidebar-nav-item--locked');
        items.forEach((item) => {
            item.addEventListener('click', (event) => {
                event.preventDefault();
                const label = item.querySelector('.sidebar-nav-label')?.textContent
                    || item.getAttribute('title') || 'этот раздел';
                Notifications.info(
                    `Для получения доступа к «${label}» обратитесь к администратору`
                );
            });
        });
    }

    /**
     * Загружает список проектов для боковой панели и рендерит карточки.
     * @private
     */
    static async _loadMyProjects() {
        const container = document.getElementById('myProjectsList');
        const loading = document.getElementById('myProjectsLoading');
        const empty = document.getElementById('myProjectsEmpty');
        if (!container) return;

        try {
            const resp = await fetch(AppConfig.api.getUrl('/api/v1/acts/my-projects'),
                { credentials: 'same-origin' });
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            const data = await resp.json();

            // Убираем loading-индикатор
            if (loading) loading.remove();

            if (!data.items || data.items.length === 0) {
                if (empty) empty.hidden = false;
                return;
            }

            // Рендерим карточки
            const fragment = document.createDocumentFragment();
            for (const p of data.items) {
                fragment.appendChild(this._renderProjectCard(p, data.is_admin));
            }
            container.appendChild(fragment);
        } catch (err) {
            console.error('LandingPage: не удалось загрузить проекты', err);
            if (loading) {
                loading.querySelector('.workflow-placeholder-text').textContent =
                    'Не удалось загрузить список проектов';
            }
        }
    }

    /**
     * Строит DOM-элемент карточки проекта.
     * @private
     */
    static _renderProjectCard(p, isAdmin) {
        const card = document.createElement('a');
        card.href = `/constructor?act_id=${p.id}`;
        card.className = 'project-card project-card--link';
        card.setAttribute('data-act-id', String(p.id));
        card.setAttribute('data-km', p.km_number);
        card.setAttribute('data-role', p.my_role);
        card.title = `Открыть «${p.inspection_name}» в конструкторе (акт #${p.id})`;

        // Статус (active/pending/completed) — простая эвристика по датам
        const statusLabel = p.status === 'completed' ? 'Завершён'
            : p.status === 'pending' ? 'Ожидание' : 'В работе';
        const statusClass = p.status === 'completed' ? 'status-completed'
            : p.status === 'pending' ? 'status-pending' : 'status-active';

        // Дедлайн: показываем, если end_date в прошлом — «просрочен»
        const todayIso = new Date().toISOString().slice(0, 10);
        const isOverdue = p.inspection_end_date < todayIso;
        const dateText = isOverdue
            ? `Просрочен: ${formatDate(p.inspection_end_date)}`
            : `Дедлайн: ${formatDate(p.inspection_end_date)}`;

        // ФИО + должность владельца/участника (для админа = свои данные,
        // для не-админа = то, что записано в team_member)
        const whoLine = p.my_full_name
            ? `<div class="project-card-who">${escapeHtml(p.my_full_name)} · ${escapeHtml(p.my_position || '')}</div>`
            : '';

        card.innerHTML = `
            <div class="project-card-header">
                <h4 class="project-card-title">${escapeHtml(p.inspection_name)}</h4>
                <span class="project-card-status ${statusClass}">${statusLabel}</span>
            </div>
            <div class="project-card-body">
                <p class="project-card-description">${escapeHtml(p.km_number)} · г. ${escapeHtml(p.city || '—')}</p>
                <div class="project-card-role">
                    <span class="project-card-role-label">Ваша роль:</span>
                    <span class="project-card-role-value">${escapeHtml(p.my_role)}</span>
                    ${isAdmin ? '<span class="project-card-role-badge">видит все проекты</span>' : ''}
                </div>
                ${whoLine}
            </div>
            <div class="project-card-footer">
                <div class="project-card-meta">
                    <span class="project-card-date">${dateText}</span>
                </div>
            </div>
        `;
        return card;
    }

    /**
     * Сворачивает чат-панель с анимацией
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

function formatDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
}

function escapeHtml(s) {
    const map = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
    return String(s || '').replace(/[&<>"']/g, (c) => map[c]);
}

// Экспортируем в глобальную область видимости
window.LandingPage = LandingPage;
