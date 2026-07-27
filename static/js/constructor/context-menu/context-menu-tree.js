/**
 * Обработчик контекстного меню для дерева.
 */
import { ContextMenuManager } from './context-menu-core.js';
import { InvoiceDialog } from '../dialog/dialog-invoice.js';
import { ItemsRenderer } from '../items/items-renderer.js';
import { PreviewManager } from '../preview/preview.js';
import { MetricsRiskCoordinator } from '../state/metrics-risk-coordinator.js';
import { UndoDeleteManager } from '../state/undo-delete.js';
import { AppState } from '../state/state-core.js';
import { TreeUtils } from '../tree/tree-utils.js';
import {
    KIND_MAIN_METRICS,
    KIND_METRICS,
    KIND_OPERATIONAL_RISK,
    KIND_OTHER_RISK,
    KIND_REGULAR_RISK,
    KIND_TAX_RISK,
    isRiskTable as kindIsRiskTable,
} from '../table/table-kind.js';
import { shouldHaveMetricsTable, shouldHaveMainMetrics } from '../state/metrics-risk-core.js';
import { AppConfig } from '../../shared/app-config.js';
import { DialogManager } from '../../shared/dialog/dialog-confirm.js';
import { Notifications } from '../../shared/notifications.js';

export class TreeContextMenu {
    constructor(menu) {
        this.menu = menu;
        this.initHandlers();
    }

