/**
 * Копирование узлов/поддеревьев между актами и внутри акта (§7).
 *
 * Транспорт — localStorage (КП-1): один ключ-буфер, работает между вкладками
 * одного origin. В буфер кладётся deep-копия копируемого поддерева, записи
 * словарей (tables/textBlocks/violations) всех листьев-блоков, версия формата
 * и act_id источника.
 *
 * При вставке (КП-2) все id регенерируются и внутренние ссылки переписываются:
 * id узлов, поля-ссылки на словари (tableId/textBlockId/violationId) и ключи
 * самих словарей. Записи словарей копируются в целевой акт с НОВЫМИ id —
 * никаких коллизий и сирот (бэк-кросс-валидатор дерево↔словари вернул бы 422).
 *
 * Ограничения вставки:
 *  - КП-3: защищённые секции 1–5 и закреплённые таблицы (metrics/risk) нельзя
 *    копировать как корень выделения; pinned-дети внутри поддерева пропускаются;
 *  - КП-4: invoice-привязки сбрасываются (фактура принадлежит акту/узлу);
 *  - КП-5: картинки (inline base64) копируются как есть, при вставке —
 *    проверка лимита суммарного размера картинок целевого акта;
 *  - КП-6: вставка через штатную валидацию (ValidationTree.canAddChild/maxDepth)
 *    и официальный мутатор insertNodeAt (позиция — после pinned-таблиц).
 *
 * Чистое ядро (serialize/regenerate/filter/reset/limits) — без DOM и без
 * AppState-зависимостей, покрыто юнит-тестами. Оркестрация (copyNode/pasteInto)
 * ходит через AppState и официальные мутаторы. Установка шортката Ctrl+C/Ctrl+V
 * и пунктов меню — side-effect (installHotkey/installMenuItems из entry).
 */

import { AppState, _unwrap } from '../state/state-core.js';
import { TreeUtils } from '../tree/tree-utils.js';
import { ValidationTree } from '../validation/validation-tree.js';
import { getBlockType, isLeafBlockType } from '../block-types.js';
import { VIOLATION_FIELD_KEYS } from '../violation/violation-fields.js';
import { isPinnedTable, isRiskTable, isMetricsTable, getTableKind } from '../table/table-kind.js';
import { AppConfig } from '../../shared/app-config.js';
import { isEditableTarget } from '../../shared/editable-target.js';
import { Notifications } from '../../shared/notifications.js';
import { formatMb } from '../../shared/format-units.js';
import {
    estimateActImageBytes,
    getImageLimits,
} from '../violation/violation-image-validator.js';
import { MetricsRiskCoordinator } from '../state/metrics-risk-coordinator.js';

/** Версия формата буфера. Несовпадение → буфер игнорируется. */
export const CLIPBOARD_FORMAT_VERSION = 1;

/** Ключ буфера в localStorage (один на origin, общий между вкладками). */
export const CLIPBOARD_STORAGE_KEY = 'constructor:clipboard';

/**
 * Сериализует поддерево узла в payload буфера: deep-копия узла + записи
 * словарей всех листьев-блоков поддерева. Чистая функция: читает raw-узлы и
 * raw-словари, возвращает новые объекты. deep-копия и сбор записей словарей —
 * общие хелперы TreeUtils (см. undo-delete).
 *
 * @param {Object} rawNode - Raw-корень копируемого поддерева
 * @param {Object} rawDicts - Сырые словари {tables, textBlocks, violations}
 * @param {string|number|null} sourceActId - act_id источника (для справки)
 * @returns {Object} Payload буфера
 */
export function serializeSubtree(rawNode, rawDicts, sourceActId = null) {
    return {
        version: CLIPBOARD_FORMAT_VERSION,
        sourceActId: sourceActId ?? null,
        node: TreeUtils.deepCopy(_unwrap(rawNode)),
        dicts: TreeUtils.collectSubtreeDictEntries(rawNode, rawDicts),
    };
}

/**
 * Фильтрует поддерево от закреплённых таблиц (pinned: metrics/risk). КП-3:
 * pinned-таблицы при вставке пропускаются. Возвращает новое дерево (deep-копию)
 * без pinned-узлов и флаг, были ли что-то отброшено.
 *
 * Корень не проверяется (его проверяет caller перед вызовом — pinned/protected
 * нельзя копировать как корень выделения). Применяется к детям рекурсивно.
 *
 * @param {Object} node - Узел (будет скопирован)
 * @param {{keepRisk?: boolean}} opts - Опции: keepRisk=true сохраняет risk-таблицы,
 *        отбрасывает только metrics (для paste в §5); по умолчанию отбрасываются все pinned.
 * @returns {{node: Object, skippedPinned: boolean}}
 */
