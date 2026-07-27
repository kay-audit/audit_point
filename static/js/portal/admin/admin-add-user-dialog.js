/**
 * Диалог добавления нового пользователя.
 *
 * По требованию: позволяет добавлять нового пользователя прямо в БД,
 * указав Фамилию, Имя, Отчество, Должность, Логин, ТБ.
 *
 * POST /api/v1/admin/users — создание пользователя + опциональные роли.
 * Роли по умолчанию НЕ включают «Администратор» (это особая роль,
 * выдаваемая только осознанно через существующие чипсы ролей).
 */
import { AdminPage } from './admin-page.js';
import { AdminRoles } from './admin-roles.js';
import { APIClient } from '../../shared/api.js';
import { DialogBase } from '../../shared/dialog/dialog-base.js';
import { Notifications } from '../../shared/notifications.js';

export class AdminAddUserDialog extends DialogBase {
    static _currentDialog = null;
    static _allRoles = [];
    static _tbCodes = [];
    static _tbLoaded = false;

    /**
     * Показывает диалог добавления пользователя.
     * @param {Array} allRoles - список всех доступных ролей (для чекбоксов)
     */
    static show(allRoles) {
        this._allRoles = allRoles || [];
        this._showDialog(this._createDialog());
    }

    /**
     * Создаёт DOM диалога.
     * @private
     */
    static _createDialog() {
        const overlay = this._createOverlay();
        this._currentDialog = overlay;

        // По умолчанию выбраны все роли КРОМЕ «Администратор» — это
        // требование заказчика: «у пользователя должны быть все права
        // кроме роли Администратор».
        const roleCheckboxes = this._allRoles
            .filter((r) => r.name !== 'Администратор')
            .map((r) => `
                <label class="admin-add-role-checkbox" title="${escape(r.description || '')}">
                    <input type="checkbox" name="role_ids" value="${r.id}" checked>
                    <span>${escape(r.name)}</span>
                </label>
            `).join('');

        overlay.innerHTML = `
            <div class="custom-dialog admin-add-user-dialog">
                <div class="dialog-header">
                    <h3 class="dialog-title">Добавить пользователя</h3>
                </div>
                <div class="dialog-body">
                    <div class="admin-add-form">
                        <div class="admin-add-form-row">
                            <label class="admin-edit-field">
                                <span>Фамилия <span class="required">*</span></span>
                                <input type="text" class="admin-add-search-input"
                                       name="lastname" required maxlength="100"
                                       autocomplete="off">
                            </label>
                            <label class="admin-edit-field">
                                <span>Имя <span class="required">*</span></span>
                                <input type="text" class="admin-add-search-input"
                                       name="firstname" required maxlength="100"
                                       autocomplete="off">
                            </label>
                            <label class="admin-edit-field">
                                <span>Отчество</span>
                                <input type="text" class="admin-add-search-input"
                                       name="middlename" maxlength="100"
                                       autocomplete="off">
                            </label>
                        </div>
                        <label class="admin-edit-field">
                            <span>Должность</span>
                            <input type="text" class="admin-add-search-input"
                                   name="job" maxlength="255"
                                   autocomplete="off">
                        </label>
                        <div class="admin-add-form-row">
                            <label class="admin-edit-field">
                                <span>Логин <span class="required">*</span></span>
                                <input type="text" class="admin-add-search-input"
                                       name="username" required minlength="5"
                                       maxlength="20" inputmode="numeric"
                                       pattern="\\d{5,20}"
                                       title="Числовой логин (5-20 цифр)"
                                       placeholder="например, 22494524"
                                       autocomplete="off">
                            </label>
                            <label class="admin-edit-field">
                                <span>ТБ (территориальный банк)</span>
                                <select class="admin-add-search-input" name="tb">
                                    <option value="">— не указан —</option>
                                </select>
                            </label>
                        </div>
                        <div class="admin-add-roles-section">
                            <div class="admin-add-roles-label">
                                Назначить роли по умолчанию <span class="hint">(все, кроме «Администратор»)</span>:
                            </div>
                            <div class="admin-add-roles-list">${roleCheckboxes}</div>
                        </div>
                    </div>
                </div>
                <div class="dialog-buttons">
                    <button class="btn btn-secondary dialog-cancel">Отмена</button>
                    <button class="btn btn-primary dialog-confirm">Добавить</button>
                </div>
            </div>
        `;

        this._loadTbCodesIfNeeded(overlay);
        this._bindEvents(overlay);
        return overlay;
    }

