/**
 * Менеджер стартовой страницы (Landing Page)
 *
 * Управляет отображением портала инструментов компании:
 * - Sidebar с навигацией по инструментам
 * - Панель «Мои проекты» (GET /api/v1/acts/my-projects) — рендерит карточки
 *   актов, в которых пользователь участвует; для админа — все акты.
 *   Клик по карточке ведёт в конструктор (как кнопка «Открыть» в Управлении актами).
 *   Фильтры по статусу / номеру КМ / роли — открываются по кнопке «Фильтры».
 * - AI-чат ассистент
 */
import { AppConfig } from '../../shared/app-config.js';
import { LandingSettingsManager } from '../portal-settings.js';
import { ChatManager } from '../../shared/chat/chat-manager.js';
import { Notifications } from '../../shared/notifications.js';

export class LandingPage {
    static _chatCollapsed = false;
    static _allProjects = [];   // кэш загруженных проектов (для фильтрации)
    static _isAdmin = false;

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
     * Настраивает topbar-кнопки (кроме настроек) и фильтры «Мои проекты».
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

        // Кнопка «Фильтры» — открывает/закрывает панель фильтров
        const filterBtn = document.getElementById('workflowFilterBtn')
            || document.querySelector('.workflow-filter-btn');
        if (filterBtn) {
            filterBtn.addEventListener('click', () => {
                const panel = document.getElementById('workflowFilters');
                if (panel) {
                    const isOpen = panel.classList.toggle('workflow-filters--open');
                    filterBtn.classList.toggle('workflow-filter-btn--active', isOpen);
                }
            });
        }

        // Применить / сбросить фильтры
        const statusSel = document.getElementById('filterStatus');
        const kmInput = document.getElementById('filterKm');
        const roleSel = document.getElementById('filterRole');
        [statusSel, kmInput, roleSel].forEach((el) => {
            if (el) el.addEventListener('input', () => this._applyFilters());
        });
        const resetBtn = document.getElementById('filterResetBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (statusSel) statusSel.value = '';
                if (kmInput) kmInput.value = '';
                if (roleSel) roleSel.value = '';
                this._applyFilters();
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

            this._allProjects = data.items || [];
            this._isAdmin = !!data.is_admin;

            // Заполняем select ролей из реальных данных
            this._populateRoleFilter();

            if (this._allProjects.length === 0) {
                if (empty) empty.hidden = false;
                return;
            }

            this._renderProjects(this._allProjects);
        } catch (err) {
            console.error('LandingPage: не удалось загрузить проекты', err);
            if (loading) {
                loading.querySelector('.workflow-placeholder-text').textContent =
                    'Не удалось загрузить список проектов';
            }
        }
    }

    /**
     * Заполняет select фильтра по ролям уникальными значениями из данных.
     * @private
     */
    static _populateRoleFilter() {
        const roleSel = document.getElementById('filterRole');
        if (!roleSel) return;
        const current = roleSel.value;
        const seen = new Set();
        // Стандартный набор ролей — отображаем независимо от наличия в данных
        ['Администратор', 'Куратор', 'Руководитель', 'Редактор', 'Участник', 'AppendixRef']
            .forEach((r) => seen.add(r));
        this._allProjects.forEach((p) => { if (p.my_role) seen.add(p.my_role); });
        // Перестраиваем options
        roleSel.innerHTML = '<option value="">Все</option>' +
            Array.from(seen).sort().map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
        roleSel.value = current;
    }

    /**
     * Рендерит массив проектов в контейнер.
     * @private
     */
    static _renderProjects(items) {
        const container = document.getElementById('myProjectsList');
        const empty = document.getElementById('myProjectsEmpty');
        if (!container) return;
        // Очищаем текущие карточки (но НЕ loading-индикатор, если он ещё есть)
        const cards = container.querySelectorAll('.project-card');
        cards.forEach((c) => c.remove());
        if (empty) empty.hidden = true;

        if (!items || items.length === 0) {
            if (empty) empty.hidden = false;
            this._updateFilterSummary(0, 0);
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const p of items) {
            fragment.appendChild(this._renderProjectCard(p, this._isAdmin));
        }
        container.appendChild(fragment);
        this._updateFilterSummary(items.length, this._allProjects.length);
    }

    /**
     * Применяет текущие значения фильтров к _allProjects и перерисовывает.
     * @private
     */
    static _applyFilters() {
        const statusSel = document.getElementById('filterStatus');
        const kmInput = document.getElementById('filterKm');
        const roleSel = document.getElementById('filterRole');
        const status = statusSel ? statusSel.value : '';
        const km = (kmInput ? kmInput.value : '').trim().toLowerCase();
        const role = roleSel ? roleSel.value : '';
        const filtered = this._allProjects.filter((p) => {
            if (status && p.status !== status) return false;
            if (km && !String(p.km_number).toLowerCase().includes(km)) return false;
            if (role && p.my_role !== role) return false;
            return true;
        });
        this._renderProjects(filtered);
    }

    /**
     * Обновляет текст «показано X из Y» под фильтрами.
     * @private
     */
    static _updateFilterSummary(shown, total) {
        const el = document.getElementById('filterSummary');
        if (!el) return;
        if (shown === total) {
            el.textContent = `Показано: ${total}`;
        } else {
            el.textContent = `Показано: ${shown} из ${total}`;
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
        card.setAttribute('data-status', p.status);
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

        // Роль в проекте — овальный бейдж светло-жёлтого цвета (как «В работе»).
        // Для админа показываем доп. плашку «видит все».
        const roleBadge = `
            <span class="project-card-role-badge" data-role="${escapeHtml(p.my_role)}">
                ${escapeHtml(p.my_role)}
            </span>
        `;
        const adminBadge = isAdmin
            ? '<span class="project-card-admin-badge">видит все</span>'
            : '';

        card.innerHTML = `
            <div class="project-card-header">
                <h4 class="project-card-title">${escapeHtml(p.inspection_name)}</h4>
                <span class="project-card-status ${statusClass}">${statusLabel}</span>
            </div>
            <div class="project-card-body">
                <p class="project-card-description">${escapeHtml(p.km_number)} · г. ${escapeHtml(p.city || '—')}</p>
                <div class="project-card-badges">
                    ${roleBadge}
                    ${adminBadge}
                </div>
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