export function filterPinnedFromSubtree(node, { keepRisk = false } = {}) {
    let skippedPinned = false;

    const drop = (child) => {
        if (!isPinnedTable(child)) return false;
        // keepRisk: риск-таблицы остаются, отбрасываем только metrics.
        if (keepRisk && isRiskTable(child)) return false;
        return true;
    };

    const clone = (n) => {
        const copy = { ...n };
        if (Array.isArray(n.children)) {
            copy.children = [];
            for (const child of n.children) {
                if (drop(child)) {
                    skippedPinned = true;
                    continue;
                }
                copy.children.push(clone(child));
            }
        }
        return copy;
    };

    return { node: clone(TreeUtils.deepCopy(node)), skippedPinned };
}

/**
 * Сбрасывает invoice-привязки во всём поддереве (КП-4). Фактура принадлежит
 * конкретному акту/узлу и при копировании не переносится. Мутирует переданное
 * (уже скопированное) дерево.
 *
 * @param {Object} node - Узел (мутируется)
 */
export function resetInvoices(node) {
    if (node.invoice) delete node.invoice;
    if (Array.isArray(node.children)) {
        for (const child of node.children) resetInvoices(child);
    }
}

/**
 * Регенерирует все id поддерева и записей словарей + remap ссылок (КП-2).
 *
 * - id каждого узла → новый (генератор передаётся, чтобы соответствовать
 *   конвенциям проекта — AppState._generateId);
 * - поля-ссылки на словари (tableId/textBlockId/violationId) → новые id;
 * - ключи копий словарей → новые id; entry.id и entry.nodeId — синхронно.
 *
 * Чистая функция: принимает payload (как из буфера), возвращает новое дерево
 * и новые словари, ничего не мутирует во входе.
 *
 * @param {Object} payload - {node, dicts}
 * @param {{genNodeId: Function, genContentId: Function}} gens - Генераторы id.
 *        genNodeId(node) → новый id узла; genContentId(type) → новый id контента.
 * @returns {{node: Object, dicts: Object}} Поддерево и словари с новыми id
 */
export function regenerateIds(payload, gens) {
    const { genNodeId, genContentId } = gens;
    const srcNode = TreeUtils.deepCopy(payload.node);
    const srcDicts = TreeUtils.deepCopy(payload.dicts || {});

    // Маппинг старый contentId → новый contentId (по dictName).
    const contentIdMap = {};
    const newDicts = {};

    const walk = (n, parentId) => {
        const newNodeId = genNodeId(n);
        n.id = newNodeId;
        if (parentId !== null && 'parentId' in n) {
            n.parentId = parentId;
        }

        // Листовой блок: регенерируем ссылку на словарь и переносим запись.
        if (n.type && isLeafBlockType(n.type)) {
            const spec = getBlockType(n.type);
            const oldContentId = n[spec.idProp];
            const dict = srcDicts[spec.dictName];
            const entry = oldContentId && dict ? dict[oldContentId] : null;
            if (entry) {
                const newContentId = genContentId(n.type);
                n[spec.idProp] = newContentId;
                contentIdMap[oldContentId] = newContentId;

                const newEntry = { ...entry, id: newContentId, nodeId: newNodeId };

                // #22 (блочная модель): блоки ВСЕХ полей нарушения несут
                // СОБСТВЕННЫЙ id — при вставке копии они должны стать новыми,
                // иначе копия делит id блоков с оригиналом (коллизии при
                // последующем удалении/DnD/диффе по id). Обход — циклом по
                // реестру VIOLATION_FIELD_KEYS, а не хардкодом одного поля
                // (тот же цикл переиспользует будущий transfer «песочница↔акт»
                // модели «роли и блоки»). Генератор — с ИНДЕКСОМ пачки:
                // Date.now() внутри map по нескольким блокам может повториться.
                if (spec.dictName === 'violations') {
                    for (const fieldKey of VIOLATION_FIELD_KEYS) {
                        const container = newEntry[fieldKey];
                        if (!Array.isArray(container?.blocks) || !container.blocks.length) continue;
                        newEntry[fieldKey] = {
                            ...container,
                            blocks: container.blocks.map((block, i) => ({
                                ...block,
                                id: `${block.type}_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 9)}`,
                            })),
                        };
                    }
                }

                if (!newDicts[spec.dictName]) newDicts[spec.dictName] = {};
                newDicts[spec.dictName][newContentId] = newEntry;
            }
        }

        if (Array.isArray(n.children)) {
            for (const child of n.children) walk(child, newNodeId);
        }
    };
    walk(srcNode, null);

    return { node: srcNode, dicts: newDicts };
}