    /**
     * Ленивая загрузка ТБ-кодов.
     * @private
     */
    static async _loadTbCodesIfNeeded(overlay) {
        if (this._tbLoaded) {
            this._fillTbSelect(overlay, this._tbCodes);
            return;
        }
        try {
            const r = await APIClient.getTbCodes();
            this._tbCodes = r.items || [];
            this._tbLoaded = true;
            this._fillTbSelect(overlay, this._tbCodes);
        } catch (err) {
            Notifications.error(`Не удалось загрузить справочник ТБ: ${err.message}`);
        }
    }

    /**
     * Заполняет select ТБ.
     * @private
     */
    static _fillTbSelect(overlay, items) {
        const sel = overlay.querySelector('select[name="tb"]');
        if (!sel) return;
        sel.innerHTML = '<option value="">— не указан —</option>' +
            items.map((c) => `<option value="${escape(c)}">${escape(c)}</option>`).join('');
    }

    /**
     * Привязывает обработчики событий.
     * @private
     */
    static _bindEvents(overlay) {
        const cancelBtn = overlay.querySelector('.dialog-cancel');
        const confirmBtn = overlay.querySelector('.dialog-confirm');

        cancelBtn.addEventListener('click', () => this._close());
        confirmBtn.addEventListener('click', () => this._onConfirm(overlay));

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this._close();
        });

        // Фокус на первом поле — на фамилии
        setTimeout(() => {
            const first = overlay.querySelector('input[name="lastname"]');
            if (first) first.focus();
        }, 100);
    }

    /**
     * Подтверждение создания — POST /users.
     * @private
     */
    static async _onConfirm(overlay) {
        const lastname = overlay.querySelector('input[name="lastname"]').value.trim();
        const firstname = overlay.querySelector('input[name="firstname"]').value.trim();
        const middlename = overlay.querySelector('input[name="middlename"]').value.trim();
        const job = overlay.querySelector('input[name="job"]').value.trim();
        const username = overlay.querySelector('input[name="username"]').value.trim();
        const tb = overlay.querySelector('select[name="tb"]').value;
        const confirmBtn = overlay.querySelector('.dialog-confirm');

        if (!lastname || !firstname) {
            Notifications.error('Поля «Фамилия» и «Имя» обязательны');
            return;
        }
        if (!username) {
            Notifications.error('Поле «Логин» обязательно');
            return;
        }
        if (!/^\d{5,20}$/.test(username)) {
            Notifications.error('Логин должен быть числовым (5-20 цифр)');
            return;
        }

        // Собираем ФИО в формате «Фамилия Имя Отчество» (отчество может быть пустым).
        const fullname = middlename
            ? `${lastname} ${firstname} ${middlename}`.replace(/\s+/g, ' ').trim()
            : `${lastname} ${firstname}`.trim();

        // Собираем выбранные роли (чекбоксы).
        const checkedBoxes = overlay.querySelectorAll(
            'input[name="role_ids"]:checked',
        );
        const roleIds = Array.from(checkedBoxes).map((cb) => parseInt(cb.value, 10));

        confirmBtn.disabled = true;
        try {
            await APIClient.createUser({
                username,
                fullname,
                job,
                tb,
                role_ids: roleIds,
            });
            Notifications.success(`Пользователь ${username} создан`);

            // Полностью перезагрузим каталог пользователей, чтобы новая
            // запись сразу появилась в таблице. Точечный addUser тут
            // не подойдёт — нам нужно знать реальный список ролей с сервера.
            try {
                const directory = await APIClient.loadUserDirectory(200, 0, '');
                AdminRoles.setUsers(directory.items || []);
            } catch (e) {
                // Если reload не удался — добавляем точечно, чтобы UI не пустовал.
                AdminRoles.addUser({
                    username,
                    fullname,
                    job,
                    tb,
                    is_department: true,
                    is_deleted: false,
                    roles: this._allRoles.filter((r) => roleIds.includes(r.id)),
                });
            }
            AdminPage.updateUserRoles(username, this._allRoles.filter((r) => roleIds.includes(r.id)));

            this._close();
        } catch (err) {
            Notifications.error(`Ошибка: ${err.message}`);
            confirmBtn.disabled = false;
        }
    }

    /**
     * Закрывает диалог
     * @private
     */
    static _close() {
        if (this._currentDialog) {
            this._hideDialog(this._currentDialog);
            this._currentDialog = null;
        }
    }
}

function escape(s) {
    const map = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
    return String(s || '').replace(/[&<>"']/g, (c) => map[c]);
}

window.AdminAddUserDialog = AdminAddUserDialog;
