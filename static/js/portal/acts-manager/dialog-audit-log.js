/**
 * Диалог аудит-лога и версий содержимого акта.
 *
 * Наследует DialogBase для стекирования, анимаций и Escape-обработки.
 * Доступен только для ролей Куратор и Руководитель.
 */
import { LockManager } from '../../constructor/lock-manager.js';
import { VersionPreviewOverlay } from './version-preview.js';
import { APIClient } from '../../shared/api.js';
import { DialogBase } from '../../shared/dialog/dialog-base.js';
import { DialogManager } from '../../shared/dialog/dialog-confirm.js';
import { FilterEngine } from '../../shared/filter-engine.js';
import { Notifications } from '../../shared/notifications.js';
import { VIOLATION_LABELS } from '../../constructor/violation/violation-fields.js';

// Метки полей нарушения в журнале аудита: реестр полей + fieldOrder — атрибут
// нарушения, а не поле реестра (см. VIOLATION_FIELDS в violation-fields.js).
const VIOLATION_CHANGE_LABELS = Object.freeze({ ...VIOLATION_LABELS, fieldOrder: 'Порядок полей' });

export class AuditLogDialog extends DialogBase {
    static _actId = null;
    static _actName = null;
    static _overlay = null;
    static _pageSize = 50;
    static _cachedLog = null;
    static _cachedVersions = null;
    static _logTotal = null;
    static _versionsTotal = null;
    static _logLoading = false;
    static _versionsLoading = false;
    static _filteredLog = [];
    static _lockAcquired = false;

    /**
     * Открывает диалог истории для акта.
     * @param {number} actId
     * @param {string} actName
     */
    static async show(actId, actName) {
        this._actId = actId;
        this._actName = actName;
        this._cachedLog = null;
        this._cachedVersions = null;
        this._logTotal = null;
        this._versionsTotal = null;
        this._logLoading = false;
        this._versionsLoading = false;
        this._filteredLog = [];
        this._lockAcquired = false;

        // Блокируем акт через LockManager (activity tracking, auto-extension, inactivity detection)
        if (typeof LockManager !== 'undefined') {
            try {
                await LockManager.init(actId);
                this._lockAcquired = true;
            } catch (err) {
                if (err.message === 'ACT_LOCKED' || err.message === 'LOCK_FAILED') {
                    return; // LockManager уже показал модал и перенаправил
                }
                console.error('Ошибка блокировки:', err);
            }
        }

        const fragment = this._cloneTemplate('auditLogDialogTemplate');
        if (!fragment) return;

        // Извлекаем overlay из фрагмента ДО вставки в DOM
        this._overlay = fragment.querySelector('.custom-dialog-overlay');
        if (!this._overlay) return;

        // Заголовок
        const title = this._overlay.querySelector('.dialog-title');
        if (title) title.textContent = `История: ${actName}`;

        const dialog = this._overlay.querySelector('.custom-dialog');

        // _showDialog сам добавит overlay в DOM
        this._showDialog(this._overlay);
        this._setupOverlayClickHandler(this._overlay, dialog, () => this._close());
        this._setupEscapeHandler(this._overlay, () => this._close());

        // Кнопка закрытия
        this._overlay.querySelector('[data-action="close"]')
            ?.addEventListener('click', () => this._close());

        // Вкладки
        this._overlay.querySelectorAll('.audit-log-tab').forEach(tab => {
            tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
        });

        // Фильтры
        this._initFilters();

        // Кнопки «Загрузить ещё»
        this._overlay.querySelector('[data-action="load-more-log"]')
            ?.addEventListener('click', () => this._loadMoreLog());
        this._overlay.querySelector('[data-action="load-more-versions"]')
            ?.addEventListener('click', () => this._loadMoreVersions());

        // Загружаем данные
        this._loadInitialLog();
    }

    // =========================================================================
    // ФИЛЬТРЫ
    // =========================================================================

