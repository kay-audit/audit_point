/**
 * Раздел "Журнал админ-операций" admin-страницы.
 *
 * Загружает записи через `APIClient.loadAdminAuditLog()` с поддержкой
 * фильтров (action / admin_username / target_username / from_date / to_date)
 * и пагинации (limit/offset, max 200 per page — лимит backend).
 *
 * Простая read-only HTML-таблица; никакой inline-редактуры.
 */
import { APIClient } from '../../shared/api.js';

export class AdminAuditLog {
    static PAGE_SIZE = 50;

    static _state = {
        action: '',
        adminUsername: '',
        targetUsername: '',
        fromDate: '',
        toDate: '',
        offset: 0,
        total: 0,
    };
    static _loading = false;

    static init() {
        this._bind();
        this.refresh();
    }

    /** @private */
    static _bind() {
        const apply = document.getElementById('adminAuditApplyBtn');
        const reset = document.getElementById('adminAuditResetBtn');
        const prev = document.getElementById('adminAuditPrevBtn');
        const next = document.getElementById('adminAuditNextBtn');

        if (apply) apply.addEventListener('click', () => {
            this._collectFiltersFromDOM();
            this._state.offset = 0;
            this.refresh();
        });
        if (reset) reset.addEventListener('click', () => this._resetFilters());
        if (prev) prev.addEventListener('click', () => this._page(-1));
        if (next) next.addEventListener('click', () => this._page(1));
    }

    /** @private */
    static _collectFiltersFromDOM() {
        this._state.action = (document.getElementById('adminAuditAction')?.value || '').trim();
        this._state.adminUsername = (document.getElementById('adminAuditAdmin')?.value || '').trim();
        this._state.targetUsername = (document.getElementById('adminAuditTarget')?.value || '').trim();
        this._state.fromDate = document.getElementById('adminAuditFrom')?.value || '';
        this._state.toDate = document.getElementById('adminAuditTo')?.value || '';
    }

    /** @private */
    static _resetFilters() {
        ['adminAuditAction', 'adminAuditAdmin', 'adminAuditTarget',
         'adminAuditFrom', 'adminAuditTo'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        this._state = {
            action: '', adminUsername: '', targetUsername: '',
            fromDate: '', toDate: '', offset: 0, total: 0,
        };
        this.refresh();
    }

    /** @private */
    static _page(delta) {
        const next = this._state.offset + delta * this.PAGE_SIZE;
        if (next < 0) return;
        if (next >= this._state.total && delta > 0) return;
        this._state.offset = next;
        this.refresh();
    }

    static async refresh() {
        if (this._loading) return;
        const container = document.getElementById('adminAuditTable');
        if (!container) return;
        this._loading = true;
        container.textContent = 'Загрузка...';

        try {
            const data = await APIClient.loadAdminAuditLog({
                action: this._state.action || undefined,
                adminUsername: this._state.adminUsername || undefined,
                targetUsername: this._state.targetUsername || undefined,
                fromDate: this._state.fromDate || undefined,
                toDate: this._state.toDate || undefined,
                limit: this.PAGE_SIZE,
                offset: this._state.offset,
            });
            this._state.total = data.total || 0;
            this._render(data.items || []);
            this._updateMeta();
        } catch (err) {
            console.error('AdminAuditLog: ошибка загрузки', err);
            container.textContent = '';
            const msg = document.createElement('div');
            msg.className = 'admin-diagnostics-error';
            msg.textContent = `Не удалось загрузить журнал: ${err.message || err}`;
            container.appendChild(msg);
        } finally {
            this._loading = false;
        }
    }

    /** @private */
    static _render(items) {
        const container = document.getElementById('adminAuditTable');
        container.textContent = '';

        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'admin-diagnostics-empty';
            empty.textContent = 'Записей по заданным фильтрам не найдено.';
            container.appendChild(empty);
            return;
        }

        const table = document.createElement('table');
        table.className = 'admin-audit-log-table';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Дата</th>
                    <th>Action</th>
                    <th>Администратор</th>
                    <th>Цель</th>
                    <th>Роль</th>
                    <th>Детали</th>
                </tr>
            </thead>
        `;
        const tbody = document.createElement('tbody');
        for (const it of items) {
            const tr = document.createElement('tr');
            tr.appendChild(this._cell(this._formatDate(it.created_at)));
            tr.appendChild(this._cell(it.action || '—'));
            tr.appendChild(this._cell(it.admin_username || '—'));
            tr.appendChild(this._cell(it.target_username || '—'));
            tr.appendChild(this._cell(it.role_name || (it.role_id != null ? `#${it.role_id}` : '—')));
            tr.appendChild(this._cell(it.details || ''));
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        container.appendChild(table);
    }

    /** @private */
    static _updateMeta() {
        const total = document.getElementById('adminAuditTotal');
        const info = document.getElementById('adminAuditPageInfo');
        const prev = document.getElementById('adminAuditPrevBtn');
        const next = document.getElementById('adminAuditNextBtn');

        if (total) total.textContent = `Всего: ${this._state.total}`;
        const page = Math.floor(this._state.offset / this.PAGE_SIZE) + 1;
        const lastPage = Math.max(1, Math.ceil(this._state.total / this.PAGE_SIZE));
        if (info) info.textContent = `${page} / ${lastPage}`;
        if (prev) prev.disabled = this._state.offset <= 0;
        if (next) next.disabled = this._state.offset + this.PAGE_SIZE >= this._state.total;
    }

    /** @private */
    static _cell(text) {
        const td = document.createElement('td');
        td.textContent = text == null ? '' : String(text);
        return td;
    }

    /** @private */
    static _formatDate(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return iso;
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
                + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        } catch {
            return iso;
        }
    }
}

window.AdminAuditLog = AdminAuditLog;
