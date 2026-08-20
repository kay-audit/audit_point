/**
 * Полноэкранный предпросмотр версии содержимого.
 * Стекируется поверх AuditLogDialog через DialogBase._activeDialogs.
 */
import { PreviewTableRenderer } from '../../constructor/preview/preview-table-renderer.js';
import { PreviewTextBlockRenderer } from '../../constructor/preview/preview-textblock-renderer.js';
import { PreviewViolationRenderer } from '../../constructor/preview/preview-violation-renderer.js';
import { tableTitleUnderlined } from '../../constructor/table/table-title.js';
import { AuditLogDialog } from './dialog-audit-log.js';
import { DiffEngine } from './diff-engine.js';
import { DiffRenderer } from './diff-renderer.js';
import { APIClient } from '../../shared/api.js';
import { DialogBase } from '../../shared/dialog/dialog-base.js';
import { DialogManager } from '../../shared/dialog/dialog-confirm.js';
import { Notifications } from '../../shared/notifications.js';

export class VersionPreviewOverlay extends DialogBase {
    static _overlay = null;
    static _viewMode = 'ui';
    static _actId = null;
    static _versionData = null;
    static _currentContent = null;
    static _diffResult = null;
    static _diffMode = 'all';

    /**
     * Показать предпросмотр версии.
     * @param {Object} versionData - Полный снэпшот версии
     * @param {string} actName - Название акта
     * @param {number} actId - ID акта
     */
    static show(versionData, actName, actId) {
        this._versionData = versionData;
        this._actId = actId;
        this._viewMode = 'ui';
        this._currentContent = null;
        this._diffResult = null;
        this._diffMode = 'all';

        const fragment = this._cloneTemplate('versionPreviewTemplate');
        if (!fragment) return;

        // Извлекаем overlay из фрагмента ДО вставки в DOM
        this._overlay = fragment.querySelector('.custom-dialog-overlay');
        if (!this._overlay) return;

        // Заполняем мета-информацию
        const titleEl = this._overlay.querySelector('[data-field="title"]');
        if (titleEl) titleEl.textContent = `Версия #${versionData.version_number} — ${actName}`;

        const metaEl = this._overlay.querySelector('[data-field="meta"]');
        if (metaEl) {
            const saveTypes = { manual: 'Ручное', periodic: 'Периодическое', auto: 'Авто' };
            const date = new Date(versionData.created_at).toLocaleString('ru-RU', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
            });
            metaEl.textContent = `${saveTypes[versionData.save_type] || versionData.save_type} | ${versionData.username} | ${date}`;
        }

        const container = this._overlay.querySelector('.version-preview-container');

        // _showDialog сам добавит overlay в DOM
        this._showDialog(this._overlay);
        this._setupEscapeHandler(this._overlay, () => this._close());
        this._setupOverlayClickHandler(this._overlay, container, () => this._close());

        // Кнопки закрытия
        this._overlay.querySelectorAll('[data-action="close"]').forEach(btn => {
            btn.addEventListener('click', () => this._close());
        });

