/**
 * Управление таблицей ролей пользователей
 *
 * Отображает все строки пользователей с чипсами ролей,
 * обеспечивает назначение/снятие ролей через API,
 * фильтрацию по тексту и ролям, сортировку по столбцам.
 */
import { APIClient } from '../../shared/api.js';
import { Notifications } from '../../shared/notifications.js';

export class AdminRoles {
    static _allRoles = [];
    static _users = [];
    static _tableEl = null;
    static _textFilter = '';
    static _roleFilter = null;
    static _sortField = 'fullname';
    static _sortDir = 'asc';

    /**
     * Инициализирует компонент таблицы ролей
     * @param {Array} allRoles - Список всех доступных ролей
     */
    static init(allRoles) {
        this._allRoles = allRoles;
        this._tableEl = document.getElementById('adminRolesTable');

        this._initSortHandlers();
        this._renderRoleFilters();
    }

    /**
     * Устанавливает массив пользователей и рендерит таблицу
     * @param {Array} users - Полный массив пользователей
     */
    static setUsers(users) {
        this._users = users;
        this._sortUsers();
        this._renderAll();
    }

    /**
     * Фильтрует по роли (toggle)
     * @param {number|null} roleId - ID роли или null для сброса
     */
    static filterByRole(roleId) {
        this._roleFilter = (this._roleFilter === roleId) ? null : roleId;
        this._updateRoleFilterChips();
        this._applyFilters();
    }

    /**
     * Сортирует по полю; при повторном клике — меняет направление
     * @param {string} field - Поле сортировки (fullname, roles, username)
     */
    static sort(field) {
        if (this._sortField === field) {
            this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this._sortField = field;
            this._sortDir = 'asc';
        }

        this._sortUsers();
        this._renderAll();
        this._applyFilters();
        this._renderSortIndicators();
    }

    /**
     * Инициализирует обработчики кликов по заголовкам
     * @private
     */
    static _initSortHandlers() {
        document.querySelectorAll('.admin-header-cell.sortable').forEach(cell => {
            cell.addEventListener('click', () => {
                this.sort(cell.dataset.sort);
            });
        });
        this._renderSortIndicators();
    }

    /**
     * Обновляет индикаторы сортировки в заголовках
     * @private
     */
    static _renderSortIndicators() {
        document.querySelectorAll('.admin-header-cell.sortable').forEach(cell => {
            const indicator = cell.querySelector('.sort-indicator');
            const isActive = cell.dataset.sort === this._sortField;

            cell.classList.toggle('active', isActive);
            if (indicator) {
                indicator.textContent = isActive ? (this._sortDir === 'asc' ? '\u25B2' : '\u25BC') : '';
            }
        });
    }

    /**
     * Рендерит чипсы фильтров по ролям
     * @private
     */
    static _renderRoleFilters() {
        const bar = document.getElementById('adminFilterBar');
        if (!bar) return;

        bar.innerHTML = '';
        for (const role of this._allRoles) {
            const chip = document.createElement('button');
            chip.className = 'admin-filter-chip';
            chip.dataset.roleId = role.id;
            chip.textContent = role.name;
            chip.title = role.description || '';
            chip.addEventListener('click', () => this.filterByRole(role.id));
            bar.appendChild(chip);
        }
    }

    /**
     * Обновляет активное состояние чипсов фильтров
     * @private
     */
    static _updateRoleFilterChips() {
        const bar = document.getElementById('adminFilterBar');
        if (!bar) return;

        bar.querySelectorAll('.admin-filter-chip').forEach(chip => {
            const chipRoleId = parseInt(chip.dataset.roleId);
            chip.classList.toggle('active', chipRoleId === this._roleFilter);
        });
    }

    /**
     * Сортирует массив пользователей
     * @private
     */
    static _sortUsers() {
        const dir = this._sortDir === 'asc' ? 1 : -1;

        this._users.sort((a, b) => {
            switch (this._sortField) {
                case 'fullname':
                    return dir * a.fullname.localeCompare(b.fullname, 'ru');
                case 'roles':
                    return dir * (a.roles.length - b.roles.length);
                case 'username':
                    return dir * a.username.localeCompare(b.username);
                default:
                    return 0;
            }
        });
    }