    static _initFilters() {
        if (!this._overlay) return;

        const filters = this._overlay.querySelector('.audit-log-filters');
        if (!filters) return;

        // Клик по чипу — переключить индивидуально
        filters.querySelectorAll('.audit-log-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                chip.classList.toggle('active');
                this._updateGroupState(chip.closest('.audit-log-chip-group'));
                this._updateToggleButton();
                this._onFilterChange();
            });
        });

        // Клик по названию группы — переключить всю группу
        filters.querySelectorAll('.audit-log-group-label').forEach(label => {
            label.addEventListener('click', () => {
                const group = label.closest('.audit-log-chip-group');
                const chips = group.querySelectorAll('.audit-log-chip');
                const allActive = Array.from(chips).every(c => c.classList.contains('active'));
                chips.forEach(c => c.classList.toggle('active', !allActive));
                this._updateGroupState(group);
                this._updateToggleButton();
                this._onFilterChange();
            });
        });

        // «Снять все / Выбрать все»
        const toggleBtn = filters.querySelector('[data-action="toggle-all"]');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this._toggleAllFilters());
        }

        // Дата и пользователь — debounce 300ms: чтобы перерендер не дёргался
        // на каждой нажатой клавише в поле поиска по username.
        if (!this._debouncedFilterChange) {
            let t = null;
            this._debouncedFilterChange = () => {
                if (t) clearTimeout(t);
                t = setTimeout(() => {
                    t = null;
                    this._onFilterChange();
                }, 300);
            };
        }
        filters.querySelectorAll('input[type="date"], input[type="text"]').forEach(input => {
            input.addEventListener('input', () => this._debouncedFilterChange());
        });

        // Сворачивание/раскрытие фильтров
        const collapseBtn = filters.querySelector('[data-action="collapse-filters"]');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', () => {
                filters.classList.toggle('collapsed');
            });
        }
    }

    static _toggleAllFilters() {
        if (!this._overlay) return;
        const chips = this._overlay.querySelectorAll('.audit-log-chip');
        const allActive = Array.from(chips).every(c => c.classList.contains('active'));

        chips.forEach(c => c.classList.toggle('active', !allActive));

        // Обновляем состояния всех групп
        this._overlay.querySelectorAll('.audit-log-chip-group').forEach(g => this._updateGroupState(g));
        this._updateToggleButton();
        this._onFilterChange();
    }

    static _updateToggleButton() {
        if (!this._overlay) return;
        const btn = this._overlay.querySelector('[data-action="toggle-all"]');
        if (!btn) return;
        const chips = this._overlay.querySelectorAll('.audit-log-chip');
        const allActive = Array.from(chips).every(c => c.classList.contains('active'));
        btn.textContent = allActive ? 'Снять все' : 'Выбрать все';
    }

    static _updateGroupState(group) {
        if (!group) return;
        const chips = group.querySelectorAll('.audit-log-chip');
        const allInactive = Array.from(chips).every(c => !c.classList.contains('active'));
        group.classList.toggle('all-inactive', allInactive);
    }

    static _onFilterChange() {
        this._applyFiltersAndRender();
    }

    // =========================================================================
    // ВКЛАДКИ
    // =========================================================================

    static _switchTab(tabName) {
        if (!this._overlay) return;

        this._overlay.querySelectorAll('.audit-log-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabName);
        });
        this._overlay.querySelectorAll('.audit-log-tab-content').forEach(c => {
            c.classList.toggle('hidden', c.dataset.tabContent !== tabName);
        });

        if (tabName === 'versions') {
            if (!this._cachedVersions) this._loadInitialVersions();
            else this._renderVersions();
        } else {
            this._applyFiltersAndRender();
        }
    }

    // =========================================================================
    // ЗАГРУЗКА ДАННЫХ
    // =========================================================================

    static async _loadInitialLog() {
        const list = this._overlay?.querySelector('#auditLogList');
        if (!list) return;

        list.innerHTML = '<div class="audit-log-loading">Загрузка...</div>';
        this._cachedLog = [];
        this._logTotal = null;
        this._hideLoadMore('auditLogLoadMore');

        try {
            const data = await APIClient.getAuditLog(this._actId, {
                limit: this._pageSize,
                offset: 0,
            });
            this._cachedLog = data.items || [];
            this._logTotal = typeof data.total === 'number' ? data.total : this._cachedLog.length;
            this._applyFiltersAndRender();
        } catch (err) {
            console.error('Ошибка загрузки аудит-лога:', err);
            list.innerHTML = '<div class="audit-log-error">Ошибка загрузки</div>';
        }
    }

    static async _loadMoreLog() {
        if (this._logLoading) return;
        if (!Array.isArray(this._cachedLog) || this._logTotal == null) return;
        if (this._cachedLog.length >= this._logTotal) return;

        const btn = this._overlay?.querySelector('[data-action="load-more-log"]');
        const originalText = btn?.textContent;
        this._logLoading = true;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Загружаю...';
        }

        try {
            const data = await APIClient.getAuditLog(this._actId, {
                limit: this._pageSize,
                offset: this._cachedLog.length,
            });
            const newItems = data.items || [];
            this._cachedLog = this._cachedLog.concat(newItems);
            if (typeof data.total === 'number') this._logTotal = data.total;
            this._applyFiltersAndRender();
        } catch (err) {
            console.error('Ошибка загрузки аудит-лога:', err);
            Notifications.error('Не удалось загрузить ещё записи');
        } finally {
            this._logLoading = false;
            if (btn) {
                btn.disabled = false;
                if (originalText) btn.textContent = originalText;
            }
        }
    }

    static _applyFiltersAndRender() {
        if (!this._cachedLog || !this._overlay) return;
        const list = this._overlay.querySelector('#auditLogList');
        if (!list) return;

        // Собираем активные типы действий (chip может покрывать несколько action'ов через CSV).
        const chips = this._overlay.querySelectorAll('.audit-log-chip');
        const activeActions = new Set();
        chips.forEach(c => {
            if (c.classList.contains('active')) {
                c.dataset.value.split(',').forEach(v => activeActions.add(v));
            }
        });

        // Пустое состояние при снятии всех фильтров.
        if (activeActions.size === 0) {
            list.innerHTML = '<div class="audit-log-empty">Выберите хотя бы один тип операции</div>';
            this._hideLoadMore('auditLogLoadMore');
            return;
        }

        const username = this._overlay.querySelector('[data-filter="username"]')?.value?.trim() || '';
        const fromDate = this._overlay.querySelector('[data-filter="from-date"]')?.value || '';
        const toDate = this._overlay.querySelector('[data-filter="to-date"]')?.value || '';

        const filtered = FilterEngine.apply(this._cachedLog, [
            { type: 'set', field: 'action', values: Array.from(activeActions) },
            { type: 'text', field: 'username', query: username },
            { type: 'date-range', field: 'created_at', from: fromDate, to: toDate },
        ]);

        this._filteredLog = filtered;
        this._renderLog();
    }

    static _renderLog() {
        const list = this._overlay?.querySelector('#auditLogList');
        if (!list) return;

        if (this._filteredLog.length === 0) {
            list.innerHTML = '<div class="audit-log-empty">Нет записей</div>';
        } else {
            list.innerHTML = this._filteredLog.map(entry => this._renderEntry(entry)).join('');

            // Обработчики сворачивания changelog
            list.querySelectorAll('.audit-log-changelog-toggle').forEach(btn => {
                btn.addEventListener('click', () => {
                    const target = btn.nextElementSibling;
                    if (target) {
                        target.classList.toggle('hidden');
                        btn.textContent = target.classList.contains('hidden')
                            ? 'Показать подробности'
                            : 'Скрыть подробности';
                    }
                });
            });
        }

        // Load-more управляется загруженным/общим объёмом, не отфильтрованным —
        // иначе после узких фильтров кнопка пропадёт, хотя на сервере ещё есть.
        this._updateLoadMore('auditLogLoadMore', this._cachedLog?.length || 0, this._logTotal || 0);
    }

    static async _loadInitialVersions() {
        const list = this._overlay?.querySelector('#versionsList');
        if (!list) return;

        list.innerHTML = '<div class="audit-log-loading">Загрузка...</div>';
        this._cachedVersions = [];
        this._versionsTotal = null;
        this._hideLoadMore('versionsLoadMore');

        try {
            const data = await APIClient.getVersions(this._actId, {
                limit: this._pageSize, offset: 0,
            });
            this._cachedVersions = data.items || [];
            this._versionsTotal = typeof data.total === 'number' ? data.total : this._cachedVersions.length;
            this._renderVersions();
        } catch (err) {
            console.error('Ошибка загрузки версий:', err);
            list.innerHTML = '<div class="audit-log-error">Ошибка загрузки</div>';
        }
    }

    static async _loadMoreVersions() {
        if (this._versionsLoading) return;
        if (!Array.isArray(this._cachedVersions) || this._versionsTotal == null) return;
        if (this._cachedVersions.length >= this._versionsTotal) return;

        const btn = this._overlay?.querySelector('[data-action="load-more-versions"]');
        const originalText = btn?.textContent;
        this._versionsLoading = true;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Загружаю...';
        }

        try {
            const data = await APIClient.getVersions(this._actId, {
                limit: this._pageSize,
                offset: this._cachedVersions.length,
            });
            const newItems = data.items || [];
            this._cachedVersions = this._cachedVersions.concat(newItems);
            if (typeof data.total === 'number') this._versionsTotal = data.total;
            this._renderVersions();
        } catch (err) {
            console.error('Ошибка загрузки версий:', err);
            Notifications.error('Не удалось загрузить ещё версии');
        } finally {
            this._versionsLoading = false;
            if (btn) {
                btn.disabled = false;
                if (originalText) btn.textContent = originalText;
            }
        }
    }

    static _renderVersions() {
        const list = this._overlay?.querySelector('#versionsList');
        if (!list) return;

        if (!this._cachedVersions?.length) {
            list.innerHTML = '<div class="audit-log-empty">Нет версий</div>';
            this._updateLoadMore('versionsLoadMore', 0, this._versionsTotal || 0);
            return;
        }

        list.innerHTML = this._cachedVersions.map(v => this._renderVersion(v)).join('');

        list.querySelectorAll('[data-action="view-version"]').forEach(btn => {
            btn.addEventListener('click', () => this._viewVersion(parseInt(btn.dataset.versionId)));
        });
        list.querySelectorAll('[data-action="restore-version"]').forEach(btn => {
            btn.addEventListener('click', () => this._restoreVersion(parseInt(btn.dataset.versionId), btn.dataset.versionNumber));
        });

        if (!this._lockAcquired) this._disableRestoreButtons();

        this._updateLoadMore('versionsLoadMore', this._cachedVersions.length, this._versionsTotal || 0);
    }

    // =========================================================================
    // ПРОСМОТР / ВОССТАНОВЛЕНИЕ ВЕРСИЙ
    // =========================================================================

    static async _viewVersion(versionId) {
        try {
            const version = await APIClient.getVersion(this._actId, versionId);
            if (typeof VersionPreviewOverlay !== 'undefined') {
                VersionPreviewOverlay.show(version, this._actName, this._actId);
            }
        } catch (err) {
            console.error('Ошибка загрузки версии:', err);
            Notifications.error('Не удалось загрузить версию');
        }
    }

    static async _restoreVersion(versionId, versionNumber) {
        if (!this._lockAcquired) {
            Notifications.warning('Восстановление невозможно: акт не заблокирован');
            return;
        }

        const confirmed = await DialogManager.show({
            title: 'Восстановление версии',
            message: `Восстановить содержимое из версии #${versionNumber}? Текущее содержимое будет заменено.`,
            icon: '⚠️',
            confirmText: 'Восстановить',
            cancelText: 'Отмена',
            type: 'warning',
        });
        if (!confirmed) return;

        try {
            const result = await APIClient.restoreVersion(this._actId, versionId);
            Notifications.success(result.message || 'Содержимое восстановлено');

            // Инвалидация кешей и перезагрузка с первой страницы
            this._cachedLog = null;
            this._cachedVersions = null;
            this._logTotal = null;
            this._versionsTotal = null;
            this._loadInitialLog();
            this._loadInitialVersions();
        } catch (err) {
            console.error('Ошибка восстановления:', err);
            Notifications.error(err.status === 409
                ? 'Акт заблокирован другим пользователем'
                : `Ошибка: ${err.message}`);
        }
    }

    static _disableRestoreButtons() {
        if (!this._overlay) return;
        this._overlay.querySelectorAll('[data-action="restore-version"]').forEach(btn => {
            btn.disabled = true;
            btn.title = 'Для восстановления необходима блокировка акта';
        });
    }

    // =========================================================================
    // РЕНДЕРИНГ
    // =========================================================================

    static _renderEntry(entry) {
        const date = this._formatDate(entry.created_at);
        const action = this._formatAction(entry.action);
        const details = this._formatDetails(entry.action, entry.details);
        const changelog = this._renderChangelog(entry.changelog, entry.details?.field_changes);

        return `
            <div class="audit-log-entry">
                <div class="audit-log-entry-header">
                    <span class="audit-log-entry-action">${action}</span>
                    <span class="audit-log-entry-meta">${this._escapeHtml(entry.username || '')} &mdash; ${date}</span>
                </div>
                ${details ? `<div class="audit-log-entry-details">${details}</div>` : ''}
                ${changelog}
            </div>
        `;
    }

    static _renderChangelog(changelog, fieldChanges) {
        if ((!changelog || !Array.isArray(changelog) || changelog.length === 0) && !fieldChanges) return '';

        const opLabels = {
            add_node: 'Добавлен узел',
            delete_node: 'Удалён узел',
            move_node: 'Перемещён узел',
            rename_node: 'Переименован узел',
            add_table: 'Добавлена таблица',
            delete_table: 'Удалена таблица',
            modify_table: 'Изменена таблица',
            add_textblock: 'Добавлен текстовый блок',
            modify_textblock: 'Изменён текстовый блок',
            add_violation: 'Добавлено нарушение',
            modify_violation: 'Изменено нарушение',
        };

        const items = (changelog || []).map(e => {
            const label = opLabels[e.op] || e.op;
            const name = e.name ? `: ${this._escapeHtml(e.name)}` : '';
            let detail = '';

            // Если есть field-level детали для этого элемента
            if (fieldChanges && e.id && fieldChanges[e.id]) {
                detail = this._renderFieldChanges(fieldChanges[e.id]);
            }

            return `<li>${label}${name}${detail}</li>`;
        }).join('');

        return `
            <button class="audit-log-changelog-toggle">Показать подробности</button>
            <ul class="audit-log-changelog-list hidden">${items}</ul>
        `;
    }

    static _renderFieldChanges(changes) {
        if (!changes) return '';

        if (changes.type === 'table' && changes.cells?.length) {
            const cellItems = changes.cells.slice(0, 10).map(c => {
                const loc = c.col_name || `кол. ${c.col + 1}`;
                const old = c.old ? `<span class="field-old">${this._escapeHtml(c.old)}</span>` : '—';
                const newVal = c.new ? `<span class="field-new">${this._escapeHtml(c.new)}</span>` : '—';
                return `<li class="field-change-item">Строка ${c.row + 1}, ${this._escapeHtml(loc)}: ${old} → ${newVal}</li>`;
            }).join('');
            const more = changes.cells.length > 10
                ? `<li class="field-change-more">...и ещё ${changes.cells.length - 10}</li>`
                : '';
            return `<ul class="field-changes-list">${cellItems}${more}</ul>`;
        }

        if (changes.type === 'textblock') {
            return `<ul class="field-changes-list"><li class="field-change-item">Содержимое: ${changes.old_length} → ${changes.new_length} символов</li></ul>`;
        }

        if (changes.type === 'violation' && changes.fields) {
            const items = Object.entries(changes.fields)
                .filter(([, v]) => v.changed)
                .map(([k]) => `<li class="field-change-item">Поле «${VIOLATION_CHANGE_LABELS[k] || k}»: изменено</li>`)
                .join('');
            return items ? `<ul class="field-changes-list">${items}</ul>` : '';
        }

        return '';
    }

    static _renderVersion(v) {
        const date = this._formatDate(v.created_at);
        const saveType = this._formatSaveType(v.save_type);

        return `
            <div class="audit-log-entry">
                <div class="audit-log-entry-header">
                    <span class="audit-log-entry-action">Версия #${v.version_number}</span>
                    <span class="audit-log-entry-meta">${saveType} &mdash; ${this._escapeHtml(v.username || '')} &mdash; ${date}</span>
                </div>
                <div class="audit-log-entry-actions">
                    <button class="btn btn-sm btn-secondary" data-action="view-version" data-version-id="${v.id}">
                        Просмотр
                    </button>
                    <button class="btn btn-sm btn-primary" data-action="restore-version" data-version-id="${v.id}" data-version-number="${v.version_number}">
                        Восстановить
                    </button>
                </div>
            </div>
        `;
    }

    static _updateLoadMore(containerId, loaded, total) {
        const container = this._overlay?.querySelector(`#${containerId}`);
        if (!container) return;

        // Скрываем, если всё уже загружено (или всего меньше первой страницы).
        if (!total || loaded >= total) {
            container.hidden = true;
            return;
        }

        const counter = container.querySelector('.load-more-counter');
        if (counter) counter.textContent = `Показано ${loaded} из ${total}`;
        container.hidden = false;
    }

    static _hideLoadMore(containerId) {
        const container = this._overlay?.querySelector(`#${containerId}`);
        if (container) container.hidden = true;
    }

    // =========================================================================
    // ФОРМАТИРОВАНИЕ
    // =========================================================================

    static _formatAction(action) {
        const map = {
            'create': 'Создание акта',
            'update': 'Обновление метаданных',
            'delete': 'Удаление акта',
            'duplicate': 'Дублирование акта',
            'lock': 'Блокировка',
            'unlock': 'Снятие блокировки',
            'content_save': 'Сохранение содержимого',
            'save_invoice': 'Сохранение фактуры',
            'export': 'Экспорт файла',
            'download': 'Скачивание файла',
            'restore': 'Восстановление версии',
        };
        return map[action] || action;
    }

    static _formatDetails(action, details) {
        if (!details || Object.keys(details).length === 0) return '';

        switch (action) {
            case 'update': {
                const parts = [];
                if (details.changes) {
                    for (const [field, vals] of Object.entries(details.changes)) {
                        parts.push(`<b>${field}</b>: ${vals.old || '—'} → ${vals.new || '—'}`);
                    }
                }
                if (details.audit_team_replaced) parts.push('Аудиторская группа обновлена');
                if (details.directives_replaced) parts.push('Поручения обновлены');
                return parts.join('<br>');
            }
            case 'content_save': {
                const parts = [];
                const st = this._formatSaveType(details.save_type);
                parts.push(`Тип: ${st}`);
                if (details.tree) {
                    const t = details.tree;
                    if (t.nodes_added) parts.push(`Узлов добавлено: ${t.nodes_added}`);
                    if (t.nodes_removed) parts.push(`Узлов удалено: ${t.nodes_removed}`);
                }
                for (const [key, label] of [['tables', 'Таблицы'], ['textblocks', 'Текстблоки'], ['violations', 'Нарушения']]) {
                    const t = details[key];
                    if (!t) continue;
                    const s = [];
                    if (t.added) s.push(`+${t.added}`);
                    if (t.removed) s.push(`-${t.removed}`);
                    if (t.existing) s.push(`=${t.existing}`);
                    if (s.length) {
                        let line = `${label}: ${s.join(', ')}`;
                        if (t.added_names?.length) line += ` (${t.added_names.join(', ')})`;
                        parts.push(line);
                    }
                }
                return parts.join('<br>');
            }
            case 'save_invoice':
                return `Узел: ${details.node_id || '—'}, БД: ${details.db_type || '—'}, Таблица: ${details.table_name || '—'}`;
            case 'export':
                return `Формат: ${details.format || '—'}, Файл: ${details.filename || '—'}`;
            case 'download':
                return `Файл: ${details.filename || '—'}`;
            case 'restore':
                return `Из версии #${details.from_version || '—'}`;
            case 'create':
                return `КМ: ${details.km_number || '—'}, Часть: ${details.part_number || '—'}`;
            case 'duplicate':
                return `Из акта #${details.source_act_id || '—'}`;
            default:
                return `<code>${this._escapeHtml(JSON.stringify(details))}</code>`;
        }
    }

    static _formatSaveType(saveType) {
        const map = { 'manual': 'Ручное', 'periodic': 'Периодическое', 'auto': 'Авто' };
        return map[saveType] || saveType;
    }

    static _formatDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        return d.toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    }

    static _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    static async _close() {
        if (this._lockAcquired && typeof LockManager !== 'undefined') {
            try {
                await LockManager.manualUnlock();
            } catch (err) {
                console.error('Ошибка разблокировки:', err);
            }
            this._lockAcquired = false;
        }

        if (this._overlay) {
            this._removeEscapeHandler(this._overlay);
            this._hideDialog(this._overlay);
            this._overlay = null;
        }
        this._cachedLog = null;
        this._cachedVersions = null;
        this._logTotal = null;
        this._versionsTotal = null;
        this._logLoading = false;
        this._versionsLoading = false;
        this._filteredLog = [];
    }
}

// Глобальный доступ
window.AuditLogDialog = AuditLogDialog;