/**
 * Проверяет, не превысит ли вставка лимит суммарного размера картинок акта
 * (КП-5). Чистая функция.
 *
 * @param {number} existingBytes - Текущий размер картинок целевого акта
 * @param {number} pastedBytes - Размер картинок вставляемого поддерева
 * @param {number} maxTotalBytes - Лимит суммарного размера на акт
 * @returns {{ok: boolean, reason: string}}
 */
export function checkImageLimits(existingBytes, pastedBytes, maxTotalBytes) {
    if (existingBytes + pastedBytes > maxTotalBytes) {
        return {
            ok: false,
            reason: `Вставка превысит лимит суммарного размера картинок акта `
                + `(${formatMb(maxTotalBytes)} МБ). Скопированное поддерево не вставлено.`,
        };
    }
    return { ok: true, reason: '' };
}

/**
 * Ошибка переполнения квоты localStorage. Браузеры кидают её по-разному:
 * code 22 (большинство), code 1014 (Firefox), либо по имени исключения.
 * @param {*} e - Перехваченное исключение
 * @returns {boolean}
 */
function isQuotaExceededError(e) {
    return e instanceof DOMException && (
        e.code === 22
        || e.code === 1014
        || e.name === 'QuotaExceededError'
        || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    );
}

export const NodeClipboard = {
    /** @type {boolean} Шорткат Ctrl+C/Ctrl+V уже установлен. */
    _hotkeyInstalled: false,

    /** @type {boolean} Пункты меню уже добавлены. */
    _menuInstalled: false,

    /**
     * Копирует узел (и его поддерево) в localStorage-буфер (КП-1).
     * Защищённые секции 1–5 и pinned-таблицы как корень выделения копировать
     * нельзя (КП-3). Копирование разрешено и в read-only.
     *
     * @param {string} nodeId - ID копируемого узла
     * @returns {boolean} true — скопировано
     */
    copyNode(nodeId) {
        const rawNode = AppState._findNodeRaw?.(nodeId);
        if (!rawNode) return false;

        // Сводные (metrics) таблицы копировать нельзя — они авто-деривируются.
        if (isMetricsTable(rawNode)) {
            Notifications.error('Сводные таблицы (метрики) копировать нельзя');
            return false;
        }
        // Защищённые узлы нельзя копировать; исключение — таблицы рисков
        // (protected, но допускают копирование как корень выделения).
        if (rawNode.protected && !isRiskTable(rawNode)) {
            Notifications.error('Защищённые разделы нельзя копировать');
            return false;
        }

        const rawDicts = {
            tables: _unwrap(AppState.tables) || {},
            textBlocks: _unwrap(AppState.textBlocks) || {},
            violations: _unwrap(AppState.violations) || {},
        };
        const payload = serializeSubtree(rawNode, rawDicts, window.currentActId ?? null);

        // КП-5: картинки (inline base64) копируются как есть. Если их суммарный
        // размер уже превышает лимит акта — вставка всё равно была бы отклонена,
        // да и буфер вряд ли вместит. Отсекаем заранее с точным сообщением про
        // размер картинок (а не про абстрактное «переполнение буфера»).
        const limits = getImageLimits();
        const imgBytes = estimateActImageBytes(payload.dicts.violations || {});
        if (imgBytes > limits.maxTotalSizePerAct) {
            Notifications.error(
                `Картинки скопированного фрагмента слишком большие для копирования `
                + `(лимит ${formatMb(limits.maxTotalSizePerAct)} МБ)`
            );
            return false;
        }

        try {
            localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(payload));
        } catch (e) {
            if (isQuotaExceededError(e)) {
                Notifications.error('Фрагмент слишком большой и не помещается в буфер браузера');
            } else {
                Notifications.error('Не удалось скопировать');
            }
            return false;
        }

        Notifications.success('Скопировано');
        return true;
    },

    /**
     * Читает payload из буфера. Возвращает null при пустом/битом/устаревшем
     * буфере.
     * @returns {Object|null}
     */
    readClipboard() {
        let raw;
        try {
            raw = localStorage.getItem(CLIPBOARD_STORAGE_KEY);
        } catch (_) {
            return null;
        }
        if (!raw) return null;

        let payload;
        try {
            payload = JSON.parse(raw);
        } catch (_) {
            return null;
        }
        if (!payload || payload.version !== CLIPBOARD_FORMAT_VERSION || !payload.node) {
            return null;
        }
        return payload;
    },

    /** Есть ли что вставлять. @returns {boolean} */
    canPaste() {
        return this.readClipboard() !== null;
    },

    /**
     * Вставляет содержимое буфера дочерним элементом целевого узла.
     * Регенерация id + remap (КП-2), фильтр pinned (КП-3), сброс invoice (КП-4),
     * проверка лимита картинок (КП-5), штатная валидация + insertNodeAt (КП-6).
     *
     * @param {string} targetNodeId - ID узла, в который вставляем (как дочерний)
     * @returns {boolean} true — вставлено
     */
    pasteInto(targetNodeId) {
        if (AppConfig.readOnlyMode?.isReadOnly) {
            Notifications.warning(AppConfig.readOnlyMode.messages.cannotModifyTree);
            return false;
        }

        const payload = this.readClipboard();
        if (!payload) {
            Notifications.info('Буфер пуст');
            return false;
        }

        const target = AppState.findNodeById(targetNodeId);
        if (!target) return false;

        if (target.type && target.type !== AppConfig.nodeTypes.ITEM) {
            Notifications.error('Нельзя вставлять внутрь этого элемента');
            return false;
        }

        // Внутри §5 риск-таблицы сохраняются; вне §5 — отбрасываются (как раньше).
        const targetUnder5 = targetNodeId === '5' || TreeUtils.isUnderSection5(target);
        const filtered = filterPinnedFromSubtree(payload.node, { keepRisk: targetUnder5 });

        const regenerated = regenerateIds(
            { node: filtered.node, dicts: payload.dicts },
            {
                genNodeId: () => AppState._generateId('node'),
                genContentId: (type) => AppState._generateId(type),
            }
        );

        resetInvoices(regenerated.node);

        // Корень буфера — таблица рисков: полная проверка размещения.
        if (isRiskTable(regenerated.node)) {
            const placement = AppState._checkRiskTablePastePlacement(target, getTableKind(regenerated.node));
            if (!placement.valid) {
                Notifications.error(placement.message);
                return false;
            }
        }

        // Нарушения нельзя помещать в поддерево пункта Process Mining.
        if (AppState._isUnderProcessMining(targetNodeId) && AppState._subtreeHasViolations(regenerated.node)) {
            Notifications.error('В пункте «Process Mining» нельзя размещать нарушения');
            return false;
        }

        // §5: к пункту 5.X нельзя добавлять подпункты, если в разделе 5 есть таблицы
        // рисков на уровне пунктов (паритет с «Добавить подпункт» в контекстном меню).
        const pastedIsItem = !regenerated.node.type || regenerated.node.type === AppConfig.nodeTypes.ITEM;
        if (targetUnder5 && pastedIsItem
                && /^5\.\d+$/.test(target.number || '')
                && AppState._collectSection5RiskLevels().hasPoint) {
            Notifications.error('Нельзя добавлять подпункты: в разделе 5 есть таблицы рисков на уровне пунктов');
            return false;
        }

        // §5-правила согласованности рисков — те же, что при перемещении.
        const pastedHasRisks = AppState._findRiskTablesInSubtree(regenerated.node).length > 0;
        if (targetUnder5 && pastedHasRisks) {
            const riskCheck = AppState._checkSection5RiskConstraints(regenerated.node, target);
            if (!riskCheck.valid) {
                Notifications.error(riskCheck.message || 'Нельзя вставить сюда');
                return false;
            }
        }

        const validation = ValidationTree.canAddChild(targetNodeId);
        if (!validation.valid) {
            Notifications.error(validation.message || 'Нельзя вставить сюда');
            return false;
        }
        const targetDepth = TreeUtils.getNodeDepth(targetNodeId);
        const subtreeDepth = TreeUtils.getSubtreeDepth(regenerated.node);
        if (targetDepth + 1 + subtreeDepth > AppConfig.tree.maxDepth) {
            Notifications.error(
                `Вставка приведёт к превышению максимальной вложенности (${AppConfig.tree.maxDepth} уровней)`
            );
            return false;
        }

        // PERSIST-2/#7: лимиты блоков-на-узел (текстблоки/нарушения/таблицы).
        // insertNodeAt не зовёт canAddContent — без этой проверки paste мог дать
        // узлу N+1 блоков лимитируемого типа. Словарь нарушений фрагмента —
        // для лимита элементов доп. контента внутри них (§5.10b).
        const blockLimitCheck = ValidationTree.canInsertSubtree(
            targetNodeId,
            regenerated.node,
            regenerated.dicts.violations,
        );
        if (!blockLimitCheck.valid) {
            Notifications.error(blockLimitCheck.message);
            return false;
        }

        // КП-5: лимит суммарного размера картинок целевого акта.
        const limits = getImageLimits();
        const existingBytes = estimateActImageBytes(_unwrap(AppState.violations) || {});
        const pastedBytes = estimateActImageBytes(regenerated.dicts.violations || {});
        const imgCheck = checkImageLimits(existingBytes, pastedBytes, limits.maxTotalSizePerAct);
        if (!imgCheck.ok) {
            Notifications.error(imgCheck.reason);
            return false;
        }

        for (const [dictName, entries] of Object.entries(regenerated.dicts)) {
            const dict = AppState[dictName];
            if (!dict) continue;
            for (const [id, entry] of Object.entries(entries)) dict[id] = entry;
        }

        // Закреплённый корень (таблица рисков) встаёт в pinned-зону (вверху, как
        // при создании через меню), обычный узел — в конец children.
        const insertIndex = isPinnedTable(regenerated.node)
            ? AppState._getFirstNonPinnedIndex(target)
            : (target.children ? target.children.length : 0);
        const result = AppState.insertNodeAt(targetNodeId, regenerated.node, insertIndex);
        if (!result.valid) {
            // Откат перенесённых записей словарей — узел не вставился.
            for (const [dictName, entries] of Object.entries(regenerated.dicts)) {
                const dict = AppState[dictName];
                if (!dict) continue;
                for (const id of Object.keys(entries)) delete dict[id];
            }
            Notifications.error(result.message || 'Не удалось вставить');
            return false;
        }

        // Регенерация сводных таблиц после вставки рисков в §5. Каскад сам
        // перенумеровывает дерево; в остальных случаях нумеруем здесь.
        if (targetUnder5 && pastedHasRisks) {
            const reconciled = MetricsRiskCoordinator.onSubtreeMoved(regenerated.node, null);
            if (!reconciled) {
                // Каскад метрик упал и откатил §5, но снимок снят уже после вставки,
                // поэтому вставленный узел остаётся. Убираем узел и записи словарей —
                // вставка остаётся атомарной (без сирот и неконсистентного §5).
                if (target.children) {
                    target.children = target.children.filter(c => c.id !== regenerated.node.id);
                }
                for (const [dictName, entries] of Object.entries(regenerated.dicts)) {
                    const dict = AppState[dictName];
                    if (!dict) continue;
                    for (const id of Object.keys(entries)) delete dict[id];
                }
                AppState._rebuildNodeIndex?.();
                AppState.generateNumbering();
                this._renderAfterPaste(targetNodeId);
                return false; // ошибку уже показал координатор
            }
        } else {
            AppState.generateNumbering();
        }

        if (filtered.skippedPinned) {
            Notifications.warning('Закреплённые таблицы при вставке пропущены');
        } else {
            Notifications.success('Вставлено');
        }

        this._renderAfterPaste(targetNodeId);
        return true;
    },

    /**
     * Полный/точечный рендер после вставки. Доступ через window-глобалы:
     * clipboard-слой не импортирует DOM-тяжёлые рендереры, в node-тестах
     * глобалов нет — рендер пропускается.
     * @private
     * @param {string} targetNodeId
     */
    _renderAfterPaste(targetNodeId) {
        window.treeManager?.renderer?.renderSubtree?.(targetNodeId)
            ?? window.treeManager?.render?.();
        if (AppState.currentStep === 2) {
            window.ItemsRenderer?.updateItem?.(targetNodeId)
                ?? window.ItemsRenderer?.renderAll?.();
        }
        window.PreviewManager?.update?.();
    },

    /**
     * Устанавливает шорткаты Ctrl+C / Ctrl+V (capture-фаза). Внутри активных
     * редакторов (contenteditable / textarea / select / текстовый input —
     * общий предикат isEditableTarget) живёт браузерный copy/paste, не
     * перехватываем (по образцу UndoDeleteManager).
     *
     * Ctrl+C/Ctrl+V работают по выделенному узлу дерева (AppState.selectedNode).
     */
    installHotkey() {
        if (this._hotkeyInstalled) return;
        this._hotkeyInstalled = true;

        document.addEventListener('keydown', (e) => {
            if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
            if (e.code !== 'KeyC' && e.code !== 'KeyV') return;
            if (isEditableTarget(document.activeElement)) return;

            const selected = AppState.selectedNode;
            if (!selected?.id) return;

            if (e.code === 'KeyC') {
                e.preventDefault();
                e.stopPropagation();
                this.copyNode(selected.id);
            } else if (e.code === 'KeyV') {
                if (AppConfig.readOnlyMode?.isReadOnly) return;
                e.preventDefault();
                e.stopPropagation();
                this.pasteInto(selected.id);
            }
        }, true);
    },

    /** @type {Element|null} Пункт меню «Копировать» (для refreshMenuState). */
    _copyMenuItem: null,

    /** @type {Element|null} Пункт меню «Вставить» (для refreshMenuState). */
    _pasteMenuItem: null,

    /**
     * Добавляет пункты «Копировать» / «Вставить» в контекстное меню дерева
     * (#contextMenu) программно — без правки шаблона (шаблон принадлежит другому
     * агенту волны). Пункты получают собственные click-обработчики (штатный
     * делегатор TreeContextMenu уже навешан в конструкторе — до инъекции — и
     * наши элементы не охватывает). Вставляются перед пунктом «Удалить».
     */
    installMenuItems() {
        if (this._menuInstalled) return;
        const menu = document.getElementById?.('contextMenu');
        if (!menu) return;
        this._menuInstalled = true;

        const deleteItem = menu.querySelector?.('[data-action="delete"]');
        const mkItem = (action, icon, label) => {
            const el = document.createElement('div');
            el.className = 'context-menu-item';
            el.setAttribute('role', 'menuitem');
            el.dataset.action = action;
            el.innerHTML = `<span aria-hidden="true">${icon}</span> ${label}`;
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                if (el.classList.contains('disabled')) return;
                this._handleMenuAction(action);
                window.ContextMenuManager?.hide?.();
            });
            return el;
        };
        const sep = () => {
            const s = document.createElement('div');
            s.className = 'context-menu-separator';
            s.setAttribute('role', 'separator');
            s.dataset.action = 'copy-paste-separator';
            return s;
        };

        const copyItem = mkItem('copy', '📄', 'Копировать');
        const pasteItem = mkItem('paste', '📋', 'Вставить');
        const separator = sep();
        this._copyMenuItem = copyItem;
        this._pasteMenuItem = pasteItem;

        if (deleteItem && menu.insertBefore) {
            menu.insertBefore(separator, deleteItem);
            menu.insertBefore(copyItem, deleteItem);
            menu.insertBefore(pasteItem, deleteItem);
        } else if (menu.appendChild) {
            menu.appendChild(separator);
            menu.appendChild(copyItem);
            menu.appendChild(pasteItem);
        }
    },

    /**
     * Обновляет доступность пунктов «Копировать»/«Вставить» при показе меню.
     * Вызывается из TreeContextMenu.updateMenuState. «Копировать» недоступно для
     * protected-секций и pinned-таблиц (их нельзя копировать как корень);
     * «Вставить» — для пустого буфера, read-only и листовых блоков.
     *
     * @param {Object|null} node - Узел, по которому открыто меню
     */
    refreshMenuState(node) {
        if (this._copyMenuItem?.classList) {
            const cannotCopy = !node || isMetricsTable(node) || (node.protected && !isRiskTable(node));
            this._copyMenuItem.classList.toggle('disabled', !!cannotCopy);
        }
        if (this._pasteMenuItem?.classList) {
            const isLeaf = node?.type && node.type !== AppConfig.nodeTypes.ITEM;
            const cannotPaste = !node
                || isLeaf
                || AppConfig.readOnlyMode?.isReadOnly
                || !this.canPaste();
            this._pasteMenuItem.classList.toggle('disabled', !!cannotPaste);
        }
    },

    /**
     * Обработчик клика по пунктам «Копировать»/«Вставить». Узел берётся из
     * ContextMenuManager.currentNodeId (как у штатных пунктов меню).
     * @private
     * @param {string} action - 'copy' | 'paste'
     */
    _handleMenuAction(action) {
        const nodeId = window.ContextMenuManager?.currentNodeId;
        if (!nodeId) return;
        if (action === 'copy') {
            this.copyNode(nodeId);
        } else if (action === 'paste') {
            this.pasteInto(nodeId);
        }
    },
};

// Window-global для совместимости с inline-скриптами в шаблонах.
window.NodeClipboard = NodeClipboard;