    /**
     * Рендерит все строки пользователей
     * @private
     */
    static _renderAll() {
        if (!this._tableEl) return;
        this._tableEl.innerHTML = '';

        const fragment = document.createDocumentFragment();
        for (const user of this._users) {
            const row = document.createElement('div');
            row.className = 'admin-roles-row';
            row.dataset.username = user.username;
            row.dataset.fullname = user.fullname || '';
            row.dataset.email = user.email || '';
            row.dataset.department = user.is_department !== false ? '1' : '0';
            row.innerHTML = this._renderRow(user);

            row.querySelectorAll('.admin-role-chip').forEach(chip => {
                chip.addEventListener('click', () => this._toggleRole(user.username, chip));
            });
            row.querySelectorAll('.admin-row-action--reset').forEach(btn => {
                btn.addEventListener('click', () => this._resetPassword(btn.dataset.username));
            });

            fragment.appendChild(row);
        }
        this._tableEl.appendChild(fragment);
    }

    /**
     * Применяет текстовый фильтр и фильтр по роли к строкам (CSS toggle)
     * @private
     */
    static _applyFilters() {
        if (!this._tableEl) return;

        const rows = this._tableEl.querySelectorAll('.admin-roles-row');
        for (const row of rows) {
            const matchesText = this._matchesTextFilter(row);
            const matchesRole = this._matchesRoleFilter(row.dataset.username);
            row.classList.toggle('hidden', !(matchesText && matchesRole));
        }
    }

    /**
     * Проверяет, подходит ли строка под текстовый фильтр
     * @param {HTMLElement} row - DOM-элемент строки
     * @returns {boolean}
     * @private
     */
    static _matchesTextFilter(row) {
        if (!this._textFilter) return true;

        const fullname = (row.dataset.fullname || '').toLowerCase();
        const username = (row.dataset.username || '').toLowerCase();
        const email = (row.dataset.email || '').toLowerCase();

        return fullname.includes(this._textFilter) ||
               username.includes(this._textFilter) ||
               email.includes(this._textFilter);
    }

    /**
     * Проверяет, имеет ли пользователь выбранную роль
     * @param {string} username - Имя пользователя
     * @returns {boolean}
     * @private
     */
    static _matchesRoleFilter(username) {
        if (this._roleFilter === null) return true;

        const user = this._users.find(u => u.username === username);
        if (!user) return false;

        return user.roles.some(r => r.id === this._roleFilter);
    }

    /**
     * Генерирует HTML содержимого строки пользователя
     * @param {Object} user - Данные пользователя
     * @returns {string} HTML строки
     * @private
     */
    static _renderRow(user) {
        const userRoleIds = new Set(user.roles.map(r => r.id));
        const chips = this._allRoles.map(role => {
            const active = userRoleIds.has(role.id);
            return `<button class="admin-role-chip ${active ? 'active' : ''}"
                            data-role-id="${role.id}"
                            title="${this._escapeAttr(role.description || '')}">
                        ${this._escapeHtml(role.name)}
                    </button>`;
        }).join('');

        const externalBadge = user.is_department === false
            ? '<span class="admin-external-badge">внешний</span>'
            : '';

        return `
            <div class="admin-roles-row-info">
                <div class="admin-roles-row-name">
                    ${this._escapeHtml(user.fullname)}${externalBadge}
                </div>
                <div class="admin-roles-row-details">${this._escapeHtml(user.job || '')}</div>
            </div>
            <div class="admin-roles-row-chips">${chips}</div>
            <div class="admin-roles-row-actions">
                <button class="admin-row-action admin-row-action--reset"
                        data-action="reset-password"
                        data-username="${this._escapeHtml(user.username)}"
                        title="Сбросить пароль">🔑 Сброс пароля</button>
            </div>
            <div class="admin-roles-row-username">${this._escapeHtml(user.username)}</div>
        `;
    }

    /**
     * Сброс пароля пользователя — вызывается с кнопки в строке таблицы.
     * Генерирует новый пароль, показывает его админу (один раз).
     * @param {string} username
     * @private
     */
    static async _resetPassword(username) {
        if (!confirm(`Сбросить пароль для пользователя ${username}?\nВсе его активные сессии будут отозваны.`)) {
            return;
        }
        try {
            const r = await APIClient.resetPassword(username);
            prompt(
                `Новый пароль для ${r.username} (скопируйте и передайте пользователю; показывается один раз):`,
                r.new_password
            );
            Notifications.success(`Пароль для ${r.username} сброшен`);
        } catch (err) {
            Notifications.error(`Ошибка: ${err.message}`);
        }
    }