    /** Инициализация пунктов меню */
    initHandlers() {
        this.menu.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                if (item.classList.contains('disabled')) return;

                const action = item.dataset.action;
                this.handleAction(action);
                ContextMenuManager.hide();
            });
        });
    }

    /** Отображение меню и обновление состояния */
    show(x, y, params = {}) {
        const {nodeId} = params;
        this.updateMenuState(nodeId);
        ContextMenuManager.positionMenu(this.menu, x, y);
    }

    /** Обновляет доступность пунктов меню */
    updateMenuState(nodeId) {
        if (!nodeId) return;

        const node = AppState.findNodeById(nodeId);
        if (!node) return;

        const riskItems = [
            ['add-regular-risk-table',     'regular'],
            ['add-operational-risk-table', 'operational'],
            ['add-tax-risk-table',         'tax'],
            ['add-other-risk-table',       'other'],
        ];
        for (const [action, riskType] of riskItems) {
            const item = this.menu.querySelector(`[data-action="${action}"]`);
            if (!item) continue;
            const allowed = this._isRiskTableAllowedForNode(node, riskType);
            item.classList.toggle('disabled', !allowed);
        }

        // Показываем "Приложить фактуру" только для leaf-узлов раздела 5
        const attachInvoiceItem = this.menu.querySelector('[data-action="attach-invoice"]');
        const attachInvoiceSeparator = this.menu.querySelector('[data-action="attach-invoice-separator"]');
        const showInvoice = TreeUtils.isTbLeaf(node);
        if (attachInvoiceItem) attachInvoiceItem.style.display = showInvoice ? '' : 'none';
        if (attachInvoiceSeparator) attachInvoiceSeparator.style.display = showInvoice ? '' : 'none';

        // Меняем текст пункта в зависимости от наличия фактуры
        if (attachInvoiceItem && showInvoice) {
            const hasInvoice = !!node.invoice;
            attachInvoiceItem.textContent = hasInvoice
                ? '📎 Изменить информацию о фактуре'
                : '📎 Приложить фактуру';
        }

        // Блокируем добавление подпунктов для всех 5.*, если где-либо на 5.* есть таблицы рисков
        const addChildItem = this.menu.querySelector('[data-action="add-child"]');
        if (addChildItem) {
            const isAddChildBlocked = node.number?.match(/^5\.\d+$/) && this._hasRiskTablesAtLevel5x();
            addChildItem.classList.toggle('disabled', !!isAddChildBlocked);
        }

        // Под пунктом Process Mining нельзя добавлять нарушения (паритет с addViolationToNode).
        const addViolationItem = this.menu.querySelector('[data-action="add-violation"]');
        if (addViolationItem) {
            addViolationItem.classList.toggle('disabled', !!AppState._isUnderProcessMining(nodeId));
        }

        // На 0 уровне «Добавить соседний пункт» превращается в «Добавить пункт: Process Mining».
        const siblingItem = this.menu.querySelector('[data-action="add-sibling"]');
        if (siblingItem) {
            const parent = AppState.findParentNode(nodeId);
            const isLevelZero = parent?.id === 'root';
            const pmExists = !!AppState.treeData?.children?.some(c => c.special === 'process_mining');
            if (isLevelZero) {
                siblingItem.innerHTML = '<span aria-hidden="true">➕</span> Добавить пункт: Process Mining';
                siblingItem.classList.toggle('disabled', pmExists);
            } else {
                siblingItem.innerHTML = '<span aria-hidden="true">➕</span> Добавить соседний пункт';
                // На уровне подпунктов 5.X.X соседний пункт запрещён, если в §5 есть
                // риски на уровне пунктов (паритет с handleAddSibling).
                const blocked = node.number?.match(/^5\.\d+\./) && this._hasRiskTablesAtLevel5x();
                siblingItem.classList.toggle('disabled', !!blocked);
            }
        }

        // Доступность инъецированных пунктов «Копировать»/«Вставить» (clipboard).
        window.NodeClipboard?.refreshMenuState?.(node);
    }

    /**
     * Проверяет, разрешено ли создавать таблицу риска данного типа на узле.
     * Ограничение «одна на пункт» — теперь per-type (на одном узле может быть
     * по одной каждого типа: regular + operational + tax + other).
     * Иерархические ограничения остаются общими, не per-type.
     *
     * @param {Object} node
     * @param {'regular'|'operational'|'tax'|'other'} riskType
     */
    _isRiskTableAllowedForNode(node, riskType) {
        if (node.type && node.type !== AppConfig.nodeTypes.ITEM) return false;
        if (!node.number) return false;
        if (!/^5\.\d+/.test(node.number)) return false;
        // Нельзя создать вторую таблицу ОДНОГО типа на одном узле
        if (this._hasDirectRiskTableOfType(node, riskType)) return false;
        // Иерархические — общие (любая risk-таблица под 5.X.X блокирует 5.X)
        if (node.number.match(/^5\.\d+$/) && this._hasRiskTablesBelowLevel5x()) return false;
        if (node.number.match(/^5\.\d+\.\d+/) && this._hasRiskTablesAtLevel5x()) return false;
        return true;
    }

    /** Возвращает причину блокировки создания таблицы рисков */
    _getRiskTableBlockReason(node, riskType) {
        const typeLabels = {
            regular:     'регуляторного',
            operational: 'операционного',
            tax:         'налогового',
            other:       'прочего',
        };
        if (this._hasDirectRiskTableOfType(node, riskType)) {
            const label = typeLabels[riskType] || 'этого';
            return `На одном пункте может быть только одна таблица ${label} риска`;
        }
        if (node.number?.match(/^5\.\d+$/) && this._hasRiskTablesBelowLevel5x()) {
            return 'Нельзя создать таблицу рисков: в подпунктах раздела 5 уже есть таблицы рисков';
        }
        if (node.number?.match(/^5\.\d+\.\d+/) && this._hasRiskTablesAtLevel5x()) {
            return 'Нельзя создать таблицу рисков: в пунктах раздела 5 уже есть таблицы рисков';
        }
        return 'Таблицы рисков можно создавать только в подпунктах раздела 5';
    }

    /** Проверяет, есть ли у узла прямая дочерняя таблица риска данного типа. */
    _hasDirectRiskTableOfType(node, riskType) {
        if (!node.children) return false;
        const kindByType = {
            'regular':     KIND_REGULAR_RISK,
            'operational': KIND_OPERATIONAL_RISK,
            'tax':         KIND_TAX_RISK,
            'other':       KIND_OTHER_RISK,
        };
        const kind = kindByType[riskType];
        if (!kind) return false;
        return node.children.some(child => child.type === AppConfig.nodeTypes.TABLE && child.kind === kind);
    }

    /**
     * Есть ли вообще риск-таблица среди прямых детей узла (все 4 типа,
     * включая «прочий»). Используется иерархическими
     * _hasRiskTablesAtLevel5x / _hasRiskTablesBelowLevel5x — правило
     * «риски только на одном уровне» симметрично по всем типам.
     */
    _hasAnyRiskTable(node) {
        if (!node.children) return false;
        // Дискриминатор сам проверяет type === table.
        return node.children.some(child => kindIsRiskTable(child));
    }

    /** Проверяет, есть ли таблицы рисков в дочерних item-узлах */
    _hasChildItemRiskTables(node) {
        if (!node.children) return false;
        for (const child of node.children) {
            if (child.type === AppConfig.nodeTypes.ITEM && AppState._findRiskTablesInSubtree(child).length > 0) {
                return true;
            }
        }
        return false;
    }

    /** Проверяет, есть ли таблицы рисков на уровне 5.* (в любой ветке) */
    _hasRiskTablesAtLevel5x() {
        const node5 = AppState.findNodeById('5');
        if (!node5?.children) return false;
        return node5.children.some(child =>
            child.type === AppConfig.nodeTypes.ITEM && child.number?.match(/^5\.\d+$/) && this._hasAnyRiskTable(child)
        );
    }

    /** Проверяет, есть ли таблицы рисков на уровне 5.*.* и глубже (в любой ветке) */
    _hasRiskTablesBelowLevel5x() {
        const node5 = AppState.findNodeById('5');
        if (!node5?.children) return false;
        return node5.children.some(child =>
            child.type === AppConfig.nodeTypes.ITEM && child.number?.match(/^5\.\d+$/) && this._hasChildItemRiskTables(child)
        );
    }

    /** Проверяет, есть ли в разделе 5 TB-leaf узлы на уровне 5.X и item-узлы на уровне 5.X.X одновременно */
    _hasBothLevelsAvailable() {
        const node5 = AppState.findNodeById('5');
        if (!node5?.children) return false;
        const items = node5.children.filter(c => !c.type || c.type === AppConfig.nodeTypes.ITEM);
        let hasLeafAt5x = false;
        let hasNodesAt5xx = false;
        for (const child of items) {
            const itemKids = (child.children || []).filter(gc => !gc.type || gc.type === AppConfig.nodeTypes.ITEM);
            if (itemKids.length === 0) hasLeafAt5x = true;
            else hasNodesAt5xx = true;
            if (hasLeafAt5x && hasNodesAt5xx) return true;
        }
        return false;
    }

    /** Проверяет, нужно ли показать предупреждение о выборе уровня для таблиц рисков */
    _shouldShowRiskLevelWarning() {
        return !this._hasRiskTablesAtLevel5x()
            && !this._hasRiskTablesBelowLevel5x()
            && this._hasBothLevelsAvailable();
    }

    /** Показывает предупреждение о выборе уровня для таблиц рисков */
    async _showRiskLevelWarning() {
        await DialogManager.alert({
            title: 'Обратите внимание',
            icon: 'ℹ️',
            message: 'В рамках одного акта таблицы рисков могут располагаться либо на уровне пунктов (5.1, 5.2, ...), '
                + 'либо на уровне подпунктов (5.1.1, 5.1.1.1, ...), но не на обоих уровнях одновременно.\n\n'
                + 'Пожалуйста, прикрепляйте таблицы рисков только к пунктам одного уровня.',
            confirmText: 'Понятно',
            type: 'info'
        });
    }

    /** Выполняет действие */
    async handleAction(action) {
        const nodeId = ContextMenuManager.currentNodeId;
        if (!nodeId) return;

        const node = AppState.findNodeById(nodeId);
        if (!node) return;

        switch (action) {
            case 'add-child':
                this.handleAddChild(node, nodeId);
                break;
            case 'add-sibling':
                this.handleAddSibling(node, nodeId);
                break;
            case 'add-regular-table':
                this.handleAddTable(node, nodeId, 'regular');
                break;
            case 'add-regular-risk-table':
                return this._handleRiskTableAction(node, nodeId, 'regular', 'regular-risk');
            case 'add-operational-risk-table':
                return this._handleRiskTableAction(node, nodeId, 'operational', 'operational-risk');
            case 'add-tax-risk-table':
                return this._handleRiskTableAction(node, nodeId, 'tax', 'tax-risk');
            case 'add-other-risk-table':
                return this._handleRiskTableAction(node, nodeId, 'other', 'other-risk');
            case 'add-textblock':
                this.handleAddTextBlock(node, nodeId);
                break;
            case 'add-violation':
                this.handleAddViolation(node, nodeId);
                break;
            case 'attach-invoice':
                this.handleAttachInvoice(node, nodeId);
                break;
            case 'delete':
                this.handleDelete(node, nodeId);
                break;
            case 'ai-assistant':
                this.openChatWithContext(node, nodeId);
                break;
        }
    }

    /**
     * Открывает AI-чат с контекстом: текущий акт + выбранный узел.
     *
     * Используется пунктом «AI-ассистент» в контекстном меню. При клике:
     * 1) Запоминает выбранный узел в window.__selectedNode.
     * 2) Открывает popup чата (chatPopupBtn) — при необходимости.
     * 3) Очищает текущую беседу (chat:clear) — если чат уже был открыт
     *    и пользователь вызвал AI-ассистент на ДРУГОМ узле. Так не будет
     *    путаницы «редактируем старый узел».
     * 4) Формирует initial_message с контекстом (КМ + выбранный блок) и
     *    сразу отправляет его через ChatManager.sendMessage({text: ...}).
     *    LLM получает user-сообщение «Готов к редактированию. Акт: ...»
     *    и отвечает «Готов к редактированию».
     *
     * Если пользователь не ввёл промпт, а потом вызвал AI-ассистента на
     * другом узле — чат НЕ будет редактировать старый узел: открывается
     * новая беседа, и initial_message уже ссылается на новый узел.
     */
    openChatWithContext(node, nodeId) {
        // 1) Запоминаем выбранный узел глобально.
        try {
            window.__selectedNode = {
                id: nodeId,
                number: node?.number ?? null,
                label: node?.label ?? null,
                type: node?.type ?? 'item',
            };
        } catch (_) { /* node уже удалён */ }

        // 2) Открываем popup чата (если закрыт). Безопасно вызывать
        //    на уже открытом — toggle() сам разберётся.
        const popupOpen = document.getElementById('chatPopupPanel')
            && !document.getElementById('chatPopupPanel').classList.contains('hidden');
        if (typeof window.ChatPopupManager !== 'undefined'
            && typeof window.ChatPopupManager.open === 'function') {
            window.ChatPopupManager.open();
        } else if (typeof document !== 'undefined') {
            const btn = document.getElementById('chatPopupBtn');
            if (btn) btn.click();
        }

        // 3) Очищаем текущую беседу, если чат УЖЕ был открыт. Так
        //    предыдущий контекст (например, выбранный ранее узел)
        //    не «утяжелит» новую итерацию AI-ассистента.
        if (popupOpen && typeof window.ChatEventBus !== 'undefined') {
            try { window.ChatEventBus.emit('chat:clear'); } catch (_) {}
        }

        // 4) Формируем initial_message с контекстом и сразу отправляем.
        //    Это будет первое user-сообщение в новой беседе; LLM получает
        //    его и отвечает «Готов к редактированию».
        let initialMsg = '';
        if (typeof window.ChatStream !== 'undefined'
            && typeof window.ChatStream.buildContextInitialMessage === 'function') {
            try {
                initialMsg = window.ChatStream.buildContextInitialMessage(
                    window.__selectedNode,
                );
            } catch (_) { initialMsg = ''; }
        }

        if (initialMsg && typeof window.ChatManager !== 'undefined'
            && typeof window.ChatManager.sendMessage === 'function') {
            // Сбрасываем __selectedNode, чтобы sendAndPoll не дублировал
            // initial_message (мы передадим его явно через text).
            // Но selectedNode нужен бэкенду — оставляем.
            // Микро-задержка: после open() ChatManager уже инициализирован.
            setTimeout(() => {
                try {
                    window.ChatManager.sendMessage({ text: initialMsg });
                } catch (e) {
                    console.error('AI-ассистент: не удалось отправить приветствие', e);
                }
            }, 50);
        }
    }

    /** Унифицированный обработчик добавления риск-таблицы любого типа. */
    async _handleRiskTableAction(node, nodeId, riskType, tableType) {
        if (!this._isRiskTableAllowedForNode(node, riskType)) {
            return Notifications.error(this._getRiskTableBlockReason(node, riskType));
        }
        if (this._shouldShowRiskLevelWarning()) {
            await this._showRiskLevelWarning();
        }
        return this.handleAddTable(node, nodeId, tableType);
    }

    /** Добавляет дочерний элемент */
    handleAddChild(node, nodeId) {
        if (node.type === AppConfig.nodeTypes.TABLE) {
            Notifications.error('Нельзя добавлять дочерние элементы к таблице');
            return;
        }

        // Нельзя добавлять подпункты ни к одному 5.*, если где-либо на 5.* есть таблица рисков
        if (node.number?.match(/^5\.\d+$/) && this._hasRiskTablesAtLevel5x()) {
            Notifications.error('Нельзя добавлять подпункты: в разделе 5 есть таблицы рисков на уровне пунктов');
            return;
        }

        const result = AppState.addNode(nodeId, '', true);
        if (result.valid) {
            // Добавление потомка → пересборка поддерева самого nodeId
            this.updateTreeViews(nodeId);
        } else {
            Notifications.error(result.message || 'Не удалось добавить элемент');
        }
    }

    /** Добавляет соседний элемент (на 0 уровне — пункт Process Mining) */
    handleAddSibling(node, nodeId) {
        const parent = AppState.findParentNode(nodeId);

        // На 0 уровне «соседний пункт» = опциональный пункт Process Mining.
        if (parent?.id === 'root') {
            this.handleAddProcessMining();
            return;
        }

        // Нельзя добавлять соседние подпункты на уровне 5.*.*, если где-либо на 5.* есть таблица рисков
        if (node.number?.match(/^5\.\d+\./)) {
            if (this._hasRiskTablesAtLevel5x()) {
                Notifications.error('Нельзя добавлять подпункты: в разделе 5 есть таблицы рисков на уровне пунктов');
                return;
            }
        }

        const result = AppState.addNode(nodeId, '', false);
        if (result.valid) {
            const sibParent = AppState.findParentNode(nodeId);
            this.updateTreeViews(sibParent ? sibParent.id : undefined);
        } else {
            Notifications.error(result.message || 'Не удалось добавить элемент');
        }
    }

    /** Добавляет опциональный пункт Process Mining (0 уровень). */
    handleAddProcessMining() {
        const result = AppState.addProcessMiningSection();
        if (result.valid) {
            this.updateTreeViews(); // полный рендер: добавлен пункт 0 уровня
        } else {
            Notifications.error(result.message || 'Не удалось добавить пункт');
        }
    }

    /** Добавляет таблицу к узлу */
    handleAddTable(node, nodeId, tableType = 'regular') {
        if (node.type === AppConfig.nodeTypes.TABLE) {
            Notifications.error('Нельзя добавлять таблицу к таблице');
            return;
        }

        let result;
        switch (tableType) {
            case 'regular':
                result = AppState.addTableToNode(nodeId);
                break;
            case 'regular-risk':
                result = AppState._createRegularRiskTable(nodeId);
                if (result.valid) {
                    AppState.generateNumbering();
                    MetricsRiskCoordinator.onRiskTableAdded(nodeId);
                }
                break;
            case 'operational-risk':
                result = AppState._createOperationalRiskTable(nodeId);
                if (result.valid) {
                    AppState.generateNumbering();
                    MetricsRiskCoordinator.onRiskTableAdded(nodeId);
                }
                break;
            case 'tax-risk':
                result = AppState._createTaxRiskTable(nodeId);
                if (result.valid) {
                    AppState.generateNumbering();
                    MetricsRiskCoordinator.onRiskTableAdded(nodeId);
                }
                break;
            case 'other-risk':
                result = AppState._createOtherRiskTable(nodeId);
                if (result.valid) {
                    AppState.generateNumbering();
                    // «Прочий» риск — полноправный участник свода: триггерит coordinator.
                    MetricsRiskCoordinator.onRiskTableAdded(nodeId);
                }
                break;
            default:
                result = AppState.addTableToNode(nodeId);
        }

        if (result.valid) {
            // Регулярные/операционные риск-таблицы влияют на метрики-таблицы
            // других узлов раздела 5 → полный renderAll. Обычная таблица — узкая.
            const scope = (tableType === 'regular') ? nodeId : undefined;
            this.updateTreeViews(scope);
        } else {
            Notifications.error(result.message || 'Ошибка при добавлении таблицы');
        }
    }

    /** Добавляет текстовый блок */
    handleAddTextBlock(node, nodeId) {
        const {TABLE, TEXTBLOCK} = AppConfig.nodeTypes;
        if ([TABLE, TEXTBLOCK].includes(node.type)) {
            Notifications.error('Нельзя добавлять текстовый блок к этому элементу');
            return;
        }

        const result = AppState.addTextBlockToNode(nodeId);
        if (result.valid) {
            this.updateTreeViews(nodeId);
        } else {
            Notifications.error(result.message || 'Ошибка при добавлении текстового блока');
        }
    }

    /** Добавляет нарушение */
    handleAddViolation(node, nodeId) {
        const {TABLE, TEXTBLOCK, VIOLATION} = AppConfig.nodeTypes;
        if ([TABLE, TEXTBLOCK, VIOLATION].includes(node.type)) {
            Notifications.error('Нельзя добавлять нарушение к этому элементу');
            return;
        }

        const result = AppState.addViolationToNode(nodeId);
        if (result.valid) {
            this.updateTreeViews(nodeId);
        } else {
            Notifications.error(result.message || 'Ошибка при добавлении нарушения');
        }
    }

    /** Приложить фактуру */
    handleAttachInvoice(node, nodeId) {
        InvoiceDialog.show(node, nodeId);
    }

    /** Удаляет узел */
    handleDelete(node, nodeId) {
        if (node.deletable === false) {
            Notifications.error('Этот элемент нельзя удалить');
            return;
        }

        // Проверка удаления таблиц метрик
        if (node.type === AppConfig.nodeTypes.TABLE && node.tableId) {
            const table = AppState.tables[node.tableId];

            const findRisks = n => AppState._findRiskTablesInSubtree(n);

            // Проверка под узлом 5.* (единый предикат необходимости сводной).
            if (table?.kind === KIND_METRICS) {
                const parentUnder5 = this._findParentFirstLevelUnderPoint5(node);
                if (parentUnder5 && shouldHaveMetricsTable(parentUnder5, findRisks)) {
                    Notifications.error('Нельзя удалить таблицу метрик, пока есть таблицы рисков');
                    return;
                }
            }

            // Проверка главной таблицы метрик (единый предикат).
            if (table?.kind === KIND_MAIN_METRICS) {
                const node5 = AppState.findNodeById('5');
                if (shouldHaveMainMetrics(node5, findRisks)) {
                    Notifications.error('Нельзя удалить общую таблицу метрик, пока в пункте 5 есть таблицы рисков');
                    return;
                }
            }
        }

        // Захватываем parentId ДО удаления, иначе AppState.findParentNode вернёт null
        const parentBeforeDelete = AppState.findParentNode(nodeId);
        const parentId = parentBeforeDelete ? parentBeforeDelete.id : null;

        // Удаление таблицы рисков триггерит _cleanupMetricsTablesAfterRiskTableDeleted,
        // которая может удалить метрики-таблицы из ДРУГИХ узлов раздела 5 → fallback на renderAll.
        // Все 4 типа — полноправные риски, удаление любого перерисовывает дерево.
        const isRiskTableDelete = kindIsRiskTable(node);

        // Свод-предупреждение: если это последний риск на уровне, каскад удалит
        // соответствующие сводные таблицы — честно сообщаем об этом в диалоге.
        let message = 'Удалить этот элемент?';
        if (isRiskTableDelete) {
            const pred = this._predictSvodRemoval(node);
            const warns = [];
            if (pred.perPoint) warns.push(`сводная таблица по пункту ${pred.perPoint}`);
            if (pred.mainSvod) warns.push('общая сводная таблица');
            if (warns.length) {
                message += `\n\nБудет также удалена ${warns.join(' и ')}, так как других таблиц рисков на уровне не останется.`;
            }
        }

        DialogManager.show({
            title: 'Удаление элемента',
            message,
            icon: '⚠️',
            confirmText: 'Удалить',
            cancelText: 'Отмена'
        }).then(userConfirmed => {
            if (userConfirmed) {
                const deleted = AppState.deleteNode(nodeId);
                if (deleted) {
                    this.updateTreeViews(isRiskTableDelete ? undefined : parentId);
                    // Toast с кнопкой «Отменить» — откат последнего удаления (Б-4).
                    UndoDeleteManager.showDeletedToast();
                }
            }
        });
    }

    /** Ищет родителя первого уровня под пунктом 5 */
    _findParentFirstLevelUnderPoint5(node) {
        let parent = AppState.findParentNode(node.id);
        let current = node;

        while (parent && parent.id !== '5') {
            current = parent;
            parent = AppState.findParentNode(current.id);
        }

        if (parent && parent.id === '5' && current.number?.match(/^5\.\d+$/)) {
            return current;
        }
        return null;
    }

    /**
     * Best-effort предсказание: какие сводные (metrics) таблицы будут удалены
     * каскадом _cleanupMetricsTablesAfterRiskTableDeleted при удалении узла node.
     * Read-only; источник истины — сам cleanup. Используется только для текста диалога.
     * @param {Object} node - удаляемый узел (предполагается риск-таблица).
     * @returns {{mainSvod: boolean, perPoint: string|null}}
     *   mainSvod — будет удалена главная сводная §5; perPoint — номер пункта 5.X,
     *   по которому будет удалена per-point сводная (или null).
     */
    _predictSvodRemoval(node) {
        const empty = {mainSvod: false, perPoint: null};
        // Узел предполагается риск-таблицей (вызывается только из handleDelete
        // при isRiskTableDelete). Дискриминатор — один источник истины.
        if (!kindIsRiskTable(node)) return empty;

        const node5 = AppState.findNodeById('5');
        if (!node5) return empty;
        const {TABLE, ITEM} = AppConfig.nodeTypes;

        // Главная сводная: останутся ли риски в §5 кроме удаляемого?
        const remaining = AppState._findRiskTablesInSubtree(node5).filter(n => n.id !== node.id);
        const mainNode = node5.children?.find(c => c.type === TABLE && c.kind === KIND_MAIN_METRICS);
        const mainSvod = !!mainNode && remaining.length === 0;

        // Per-point сводная по 5.X-предку (только для глубоких рисков 5.X.Y+).
        let perPoint = null;
        const ancestor5x = this._findParentFirstLevelUnderPoint5(node);
        if (ancestor5x) {
            let deep = [];
            for (const child of ancestor5x.children || []) {
                if (child.type === ITEM) {
                    deep = deep.concat(AppState._findRiskTablesInSubtree(child));
                }
            }
            deep = deep.filter(n => n.id !== node.id);
            const perNode = ancestor5x.children?.find(c => c.type === TABLE && c.kind === KIND_METRICS);
            if (perNode && deep.length === 0) {
                perPoint = ancestor5x.number;
            }
        }

        return {mainSvod, perPoint};
    }

    /**
     * Обновление UI после изменения дерева.
     * @param {string} [scopeNodeId] - ID узла-родителя, чьё поддерево достаточно перерисовать.
     *   Если не указан — fallback на полный рендер (используется для рисковых таблиц,
     *   которые затрагивают метрики-таблицы в произвольных местах раздела 5).
     */
    updateTreeViews(scopeNodeId) {
        if (scopeNodeId) {
            // Точечная пересборка поддерева в дереве (внутри — fallback на
            // полный render, если узел не отрисован, напр. scope === 'root').
            treeManager.renderer.renderSubtree(scopeNodeId);
        } else {
            treeManager.render();
        }
        PreviewManager.update();
        if (AppState.currentStep === 2) {
            if (scopeNodeId) {
                ItemsRenderer.updateItem(scopeNodeId);
            } else {
                ItemsRenderer.renderAll();
            }
        }
    }
}

// Window-globals для совместимости с inline-скриптами в шаблонах.
window.TreeContextMenu = TreeContextMenu;
