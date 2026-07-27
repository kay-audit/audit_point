/**
 * Диалог редактирования пользователя (ФИО / Должность / ТБ / email).
 *
 * Открывается по кнопке «Редактировать» в строке таблицы ролей. Позволяет
 * менять только метаданные пользователя — роль-связи редактируются
 * отдельными чипсами в строке, soft-delete — кнопкой «Удалить».
 *
 * Вызывает PUT /api/v1/admin/users/{username}. После успеха — обновляет
 * локальный кеш AdminRoles и закрывается.
 */
import { AdminPage } from './admin-page.js';
import { AdminRoles } from './admin-roles.js';
import { APIClient } from '../../shared/api.js';
import { DialogBase } from '../../shared/dialog/dialog-base.js';
import { Notifications } from '../../shared/notifications.js';

export class AdminEditUserDialog extends DialogBase {
    static _currentDialog = null;
    static _allRoles = [];
    static _tbCodes = [];
    static _tbLoaded = false;

    /**
     * Показывает диалог редактирования пользователя.
     * @param {Object} user - данные пользователя из таблицы
     * @param {Array} allRoles - список ролей (для передачи в onSave)
     */
    static show(user, allRoles) {
        this._allRoles = allRoles || [];
        this._showDialog(this._createDialog(user));
    }

    /**
     * Создаёт DOM диалога
     * @private
     */
    static _createDialog(user) {
        const overlay = this._createOverlay();
        this._currentDialog = overlay;

        overlay.innerHTML = `
            <div class="custom-dialog admin-edit-user-dialog">
                <div class="dialog-header">
                    <h3 class="dialog-title">Редактировать пользователя</h3>
                </div>
                <div class="dialog-body">
                    <div class="admin-edit-form">
                        <label class="admin-edit-field">
                            <span>Логин</span>
                            <input type="text" class="admin-add-search-input"
                                   name="username"
                                   value="${escape(user.username || '')}"
                                   readonly
                                   title="Логин менять нельзя">
                        </label>
                        <label class="admin-edit-field">
                            <span>Фамилия Имя Отчество <span class="required">*</span></span>
                            <input type="text" class="admin-add-search-input"
                                   name="fullname"
                                   value="${escape(user.fullname || '')}"
                                   required
                                   maxlength="255">
                        </label>
                        <label class="admin-edit-field">
                            <span>Должность</span>
                            <input type="text" class="admin-add-search-input"
                                   name="job"
                                   value="${escape(user.job || '')}"
                                   maxlength="255">
                        </label>
                        <label class="admin-edit-field">
                            <span>Email</span>
                            <input type="email" class="admin-add-search-input"
                                   name="email"
                                   value="${escape(user.email || '')}"
                                   maxlength="255">
                        </label>
                        <label class="admin-edit-field">
                            <span>ТБ (территориальный банк)</span>
                            <select class="admin-add-search-input" name="tb">
                                <option value="">— не указан —</option>
                            </select>
                        </label>
                    </div>
                </div>
                <div class="dialog-buttons">
                    <button class="btn btn-secondary dialog-cancel">Отмена</button>
                    <button class="btn btn-primary dialog-confirm">Сохранить</button>
                </div>
            </div>
        `;

        // Подгружаем справочник ТБ с сервера (идемпотентно — загружается один раз).
        this._loadTbCodesIfNeeded(overlay);

        this._bindEvents(overlay, user);
        return overlay;
    }

    /**
     * Ленивая загрузка списка ТБ с сервера и заполнение select.
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
     * Заполняет select ТБ-кодов и подставляет текущее значение пользователя.
     * @private
     */
    static _fillTbSelect(overlay, items) {
        const sel = overlay.querySelector('select[name="tb"]');
        if (!sel) return;
        const current = sel.dataset.current || '';
        sel.innerHTML = '<option value="">— не указан —</option>' +
            items.map((c) => `<option value="${escape(c)}">${escape(c)}</option>`).join('');
        if (current) sel.value = current;
    }

    /**
     * Привязывает обработчики событий
     * @private
     */
    static _bindEvents(overlay, user) {
        const cancelBtn = overlay.querySelector('.dialog-cancel');
        const confirmBtn = overlay.querySelector('.dialog-confirm');
        const tbSel = overlay.querySelector('select[name="tb"]');

        cancelBtn.addEventListener('click', () => this._close());
        confirmBtn.addEventListener('click', () => this._onSave(overlay, user));

        // Сохраняем «текущее» значение в dataset, чтобы после AJAX-загрузки
        // справочника ТБ можно было корректно восстановить выбор.
        if (tbSel) tbSel.dataset.current = user.tb || '';

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this._close();
        });
    }

    /**
     * Подтверждение редактирования — вызов PUT /users/{username}.
     * @private
     */
    static async _onSave(overlay, user) {
        const fullname = overlay.querySelector('input[name="fullname"]').value.trim();
        const job = overlay.querySelector('input[name="job"]').value.trim();
        const email = overlay.querySelector('input[name="email"]').value.trim();
        const tb = overlay.querySelector('select[name="tb"]').value;
        const confirmBtn = overlay.querySelector('.dialog-confirm');

        if (!fullname) {
            Notifications.error('Поле «ФИО» обязательно');
            return;
        }
        confirmBtn.disabled = true;
        try {
            await APIClient.updateUser(user.username, {
                fullname,
                job,
                email,
                tb,
            });
            Notifications.success(`Пользователь ${user.username} обновлён`);

            // Обновим локальный кеш (роли возвращаются без изменений — мы их
            // не трогали). В user-объекте из таблицы уже есть tb; перезатираем.
            const updated = {
                ...user,
                fullname,
                job,
                email,
                tb,
            };
            AdminRoles.addUser(updated);
            AdminPage.updateUserRoles(user.username, user.roles || []);

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

window.AdminEditUserDialog = AdminEditUserDialog;