    /**
     * Переключает роль пользователя (назначение/снятие)
     * @param {string} username - Имя пользователя
     * @param {HTMLElement} chip - DOM-элемент чипса роли
     * @private
     */
    static async _toggleRole(username, chip) {
        const roleId = parseInt(chip.dataset.roleId);
        const isActive = chip.classList.contains('active');

        // Оптимистичное обновление UI
        chip.classList.toggle('active');
        chip.disabled = true;

        try {
            if (isActive) {
                await APIClient.removeRole(username, roleId);
            } else {
                await APIClient.assignRole(username, roleId);
            }

            // Обновляем локальное состояние
            const user = this._users.find(u => u.username === username);
            if (user) {
                if (isActive) {
                    user.roles = user.roles.filter(r => r.id !== roleId);
                } else {
                    const role = this._allRoles.find(r => r.id === roleId);
                    if (role) user.roles.push(role);
                }
            }
        } catch (error) {
            // Откат при ошибке: оптимистично сняли/добавили — возвращаем визуал.
            chip.classList.toggle('active');
            Notifications.error(`Ошибка: ${error.message}`);

            // Сверяем локальное состояние с сервером: серверный rollback
            // мог разойтись с нашим оптимистичным изменением (например,
            // другой админ параллельно тронул того же юзера). Берём истину из API.
            try {
                const fresh = await APIClient.getUserRoles(username);
                const user = this._users.find(u => u.username === username);
                if (user && fresh) {
                    user.roles = fresh.roles || [];
                    this._refreshUserRow(user);
                }
            } catch (syncErr) {
                console.error('Не удалось пересинхронизировать роли пользователя:', syncErr);
            }
        } finally {
            chip.disabled = false;
        }
    }

    /**
     * Перерисовывает строку конкретного пользователя без полного _renderAll
     * (нужно после серверной ресинхронизации ролей в catch _toggleRole).
     * @param {Object} user
     * @private
     */
    static _refreshUserRow(user) {
        if (!this._tableEl) return;
        const row = this._tableEl.querySelector(`.admin-roles-row[data-username="${CSS.escape(user.username)}"]`);
        if (!row) return;
        row.innerHTML = this._renderRow(user);
        row.querySelectorAll('.admin-role-chip').forEach(chip => {
            chip.addEventListener('click', () => this._toggleRole(user.username, chip));
        });
        row.querySelectorAll('.admin-row-action--reset').forEach(btn => {
            btn.addEventListener('click', () => this._resetPassword(btn.dataset.username));
        });
    }

    /**
     * Дописывает страницу пользователей (load-more) и перерисовывает таблицу.
     * Дубли по username игнорируются (на случай пересечения страниц).
     * @param {Array} users - Очередная страница пользователей
     */
    static appendUsers(users) {
        const known = new Set(this._users.map(u => u.username));
        for (const user of users) {
            if (!known.has(user.username)) {
                this._users.push(user);
                known.add(user.username);
            }
        }
        this._sortUsers();
        this._renderAll();
        this._applyFilters();
    }

    /**
     * Добавляет пользователя в список и перерисовывает таблицу
     * @param {Object} user - Данные пользователя с ролями
     */
    static addUser(user) {
        const exists = this._users.find(u => u.username === user.username);
        if (exists) {
            exists.roles = user.roles;
        } else {
            this._users.push(user);
        }
        this._sortUsers();
        this._renderAll();
        this._applyFilters();
    }

    /**
     * Экранирует HTML-символы
     * @param {string} str - Исходная строка
     * @returns {string} Экранированная строка
     * @private
     */
    static _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Экранирует символы для HTML-атрибутов
     * @param {string} str - Исходная строка
     * @returns {string} Экранированная строка
     * @private
     */
    static _escapeAttr(str) {
        return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
}

// Экспортируем в глобальную область видимости
window.AdminRoles = AdminRoles;
