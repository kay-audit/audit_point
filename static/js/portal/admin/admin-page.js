/**
 * Главный контроллер страницы администрирования.
 *
 * Управляет тремя разделами:
 *   - "roles"       — управление ролями пользователей (исходный функционал);
 *   - "diagnostics" — observability батчеров и фоновых задач (lazy);
 *   - "audit-log"   — журнал админ-операций (lazy).
 *
 * Lazy-инициализация: тяжёлые tabs подгружают данные только при первом
 * переключении, чтобы не нагружать страницу при открытии "Роли".
 */
import { AdminAddUserDialog } from './admin-add-user-dialog.js';
import { AdminAuditLog } from './admin-audit-log.js';
import { AdminDiagnostics } from './admin-diagnostics.js';
import { AdminEditUserDialog } from './admin-edit-user-dialog.js';
import { AdminRoles } from './admin-roles.js';
import { AdminSearch } from './admin-search.js';
import { APIClient } from '../../shared/api.js';
import { Notifications } from '../../shared/notifications.js';

export class AdminPage {
    static _usersDirectory = [];
    static _allRoles = [];
    static _initializedTabs = new Set();

    /* --- Состояние пагинации справочника (load-more) --- */
    static _pageSize = 50;
    static _dirOffset = 0;
    static _dirTotal = 0;
    static _dirLoadingMore = false;
    static _searchActive = false;
    static _searchSeq = 0;

    static async init() {
        try {
            const [directory, roles] = await Promise.all([
                APIClient.loadUserDirectory(this._pageSize, 0),
                APIClient.loadAllRoles(),
            ]);
            this._usersDirectory = directory.items;
            this._dirTotal = directory.total;
            this._dirOffset = directory.items.length;
            this._allRoles = roles;

            AdminSearch.init((q) => this.searchDirectory(q));
            AdminRoles.init(this._allRoles);
            AdminRoles.setUsers(this._usersDirectory);
            this._initAddUserButton();
            this._renderLoadMore();
            this._initTabs();
            this._initializedTabs.add('roles');

            console.log('AdminPage: инициализация завершена');
        } catch (error) {
            console.error('AdminPage: ошибка инициализации:', error);
            Notifications.error('Не удалось загрузить данные администрирования');
        }
    }

    /**
     * Подгружает следующую страницу справочника пользователей и дописывает
     * её в таблицу ролей.
     * @private
     */
    static async _loadMoreDirectory() {
        if (this._dirLoadingMore) return;
        if (this._dirOffset >= this._dirTotal) return;

        this._dirLoadingMore = true;
        const btn = document.getElementById('adminDirLoadMoreBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Загрузка...';
        }

        try {
            const page = await APIClient.loadUserDirectory(
                this._pageSize, this._dirOffset,
            );
            this._dirTotal = page.total;
            this._dirOffset += page.items.length;
            this._usersDirectory.push(...page.items);
            AdminRoles.appendUsers(page.items);
            this._renderLoadMore();
        } catch (error) {
            console.error('AdminPage: ошибка подгрузки справочника:', error);
            Notifications.error('Не удалось загрузить ещё пользователей');
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Загрузить ещё';
            }
        } finally {
            this._dirLoadingMore = false;
        }
    }

    /**
     * Поиск по справочнику. При непустом запросе тянет совпадения с сервера
     * (по всему справочнику) и показывает их без кнопки «Загрузить ещё».
     * При пустом — возвращает ранее загруженный пагинированный список.
     * @param {string} query - Строка поиска
     */
    static async searchDirectory(query) {
        const q = (query || '').trim();
        const seq = ++this._searchSeq;

        if (!q) {
            // Сброс поиска — восстанавливаем накопленный справочник и пагинацию.
            this._searchActive = false;
            AdminRoles.setUsers(this._usersDirectory);
            this._renderLoadMore();
            return;
        }

        this._searchActive = true;
        let page;
        try {
            page = await APIClient.loadUserDirectory(this._pageSize, 0, q);
        } catch (error) {
            if (seq !== this._searchSeq) return;  // ответ устарел — игнор
            console.error('AdminPage: ошибка поиска по справочнику:', error);
            Notifications.error('Не удалось выполнить поиск');
            return;
        }
        if (seq !== this._searchSeq) return;  // пока ждали — запрос сменился
        AdminRoles.setUsers(page.items);
        this._renderLoadMore();
    }

    /**
     * Создаёт/обновляет/убирает кнопку «Загрузить ещё» под таблицей ролей.
     * @private
     */
    static _renderLoadMore() {
        const section = document.querySelector('.admin-roles-section');
        if (!section) return;

        let btn = document.getElementById('adminDirLoadMoreBtn');

        if (this._searchActive || this._dirOffset >= this._dirTotal) {
            if (btn) btn.remove();
            return;
        }

        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'adminDirLoadMoreBtn';
            btn.type = 'button';
            btn.className = 'btn btn-secondary admin-load-more-btn';
            btn.addEventListener('click', () => this._loadMoreDirectory());
            section.appendChild(btn);
        }
        btn.disabled = false;
        const remaining = this._dirTotal - this._dirOffset;
        btn.textContent = `Загрузить ещё (осталось ${remaining})`;
    }

    static updateUserRoles(username, roles) {
        const user = this._usersDirectory.find(u => u.username === username);
        if (user) {
            user.roles = roles;
        } else {
            this._usersDirectory.push({ username, roles });
        }
    }

    /**
     * Инициализирует кнопку добавления пользователя.
     * @private
     */
    static _initAddUserButton() {
        const btn = document.getElementById('adminAddUserBtn');
        if (btn) {
            btn.addEventListener('click', () => {
                AdminAddUserDialog.show(this._allRoles);
            });
        }
    }

    /**
     * Привязывает обработчики переключения tabs.
     * @private
     */
    static _initTabs() {
        const tabs = document.querySelectorAll('.admin-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const name = tab.dataset.tab;
                this._switchTab(name);
            });
        });
    }

    /**
     * Активирует указанный таб и при первом открытии инициализирует
     * соответствующий модуль.
     * @private
     */
    static _switchTab(name) {
        document.querySelectorAll('.admin-tab').forEach(t => {
            const active = t.dataset.tab === name;
            t.classList.toggle('admin-tab--active', active);
            t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('.admin-tab-panel').forEach(p => {
            const active = p.dataset.tabPanel === name;
            p.classList.toggle('admin-tab-panel--active', active);
            if (active) {
                p.removeAttribute('hidden');
            } else {
                p.setAttribute('hidden', '');
            }
        });

        if (this._initializedTabs.has(name)) {
            return;
        }
        this._initializedTabs.add(name);

        if (name === 'diagnostics' && typeof AdminDiagnostics !== 'undefined') {
            AdminDiagnostics.init();
        } else if (name === 'audit-log' && typeof AdminAuditLog !== 'undefined') {
            AdminAuditLog.init();
        }
    }
}

window.AdminPage = AdminPage;