        // Toggle UI / JSON / Diff
        this._overlay.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => this._switchView(btn.dataset.view));
        });

        // Diff mode toggle
        this._overlay.querySelectorAll('.diff-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => this._switchDiffMode(btn.dataset.diffMode));
        });

        // Кнопка восстановления
        this._overlay.querySelector('[data-action="restore"]')
            ?.addEventListener('click', () => this._restore(versionData.id, versionData.version_number));

        // Рендерим UI-представление
        this._renderUIView(this._overlay.querySelector('.version-preview-ui'), versionData);
        this._renderJSONView(this._overlay.querySelector('.version-preview-json pre'), versionData);
    }

    /**
     * Переключение UI / JSON / Diff
     * @param {string} mode - 'ui', 'json' или 'diff'
     */
    static _switchView(mode) {
        if (!this._overlay) return;
        this._viewMode = mode;

        this._overlay.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === mode);
        });

        const containers = {
            ui: this._overlay.querySelector('.version-preview-ui'),
            json: this._overlay.querySelector('.version-preview-json'),
            diff: this._overlay.querySelector('.version-preview-diff'),
        };
        for (const [key, el] of Object.entries(containers)) {
            if (el) el.classList.toggle('hidden', key !== mode);
        }

        // Diff-контролы видны только в режиме diff
        const diffControls = this._overlay.querySelector('.diff-controls');
        if (diffControls) diffControls.classList.toggle('hidden', mode !== 'diff');

        // Лениво загружаем текущий контент при первом переключении на diff
        if (mode === 'diff') {
            this._loadAndRenderDiff();
        }
    }

    /**
     * Загружает текущее содержимое и вычисляет diff.
     */
    static async _loadAndRenderDiff() {
        const diffContent = this._overlay?.querySelector('.diff-content');
        if (!diffContent) return;

        // Если diff уже вычислен — просто рендерим
        if (this._diffResult) {
            this._applyDiffRender(diffContent);
            return;
        }

        diffContent.innerHTML = '<div class="audit-log-loading">Загрузка текущего содержимого...</div>';

        try {
            const resp = await APIClient.loadActContentRaw(this._actId);
            this._currentContent = resp;

            this._diffResult = DiffEngine.compute(
                {
                    tree_data: this._versionData.tree_data,
                    tables_data: this._versionData.tables_data,
                    textblocks_data: this._versionData.textblocks_data,
                    violations_data: this._versionData.violations_data,
                    // Старая сторона фактур — блоб снимка (у версий до миграции
                    // отсутствует → движок трактует как {}).
                    invoices_data: this._versionData.invoices_data,
                },
                {
                    tree: resp.tree,
                    tables: resp.tables,
                    textBlocks: resp.textBlocks,
                    violations: resp.violations,
                    // Новая сторона — текущие фактуры акта (GET /acts/{id}/content
                    // отдаёт их как {node_id: реквизиты}).
                    invoices: resp.invoices,
                }
            );

            this._applyDiffRender(diffContent);
        } catch (err) {
            console.error('Ошибка загрузки для сравнения:', err);
            diffContent.innerHTML = '<div class="audit-log-error">Ошибка загрузки текущего содержимого</div>';
        }
    }

    /**
     * Рендерит diff или сообщение об отсутствии изменений.
     */
    static _applyDiffRender(container) {
        const diffControls = this._overlay?.querySelector('.diff-controls');

        if (!this._diffResult.hasChanges) {
            if (diffControls) diffControls.classList.add('hidden');
            // Деактивируем кнопку восстановления — версия идентична текущему содержимому
            const restoreBtn = this._overlay?.querySelector('[data-action="restore"]');
            if (restoreBtn) {
                restoreBtn.disabled = true;
                restoreBtn.title = 'Версия идентична текущему содержимому';
            }
            container.innerHTML = `
                <div class="diff-no-changes">
                    <div class="diff-no-changes-icon">\u2713</div>
                    <div class="diff-no-changes-title">Изменений нет</div>
                    <div class="diff-no-changes-subtitle">
                        Версия #${this._versionData.version_number} идентична текущему содержимому
                    </div>
                </div>`;
            return;
        }

        if (diffControls) diffControls.classList.remove('hidden');
        DiffRenderer.render(container, this._diffResult, this._diffMode === 'changes-only');
    }

    /**
     * Переключение подрежимов diff.
     */
    static _switchDiffMode(mode) {
        this._diffMode = mode;
        const diffContent = this._overlay?.querySelector('.diff-content');
        if (diffContent && this._diffResult) {
            this._applyDiffRender(diffContent);
        }
        this._overlay?.querySelectorAll('.diff-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.diffMode === mode);
        });
    }

    /**
     * Рендерит UI-представление дерева и содержимого
     */
    static _renderUIView(container, data) {
        if (!container) return;
        container.innerHTML = '';

        const tree = data.tree_data;
        if (!tree) {
            container.innerHTML = '<div class="audit-log-empty">Нет данных дерева</div>';
            return;
        }

        this._renderNode(container, tree, data, 0);
    }

    /**
     * Рекурсивный рендер узла дерева
     * @param {string|null} [rootSectionId=null] - ID раздела верхнего уровня,
     *   в поддереве которого идёт рендер (null на корне). Нужен правилу
     *   оформления подписи таблиц (table-title.js).
     */
    static _renderNode(container, node, data, depth, rootSectionId = null) {
        if (!node) return;

        const type = node.type || 'item';

        if (type === 'item' || !node.type) {
            // Заголовок пункта
            const level = Math.min(depth + 1, 5);
            const heading = document.createElement(`h${level}`);
            heading.className = 'version-preview-heading';
            const number = node.number ? `${node.number}. ` : '';
            heading.textContent = `${number}${node.label || ''}`;
            container.appendChild(heading);
        }

        if (type === 'table' && node.tableId) {
            const tableData = data.tables_data?.[node.tableId];
            if (tableData && typeof PreviewTableRenderer !== 'undefined') {
                const label = document.createElement('div');
                // Подпись таблицы подчиняется общему правилу оформления
                // (table-title.js): обычное начертание, подчёркивание — только
                // у пресетных таблиц разделов 1–4. Метки текстблока и
                // нарушения ниже остаются интерфейсными, они не подписи таблиц.
                label.className = tableTitleUnderlined(node, rootSectionId)
                    ? 'version-preview-label version-preview-label--table version-preview-label--underline'
                    : 'version-preview-label version-preview-label--table';
                label.textContent = node.customLabel || node.number || node.label || 'Таблица';
                container.appendChild(label);
                container.appendChild(PreviewTableRenderer.create(tableData));
            }
        }

        if (type === 'textblock' && node.textBlockId) {
            const tbData = data.textblocks_data?.[node.textBlockId];
            if (tbData && typeof PreviewTextBlockRenderer !== 'undefined') {
                const label = document.createElement('div');
                label.className = 'version-preview-label';
                label.textContent = node.customLabel || node.number || node.label || 'Текстовый блок';
                container.appendChild(label);
                container.appendChild(PreviewTextBlockRenderer.create(tbData));
            }
        }

        if (type === 'violation' && node.violationId) {
            const vData = data.violations_data?.[node.violationId];
            if (vData && typeof PreviewViolationRenderer !== 'undefined') {
                const label = document.createElement('div');
                label.className = 'version-preview-label';
                label.textContent = node.customLabel || node.number || node.label || 'Нарушение';
                container.appendChild(label);
                container.appendChild(PreviewViolationRenderer.create(vData));
            }
        }

        // Рекурсия по children. Дети корня — разделы верхнего уровня: каждый
        // открывает свой раздел, который наследует всё его поддерево.
        if (node.children) {
            for (const child of node.children) {
                this._renderNode(
                    container, child, data, depth + 1, rootSectionId ?? child.id,
                );
            }
        }
    }

    /**
     * Рендерит JSON-представление
     */
    static _renderJSONView(preEl, data) {
        if (!preEl) return;
        const json = JSON.stringify({
            tree: data.tree_data,
            tables: data.tables_data,
            textblocks: data.textblocks_data,
            violations: data.violations_data,
        }, null, 2);

        preEl.textContent = json;
    }

    /**
     * Восстановление из версии
     */
    static async _restore(versionId, versionNumber) {
        const confirmed = await DialogManager.show({
            title: 'Восстановление версии',
            message: `Восстановить содержимое из версии #${versionNumber}? Текущее содержимое будет заменено.`,
            icon: '\u26a0\ufe0f',
            confirmText: 'Восстановить',
            cancelText: 'Отмена',
            type: 'warning',
        });
        if (!confirmed) return;

        try {
            // Lock уже держит родительский AuditLogDialog (LockManager.init при show).
            // Повторный lockAct + unlockAct в finally глобально снимет блокировку —
            // LockManager-heartbeat начнёт получать «вы не владеете блокировкой»
            // и через 1-2 мин выкинет юзера фейковой «Сессия завершена».
            const result = await APIClient.restoreVersion(this._actId, versionId);
            Notifications.success(result.message || 'Содержимое восстановлено');

            // Закрываем превью и обновляем диалог
            this._close();

            // Обновляем данные в AuditLogDialog если он открыт
            if (typeof AuditLogDialog !== 'undefined' && AuditLogDialog._overlay) {
                AuditLogDialog._loadInitialLog();
                AuditLogDialog._loadInitialVersions();
            }
        } catch (err) {
            console.error('Ошибка восстановления:', err);
            if (err.status === 409) {
                Notifications.error('Акт заблокирован другим пользователем');
            } else {
                Notifications.error(`Ошибка: ${err.message}`);
            }
        }
    }

    static _close() {
        if (this._overlay) {
            this._removeEscapeHandler(this._overlay);
            this._hideDialog(this._overlay);
            this._overlay = null;
        }
        this._currentContent = null;
        this._diffResult = null;
    }
}

// Глобальный доступ
window.VersionPreviewOverlay = VersionPreviewOverlay;
